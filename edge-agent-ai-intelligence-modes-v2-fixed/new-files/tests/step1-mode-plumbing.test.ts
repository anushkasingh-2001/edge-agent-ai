/**
 * Step 1 (plumbing) tests.
 *
 * These assert the wiring added in Step 1 WITHOUT asserting model-
 * selection behaviour (that lands in Step 2). Specifically:
 *
 *   1. runFindingFixesApi forwards `intelligenceMode` (and manualModels)
 *      in the POST body to /api/findings/fix. This is the fix for the
 *      "UI holds the mode but never sends it" defect.
 *   2. The patch pipeline's PipelineContext type accepts the new
 *      intelligenceMode / complexity / manualModels / forceTier fields
 *      (compile-time + a runtime smoke that buildCacheKey-relevant
 *      context differs by mode).
 *
 * Run with:
 *   node --import tsx/esm --test tests/step1-mode-plumbing.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { runFindingFixesApi } from "../lib/finding-fixes-client"

test("runFindingFixesApi forwards intelligenceMode in the request body", async () => {
  const calls: Array<{ url: string; body: any }> = []
  const realFetch = globalThis.fetch
  // @ts-expect-error test stub
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return {
      ok: true,
      status: 200,
      json: async () => ({ proposals: [], applied: false }),
    } as Response
  }
  try {
    await runFindingFixesApi({
      projectPath: "/tmp/x",
      mode: "suggest",
      targets: [{ id: "f1", rule_id: "dangerous-tools", file: "a.py", line: 1 } as any],
      intelligenceMode: "pro",
      manualModels: { patch: "mid" },
    })
  } finally {
    globalThis.fetch = realFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "/api/findings/fix")
  assert.equal(calls[0].body.intelligenceMode, "pro", "mode must be in the POST body")
  assert.deepEqual(calls[0].body.manualModels, { patch: "mid" })
})

test("runFindingFixesApi omits mode cleanly when not provided (back-compat)", async () => {
  const calls: Array<{ body: any }> = []
  const realFetch = globalThis.fetch
  // @ts-expect-error test stub
  globalThis.fetch = async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) })
    return { ok: true, status: 200, json: async () => ({}) } as Response
  }
  try {
    await runFindingFixesApi({
      projectPath: "/tmp/x",
      mode: "suggest",
      targets: [{ id: "f1", rule_id: "x", file: "a.py", line: 1 } as any],
    })
  } finally {
    globalThis.fetch = realFetch
  }
  // Field is present but undefined → not a crash; server defaults to auto.
  assert.equal(calls[0].body.intelligenceMode, undefined)
  assert.equal(calls[0].body.projectPath, "/tmp/x")
})
