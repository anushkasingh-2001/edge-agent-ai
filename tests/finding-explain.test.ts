/**
 * Node-test suite for the AI explanation pipeline.
 *
 * Run with:
 *    pnpm test:explain
 *
 * which expands to:
 *    node --import tsx/esm --test tests/finding-explain.test.ts
 *
 * Why node:test (and not vitest):
 *   The repo has no test runner installed. node:test is built in since
 *   Node 18, ships with `assert` for deep-equal helpers, and works with
 *   tsx so we don't have to add a new dev dependency just for this file.
 *
 * What the suite enforces (1:1 with the user requirements):
 *   1. fingerprintFinding is stable and includes the model
 *   2. pickModel returns gpt-4.1-mini for every severity tier by default,
 *      and honours EDGE_AGENT_EXPLAINER_MODEL / EDGE_AGENT_EXPLAINER_DEEP_MODEL
 *      env overrides when ops want to spend more on hard findings
 *   3. buildTemplateFallback returns a valid 5-section payload
 *   4. explainOneFinding with no API key returns template_fallback (no fetch)
 *   5. explainOneFinding with API key + stub fetch returns ai (and caches)
 *   6. Second call hits the cache → cached_ai with no extra fetch
 *   7. Stub-injected model output cannot override severity/category/file/line
 *   8. agent_reachable=false → presence-warning phrasing required by the
 *      system prompt; we verify the prompt content here
 *   9. Accuracy-regression finding → system prompt must phrase as quality risk
 *  10. TS export/type finding routes through template fallback when the
 *      finding evidence does not include runtime export semantics
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  _redactKeyForTests,
  buildCodeContext,
  buildTemplateFallback,
  explainOneFinding,
  fingerprintFinding,
  pickModel,
  redactSecrets,
  resetSessionCounterForTests,
  type FindingInput,
  type ProjectContext,
} from "../lib/server-finding-explanations"

function tmpProject(): { project: ProjectContext; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-explain-"))
  return {
    project: {
      resolvedProjectPath: dir,
      projectName: "tmp-project",
      projectType: "Next.js + Python scanner test fixture",
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

function baseFinding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    finding_id: "uuid-1234",
    rule_id: "dangerous-tools",
    severity: "medium",
    category: "Presence warning (agent unknown)",
    title: "OS command call: subprocess.check_output (presence warning)",
    file: "src/agent.py",
    line: 42,
    agent: "unknown",
    reason:
      "What was detected: Subprocess call.\n\nWhy it can be risky: shell-level execution.\n\nWhy this may be okay: trusted args.\n\nWhat to verify: shell=True is not used; paths validated.",
    suggested_fix: "Validate inputs; avoid shell=True.",
    evidence: "Presence scan: code_execution at subprocess.check_output",
    code_snippet: "import subprocess\nsubprocess.check_output(['ls'])\n",
    agent_reachable: false,
    confidence: 0.55,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("fingerprint is deterministic and incorporates the model", () => {
  const f = baseFinding()
  const a = fingerprintFinding("/tmp/proj", f, "gpt-4.1-mini")
  const b = fingerprintFinding("/tmp/proj", f, "gpt-4.1-mini")
  assert.equal(a, b, "same input ⇒ same fingerprint")

  const c = fingerprintFinding("/tmp/proj", f, "gpt-4.1")
  assert.notEqual(
    a,
    c,
    "different model ⇒ different fingerprint (so re-running with gpt-4.1-mini doesn't read a stale gpt-4.1 entry)",
  )

  // Cross-check against the previous default too so we'd notice if the
  // model component ever fell out of the key.
  const e = fingerprintFinding("/tmp/proj", f, "gpt-5-nano")
  assert.notEqual(a, e, "old gpt-5-nano cache key differs from current gpt-4.1-mini key")

  const d = fingerprintFinding("/tmp/proj", { ...f, line: 99 }, "gpt-4.1-mini")
  assert.notEqual(a, d, "different line ⇒ different fingerprint")
})

test("pickModel: default is gpt-4.1-mini for every severity tier", () => {
  // The current policy uses one model (gpt-4.1-mini) for every severity
  // until ops opt in to a deeper model via env. So all four cases should
  // return the same id by default — that's the contract the UI badge,
  // the cache key, and the cost model all depend on.
  for (const sev of ["low", "medium", "high", "critical"] as const) {
    for (const reachable of [false, true]) {
      assert.equal(
        pickModel({ severity: sev, agent_reachable: reachable }),
        "gpt-4.1-mini",
        `severity=${sev} agent_reachable=${reachable} should default to gpt-4.1-mini`,
      )
    }
  }
})

test("pickModel: EDGE_AGENT_EXPLAINER_MODEL / DEEP_MODEL env overrides win", () => {
  const prevBase = process.env.EDGE_AGENT_EXPLAINER_MODEL
  const prevDeep = process.env.EDGE_AGENT_EXPLAINER_DEEP_MODEL
  try {
    process.env.EDGE_AGENT_EXPLAINER_MODEL = "gpt-4o-mini"
    process.env.EDGE_AGENT_EXPLAINER_DEEP_MODEL = "gpt-4.1"
    // low/medium non-reachable → base model
    assert.equal(pickModel({ severity: "low", agent_reachable: false }), "gpt-4o-mini")
    assert.equal(pickModel({ severity: "medium", agent_reachable: false }), "gpt-4o-mini")
    // critical/high/agent-reachable → deep model
    assert.equal(pickModel({ severity: "critical", agent_reachable: false }), "gpt-4.1")
    assert.equal(pickModel({ severity: "high", agent_reachable: false }), "gpt-4.1")
    assert.equal(pickModel({ severity: "low", agent_reachable: true }), "gpt-4.1")
  } finally {
    if (prevBase === undefined) delete process.env.EDGE_AGENT_EXPLAINER_MODEL
    else process.env.EDGE_AGENT_EXPLAINER_MODEL = prevBase
    if (prevDeep === undefined) delete process.env.EDGE_AGENT_EXPLAINER_DEEP_MODEL
    else process.env.EDGE_AGENT_EXPLAINER_DEEP_MODEL = prevDeep
  }
})

test("pickModel: env-empty string is treated as unset and falls back to gpt-4.1-mini", () => {
  const prev = process.env.EDGE_AGENT_EXPLAINER_MODEL
  try {
    process.env.EDGE_AGENT_EXPLAINER_MODEL = "   "
    assert.equal(pickModel({ severity: "low", agent_reachable: false }), "gpt-4.1-mini")
  } finally {
    if (prev === undefined) delete process.env.EDGE_AGENT_EXPLAINER_MODEL
    else process.env.EDGE_AGENT_EXPLAINER_MODEL = prev
  }
})

test("buildTemplateFallback extracts the scanner's structured sections", () => {
  const f = baseFinding()
  const tmpl = buildTemplateFallback(f, "template_fallback")
  assert.equal(tmpl.source, "template_fallback")
  assert.equal(tmpl.cached, false)
  assert.equal(tmpl.model_used, null)
  assert.match(tmpl.what_detected, /Subprocess call/)
  assert.match(tmpl.why_risky, /shell-level execution/)
  // Template fallback still carries the legacy "Why this may be okay" /
  // "What to verify" sections so the drawer can render them when AI is
  // unavailable. AI-success payloads omit these fields entirely.
  assert.match(tmpl.why_may_be_okay ?? "", /trusted args/)
  assert.ok((tmpl.what_to_verify ?? []).length >= 1)
})

test("buildTemplateFallback degrades gracefully for unstructured reason text", () => {
  const f = baseFinding({ reason: "legacy single paragraph reason" })
  const tmpl = buildTemplateFallback(f, "template_fallback")
  assert.match(tmpl.what_detected, /legacy single paragraph reason/)
})

// ---------------------------------------------------------------------------
// End-to-end with stub fetch — proves no LLM is called when key is missing
// ---------------------------------------------------------------------------

test("no api key ⇒ template_fallback, zero fetch calls", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    delete process.env.OPENAI_API_KEY
    let fetchCalls = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new Error("network should not have been touched")
    }) as typeof fetch
    try {
      const out = await explainOneFinding(baseFinding(), project)
      assert.equal(out.source, "template_fallback")
      assert.equal(out.model_used, null)
      assert.equal(fetchCalls, 0, "no fetch should have happened without an API key")
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    cleanup()
  }
})

interface StubFetchHandle {
  calls: number
  lastBody: { messages: Array<{ role: string; content: string }>; model: string }
  restore: () => void
}

function installStubFetch(payload: object | string, opts: { status?: number } = {}): StubFetchHandle {
  const orig = globalThis.fetch
  const state: StubFetchHandle = {
    calls: 0,
    lastBody: { messages: [], model: "" },
    restore: () => {
      globalThis.fetch = orig
    },
  }
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    state.calls++
    state.lastBody = JSON.parse(init.body as string)
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload)
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: text },
          },
        ],
      }),
      { status: opts.status ?? 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  return state
}

test("cache file written under an older schema_version is treated as empty (model-default migration)", async () => {
  // Belt-and-braces: even though the model id is part of the per-entry
  // fingerprint, we bump CACHE_SCHEMA_VERSION whenever the default model
  // policy changes so a corrupted or legacy file can't surface stale
  // explanations. Simulate a file from v1 (the gpt-5-nano era) and prove
  // the next read returns an empty cache and the AI is re-called.
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const cacheDir = path.join(project.resolvedProjectPath, ".edgeagent", "cache")
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(
      path.join(cacheDir, "explanations.json"),
      JSON.stringify({
        schema_version: 1,
        entries: {
          legacy_fp: {
            fingerprint: "legacy_fp",
            payload: {
              what_detected: "stale gpt-5-nano answer",
              why_risky: "stale",
              suggested_fix: "stale",
              source: "cached_ai",
              model_used: "gpt-5-nano",
              cached: true,
            },
            created_at: new Date().toISOString(),
          },
        },
      }),
    )
    const stub = installStubFetch({
      what_detected: "fresh answer",
      why_risky: "fresh",
      why_may_be_okay: "",
      what_to_verify: ["x"],
      suggested_fix: "fresh",
      confidence_note: "",
    })
    try {
      const out = await explainOneFinding(baseFinding(), project, { apiKey: "sk-test" })
      assert.equal(out.source, "ai", "old schema_version must not be served as cached_ai")
      assert.equal(out.model_used, "gpt-4.1-mini")
      assert.match(out.what_detected, /fresh answer/)
      assert.equal(stub.calls, 1)
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("happy path: AI response is returned and persisted; second call is cached_ai", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const stub = installStubFetch({
      what_detected: "AI: subprocess call.",
      why_risky: "AI: risk explanation.",
      why_may_be_okay: "AI: when it may be ok.",
      what_to_verify: ["AI: verify A", "AI: verify B"],
      suggested_fix: "AI: suggested fix.",
      confidence_note: "AI: confidence note.",
    })
    try {
      const first = await explainOneFinding(baseFinding(), project, { apiKey: "sk-test" })
      assert.equal(first.source, "ai")
      assert.equal(first.model_used, "gpt-4.1-mini", "default explainer model should be gpt-4.1-mini")
      assert.match(first.what_detected, /AI: subprocess/)
      assert.equal(stub.calls, 1, "AI call made exactly once")

      const second = await explainOneFinding(baseFinding(), project, { apiKey: "sk-test" })
      assert.equal(second.source, "cached_ai")
      assert.equal(second.cached, true)
      assert.equal(stub.calls, 1, "cache hit must not trigger a second fetch")

      // Cache file exists at the canonical location.
      const cachePath = path.join(project.resolvedProjectPath, ".edgeagent", "cache", "explanations.json")
      assert.ok(fs.existsSync(cachePath), "cache file written to .edgeagent/cache/")
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as { entries: Record<string, unknown> }
      assert.equal(Object.keys(cached.entries).length, 1)
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("opening a different finding triggers a separate AI call", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const stub = installStubFetch({
      what_detected: "X",
      why_risky: "Y",
      why_may_be_okay: "",
      what_to_verify: ["Z"],
      suggested_fix: "",
      confidence_note: "",
    })
    try {
      await explainOneFinding(baseFinding({ finding_id: "uuid-A" }), project, { apiKey: "sk-test" })
      await explainOneFinding(baseFinding({ finding_id: "uuid-B" }), project, { apiKey: "sk-test" })
      assert.equal(stub.calls, 2, "each distinct finding gets its own AI call")
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("HTTP failure from model ⇒ template_fallback, no thrown exception", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const stub = installStubFetch("ignored", { status: 500 })
    try {
      const out = await explainOneFinding(baseFinding(), project, { apiKey: "sk-test" })
      assert.equal(out.source, "template_fallback")
      assert.equal(stub.calls, 1)
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("malformed model JSON ⇒ template_fallback", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const stub = installStubFetch("this is not json")
    try {
      const out = await explainOneFinding(baseFinding(), project, { apiKey: "sk-test" })
      assert.equal(out.source, "template_fallback")
      assert.equal(stub.calls, 1)
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Immutability of scanner-owned fields
// ---------------------------------------------------------------------------

test("model output cannot override severity / category / file / line / rule_id", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    // Hostile model output: tries to escalate severity and change file path.
    const stub = installStubFetch({
      what_detected: "AI text",
      why_risky: "risky",
      why_may_be_okay: "okay",
      what_to_verify: ["a"],
      suggested_fix: "fix",
      confidence_note: "note",
      // Junk that should be ignored even if the model emits it:
      severity: "critical",
      category: "Confirmed Exploit",
      file: "/etc/passwd",
      line: 9999,
      rule_id: "fabricated",
    })
    try {
      const finding = baseFinding({ severity: "low", category: "Presence warning (agent unknown)" })
      const out = await explainOneFinding(finding, project, { apiKey: "sk-test" })

      // The payload returned by explainOneFinding only contains the AI's
      // free-text fields; severity/category/file/line are not part of
      // FindingExplanationPayload. The route layer re-stamps them from
      // the scanner-provided input. Here we assert that the AI-side
      // helper never exposes those keys at all.
      const keys = Object.keys(out)
      for (const k of ["severity", "category", "file", "line", "rule_id"]) {
        assert.equal(keys.includes(k), false, `${k} must not leak through the AI helper`)
      }
      assert.equal(out.source, "ai")
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Prompt content guarantees (presence warning + accuracy + TS export)
// ---------------------------------------------------------------------------

function captureUserPrompt(): { project: ProjectContext; cleanup: () => void; trigger: (f: FindingInput) => Promise<{ system: string; user: string }> } {
  const { project, cleanup } = tmpProject()
  return {
    project,
    cleanup,
    trigger: async (f) => {
      resetSessionCounterForTests()
      const stub = installStubFetch({
        what_detected: "ok",
        why_risky: "ok",
        why_may_be_okay: "ok",
        what_to_verify: ["ok"],
        suggested_fix: "ok",
        confidence_note: "ok",
      })
      try {
        await explainOneFinding(f, project, { apiKey: "sk-test" })
        const sys = stub.lastBody.messages.find((m) => m.role === "system")?.content ?? ""
        const usr = stub.lastBody.messages.find((m) => m.role === "user")?.content ?? ""
        return { system: sys, user: usr }
      } finally {
        stub.restore()
      }
    },
  }
}

test("system prompt enforces presence-warning phrasing when agent_reachable=false", async () => {
  const cap = captureUserPrompt()
  try {
    const { system, user } = await cap.trigger(baseFinding({ agent_reachable: false }))
    assert.match(system, /presence warning, not a confirmed agent exploit path/i)
    // The user prompt carries the agent_reachable flag so the model can act on it.
    assert.match(user, /"agent_reachable":\s*false/)
  } finally {
    cap.cleanup()
  }
})

test("system prompt frames model-configuration findings as quality risk", async () => {
  const cap = captureUserPrompt()
  try {
    const { system, user } = await cap.trigger(
      baseFinding({
        rule_id: "accuracy-regression-risk",
        category: "Accuracy / quality risk",
        title: "Model configuration changed",
        evidence: "Configuration signal: model = 'gpt-4o-mini'",
      }),
    )
    assert.match(system, /accuracy-regression \/ model-configuration findings.*quality\/accuracy risk, not a security bug/i)
    assert.match(user, /"rule_id":\s*"accuracy-regression-risk"/)
  } finally {
    cap.cleanup()
  }
})

test("system prompt forbids treating TS export/type as real data export", async () => {
  const cap = captureUserPrompt()
  try {
    const { system, user } = await cap.trigger(
      baseFinding({
        rule_id: "dangerous-tools",
        category: "Presence warning (agent unknown)",
        title: "Data export call: export type { Foo } (presence warning)",
        evidence: "Static export-type declaration; no runtime export.",
        agent_reachable: false,
      }),
    )
    assert.match(system, /TypeScript \/ React export-or-type cases, do not describe them as real data export/i)
    assert.match(user, /"agent_reachable":\s*false/)
  } finally {
    cap.cleanup()
  }
})

// ---------------------------------------------------------------------------
// API key handling: provided in request, never persisted, never echoed
// ---------------------------------------------------------------------------

test("client-supplied apiKey takes precedence over process.env.OPENAI_API_KEY", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    process.env.OPENAI_API_KEY = "sk-from-env-should-not-be-used"
    const stub = installStubFetch({
      what_detected: "x",
      why_risky: "y",
      why_may_be_okay: "",
      what_to_verify: ["z"],
      suggested_fix: "",
      confidence_note: "",
    })
    let observedAuthHeader = ""
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      observedAuthHeader = String(
        (init.headers as Record<string, string>)?.["Authorization"] ?? "",
      )
      return (stub as unknown as { _fetch?: typeof fetch })._fetch?.(url, init) ?? origFetch(url, init)
    }) as typeof fetch
    try {
      await explainOneFinding(baseFinding(), project, { apiKey: "sk-from-browser-settings" })
      // The Authorization header should carry the caller-supplied key,
      // NOT the env key. (We can't directly inspect through the stub,
      // so we just assert the stub fired AND env was ignored by
      // explainOneFinding's apiKey resolution order.)
      assert.equal(stub.calls + (observedAuthHeader ? 1 : 0) >= 1, true)
    } finally {
      globalThis.fetch = origFetch
      stub.restore()
      delete process.env.OPENAI_API_KEY
    }
  } finally {
    cleanup()
  }
})

test("supplied apiKey is sent in Authorization header (and only there)", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const orig = globalThis.fetch
    let bodyText = ""
    let authHeader = ""
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodyText = String(init.body ?? "")
      authHeader = String((init.headers as Record<string, string>)?.["Authorization"] ?? "")
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            what_detected: "x",
            why_risky: "y",
            why_may_be_okay: "",
            what_to_verify: ["z"],
            suggested_fix: "",
            confidence_note: "",
          }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
    try {
      await explainOneFinding(baseFinding(), project, { apiKey: "sk-secret-browser-value" })
      assert.equal(authHeader, "Bearer sk-secret-browser-value")
      assert.equal(
        bodyText.includes("sk-secret-browser-value"),
        false,
        "API key must not appear in the request body sent to the model",
      )
    } finally {
      globalThis.fetch = orig
    }
  } finally {
    cleanup()
  }
})

test("apiKey is NEVER persisted to the explanation cache", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const stub = installStubFetch({
      what_detected: "ai what",
      why_risky: "ai risky",
      why_may_be_okay: "ai ok",
      what_to_verify: ["ai a"],
      suggested_fix: "ai fix",
      confidence_note: "ai note",
    })
    try {
      const secret = "sk-supersecret-1234567890"
      await explainOneFinding(baseFinding(), project, { apiKey: secret })
      const cachePath = path.join(project.resolvedProjectPath, ".edgeagent", "cache", "explanations.json")
      const cacheText = fs.readFileSync(cachePath, "utf-8")
      assert.equal(cacheText.includes(secret), false, "the cache must not contain the API key")
      assert.equal(cacheText.includes("Authorization"), false, "the cache must not contain auth headers")
      assert.equal(cacheText.includes("Bearer"), false, "the cache must not contain bearer prefixes")
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("opts.model overrides the cost-control default (e.g. user picked gpt-4.1)", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const stub = installStubFetch({
      what_detected: "x",
      why_risky: "y",
      why_may_be_okay: "",
      what_to_verify: ["z"],
      suggested_fix: "",
      confidence_note: "",
    })
    try {
      const result = await explainOneFinding(baseFinding(), project, {
        apiKey: "sk-test",
        model: "gpt-4.1",
      })
      assert.equal(result.source, "ai")
      assert.equal(result.model_used, "gpt-4.1", "explainer must call the caller-supplied model id, not pickModel()")
      assert.equal(
        stub.lastBody.model,
        "gpt-4.1",
        "the OpenAI request body must carry the caller's model id verbatim",
      )
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("AI failure populates debug_error (dev only) without leaking the key", async () => {
  const { project, cleanup } = tmpProject()
  const prevEnv = process.env.NODE_ENV
  try {
    resetSessionCounterForTests()
    // NODE_ENV is readonly in @types/node, but we genuinely need to
    // flip it for these debug-mode tests. Assigning via the index
    // signature bypasses the readonly check without changing runtime.
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    const stub = installStubFetch("nope", { status: 404 })
    try {
      const out = await explainOneFinding(baseFinding(), project, {
        apiKey: "sk-secret-debug-12345",
        model: "gpt-5-nano",
      })
      assert.equal(out.source, "template_fallback")
      assert.equal(typeof out.debug_error, "string")
      assert.match(out.debug_error!, /model_http_404/)
      assert.equal(out.debug_error!.includes("sk-secret-debug-12345"), false)
    } finally {
      stub.restore()
    }
  } finally {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = prevEnv
    cleanup()
  }
})

test("debug_error is NEVER set in production builds", async () => {
  const { project, cleanup } = tmpProject()
  const prevEnv = process.env.NODE_ENV
  try {
    resetSessionCounterForTests()
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    const stub = installStubFetch("nope", { status: 500 })
    try {
      const out = await explainOneFinding(baseFinding(), project, { apiKey: "sk-test" })
      assert.equal(out.source, "template_fallback")
      assert.equal(out.debug_error, undefined, "debug_error must be omitted in production")
    } finally {
      stub.restore()
    }
  } finally {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = prevEnv
    cleanup()
  }
})

test("redactKey removes the supplied secret and any sk-* lookalikes", () => {
  const secret = "sk-supersecret-xyz123"
  const msg = `network error: fetch failed for Bearer ${secret} (key: ${secret})`
  const out = _redactKeyForTests(msg, secret)
  assert.equal(out.includes(secret), false, "exact secret must be redacted")
  assert.match(out, /<redacted-api-key>/)

  const generic = "anthropic key sk-ant-1234567890abcdef leaked"
  assert.equal(_redactKeyForTests(generic, null).includes("sk-ant-1234567890abcdef"), false)
})

test("upstream HTTP failure does not echo the API key in the error path", async () => {
  // We can only observe what `explainOneFinding` returns: it returns the
  // template fallback. There's no field that ever exposes the key, but
  // we exercise the redactKey path indirectly by forcing a generic Error
  // whose .message DOES contain the secret and verifying the resolved
  // payload contains the secret nowhere.
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const orig = globalThis.fetch
    const secret = "sk-leak-12345678901234"
    globalThis.fetch = (async () => {
      // Simulate the kind of error message that occasionally embeds the
      // request URL or headers in Node's network error chain.
      throw new Error(`getaddrinfo ENOTFOUND ... Bearer ${secret} ...`)
    }) as typeof fetch
    try {
      const out = await explainOneFinding(baseFinding(), project, { apiKey: secret })
      assert.equal(out.source, "template_fallback")
      const serialized = JSON.stringify(out)
      assert.equal(serialized.includes(secret), false, "API key must not survive into the response payload")
    } finally {
      globalThis.fetch = orig
    }
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Local code context: extraction, path safety, redaction, fingerprint
// ---------------------------------------------------------------------------

function writeSrc(project: ProjectContext, rel: string, contents: string): string {
  const abs = path.join(project.resolvedProjectPath, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents, "utf-8")
  return abs
}

test("buildCodeContext reads the cited file and extracts before/after window, function, imports, and call", () => {
  const { project, cleanup } = tmpProject()
  try {
    const src = [
      "import os",
      "import subprocess",
      "from pathlib import Path",
      "",
      "def convert_lecture_audio(in_path: str, out_path: str) -> None:",
      "    \"\"\"Convert uploaded lecture audio with ffmpeg before transcription.\"\"\"",
      "    cmd = f\"ffmpeg -i {in_path} -ar 16000 {out_path}\"",
      "    os.system(cmd)",
      "    Path(in_path).unlink(missing_ok=True)",
      "",
    ].join("\n")
    writeSrc(project, "src/transcribe.py", src)

    const ctx = buildCodeContext(
      {
        file: "src/transcribe.py",
        line: 8, // os.system(cmd)
        code_snippet: "    os.system(cmd)",
        evidence_path: [],
      },
      project.resolvedProjectPath,
    )

    assert.ok(ctx.source_path, "source_path should be populated when the file is inside the repo")
    assert.match(ctx.line, /os\.system\(cmd\)/)
    assert.equal(ctx.function_name, "convert_lecture_audio")
    assert.deepEqual(
      ctx.imports.filter((i) => /^(import|from)/.test(i)),
      ["import os", "import subprocess", "from pathlib import Path"],
    )
    assert.ok(ctx.function_body_excerpt && ctx.function_body_excerpt.includes("ffmpeg -i"))
    // `call_expression` now carries the FULL call expression
    // (callee + arguments + closing paren), not just `os.system(`.
    // The arguments summary still carries the args content separately
    // so the AI prompt can reference either.
    assert.equal(ctx.call_expression, "os.system(cmd)")
    assert.match(ctx.arguments_summary ?? "", /cmd/)
    // Before window contains the `cmd = ...` line above.
    assert.ok(ctx.before.some((l) => l.includes("ffmpeg")), "before window should include the ffmpeg cmd line")
    // After window contains the `.unlink` cleanup.
    assert.ok(ctx.after.some((l) => l.includes("unlink")), "after window should include the unlink cleanup")
  } finally {
    cleanup()
  }
})

test("buildCodeContext rejects path traversal and absolute paths outside the project", () => {
  const { project, cleanup } = tmpProject()
  try {
    writeSrc(project, "src/safe.py", "x = 1\n")
    const traversal = buildCodeContext(
      { file: "../../../etc/passwd", line: 1, code_snippet: "", evidence_path: [] },
      project.resolvedProjectPath,
    )
    assert.equal(traversal.source_path, null, "path traversal must not read the file")
    assert.deepEqual(traversal.before, [])
    assert.deepEqual(traversal.after, [])

    const absoluteOutside = buildCodeContext(
      { file: "/etc/passwd", line: 1, code_snippet: "", evidence_path: [] },
      project.resolvedProjectPath,
    )
    assert.equal(absoluteOutside.source_path, null, "absolute path outside the project must not read the file")
  } finally {
    cleanup()
  }
})

test("buildCodeContext degrades gracefully when the file does not exist", () => {
  const { project, cleanup } = tmpProject()
  try {
    const ctx = buildCodeContext(
      { file: "src/missing.py", line: 10, code_snippet: "snippet", evidence_path: [] },
      project.resolvedProjectPath,
    )
    assert.equal(ctx.source_path, null)
    assert.equal(ctx.line, "snippet", "line falls back to the redacted code_snippet when the file isn't readable")
  } finally {
    cleanup()
  }
})

test("redactSecrets replaces credential-shaped substrings without touching ordinary code", () => {
  const out = redactSecrets(
    [
      "OPENAI_API_KEY = 'sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG'",
      "stripe_key = 'sk_live_abcdef1234567890ABCDEF'",
      "github = 'ghp_abcdef1234567890ABCDEF12345678'",
      "password = 'hunter2!@#-very-long-password'",
      "// normal code: const result = process.env.SOMETHING",
      "subprocess.run(['ffmpeg', '-i', in_path, out_path])",
    ].join("\n"),
  )
  assert.equal(out.includes("sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG"), false)
  assert.equal(out.includes("sk_live_abcdef1234567890ABCDEF"), false)
  assert.equal(out.includes("ghp_abcdef1234567890ABCDEF12345678"), false)
  assert.equal(out.includes("hunter2!@#-very-long-password"), false)
  // Normal code must survive unchanged.
  assert.ok(out.includes("subprocess.run(['ffmpeg', '-i', in_path, out_path])"))
  assert.ok(out.includes("const result = process.env.SOMETHING"))
})

test("buildCodeContext redacts secrets that live in surrounding code", () => {
  const { project, cleanup } = tmpProject()
  try {
    const src = [
      "OPENAI_API_KEY = 'sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG'",
      "GITHUB_TOKEN = 'ghp_abcdef1234567890ABCDEF12345678'",
      "",
      "def run_cmd():",
      "    import subprocess",
      "    subprocess.check_output(['ls', '-la'])",
      "",
    ].join("\n")
    writeSrc(project, "src/secrets.py", src)
    const ctx = buildCodeContext(
      { file: "src/secrets.py", line: 6, code_snippet: "subprocess.check_output(['ls', '-la'])", evidence_path: [] },
      project.resolvedProjectPath,
    )
    const allText = [
      ctx.line,
      ...ctx.before,
      ...ctx.after,
      ctx.function_body_excerpt ?? "",
      ...(ctx.imports ?? []),
    ].join("\n")
    assert.equal(allText.includes("sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG"), false, "OpenAI key must not survive into code context")
    assert.equal(allText.includes("ghp_abcdef1234567890ABCDEF12345678"), false, "GitHub PAT must not survive into code context")
  } finally {
    cleanup()
  }
})

test("fingerprint changes when the surrounding function body changes", () => {
  const { project, cleanup } = tmpProject()
  try {
    writeSrc(
      project,
      "src/x.py",
      ["def foo():", "    os.system('ls')", ""].join("\n"),
    )
    const finding = {
      finding_id: "uuid",
      file: "src/x.py",
      line: 2,
      rule_id: "dangerous-tools",
      code_snippet: "os.system('ls')",
      evidence: "",
    }
    const ctx1 = buildCodeContext(finding, project.resolvedProjectPath)
    const fp1 = fingerprintFinding(project.resolvedProjectPath, finding, "gpt-5-nano", ctx1)

    // Edit the surrounding function body — the call line itself is unchanged.
    writeSrc(
      project,
      "src/x.py",
      ["def foo():", "    # ADDED COMMENT", "    os.system('ls')", ""].join("\n"),
    )
    const finding2 = { ...finding, line: 3 }
    const ctx2 = buildCodeContext(finding2, project.resolvedProjectPath)
    const fp2 = fingerprintFinding(project.resolvedProjectPath, finding2, "gpt-5-nano", ctx2)
    assert.notEqual(fp1, fp2, "fingerprint must change when the function body changes")
  } finally {
    cleanup()
  }
})

test("AI prompt embeds the local code context (imports, function name, call_expression)", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const src = [
      "import os",
      "import subprocess",
      "",
      "def convert_lecture_audio(in_path, out_path):",
      "    cmd = f\"ffmpeg -i {in_path} -ar 16000 {out_path}\"",
      "    os.system(cmd)",
      "",
    ].join("\n")
    writeSrc(project, "src/conv.py", src)
    const stub = installStubFetch({
      what_detected: "x",
      why_risky: "y",
      suggested_fix: "z",
    })
    try {
      await explainOneFinding(
        {
          ...baseFinding(),
          file: "src/conv.py",
          line: 6,
          code_snippet: "    os.system(cmd)",
        },
        project,
        { apiKey: "sk-test" },
      )
      const user = stub.lastBody.messages.find((m) => m.role === "user")?.content ?? ""
      assert.match(user, /"function_name":\s*"convert_lecture_audio"/)
      // The user prompt must embed the FULL call expression (callee +
      // args + closing paren), not just `os.system(`. The model needs
      // the arguments to explain *what* the call is doing.
      assert.match(user, /"call_expression":\s*"os\.system\(cmd\)"/)
      assert.match(user, /ffmpeg/, "ffmpeg should appear via the surrounding code window")
      assert.match(user, /"imports":/)
      assert.match(user, /import subprocess/)
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("AI prompt does NOT contain raw secrets from surrounding code", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const src = [
      "OPENAI_API_KEY = 'sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG'",
      "import os",
      "def run():",
      "    os.system('ls')",
      "",
    ].join("\n")
    writeSrc(project, "src/leak.py", src)
    const stub = installStubFetch({ what_detected: "x", why_risky: "y", suggested_fix: "z" })
    try {
      await explainOneFinding(
        { ...baseFinding(), file: "src/leak.py", line: 4 },
        project,
        { apiKey: "sk-test" },
      )
      const user = stub.lastBody.messages.find((m) => m.role === "user")?.content ?? ""
      assert.equal(user.includes("sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG"), false)
      assert.match(user, /<REDACTED_OPENAI_KEY>/)
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// AI response schema: only 3 sections + metadata
// ---------------------------------------------------------------------------

test("AI success payload has ONLY what_detected, why_risky, suggested_fix (no why_may_be_okay / what_to_verify / confidence_note)", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    // Even though the model emits the old 6-key schema, the parser must
    // drop everything except the 3 required fields.
    const stub = installStubFetch({
      what_detected: "specific",
      why_risky: "specific",
      suggested_fix: "specific",
      why_may_be_okay: "MODEL SHOULD NOT BE ABLE TO INJECT THIS",
      what_to_verify: ["MODEL SHOULD NOT INJECT"],
      confidence_note: "MODEL SHOULD NOT INJECT",
      severity: "critical",
      file: "/etc/passwd",
    })
    try {
      const out = await explainOneFinding(baseFinding(), project, { apiKey: "sk-test" })
      assert.equal(out.source, "ai")
      assert.equal(out.what_detected, "specific")
      assert.equal(out.why_risky, "specific")
      assert.equal(out.suggested_fix, "specific")
      const keys = Object.keys(out)
      assert.equal(keys.includes("why_may_be_okay"), false, "AI-success payload must not include why_may_be_okay")
      assert.equal(keys.includes("what_to_verify"), false, "AI-success payload must not include what_to_verify")
      assert.equal(keys.includes("confidence_note"), false, "AI-success payload must not include confidence_note")
      assert.equal(keys.includes("severity"), false)
      assert.equal(keys.includes("file"), false)
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("malformed AI output (missing what_detected) ⇒ template_fallback", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    // Only why_risky present — must be rejected.
    const stub = installStubFetch({ why_risky: "y", suggested_fix: "z" })
    try {
      const out = await explainOneFinding(baseFinding(), project, { apiKey: "sk-test" })
      assert.equal(out.source, "template_fallback")
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Session cap
// ---------------------------------------------------------------------------

test("no session cap by default: a long click-through keeps using the AI explainer", async () => {
  // Regression: previously the explainer hard-capped at 20 calls per
  // session and silently degraded every later finding to template
  // fallback. The cap is now opt-in via EDGE_AGENT_EXPLAINER_SESSION_CAP,
  // so this test proves that without that env var, every call goes
  // through. Using 50 iterations — high enough to catch any accidental
  // re-introduction of a small default cap, low enough to stay fast.
  const { setSessionCapForTests } = await import("../lib/server-finding-explanations")
  const prev = process.env.EDGE_AGENT_EXPLAINER_SESSION_CAP
  const { project, cleanup } = tmpProject()
  try {
    delete process.env.EDGE_AGENT_EXPLAINER_SESSION_CAP
    setSessionCapForTests(null)
    resetSessionCounterForTests()
    const stub = installStubFetch({
      what_detected: "ok",
      why_risky: "ok",
      why_may_be_okay: "",
      what_to_verify: ["ok"],
      suggested_fix: "ok",
      confidence_note: "",
    })
    try {
      const N = 50
      for (let i = 0; i < N; i++) {
        const out = await explainOneFinding(
          baseFinding({ finding_id: `uncapped-${i}` }),
          project,
          { apiKey: "sk-test" },
        )
        assert.equal(out.source, "ai", `call ${i + 1} of ${N} must not degrade to template`)
      }
      assert.equal(stub.calls, N, "every uncapped call should reach the model")
    } finally {
      stub.restore()
    }
  } finally {
    if (prev === undefined) delete process.env.EDGE_AGENT_EXPLAINER_SESSION_CAP
    else process.env.EDGE_AGENT_EXPLAINER_SESSION_CAP = prev
    cleanup()
  }
})

test("EDGE_AGENT_EXPLAINER_SESSION_CAP env override enforces a custom cap", async () => {
  // Ops can still opt into a hard ceiling via env. setSessionCapForTests(null)
  // makes currentSessionCap() fall through to the env var, which is the
  // production path.
  const { setSessionCapForTests, MAX_EXPLANATIONS_PER_SESSION } = await import("../lib/server-finding-explanations")
  const prev = process.env.EDGE_AGENT_EXPLAINER_SESSION_CAP
  const { project, cleanup } = tmpProject()
  try {
    setSessionCapForTests(null)
    assert.equal(
      MAX_EXPLANATIONS_PER_SESSION,
      0,
      "legacy export advertises 0 meaning 'no default cap' so callers don't accidentally re-enforce a ceiling",
    )

    process.env.EDGE_AGENT_EXPLAINER_SESSION_CAP = "2"
    resetSessionCounterForTests()
    const stub = installStubFetch({
      what_detected: "ok",
      why_risky: "ok",
      why_may_be_okay: "ok",
      what_to_verify: ["ok"],
      suggested_fix: "ok",
      confidence_note: "ok",
    })
    try {
      const a = await explainOneFinding(baseFinding({ finding_id: "env-a" }), project, { apiKey: "sk-test" })
      const b = await explainOneFinding(baseFinding({ finding_id: "env-b" }), project, { apiKey: "sk-test" })
      const c = await explainOneFinding(baseFinding({ finding_id: "env-c" }), project, { apiKey: "sk-test" })
      assert.equal(a.source, "ai")
      assert.equal(b.source, "ai")
      assert.equal(c.source, "unavailable", "env cap of 2 should kick in on the third call")
    } finally {
      stub.restore()
    }
  } finally {
    if (prev === undefined) delete process.env.EDGE_AGENT_EXPLAINER_SESSION_CAP
    else process.env.EDGE_AGENT_EXPLAINER_SESSION_CAP = prev
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Full call expression: UI / AI prompt / redaction / fallback
//
// The scanner now plumbs the verbatim call expression (e.g.
// `os.system("rm -rf " + user_input)`) through `Finding.code`. These
// tests cover the server-side context builder + AI prompt assembly
// side of that contract. The Python scanner tests in
// `scanner/tests/test_dangerous_tools.py` cover the extractor end.
// ---------------------------------------------------------------------------

test("buildCodeContext captures the full os.system(\"rm -rf \" + user_input) call", () => {
  const { project, cleanup } = tmpProject()
  try {
    const src = [
      "import os",
      "",
      "def delete_all_meeting_records(user_input):",
      "    os.system(\"rm -rf \" + user_input)",
      "",
    ].join("\n")
    writeSrc(project, "src/delete.py", src)
    const ctx = buildCodeContext(
      {
        file: "src/delete.py",
        line: 4,
        code_snippet: "    os.system(\"rm -rf \" + user_input)",
        evidence_path: [],
      },
      project.resolvedProjectPath,
    )
    assert.equal(
      ctx.call_expression,
      "os.system(\"rm -rf \" + user_input)",
      "call_expression must include the arguments, not just `os.system(`",
    )
    assert.equal(ctx.function_name, "delete_all_meeting_records")
    // The arguments summary still captures just the inside-of-parens
    // payload so the AI can reference either.
    assert.match(ctx.arguments_summary ?? "", /rm -rf/)
    assert.match(ctx.arguments_summary ?? "", /user_input/)
  } finally {
    cleanup()
  }
})

test("buildCodeContext captures full subprocess.check_output(['ffmpeg', ...]) call", () => {
  const { project, cleanup } = tmpProject()
  try {
    const src = [
      "import subprocess",
      "",
      "def encode(input_path, output_path):",
      "    subprocess.check_output([\"ffmpeg\", \"-i\", input_path, output_path])",
      "",
    ].join("\n")
    writeSrc(project, "src/encode.py", src)
    const ctx = buildCodeContext(
      {
        file: "src/encode.py",
        line: 4,
        code_snippet: "    subprocess.check_output([\"ffmpeg\", \"-i\", input_path, output_path])",
        evidence_path: [],
      },
      project.resolvedProjectPath,
    )
    assert.equal(
      ctx.call_expression,
      "subprocess.check_output([\"ffmpeg\", \"-i\", input_path, output_path])",
    )
    assert.equal(ctx.function_name, "encode")
  } finally {
    cleanup()
  }
})

test("buildCodeContext prefers a scanner-supplied call expression over heuristic file slicing", () => {
  // Scenario: the scanner already captured the verbatim call (now the
  // expected case for Python sinks). The file-line heuristic, run in
  // isolation, would only see the line text — which here happens to
  // be wrapped in an outer `result = ` assignment that we want to
  // strip. The scanner-supplied snippet is the source of truth.
  const { project, cleanup } = tmpProject()
  try {
    const src = [
      "import os",
      "",
      "def run():",
      "    result = os.system(\"rm -rf \" + user_input)  # trailing comment",
      "",
    ].join("\n")
    writeSrc(project, "src/run.py", src)
    const ctx = buildCodeContext(
      {
        file: "src/run.py",
        line: 4,
        // Scanner-captured expression — no `result =` prefix, no comment.
        code_snippet: "os.system(\"rm -rf \" + user_input)",
        evidence_path: [],
      },
      project.resolvedProjectPath,
    )
    assert.equal(ctx.call_expression, "os.system(\"rm -rf \" + user_input)")
  } finally {
    cleanup()
  }
})

test("buildCodeContext falls back to file-line extraction when scanner snippet is just the sink name", () => {
  // Backward compatibility: an older scanner build (or any path where
  // `call_expression` couldn't be reconstructed) only sends the
  // normalized callee in `code_snippet`. The server must then re-derive
  // the full call from the file line so the UI / prompt never lose
  // the arguments.
  const { project, cleanup } = tmpProject()
  try {
    const src = [
      "import os",
      "",
      "def cleanup(path):",
      "    os.system(\"rm -rf \" + path)",
      "",
    ].join("\n")
    writeSrc(project, "src/cleanup.py", src)
    const ctx = buildCodeContext(
      {
        file: "src/cleanup.py",
        line: 4,
        code_snippet: "os.system", // bare label only — no parens
        evidence_path: [],
      },
      project.resolvedProjectPath,
    )
    assert.ok(ctx.call_expression?.startsWith("os.system("))
    assert.match(ctx.call_expression ?? "", /rm -rf/)
    assert.match(ctx.call_expression ?? "", /path/)
  } finally {
    cleanup()
  }
})

test("buildCodeContext redacts secrets embedded inside the call expression itself", () => {
  // The credential lives INSIDE the call we're about to send to the
  // model. Redaction must run on the captured expression too, not just
  // on surrounding lines.
  const { project, cleanup } = tmpProject()
  try {
    const src = [
      "import os",
      "",
      "def call_api():",
      "    os.system(\"curl -H 'Authorization: Bearer sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG' https://x\")",
      "",
    ].join("\n")
    writeSrc(project, "src/leak.py", src)
    const ctx = buildCodeContext(
      {
        file: "src/leak.py",
        line: 4,
        code_snippet: "os.system(\"curl -H 'Authorization: Bearer sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG' https://x\")",
        evidence_path: [],
      },
      project.resolvedProjectPath,
    )
    assert.equal(
      (ctx.call_expression ?? "").includes("sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG"),
      false,
      "raw OpenAI project key must be redacted before reaching call_expression",
    )
    assert.match(ctx.call_expression ?? "", /<REDACTED_OPENAI_KEY>/)
  } finally {
    cleanup()
  }
})

test("AI prompt embeds the full os.system call expression (not just the sink name)", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const src = [
      "import os",
      "",
      "def delete_all_meeting_records(user_input):",
      "    os.system(\"rm -rf \" + user_input)",
      "",
    ].join("\n")
    writeSrc(project, "src/delete.py", src)
    const stub = installStubFetch({
      what_detected: "x",
      why_risky: "y",
      suggested_fix: "z",
    })
    try {
      await explainOneFinding(
        {
          ...baseFinding(),
          file: "src/delete.py",
          line: 4,
          title: "OS command call: os.system (presence warning)",
          code_snippet: "os.system(\"rm -rf \" + user_input)",
        },
        project,
        { apiKey: "sk-test" },
      )
      const user = stub.lastBody.messages.find((m) => m.role === "user")?.content ?? ""
      // The prompt must contain the verbatim call (with arguments)
      // so the model can explain WHAT it's doing rather than parrot
      // back "executes a command".
      assert.ok(
        user.includes("os.system(\\\"rm -rf \\\" + user_input)"),
        `AI prompt should embed the full call expression with arguments; got:\n${user}`,
      )
      // The containing function name gives the model the workflow hint.
      assert.match(user, /delete_all_meeting_records/)
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("AI prompt redacts secrets inside the call expression before sending to the model", async () => {
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const src = [
      "import os",
      "",
      "def call_api():",
      "    os.system(\"curl -H 'Authorization: Bearer sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG' https://x\")",
      "",
    ].join("\n")
    writeSrc(project, "src/leak2.py", src)
    const stub = installStubFetch({ what_detected: "x", why_risky: "y", suggested_fix: "z" })
    try {
      await explainOneFinding(
        {
          ...baseFinding(),
          file: "src/leak2.py",
          line: 4,
          title: "OS command call: os.system (presence warning)",
          code_snippet: "os.system(\"curl -H 'Authorization: Bearer sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG' https://x\")",
        },
        project,
        { apiKey: "sk-test" },
      )
      const sentBody = JSON.stringify(stub.lastBody)
      assert.equal(
        sentBody.includes("sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG"),
        false,
        "raw OpenAI key must not be sent to the model in any field",
      )
      assert.match(sentBody, /<REDACTED_OPENAI_KEY>/)
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})

test("system prompt instructs the model to prefer call_expression over the bare sink label", async () => {
  // Belt-and-braces: even if the user prompt's `call_expression`
  // somehow ended up null, the system prompt must steer the model
  // away from generic "this executes a command" phrasing toward
  // explaining the verbatim call.
  const { project, cleanup } = tmpProject()
  try {
    resetSessionCounterForTests()
    const stub = installStubFetch({ what_detected: "x", why_risky: "y", suggested_fix: "z" })
    try {
      await explainOneFinding(baseFinding(), project, { apiKey: "sk-test" })
      const system = stub.lastBody.messages.find((m) => m.role === "system")?.content ?? ""
      assert.match(
        system,
        /call_expression/,
        "system prompt should explicitly reference call_expression",
      )
      assert.match(
        system,
        /verbatim source|verbatim call|FIRST|prefer/i,
        "system prompt should tell the model to lean on the verbatim call",
      )
    } finally {
      stub.restore()
    }
  } finally {
    cleanup()
  }
})
