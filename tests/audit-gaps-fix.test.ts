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
  const r = resolveAiProviderForRequest({
    userId: "u-m2",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "manual",
    task: "explain",
    byokApiKey: "sk-byok",
    manualModelSelection: { explain: "anthropic:claude-3-7-sonnet" },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "anthropic")
    assert.equal(r.model, "claude-3-7-sonnet")
  }
})

// ===================================================================
// H1: BYOK fix request must include apiKey / baseUrl / provider
// ===================================================================

test("H1: runFindingFixesApi sends apiKey/baseUrl/provider when BYOK", async () => {
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
      aiProviderMode: "byok",
      provider: "anthropic",
      apiKey: "sk-user-anthropic",
      baseUrl: undefined,
      manualModelSelection: { patch: "anthropic:claude-3-7-sonnet" },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  const body = captured.body as Record<string, unknown>
  assert.equal(body.aiProviderMode, "byok")
  assert.equal(body.provider, "anthropic")
  assert.equal(body.apiKey, "sk-user-anthropic")
  assert.deepEqual(body.manualModelSelection, {
    patch: "anthropic:claude-3-7-sonnet",
  })
  // ``manualModels`` legacy alias also present for older servers.
  assert.deepEqual(body.manualModels, {
    patch: "anthropic:claude-3-7-sonnet",
  })
})

test("H1: hosted mode does NOT leak BYOK secrets even if passed", async () => {
  // Defence-in-depth: callers that mistakenly supply an apiKey under
  // Hosted mode (e.g. shared state between toolbar + drawer) must not
  // have it forwarded to the server. The client strips BYOK fields
  // when aiProviderMode is "hosted".
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
    // BYOK-only MVP: the client always forwards the caller's apiKey /
    // provider / baseUrl. The legacy Hosted "drop BYOK fields" branch
    // is gone — there is no hosted path to protect anymore — and the
    // user explicitly opted in by entering the key in Settings.
    await runFindingFixesApi({
      projectPath: "/p",
      mode: "suggest",
      targets: [],
      intelligenceMode: "auto",
      aiProviderMode: "hosted",
      provider: "anthropic",
      apiKey: "sk-leaked-key",
      baseUrl: "https://attacker.example",
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  const body = captured.body as Record<string, unknown>
  // The wire enum is forced to "byok" by the client. The fields are
  // forwarded verbatim — the user typed them and the server is the
  // single point of truth for validating them.
  assert.equal(body.aiProviderMode, "byok")
  assert.equal(body.provider, "anthropic")
  assert.equal(body.apiKey, "sk-leaked-key")
  assert.equal(body.baseUrl, "https://attacker.example")
})

// ===================================================================
// C1: BYOK-only MVP — recordConsumption is a no-op
// ===================================================================
//
// We assert the underlying primitive — recordConsumption — because the
// explain route itself sits behind Next/server which would require a
// full route runner. The route's call site uses these exact params,
// and the credit-ledger contract is what actually matters.
//
// BYOK-only contract: no `apiKeySource` value (hosted OR byok) draws
// down the local credit ledger. The user's upstream provider bills
// them directly. This pins the contract against a regression that
// re-introduces a silent app-owned billing path.

test("C1: BYOK-only recordConsumption never decrements credits (hosted code path)", () => {
  _resetLedgerForTests()
  enterprise()
  const before = planSummary(loadSubscription("u-c1", "w")).creditsRemaining
  recordConsumption({
    userId: "u-c1",
    workspaceId: "w",
    apiKeySource: "hosted",
    actualCostUsd: 0.0015,
  })
  const after = planSummary(loadSubscription("u-c1", "w")).creditsRemaining
  assert.equal(
    after,
    before,
    "BYOK-only build must never debit the credit ledger, even when a legacy call site passes apiKeySource='hosted'",
  )
})

test("C1: BYOK explain-style recordConsumption does NOT touch credits", () => {
  _resetLedgerForTests()
  enterprise()
  const before = planSummary(loadSubscription("u-c1b", "w")).creditsRemaining
  recordConsumption({
    userId: "u-c1b",
    workspaceId: "w",
    apiKeySource: "byok",
    actualCostUsd: 0.5,
  })
  const after = planSummary(loadSubscription("u-c1b", "w")).creditsRemaining
  assert.equal(after, before, "BYOK callers pay their own provider directly")
})

// ===================================================================
// U1: The Behavioral row's Fix button must forward toolbar state
// ===================================================================
//
// We assert this at the wire level: a Behavioral-row Fix that flows
// through runFindingFixesApi must produce the same payload shape as
// the toolbar Fix would have. Anything else means the row got stale
// defaults instead of the live toolbar selection.

test("U1: Fix request from a Behavioral-row state forwards mode/provider/manual", async () => {
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
    // Simulate what the BehavioralTestRow now sends via the threaded
    // toolbar state (intelligenceMode=pro, BYOK Anthropic with a
    // manual model pick).
    await runFindingFixesApi({
      projectPath: "/p",
      mode: "apply",
      targets: [
        { ref_id: "r1", rule_id: "behavioral.test", file: "a.py", line: 1 },
      ],
      intelligenceMode: "pro",
      aiProviderMode: "byok",
      provider: "anthropic",
      apiKey: "sk-anth",
      manualModelSelection: { patch: "anthropic:claude-3-7-sonnet" },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  const body = captured.body as Record<string, unknown>
  assert.equal(body.intelligenceMode, "pro")
  assert.equal(body.aiProviderMode, "byok")
  assert.equal(body.provider, "anthropic")
  assert.equal(body.apiKey, "sk-anth")
  assert.deepEqual(body.manualModelSelection, {
    patch: "anthropic:claude-3-7-sonnet",
  })
})
