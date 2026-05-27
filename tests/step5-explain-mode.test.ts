/**
 * Step 5 tests — explanation is mode-aware (Q4/Q5).
 *
 *   - pickModelForMode: save/auto → cheap base; pro/max → deep tier;
 *     manual → user's explanation choice; no mode → null (back-compat
 *     fallback to severity-only pickModel).
 *   - fetchFindingExplanation forwards `intelligenceMode` in the POST
 *     body (the explain route then routes the explainer model by mode).
 *
 * Explanation already sends a CLAMPED snippet (≤10 lines), never the
 * whole file, so the "no whole file" property held before Step 5; this
 * step makes the MODEL TIER follow the mode.
 *
 * Run with:
 *   node --import tsx/esm --test tests/step5-explain-mode.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { pickModel, pickModelForMode } from "../lib/server-finding-explanations"
import { fetchFindingExplanation } from "../lib/finding-explanation-client"

const LOW = { severity: "low" as const, agent_reachable: false }
const HIGH = { severity: "high" as const, agent_reachable: true }

test("no mode → null (caller falls back to severity-only pickModel)", () => {
  assert.equal(pickModelForMode(LOW, undefined), null)
})

test("save / auto → cheap base explainer regardless of severity", () => {
  const base = pickModel(LOW)
  assert.equal(pickModelForMode(HIGH, "save"), base)
  assert.equal(pickModelForMode(HIGH, "auto"), base)
})

test("pro / max → deep explainer for high/reachable findings", () => {
  assert.equal(pickModelForMode(HIGH, "pro"), pickModel(HIGH))
  assert.equal(pickModelForMode(HIGH, "max"), pickModel(HIGH))
})

test("manual → user explanation choice, or null when unset", () => {
  assert.equal(pickModelForMode(LOW, "manual", { explanation: "gpt-4o-mini" }), "gpt-4o-mini")
  assert.equal(pickModelForMode(LOW, "manual", {}), null)
})

test("fetchFindingExplanation forwards intelligenceMode in the POST body", async () => {
  const calls: Array<{ url: string; body: any }> = []
  const realFetch = globalThis.fetch
  // @ts-expect-error test stub
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return { ok: true, status: 200, json: async () => ({ summary: "x" }) } as Response
  }
  try {
    await fetchFindingExplanation({
      projectPath: "/tmp/x",
      // minimal UiFinding-ish shape
      finding: {
        id: "1",
        ruleId: "dangerous-tools",
        severity: "high",
        category: "Tools",
        title: "t",
        file: "a.py",
        line: 1,
        reason: "",
        suggestedFix: "",
        evidence: "",
        code: "x = 1",
      } as any,
      intelligenceMode: "pro",
      manualModels: { explanation: "gpt-4o-mini" },
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "/api/finding/explain")
  assert.equal(calls[0].body.intelligenceMode, "pro")
  assert.deepEqual(calls[0].body.manualModels, { explanation: "gpt-4o-mini" })
})
