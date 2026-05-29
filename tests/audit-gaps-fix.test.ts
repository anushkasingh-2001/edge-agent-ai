/**
 * Regression tests for the post-audit gap-fix patch.
 *
 * Each test maps to one of the five audit items (M1, M2, H1, C1, U1)
 * plus a couple of cross-cutting cases. The tests are intentionally
 * surgical — they assert the exact behaviour the patch is supposed to
 * deliver and nothing more, so they keep passing as the surrounding
 * code evolves.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { pickModelForMode } from "../lib/server-finding-explanations"
import {
  recordConsumption,
  resolveAiProviderForRequest,
} from "../lib/server-ai-provider-resolver"
import {
  _resetLedgerForTests,
  loadSubscription,
  planSummary,
} from "../lib/server-subscription"
import { runFindingFixesApi } from "../lib/finding-fixes-client"

function enterprise() {
  process.env.EDGE_AGENT_PLAN_TIER = "enterprise"
}

const lowFinding = { severity: "low" as const, agent_reachable: false }

// ===================================================================
// M1: pickModelForMode prefers `manualModels.explain` over `.explanation`
// ===================================================================

test("M1: pickModelForMode reads manualModels.explain (v2 key)", () => {
  const out = pickModelForMode(lowFinding, "manual", {
    explain: "gpt-4.1-mini",
  })
  assert.equal(out, "gpt-4.1-mini")
})

test("M1: pickModelForMode falls back to legacy manualModels.explanation", () => {
  const out = pickModelForMode(lowFinding, "manual", {
    explanation: "gpt-4.1-mini",
  })
  assert.equal(
    out,
    "gpt-4.1-mini",
    "legacy `explanation` must still be honoured for Step-1 callers",
  )
})

test("M1: explain wins when both manualModels.explain and .explanation are set", () => {
  // The v2 UI is the source of truth — a stale Step-1 value should
  // never override a freshly-picked v2 selection.
  const out = pickModelForMode(lowFinding, "manual", {
    explain: "gpt-4.1-mini",
    explanation: "gpt-3.5-turbo",
  })
  assert.equal(out, "gpt-4.1-mini")
})

// ===================================================================
// M2: provider-qualified ids must be stripped before reaching callLlm
// ===================================================================

test("M2: pickModelForMode strips `anthropic:` prefix", () => {
  const out = pickModelForMode(lowFinding, "manual", {
    explain: "anthropic:claude-sonnet-4-5-20250929",
  })
  assert.equal(out, "claude-sonnet-4-5-20250929")
})

test("M2: pickModelForMode strips `openai:` prefix", () => {
  const out = pickModelForMode(lowFinding, "manual", {
    explain: "openai:gpt-4.1-mini",
  })
  assert.equal(out, "gpt-4.1-mini")
})

test("M2: pickModelForMode strips `google:` and `custom:` prefixes", () => {
  assert.equal(
    pickModelForMode(lowFinding, "manual", {
      explain: "google:gemini-2.5-pro",
    }),
    "gemini-2.5-pro",
  )
  assert.equal(
    pickModelForMode(lowFinding, "manual", {
      explain: "custom:qwen-coder-2.5",
    }),
    "qwen-coder-2.5",
  )
})

test("M2: pickModelForMode leaves a plain id with no prefix untouched", () => {
  const out = pickModelForMode(lowFinding, "manual", {
    explain: "claude-3.5-sonnet",
  })
  assert.equal(out, "claude-3.5-sonnet")
})

test("M2: an unknown slot is preserved (defensive)", () => {
  // Anything outside the recognised provider list keeps the prefix —
  // we don't want to silently corrupt model ids that happen to
  // contain a colon (versioned models, registry paths, etc).
  const out = pickModelForMode(lowFinding, "manual", {
    explain: "future-provider:model-v2",
  })
  assert.equal(out, "future-provider:model-v2")
})

// Manual mode under the resolver path (which patch/fix use) already
// handles the prefix — re-assert that as well so we don't regress.
test("M2: resolver path also returns a prefix-stripped manual model", () => {
  _resetLedgerForTests()
  enterprise()
  process.env.ANTHROPIC_API_KEY = "sk-hosted-test"
  const r = resolveAiProviderForRequest({
    userId: "u-m2",
    workspaceId: "w",
    intelligenceMode: "manual",
    task: "explain",
    manualModelSelection: { explain: "anthropic:claude-3-7-sonnet" },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "anthropic")
    assert.equal(r.model, "claude-3-7-sonnet")
  }
})

// ===================================================================
// H1 (hosted contract): Fix request must NEVER carry apiKey / baseUrl /
// provider on the wire. The hosted resolver runs server-side from env.
// ===================================================================

test("H1: runFindingFixesApi never sends apiKey/baseUrl/provider on the wire", async () => {
  const captured: { body?: Record<string, unknown> } = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured.body = JSON.parse(init?.body ?? "{}")
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
      intelligenceMode: "auto",
      manualModelSelection: { patch: "anthropic:claude-sonnet-4-6" },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  const body = captured.body as Record<string, unknown>
  assert.equal(body.apiKey, undefined, "client must never put apiKey on the wire")
  assert.equal(body.baseUrl, undefined, "client must never put baseUrl on the wire")
  assert.equal(
    body.provider,
    undefined,
    "client must never select a provider for the server",
  )
  assert.deepEqual(body.manualModelSelection, {
    patch: "anthropic:claude-sonnet-4-6",
  })
})

// ===================================================================
// C1 (hosted contract): recordConsumption DEBITS credits on success.
// ===================================================================

test("C1: hosted recordConsumption debits the credit ledger", () => {
  _resetLedgerForTests()
  enterprise()
  const before = planSummary(loadSubscription("u-c1", "w")).creditsRemaining
  const debited = recordConsumption({
    userId: "u-c1",
    workspaceId: "w",
    apiKeySource: "hosted",
    estimatedCredits: 3,
  })
  assert.equal(debited, 3, "credits returned equal credits debited")
  const after = planSummary(loadSubscription("u-c1", "w")).creditsRemaining
  assert.equal(after, before - 3, "hosted call must debit the user's ledger")
})

// ===================================================================
// U1: The Behavioral row's Fix button must forward toolbar state, but
// only the hosted-safe fields (intelligenceMode + manual model picks).
// ===================================================================

test("U1: Fix request from a Behavioral row forwards mode + manual, never keys", async () => {
  const captured: { body?: Record<string, unknown> } = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured.body = JSON.parse(init?.body ?? "{}")
    return new Response(
      JSON.stringify({
        mode: "apply",
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
      mode: "apply",
      targets: [
        { ref_id: "r1", rule_id: "behavioral.test", file: "a.py", line: 1 },
      ],
      intelligenceMode: "pro",
      manualModelSelection: { patch: "anthropic:claude-sonnet-4-6" },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  const body = captured.body as Record<string, unknown>
  assert.equal(body.intelligenceMode, "pro")
  assert.deepEqual(body.manualModelSelection, {
    patch: "anthropic:claude-sonnet-4-6",
  })
  assert.equal(body.apiKey, undefined)
  assert.equal(body.baseUrl, undefined)
  assert.equal(body.provider, undefined)
})
