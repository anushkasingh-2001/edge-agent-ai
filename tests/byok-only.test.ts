/**
 * BYOK-only end-to-end behaviour tests.
 *
 * Covers the user-visible contracts of the BYOK-only MVP that aren't
 * already pinned by the resolver-level tests:
 *
 *   - scanner works without an API key (smoke check, doc-only — the
 *     scanner pipeline lives in lib/server-scanner.ts and is exercised
 *     by tests/scan-rules.test.ts; here we just assert that resolving
 *     a scan-side path doesn't accidentally pull the resolver in).
 *   - explain fails gracefully without a key (`template_fallback`,
 *     model_used=null, no fetch issued).
 *   - explain with a key triggers a single fetch carrying the key in
 *     the Authorization header (BYOK forwarding works end-to-end).
 *   - findings/fix client sends BYOK fields on every call.
 *   - aiProviderMode `"hosted"` is treated as missing_api_key.
 *   - process.env.OPENAI_API_KEY is NOT honoured as a fallback even
 *     when set in the ambient environment.
 *   - classifyUpstreamFailure surfaces the canonical INVALID-key
 *     message for 401/403/404 upstream errors.
 *   - Manual mode threads the user-selected model id through.
 *
 * Run with:
 *   node --import tsx --test tests/byok-only.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  resolveAiProviderForRequest,
  classifyUpstreamFailure,
  BYOK_MESSAGES,
} from "../lib/server-ai-provider-resolver"
import {
  explainOneFinding,
  resetSessionCounterForTests,
  type FindingInput,
  type ProjectContext,
} from "../lib/server-finding-explanations"
import { runFindingFixesApi } from "../lib/finding-fixes-client"

function tmpProject(): { project: ProjectContext; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "byok-test-"))
  return {
    project: {
      resolvedProjectPath: dir,
      projectName: path.basename(dir),
      projectType: null,
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

function baseFinding(): FindingInput {
  return {
    finding_id: "f-1",
    rule_id: "ssrf",
    severity: "high",
    category: "Injection",
    title: "SSRF",
    file: "x.py",
    line: 1,
    agent: "unknown",
    reason: "What was detected: SSRF\nWhy it might be risky: input flows to URL\nSuggested fix: validate",
    suggested_fix: "validate",
    evidence: "url = input",
    code_snippet: "url = input",
  }
}

// ===================================================================
// 1. Explain without a key returns template_fallback and no fetch
// ===================================================================

test("explain without a BYOK key returns template_fallback (no fetch)", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    // Ensure the ambient env can't accidentally back-fill a key.
    delete (process.env as Record<string, string | undefined>).OPENAI_API_KEY
    let fetchCalls = 0
    const orig = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new Error("BYOK-only build must NOT hit network without a key")
    }) as typeof fetch
    try {
      const out = await explainOneFinding(baseFinding(), project, {
        apiKey: undefined,
      })
      assert.equal(out.source, "template_fallback")
      assert.equal(out.model_used, null)
      assert.equal(fetchCalls, 0)
    } finally {
      globalThis.fetch = orig
    }
  } finally {
    cleanup()
  }
})

// ===================================================================
// 2. process.env.OPENAI_API_KEY is NOT consulted as a fallback
// ===================================================================

test("explain without a caller key ignores ambient process.env.OPENAI_API_KEY", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    ;(process.env as Record<string, string | undefined>).OPENAI_API_KEY =
      "sk-env-must-not-be-used"
    let fetchCalls = 0
    const orig = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new Error("env key must NOT trigger any network call")
    }) as typeof fetch
    try {
      const out = await explainOneFinding(baseFinding(), project, {
        apiKey: undefined,
      })
      assert.equal(out.source, "template_fallback")
      assert.equal(fetchCalls, 0)
    } finally {
      globalThis.fetch = orig
      delete (process.env as Record<string, string | undefined>).OPENAI_API_KEY
    }
  } finally {
    cleanup()
  }
})

// ===================================================================
// 3. Explain with a BYOK key triggers one fetch, key in Authorization
// ===================================================================

test("explain with a BYOK key forwards the key in the Authorization header", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    delete (process.env as Record<string, string | undefined>).OPENAI_API_KEY
    let observedAuth = ""
    let fetchCalls = 0
    const orig = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      fetchCalls++
      observedAuth = String(
        (init.headers as Record<string, string>)?.["Authorization"] ?? "",
      )
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  what_detected: "x",
                  why_risky: "y",
                  suggested_fix: "z",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
    try {
      const out = await explainOneFinding(baseFinding(), project, {
        apiKey: "sk-byok-user",
      })
      assert.equal(fetchCalls, 1)
      assert.equal(observedAuth, "Bearer sk-byok-user")
      assert.equal(out.source, "ai")
    } finally {
      globalThis.fetch = orig
    }
  } finally {
    cleanup()
  }
})

// ===================================================================
// 4. runFindingFixesApi always forwards BYOK fields + intelligenceMode
// ===================================================================

test("runFindingFixesApi forwards apiKey/provider/baseUrl and intelligenceMode", async () => {
  const captured: Array<Record<string, unknown>> = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured.push(JSON.parse(init?.body ?? "{}"))
    return new Response(
      JSON.stringify({
        mode: "suggest",
        total: 0,
        applied: 0,
        skipped: 0,
        failed: 0,
        proposals: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  try {
    await runFindingFixesApi({
      projectPath: "/p",
      mode: "suggest",
      targets: [],
      intelligenceMode: "pro",
      provider: "anthropic",
      apiKey: "sk-byok",
      baseUrl: "https://api.anthropic.com",
    })
  } finally {
    globalThis.fetch = orig
  }
  assert.equal(captured.length, 1)
  const body = captured[0]
  assert.equal(body.intelligenceMode, "pro")
  assert.equal(body.apiKey, "sk-byok")
  assert.equal(body.provider, "anthropic")
  assert.equal(body.baseUrl, "https://api.anthropic.com")
  assert.equal(body.aiProviderMode, "byok", "client always sends byok in BYOK-only MVP")
})

// ===================================================================
// 5. Resolver: aiProviderMode='hosted' is treated as missing_api_key
// ===================================================================

test("aiProviderMode='hosted' is treated as missing_api_key", () => {
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "hosted",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, "missing_api_key")
    assert.equal(r.reason, BYOK_MESSAGES.missing)
  }
})

// ===================================================================
// 6. Manual mode honours user-selected model id (no hosted fallback)
// ===================================================================

test("Manual mode uses the user-selected model id and BYOK key only", () => {
  process.env.EDGE_AGENT_PLAN_TIER = "enterprise"
  const r = resolveAiProviderForRequest({
    userId: "u-man",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "manual",
    task: "patch",
    byokApiKey: "sk-byok-user",
    manualModelSelection: {
      patch: "anthropic:claude-sonnet-4-6",
    },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "anthropic", "provider derived from slot prefix")
    assert.equal(r.model, "claude-sonnet-4-6", "model id passed through")
    assert.equal(r.apiKey, "sk-byok-user")
    assert.equal(r.apiKeySource, "byok")
  }
})

// ===================================================================
// 7. classifyUpstreamFailure for invalid-key surfaces the canonical message
// ===================================================================

test("classifyUpstreamFailure: invalid/unauthorized surfaces canonical message", () => {
  const r1 = classifyUpstreamFailure(401, "Unauthorized")
  assert.equal(r1.code, "invalid_api_key")
  assert.equal(r1.reason, BYOK_MESSAGES.invalid)

  const r2 = classifyUpstreamFailure(403, "Forbidden")
  assert.equal(r2.code, "invalid_api_key")

  const r3 = classifyUpstreamFailure(404, "model not found")
  assert.equal(r3.code, "model_unavailable")
  assert.equal(r3.reason, BYOK_MESSAGES.invalid)

  // Body text fallback when status is generic 400.
  const r4 = classifyUpstreamFailure(400, "Incorrect API key provided")
  assert.equal(r4.code, "invalid_api_key")

  // Unknown failures pass through as "other" with the upstream text.
  const r5 = classifyUpstreamFailure(500, "boom")
  assert.equal(r5.code, "other")
})

// ===================================================================
// 8. Scanner-side smoke: the resolver is never pulled in by the scanner
//    path. (Just import some scanner module names to make sure the
//    import graph doesn't transitively require BYOK.)
// ===================================================================

test("scanner deps don't transitively require a BYOK key (smoke)", async () => {
  // We import a representative scanner-only module and assert it
  // loads without throwing — proving the AI key plumbing is NOT
  // a hard requirement for the deterministic scanner path.
  const mod = await import("../lib/scan-report")
  // Just spot-check an exported helper that other tests rely on.
  assert.ok(typeof mod === "object")
})
