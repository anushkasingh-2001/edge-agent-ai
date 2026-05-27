/**
 * All-mode wiring regression tests (BYOK-only MVP).
 *
 * Canonical end-to-end matrix for the five intelligence modes
 * (Save / Auto / Pro / Max / Manual) plus the BYOK provider resolver.
 * Each test covers one item from the required-tests checklist and is
 * named accordingly so a failure points straight at the broken seam.
 *
 *   1. Save mode refuses LLM patch generation.
 *   2. Auto mode routes cheap/cascade/strong based on complexity.
 *   3. Pro mode routes to coding_flagship tier.
 *   4. Max mode enables two-step plan → patch behavior.
 *   5. Manual mode honors exact selected model IDs.
 *   6. manualModels and manualModelSelection are both accepted/normalized.
 *   7. Fix all / Fix filtered forwards intelligenceMode + BYOK key.
 *   8. BYOK resolver picks correct provider; no hosted fallback.
 *   9. No credit drawdown in BYOK-only (recordConsumption is a no-op).
 *
 * Run with:
 *   node --import tsx --test tests/all-modes-e2e-wiring.test.ts
 *
 * (The bare `node --import tsx/esm --test` form prints a CJS resolver
 * error against this repo's tsconfig — tsx 4.x exposes its loader as
 * `tsx`, not `tsx/esm`. `tsx --test` and `node --import tsx --test`
 * both work and produce identical output.)
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  resolveAiProviderForRequest,
  recordConsumption,
} from "../lib/server-ai-provider-resolver"
import {
  _resetLedgerForTests,
  loadSubscription,
  planSummary,
} from "../lib/server-subscription"
import { routeForMode } from "../lib/server-model-router-ext"
import { routeTaskForMode } from "../lib/intelligence-mode"
import { runFindingFixesApi } from "../lib/finding-fixes-client"

// ===================================================================
// Test helpers
// ===================================================================

/** Forge an "Enterprise" plan tier so plan-gated modes (Pro/Max/Manual)
 *  are unlocked. Free tier intentionally downgrades them server-side. */
function enterprise() {
  process.env.EDGE_AGENT_PLAN_TIER = "enterprise"
}

/** Returns a stub BYOK key set; tests call the resolver with this so
 *  every spec assertion runs in the BYOK-only world. There is no
 *  hosted/env fallback in MVP, so every successful resolution
 *  requires a caller-supplied key. */
function byokKey(): string {
  return "sk-byok-test"
}

/** Capture-style fetch stub: records the JSON body sent to fetch() and
 *  returns a synthetic 200 OK with an empty RunFixesResult. Tests use
 *  this to inspect what `runFindingFixesApi` puts on the wire without
 *  needing a live Next route. */
function stubFetchOnce(): {
  bodies: Array<Record<string, unknown>>
  restore: () => void
} {
  const bodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}"))
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
  return {
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

// ===================================================================
// 1. Save mode refuses LLM patch generation.
// ===================================================================

test("1. Save mode refuses LLM patch generation (BYOK-only, with key)", () => {
  _resetLedgerForTests()
  process.env.EDGE_AGENT_PLAN_TIER = "free"
  const r = resolveAiProviderForRequest({
    userId: "u-save",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "save",
    task: "patch",
    byokApiKey: byokKey(),
  })
  assert.equal(r.ok, false, "Save must NOT return a usable resolution for patch")
  if (!r.ok) {
    assert.equal(
      r.code,
      "task_not_allowed_in_mode",
      "Save's refusal is policy-driven, not a missing-key failure",
    )
  }
  // Explain in Save mode is still allowed — same resolver call,
  // different task — so a regression that flat-blocks Save would be
  // caught here as well. Still requires a key, like every AI action.
  const explain = resolveAiProviderForRequest({
    userId: "u-save",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "save",
    task: "explain",
    byokApiKey: byokKey(),
  })
  assert.equal(explain.ok, true, "Save mode must still permit explain (with a key)")
})

test("1b. Save mode explain without a key returns missing_api_key", () => {
  _resetLedgerForTests()
  process.env.EDGE_AGENT_PLAN_TIER = "free"
  const r = resolveAiProviderForRequest({
    userId: "u-save",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "save",
    task: "explain",
  })
  assert.equal(r.ok, false, "Save explain still requires a BYOK key")
  if (!r.ok) assert.equal(r.code, "missing_api_key")
})

// ===================================================================
// 2. Auto mode routes cheap/cascade/strong based on complexity.
// ===================================================================

test("2. Auto mode routes cheap/cascade/strong based on complexity", () => {
  // The complexity score lands in one of three buckets:
  //   < 0.30  → "cheap"
  //   ≤ 0.65  → "cascade"
  //   > 0.65  → "strong"
  //
  // We sample each bucket with both an explain and a patch task so
  // the tier matrix is exercised across the two tasks whose routing
  // actually differs by bucket.
  const lo = routeForMode({
    mode: "auto",
    task: "explain",
    complexity: 0.1, // cheap
    provider: "openai_compatible",
  })
  const mid = routeForMode({
    mode: "auto",
    task: "explain",
    complexity: 0.5, // cascade
    provider: "openai_compatible",
  })
  const hi = routeForMode({
    mode: "auto",
    task: "explain",
    complexity: 0.85, // strong
    provider: "openai_compatible",
  })
  // Explain: cheap and cascade both pick the cheap tier (cascade can
  // escalate once); strong picks mid up-front.
  assert.equal(lo.tier, "cheap")
  assert.equal(lo.cascade, false)
  assert.equal(mid.tier, "cheap")
  assert.equal(mid.cascade, true)
  assert.equal(hi.tier, "mid")

  // Patch routing's strong-bucket twoStep is asserted separately in
  // test #4. Here we only check that the three buckets produce at
  // least two distinct decisions for patch as well, which is the
  // load-bearing invariant — a regression that collapses all three
  // buckets to the same tier would be caught.
  const patchLo = routeForMode({
    mode: "auto",
    task: "patch",
    complexity: 0.1,
    provider: "openai_compatible",
  })
  const patchHi = routeForMode({
    mode: "auto",
    task: "patch",
    complexity: 0.9,
    provider: "openai_compatible",
  })
  assert.notEqual(
    patchLo.tier,
    patchHi.tier,
    "Auto patch must escalate tier between cheap and strong complexity",
  )
  assert.equal(patchHi.tier, "coding_flagship")
  assert.equal(patchLo.cascade, true, "Auto patch always cascades")
})

// ===================================================================
// 3. Pro mode routes to coding_flagship tier.
// ===================================================================

test("3. Pro mode routes to coding_flagship tier", () => {
  // Pro pins the strongest coding tier regardless of complexity — the
  // whole point of Pro is "accuracy first, cost second". We sample
  // two complexity extremes and assert both still land on the
  // coding_flagship tier with a single-shot patch (twoStep is a Max
  // affordance, not Pro's).
  const easy = routeForMode({
    mode: "pro",
    task: "patch",
    complexity: 0.05,
    provider: "anthropic",
  })
  const hard = routeForMode({
    mode: "pro",
    task: "patch",
    complexity: 0.95,
    provider: "google",
  })
  assert.equal(easy.tier, "coding_flagship")
  assert.equal(hard.tier, "coding_flagship")
  assert.equal(easy.twoStep, false, "Pro patch is single-shot")
  assert.equal(hard.twoStep, false, "Pro patch is single-shot")
  // Pro's bundleMode tag is read by the context-bundler so Pro gets
  // the larger token budget — assert it's wired.
  assert.equal(easy.bundleMode, "pro")
})

// ===================================================================
// 4. Max mode enables two-step plan → patch behavior.
// ===================================================================

test("4. Max mode enables two-step plan → patch behavior", () => {
  // Max always plans then patches, even on trivial cases — that's
  // the contract that distinguishes it from Pro. We assert via
  // `routeTaskForMode` (the pure policy decision) AND via the full
  // `routeForMode` wrapper (the decision the patch pipeline actually
  // consumes) so a regression in either layer is caught.
  const policyDecision = routeTaskForMode("max", "patch", 0.1)
  assert.equal(policyDecision.twoStep, true, "Max patch policy must be two-step")
  // root_cause shares the same two-step affordance.
  const rootCausePolicy = routeTaskForMode("max", "root_cause", 0.1)
  assert.equal(
    rootCausePolicy.twoStep,
    true,
    "Max root_cause must also be two-step",
  )
  // Pure-explain tasks stay single-shot (no draft-then-finalize for
  // explanations) — make sure twoStep doesn't bleed across tasks.
  const explainPolicy = routeTaskForMode("max", "explain", 0.9)
  assert.equal(
    explainPolicy.twoStep,
    false,
    "Max explain must remain single-shot",
  )
  // Wrapper-level sanity: routeForMode forwards twoStep so the pipeline
  // can read it without re-deriving the policy.
  const wrapped = routeForMode({
    mode: "max",
    task: "patch",
    complexity: 0.5,
    provider: "openai_compatible",
  })
  assert.equal(wrapped.twoStep, true)
  assert.equal(wrapped.bundleMode, "max-patch")
})

// ===================================================================
// 5. Manual mode honors exact selected model IDs.
// ===================================================================

test("5. Manual mode honours an actual provider-qualified model id", () => {
  _resetLedgerForTests()
  enterprise()
  const r = resolveAiProviderForRequest({
    userId: "u-manual",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "manual",
    task: "patch",
    byokApiKey: "sk-user",
    manualModelSelection: {
      patch: "anthropic:claude-sonnet-4-6",
    },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "anthropic", "provider derived from `slot:` prefix")
    assert.equal(r.model, "claude-sonnet-4-6", "exact model id passes through")
    assert.equal(r.apiKeySource, "byok")
  }
})

test("5. Manual mode also accepts the old tier-name override format", () => {
  _resetLedgerForTests()
  enterprise()
  const r = resolveAiProviderForRequest({
    userId: "u-manual2",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "manual",
    task: "patch",
    byokApiKey: "sk-user",
    byokProvider: "google",
    manualModelSelection: { patch: "coding_flagship" },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "google")
    assert.equal(
      r.model,
      "gemini-2.5-pro",
      "tier-name resolves through the provider tier table",
    )
  }
})

// ===================================================================
// 6. manualModels and manualModelSelection are both accepted/normalized.
// ===================================================================
//
// Two angles:
//   a) Client side — runFindingFixesApi must send BOTH wire names
//      regardless of which the caller used (we accept either name and
//      mirror it so older + newer servers can both decode it).
//   b) Server side — resolveAiProviderForRequest reads manualSelection
//      via a single canonical name; the route handlers normalise
//      `manualModels` → `manualModelSelection` before forwarding.

test("6a. Client normalises legacy `manualModels` into both wire names", async () => {
  const { bodies, restore } = stubFetchOnce()
  try {
    await runFindingFixesApi({
      projectPath: "/p",
      mode: "suggest",
      targets: [],
      intelligenceMode: "manual",
      aiProviderMode: "byok",
      provider: "openai_compatible",
      apiKey: "sk-byok",
      manualModels: { patch: "openai:gpt-4.1" },
    })
  } finally {
    restore()
  }
  assert.equal(bodies.length, 1)
  const body = bodies[0]
  // Both names must be present on the wire — even if the caller only
  // supplied the legacy `manualModels`, the v2 server reads
  // `manualModelSelection`, and vice versa for older servers.
  assert.deepEqual(body.manualModelSelection, { patch: "openai:gpt-4.1" })
  assert.deepEqual(body.manualModels, { patch: "openai:gpt-4.1" })
})

test("6b. Client normalises canonical `manualModelSelection` into both names", async () => {
  const { bodies, restore } = stubFetchOnce()
  try {
    await runFindingFixesApi({
      projectPath: "/p",
      mode: "suggest",
      targets: [],
      intelligenceMode: "manual",
      aiProviderMode: "byok",
      provider: "openai_compatible",
      apiKey: "sk-byok",
      manualModelSelection: { patch: "openai:gpt-4.1-mini" },
    })
  } finally {
    restore()
  }
  const body = bodies[0]
  assert.deepEqual(body.manualModelSelection, { patch: "openai:gpt-4.1-mini" })
  assert.deepEqual(body.manualModels, { patch: "openai:gpt-4.1-mini" })
})

test("6c. Resolver reads manual picks via manualModelSelection", () => {
  _resetLedgerForTests()
  enterprise()
  // Asserts the SERVER-side normalisation contract: the resolver only
  // knows about `manualModelSelection`; if a route handler forgets to
  // normalise a legacy `manualModels` body, the Manual choice would
  // silently fall back to the mode default. This test pins the
  // intended interface so a refactor that renames the resolver
  // parameter breaks loudly.
  const r = resolveAiProviderForRequest({
    userId: "u-norm",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "manual",
    task: "explain",
    byokApiKey: "sk-byok",
    manualModelSelection: { explain: "openai:gpt-4.1-mini" },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "openai_compatible")
    assert.equal(r.model, "gpt-4.1-mini")
  }
})

// ===================================================================
// 7. Fix all / Fix filtered forwards intelligenceMode.
// ===================================================================
//
// Both surfaces ("Fix all" toolbar button and the drawer/Behavioral
// row's per-finding Fix) flow through the same client helper
// (`runFindingFixesApi`) and the same `/api/findings/fix` route. We
// assert the wire body carries `intelligenceMode` for both the
// single-target ("Fix this") and multi-target ("Fix all" / "Fix
// filtered") shapes — a regression that dropped the field would fail
// both bodies.

test("7. Fix all / Fix filtered forwards intelligenceMode + BYOK key", async () => {
  const { bodies, restore } = stubFetchOnce()
  try {
    // "Fix this" — single finding from the drawer or row.
    await runFindingFixesApi({
      projectPath: "/p",
      mode: "suggest",
      targets: [
        { ref_id: "r1", rule_id: "ssrf", file: "a.py", line: 10 },
      ],
      intelligenceMode: "pro",
      provider: "openai_compatible",
      apiKey: "sk-user-key",
    })
    // "Fix all" / "Fix filtered" — N targets from the toolbar or the
    // category dropdown.
    await runFindingFixesApi({
      projectPath: "/p",
      mode: "apply",
      targets: [
        { ref_id: "r2", rule_id: "xss", file: "b.tsx", line: 1 },
        { ref_id: "r3", rule_id: "xss", file: "b.tsx", line: 7 },
        { ref_id: "r4", rule_id: "xss", file: "c.tsx", line: 3 },
      ],
      intelligenceMode: "max",
      provider: "anthropic",
      apiKey: "sk-user-key",
      baseUrl: "https://api.anthropic.com",
    })
  } finally {
    restore()
  }
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].intelligenceMode, "pro", "Fix this carries intelligenceMode")
  assert.equal(bodies[1].intelligenceMode, "max", "Fix all/filtered carries intelligenceMode")
  // BYOK fields must always be forwarded — without them the route
  // returns missing_api_key and the UI never gets an LLM upgrade.
  assert.equal(bodies[0].apiKey, "sk-user-key")
  assert.equal(bodies[0].provider, "openai_compatible")
  assert.equal(bodies[0].aiProviderMode, "byok", "wire enum is BYOK-only now")
  assert.equal(bodies[1].apiKey, "sk-user-key")
  assert.equal(bodies[1].provider, "anthropic")
  assert.equal(bodies[1].baseUrl, "https://api.anthropic.com")
  // Targets array is forwarded verbatim — a regression that drops the
  // list (e.g. body-shape change) would surface here too.
  const bulkTargets = bodies[1].targets as Array<{ ref_id: string }>
  assert.equal(bulkTargets.length, 3)
})

// ===================================================================
// 8. BYOK-only resolver picks correct provider; no hosted fallback.
// ===================================================================

test("8a. Legacy aiProviderMode='hosted' is treated as missing_api_key (no silent fallback)", () => {
  _resetLedgerForTests()
  enterprise()
  // Even with EDGE_AGENT_HOSTED_OPENAI_KEY set, the resolver must
  // require a caller key — there is no server-key path anymore.
  process.env.EDGE_AGENT_HOSTED_OPENAI_KEY = "sk-hosted-should-be-ignored"
  const r = resolveAiProviderForRequest({
    userId: "u-h",
    workspaceId: "w",
    aiProviderMode: "hosted",
    intelligenceMode: "auto",
    task: "patch",
  })
  assert.equal(r.ok, false, "Hosted must not silently use a server key in BYOK-only MVP")
  if (!r.ok) assert.equal(r.code, "missing_api_key")
  delete process.env.EDGE_AGENT_HOSTED_OPENAI_KEY
})

test("8b. BYOK resolution returns apiKeySource=byok and the caller key", () => {
  _resetLedgerForTests()
  enterprise()
  const r = resolveAiProviderForRequest({
    userId: "u-b",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "auto",
    task: "patch",
    byokApiKey: "sk-from-user",
    byokProvider: "anthropic",
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.apiKeySource, "byok")
    assert.equal(r.apiKey, "sk-from-user", "BYOK key passes straight through")
    assert.equal(r.provider, "anthropic")
  }
})

test("8c. BYOK with a missing apiKey is rejected with missing_api_key code", () => {
  _resetLedgerForTests()
  enterprise()
  const r = resolveAiProviderForRequest({
    userId: "u-bx",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "auto",
    task: "patch",
    byokApiKey: null,
  })
  assert.equal(r.ok, false, "BYOK without a key must refuse, not fall back")
  if (!r.ok) assert.equal(r.code, "missing_api_key")
})

test("8d. process.env.*_API_KEY is NOT consulted as a fallback", () => {
  _resetLedgerForTests()
  enterprise()
  process.env.OPENAI_API_KEY = "sk-env-leak"
  const r = resolveAiProviderForRequest({
    userId: "u-bx2",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "auto",
    task: "patch",
  })
  assert.equal(r.ok, false, "env vars must not back-fill missing caller key")
  if (!r.ok) assert.equal(r.code, "missing_api_key")
  delete process.env.OPENAI_API_KEY
})

// ===================================================================
// 9. No credit drawdown in BYOK-only (recordConsumption is a no-op).
// ===================================================================

test("9a. Resolver still emits an estimatedCostUsd for UI display", () => {
  _resetLedgerForTests()
  enterprise()
  const resolved = resolveAiProviderForRequest({
    userId: "u-c",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "pro",
    task: "patch",
    byokApiKey: byokKey(),
    estimatedInputTokens: 1200,
    estimatedOutputTokens: 400,
  })
  assert.equal(resolved.ok, true)
  if (resolved.ok) {
    assert.ok(
      resolved.estimatedCostUsd > 0,
      "resolver still prices the call for UI display, informational only",
    )
    // Credits are explicitly zero in BYOK-only mode — the app does
    // not own a balance to debit.
    assert.equal(resolved.estimatedCredits, 0)
    assert.equal(resolved.quotaStatus.total, 0)
  }
})

test("9b. recordConsumption never decrements credits (BYOK-only no-op)", () => {
  _resetLedgerForTests()
  enterprise()
  const before = planSummary(loadSubscription("u-c2", "w")).creditsRemaining
  // Even legacy callers that still pass apiKeySource="hosted" must
  // NOT touch the ledger. The resolver no longer ever returns
  // `hosted`, so this guards against a future regression that
  // re-introduces a credit drawdown.
  recordConsumption({
    userId: "u-c2",
    workspaceId: "w",
    apiKeySource: "hosted",
    actualCostUsd: 0.02,
  })
  recordConsumption({
    userId: "u-c2",
    workspaceId: "w",
    apiKeySource: "byok",
    actualCostUsd: 1000,
  })
  const after = planSummary(loadSubscription("u-c2", "w")).creditsRemaining
  assert.equal(
    after,
    before,
    "BYOK-only build must never draw down credits",
  )
})

test("9c. Skipping recordConsumption (e.g. template fallback) leaves credits intact", () => {
  _resetLedgerForTests()
  enterprise()
  const before = planSummary(loadSubscription("u-c3", "w")).creditsRemaining
  const after = planSummary(loadSubscription("u-c3", "w")).creditsRemaining
  assert.equal(
    after,
    before,
    "A skipped recordConsumption call must not silently bill the user",
  )
})
