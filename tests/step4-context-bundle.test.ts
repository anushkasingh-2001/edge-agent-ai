/**
 * Step 4 tests — graph-bounded prompting replaces whole-file payloads.
 *
 *   - applySearchReplace: unique edit applies; missing/ambiguous/empty
 *     rejected (this is the apply mechanism for every non-max mode).
 *   - resolveNewContents: bundle path uses edits; max-patch uses
 *     new_contents; safe fallback.
 *   - buildContextBundle: bounded + far smaller than the full file, and
 *     never leaks a full file for non-max modes.
 *
 * Run with:
 *   node --import tsx/esm --test tests/step4-context-bundle.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applySearchReplace,
  resolveNewContents,
  renderBundlePrompt,
} from "../lib/server-patch-pipeline"
import { buildContextBundle } from "../lib/server-context-bundle"
import {
  bundleHasNoFullFiles,
  bundleInputTokens,
  estimateTokens,
  type ContextBundleMode,
} from "../lib/context-bundle"

const ORIG = `def run(q, session):
    session.run(f"MATCH (n) WHERE n.name='{q}'")
    return True
`

test("applySearchReplace applies a unique edit", () => {
  const r = applySearchReplace(ORIG, [
    {
      old_str: `session.run(f"MATCH (n) WHERE n.name='{q}'")`,
      new_str: `session.run("MATCH (n) WHERE n.name=$q", q=q)`,
    },
  ])
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.ok(r.text.includes("$q"))
    assert.ok(!r.text.includes('f"MATCH'))
  }
})

test("applySearchReplace rejects missing / ambiguous / empty", () => {
  assert.equal(applySearchReplace(ORIG, [{ old_str: "NOPE", new_str: "x" }]).ok, false)
  assert.equal(
    applySearchReplace("x = 1\nx = 1\n", [{ old_str: "x = 1", new_str: "x = 2" }]).ok,
    false,
  )
  assert.equal(applySearchReplace(ORIG, []).ok, false)
})

test("resolveNewContents: bundle path applies edits, max-patch uses new_contents", () => {
  const bundle = resolveNewContents(
    { edits: [{ old_str: "return True", new_str: "return False" }] },
    ORIG,
    false,
  )
  assert.equal(bundle.ok, true)
  if (bundle.ok) assert.ok(bundle.text.includes("return False"))

  const full = resolveNewContents({ new_contents: "WHOLE FILE" }, ORIG, true)
  assert.equal(full.ok, true)
  if (full.ok) assert.equal(full.text, "WHOLE FILE")

  const none = resolveNewContents({}, ORIG, false)
  assert.equal(none.ok, false)
})

test("renderBundlePrompt emits slices, not a whole file", () => {
  const prompt = renderBundlePrompt({
    finding: { rule_id: "cypher-injection-from-llm-or-user", severity: "high", title: "Cypher", line: 2 },
    evidence: { primarySlice: { file: "a.py", startLine: 1, endLine: 3, text: ORIG } },
    taintPath: {
      nodes: [{ kind: "Source", subkind: "UserInput", file: "a.py", line: 1 }],
      slices: [],
      guardsMissing: ["parameterization"],
    },
    neighborhood: { callers: [], callees: [] },
  })
  assert.ok(prompt.includes("FINDING:"))
  assert.ok(prompt.includes("MISSING GUARDS"))
})

test("buildContextBundle is bounded and never leaks a full file (non-max modes)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"))
  try {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}: code(x=${i})`).join("\n")
    fs.writeFileSync(path.join(dir, "big.py"), big, "utf8")
    const fullTokens = estimateTokens(big)

    for (const mode of ["save-explain", "auto-small", "auto-large", "pro"] as ContextBundleMode[]) {
      const b = buildContextBundle({
        projectPath: dir,
        mode,
        finding: {
          id: "f1",
          rule_id: "cypher-injection-from-llm-or-user",
          severity: "high",
          title: "x",
          file: "big.py",
          line: 200,
          evidence_path: [],
        },
        irHash: "v2",
      })
      assert.equal(bundleHasNoFullFiles(b), true, `${mode} leaked a full file`)
      assert.ok(bundleInputTokens(b) < fullTokens, `${mode} not smaller than full file`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
