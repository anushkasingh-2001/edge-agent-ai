/**
 * Node-test suite for the automated fix architecture.
 *
 * Run with:
 *    pnpm test:fix-system
 *
 * which expands to:
 *    node --import tsx/esm --test tests/fix-system.test.ts
 *
 * What this suite enforces (1:1 with the integration brief):
 *
 *   Planner
 *     - TEMPLATE_COVERED_RULES is in 1:1 sync with TEMPLATES in
 *       server-finding-fixes.ts (any drift = test fails). Catches the
 *       "scaffold ships rule ids that don't exist in the scanner" bug.
 *     - Low-confidence (numeric < 0.4 OR band="low") routes to
 *       needs_user_decision, NOT to llm_simple_patch.
 *     - Image/binary/lockfile extensions route to cannot_fix_safely.
 *     - has_suggested_patch=true wins over template (scanner rule fix).
 *     - quality-risk rules (accuracy-regression-risk) → needs_user_decision.
 *
 *   Router
 *     - explanation tier ⇒ gpt-4.1-mini by default.
 *     - patch tier ⇒ gpt-4.1 by default; EDGE_AGENT_FIX_MODEL overrides.
 *     - privateCodeMode pins to "custom" regardless of provider.
 *     - openai_compatible is the canonical provider id ("openai" string
 *       is intentionally not in the union — typo would mean broken
 *       runtime calls today).
 *
 *   Cache
 *     - Cache key includes the model id (switching model = miss).
 *     - Cache key includes the file hash (file edit = miss).
 *     - cacheList enumerates the namespace for preview-by-id lookup.
 *
 *   LLM client
 *     - assertOpenAICompatible refuses anthropic/google without an
 *       explicit OpenAI-compatible baseUrl.
 *     - Missing API key is reported, not thrown.
 *     - Network errors do NOT echo the bearer token.
 *
 *   Pipeline (safety)
 *     - Secrets-rule findings refuse pipeline (deterministic-only).
 *     - Path traversal aborts before any read.
 *     - applyPatch rejects when the file hash changed between
 *       preview and apply (concurrent-edit guard).
 *     - applyPatch refuses files outside project root.
 *
 *   Clustering
 *     - identical_root_cause clusters by (rule_id, file).
 *     - cross_file_taint picks the source file (fewest sinks).
 *     - missing_module_consumers triggers on 4+ findings / 3+ files.
 *     - totalEstimatedLlmCalls sums correctly (template clusters = 0).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  TEMPLATE_COVERED_RULES,
  planFix,
  type PlannerFinding,
} from "../lib/fix-planner"
import {
  routeModel,
  taskForFixClass,
  _resolveModelForTests,
} from "../lib/server-model-router"
import {
  buildCacheKey,
  cacheGet,
  cacheSet,
  cacheList,
  hashFileContents,
  previewMatchesCurrentFile,
} from "../lib/fix-cache"
import {
  assertOpenAICompatible,
  callLlm,
  parseJsonReply,
  _setFetcherForTests,
} from "../lib/server-llm-client"
import {
  applyPatch,
  generatePatchPreview,
  type PatchPreview,
} from "../lib/server-patch-pipeline"
import {
  clusterFindings,
  totalEstimatedLlmCalls,
} from "../lib/server-fix-clustering"
import { scorePatch, type ValidationSignals } from "../lib/patch-confidence"

/* ------------------------------------------------------------------ *
 *  Fixtures                                                           *
 * ------------------------------------------------------------------ */

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function mkFinding(
  over: Partial<PlannerFinding> = {},
): PlannerFinding {
  return {
    id: "F1",
    rule_id: "dangerous-tools",
    severity: "high",
    category: "tools",
    file: "agent.py",
    line: 10,
    ...over,
  }
}

function baseSignals(over: Partial<ValidationSignals> = {}): ValidationSignals {
  return {
    findingResolved: true,
    parses: true,
    diffApplied: true,
    touchedAllowedFilesOnly: true,
    noNewHighCritical: true,
    testsPassed: null,
    buildPassed: null,
    diffLines: 4,
    matchesStyle: true,
    ...over,
  }
}

/* ------------------------------------------------------------------ *
 *  Planner                                                            *
 * ------------------------------------------------------------------ */

test("planner: TEMPLATE_COVERED_RULES is 1:1 with TEMPLATES in fix engine", async () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "lib", "server-finding-fixes.ts"),
    "utf8",
  )
  // Extract the keys of the TEMPLATES record. The literal source uses
  // `const TEMPLATES: Record<string, FixTemplate> = { "rule-id": ... }`
  // so a simple regex pull is fine and avoids importing the module
  // (which would drag in its file-system dependencies).
  const templateBlock = /const TEMPLATES[\s\S]*?\n\}\n/.exec(src)
  assert.ok(templateBlock, "could not locate TEMPLATES block")
  const ruleIdRegex = /"([a-z][a-z0-9-]*)":\s*\{/g
  const templateRules = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = ruleIdRegex.exec(templateBlock[0])) !== null) {
    templateRules.add(m[1])
  }
  assert.ok(templateRules.size > 0, "regex did not match any rule ids")

  for (const r of TEMPLATE_COVERED_RULES) {
    assert.ok(
      templateRules.has(r),
      `TEMPLATE_COVERED_RULES has '${r}' but TEMPLATES does not — these must agree`,
    )
  }
  // The reverse direction is allowed to be looser (TEMPLATES may carry
  // legacy aliases like "vague-prompts" intentionally). We assert at
  // least the rules the scanner emits today are templated:
  for (const r of [
    "dangerous-tools",
    "human-approval",
    "prompt-injection",
    "secrets",
    "mcp-security",
    "openapi-schema",
    "dependency-risks",
    "user-input-dangerous-code",
  ]) {
    assert.ok(templateRules.has(r), `expected TEMPLATES to cover '${r}'`)
  }
})

test("planner: scanner_rule_fix wins when has_suggested_patch=true", () => {
  const p = planFix(mkFinding({ has_suggested_patch: true }))
  assert.equal(p.fix_class, "scanner_rule_fix")
  assert.equal(p.needs_llm, false)
})

test("planner: low-confidence numeric routes to needs_user_decision", () => {
  const p = planFix(
    mkFinding({ confidence: 0.3, has_suggested_patch: false, rule_id: "auth-checks" }),
  )
  assert.equal(p.fix_class, "needs_user_decision")
  assert.equal(p.needs_llm, false)
})

test("planner: low-confidence band routes to needs_user_decision", () => {
  const p = planFix(
    mkFinding({ confidence_band: "low", rule_id: "auth-checks" }),
  )
  assert.equal(p.fix_class, "needs_user_decision")
})

test("planner: binary/image file routes to cannot_fix_safely", () => {
  const p = planFix(mkFinding({ file: "assets/logo.png" }))
  assert.equal(p.fix_class, "cannot_fix_safely")
  assert.equal(p.needs_llm, false)
})

test("planner: accuracy-regression-risk is needs_user_decision", () => {
  const p = planFix(mkFinding({ rule_id: "accuracy-regression-risk" }))
  assert.equal(p.fix_class, "needs_user_decision")
})

test("planner: cross-file finding routes to llm_complex_patch", () => {
  const p = planFix(
    mkFinding({
      rule_id: "unknown-rule",
      evidence_path_files: 3,
      has_suggested_patch: false,
    }),
  )
  assert.equal(p.fix_class, "llm_complex_patch")
})

test("planner: auth-checks routes to llm_complex_patch (root cause elsewhere)", () => {
  const p = planFix(mkFinding({ rule_id: "auth-checks", confidence: 0.8 }))
  assert.equal(p.fix_class, "llm_complex_patch")
})

/* ------------------------------------------------------------------ *
 *  Model router                                                       *
 * ------------------------------------------------------------------ */

test("router: default explanation model is gpt-4.1-mini (openai_compatible)", () => {
  // Wipe env overrides for the duration of this test.
  const save = {
    explainer: process.env.EDGE_AGENT_EXPLAINER_MODEL,
    fix: process.env.EDGE_AGENT_FIX_MODEL,
  }
  delete process.env.EDGE_AGENT_EXPLAINER_MODEL
  delete process.env.EDGE_AGENT_FIX_MODEL
  try {
    const r = routeModel({ task: "explanation", provider: "openai_compatible" })
    assert.equal(r.model, "gpt-4.1-mini")
    assert.equal(r.tier, "cheap")
  } finally {
    if (save.explainer) process.env.EDGE_AGENT_EXPLAINER_MODEL = save.explainer
    if (save.fix) process.env.EDGE_AGENT_FIX_MODEL = save.fix
  }
})

test("router: default patch_simple model is gpt-4.1; EDGE_AGENT_FIX_MODEL overrides", () => {
  const save = process.env.EDGE_AGENT_FIX_MODEL
  delete process.env.EDGE_AGENT_FIX_MODEL
  try {
    const a = routeModel({ task: "patch_simple", provider: "openai_compatible" })
    assert.equal(a.model, "gpt-4.1")

    process.env.EDGE_AGENT_FIX_MODEL = "gpt-4.1-vision-preview"
    const b = routeModel({ task: "patch_simple", provider: "openai_compatible" })
    assert.equal(b.model, "gpt-4.1-vision-preview")
  } finally {
    if (save) process.env.EDGE_AGENT_FIX_MODEL = save
    else delete process.env.EDGE_AGENT_FIX_MODEL
  }
})

test("router: privateCodeMode pins to local 'custom' provider", () => {
  const r = routeModel({
    task: "patch_complex",
    provider: "openai_compatible",
    privateCodeMode: true,
  })
  assert.equal(r.tier, "local")
  // The custom slot's local model. Test against the resolver helper so
  // a future env override doesn't break this assertion.
  assert.equal(r.model, _resolveModelForTests("custom", "local"))
})

test("router: taskForFixClass maps planner classes to tasks", () => {
  assert.equal(taskForFixClass("llm_simple_patch"), "patch_simple")
  assert.equal(taskForFixClass("llm_complex_patch"), "patch_complex")
  assert.equal(taskForFixClass("template_fix"), null)
  assert.equal(taskForFixClass("cannot_fix_safely"), null)
})

/* ------------------------------------------------------------------ *
 *  Cache                                                              *
 * ------------------------------------------------------------------ */

test("cache: key changes when the model id changes (invariant 4)", () => {
  const baseParts = {
    scannerVersion: "2.0",
    fileHashes: ["abc"],
    findingIds: ["F1"],
    contextHash: "ctx",
  }
  const k1 = buildCacheKey({ ...baseParts, model: "gpt-4.1-mini" })
  const k2 = buildCacheKey({ ...baseParts, model: "gpt-4.1" })
  assert.notEqual(k1, k2)
})

test("cache: key changes when the file hash changes", () => {
  const baseParts = {
    model: "gpt-4.1",
    scannerVersion: "2.0",
    findingIds: ["F1"],
    contextHash: "ctx",
  }
  const k1 = buildCacheKey({ ...baseParts, fileHashes: ["aaa"] })
  const k2 = buildCacheKey({ ...baseParts, fileHashes: ["bbb"] })
  assert.notEqual(k1, k2)
})

test("cache: key is order-insensitive for findingIds and fileHashes", () => {
  const k1 = buildCacheKey({
    model: "gpt-4.1",
    scannerVersion: "2.0",
    fileHashes: ["a", "b"],
    findingIds: ["F1", "F2"],
    contextHash: "ctx",
  })
  const k2 = buildCacheKey({
    model: "gpt-4.1",
    scannerVersion: "2.0",
    fileHashes: ["b", "a"],
    findingIds: ["F2", "F1"],
    contextHash: "ctx",
  })
  assert.equal(k1, k2)
})

test("cache: list + set + get round-trip", () => {
  const { dir, cleanup } = mkTmp("edge-fix-cache-")
  try {
    cacheSet(dir, "patch_previews", "k1", { hello: "world" })
    cacheSet(dir, "patch_previews", "k2", { other: "thing" })
    const all = cacheList(dir, "patch_previews")
    assert.equal(all.length, 2)
    assert.deepEqual(cacheGet(dir, "patch_previews", "k1"), { hello: "world" })
  } finally {
    cleanup()
  }
})

test("cache: previewMatchesCurrentFile detects concurrent edits", () => {
  const { dir, cleanup } = mkTmp("edge-fix-cache-")
  try {
    const fp = path.join(dir, "a.txt")
    fs.writeFileSync(fp, "hello\n")
    const hashAtPreview = hashFileContents(fs.readFileSync(fp, "utf8"))
    assert.equal(
      previewMatchesCurrentFile(dir, { file: "a.txt", previewFileHash: hashAtPreview }),
      true,
    )
    fs.writeFileSync(fp, "hello world\n")
    assert.equal(
      previewMatchesCurrentFile(dir, { file: "a.txt", previewFileHash: hashAtPreview }),
      false,
    )
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------------------------ *
 *  LLM client                                                         *
 * ------------------------------------------------------------------ */

test("llm: assertOpenAICompatible accepts openai_compatible + key", () => {
  const r = assertOpenAICompatible({
    provider: "openai_compatible",
    apiKey: "sk-test",
    baseUrl: null,
  })
  assert.equal(r.ok, true)
})

test("llm: assertOpenAICompatible refuses missing key", () => {
  const r = assertOpenAICompatible({
    provider: "openai_compatible",
    apiKey: "",
    baseUrl: null,
  })
  assert.equal(r.ok, false)
})

test("llm: assertOpenAICompatible refuses anthropic without compat baseUrl", () => {
  const r = assertOpenAICompatible({
    provider: "anthropic",
    apiKey: "sk-ant-test",
    baseUrl: null,
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.error, /openai_compatible_baseUrl/)
  }
})

test("llm: callLlm reports missing key without throwing", async () => {
  const r = await callLlm({
    model: "gpt-4.1",
    apiKey: "",
    system: "s",
    user: "u",
  })
  assert.equal(r.ok, false)
})

test("llm: callLlm network error does not echo bearer key", async () => {
  const prev = _setFetcherForTests((async () => {
    throw new Error("ECONNREFUSED at 127.0.0.1 with bearer sk-supersecret")
  }) as typeof fetch)
  try {
    const r = await callLlm({
      model: "gpt-4.1",
      apiKey: "sk-supersecret",
      system: "s",
      user: "u",
    })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.ok(
        !r.error.includes("sk-supersecret"),
        `error must not echo the api key: ${r.error}`,
      )
    }
  } finally {
    _setFetcherForTests(prev)
  }
})

test("llm: parseJsonReply handles fenced ```json blocks", () => {
  const out = parseJsonReply<{ a: number }>('```json\n{"a": 1}\n```')
  assert.deepEqual(out, { a: 1 })
})

/* ------------------------------------------------------------------ *
 *  Pipeline safety                                                    *
 * ------------------------------------------------------------------ */

test("pipeline: secrets rule refuses LLM round-trip (guard_secrets)", async () => {
  const { dir, cleanup } = mkTmp("edge-fix-secrets-")
  try {
    const finding = mkFinding({ rule_id: "secrets", file: "config.py" })
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
    })
    assert.ok("refused" in result && result.refused)
    if ("refused" in result) {
      assert.equal(result.stage, "guard_secrets")
    }
  } finally {
    cleanup()
  }
})

test("pipeline: path traversal aborts before any read", async () => {
  const { dir, cleanup } = mkTmp("edge-fix-pathtrav-")
  try {
    const finding = mkFinding({ file: "../../../etc/passwd" })
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
    })
    assert.ok("refused" in result && result.refused)
    if ("refused" in result) {
      assert.equal(result.stage, "guard_path")
    }
  } finally {
    cleanup()
  }
})

test("pipeline: cannot_fix_safely findings refuse upstream", async () => {
  const { dir, cleanup } = mkTmp("edge-fix-unfixable-")
  try {
    const finding = mkFinding({ file: "assets/icon.png" })
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
    })
    assert.ok("refused" in result && result.refused)
  } finally {
    cleanup()
  }
})

test("apply: rejects when file hash changed between preview and apply", () => {
  const { dir, cleanup } = mkTmp("edge-fix-apply-")
  try {
    const rel = "a.py"
    fs.writeFileSync(path.join(dir, rel), "x = 1\n")
    const beforeHash = hashFileContents("x = 1\n")
    const preview: PatchPreview = {
      previewId: "p1",
      findingId: "F1",
      fixClass: "llm_simple_patch",
      modelUsed: "gpt-4.1",
      patches: [{ file: rel, newContents: "x = 2\n", beforeFileHash: beforeHash }],
      unifiedDiff: "",
      confidence: scorePatch(baseSignals()),
      signals: baseSignals(),
      resolved: true,
      introducedHighCritical: 0,
      reason: "test",
    }
    // Concurrent edit lands BEFORE apply.
    fs.writeFileSync(path.join(dir, rel), "x = 99\n")

    const result = applyPatch({ projectPath: dir, preview })
    assert.equal(result.applied, false)
    assert.match(result.reason, /changed since preview/)
    // File content must still be the concurrent value (not the patch).
    assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), "x = 99\n")
  } finally {
    cleanup()
  }
})

test("apply: refuses files outside project root", () => {
  const { dir, cleanup } = mkTmp("edge-fix-apply-")
  try {
    const preview: PatchPreview = {
      previewId: "p1",
      findingId: "F1",
      fixClass: "llm_simple_patch",
      modelUsed: "gpt-4.1",
      patches: [
        {
          file: "../../../etc/passwd",
          newContents: "owned",
          beforeFileHash: "anything",
        },
      ],
      unifiedDiff: "",
      confidence: scorePatch(baseSignals()),
      signals: baseSignals(),
      resolved: true,
      introducedHighCritical: 0,
      reason: "",
    }
    const r = applyPatch({ projectPath: dir, preview })
    assert.equal(r.applied, false)
    assert.match(r.reason, /escapes project root/)
  } finally {
    cleanup()
  }
})

test("apply: writes file + backup on success", () => {
  const { dir, cleanup } = mkTmp("edge-fix-apply-")
  try {
    const rel = "main.py"
    fs.writeFileSync(path.join(dir, rel), "old\n")
    const beforeHash = hashFileContents("old\n")
    const preview: PatchPreview = {
      previewId: "p1",
      findingId: "F1",
      fixClass: "llm_simple_patch",
      modelUsed: "gpt-4.1",
      patches: [{ file: rel, newContents: "new\n", beforeFileHash: beforeHash }],
      unifiedDiff: "",
      confidence: scorePatch(baseSignals()),
      signals: baseSignals(),
      resolved: true,
      introducedHighCritical: 0,
      reason: "",
    }
    const r = applyPatch({ projectPath: dir, preview })
    assert.equal(r.applied, true)
    assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), "new\n")
    assert.equal(
      fs.readFileSync(path.join(dir, ".edge-agent", "backups", `${rel}.bak`), "utf8"),
      "old\n",
    )
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------------------------ *
 *  Confidence                                                         *
 * ------------------------------------------------------------------ */

test("confidence: unresolved finding capped to weak band", () => {
  const c = scorePatch(baseSignals({ findingResolved: false }))
  assert.equal(c.band, "weak")
  assert.match(c.guidance, /does not fix it|safety check/)
})

test("confidence: strong needs at least tests OR build to pass", () => {
  // Everything green but tests/build null → review (unverified ceiling).
  const c = scorePatch(baseSignals({ testsPassed: null, buildPassed: null }))
  assert.notEqual(c.band, "strong")
  // Now with tests + build passing:
  const c2 = scorePatch(baseSignals({ testsPassed: true, buildPassed: true }))
  assert.equal(c2.band, "strong")
})

/* ------------------------------------------------------------------ *
 *  Clustering                                                         *
 * ------------------------------------------------------------------ */

test("cluster: 3 dangerous-tools in same file collapses to one cluster", () => {
  const planned = [1, 2, 3].map((i) => {
    const f = mkFinding({
      id: `F${i}`,
      rule_id: "dangerous-tools",
      file: "agent.py",
      line: i * 10,
    })
    return { finding: f, plan: planFix(f) }
  })
  const clusters = clusterFindings(planned)
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].kind, "identical_root_cause")
  assert.equal(clusters[0].finding_ids.length, 3)
  assert.equal(clusters[0].estimated_llm_calls, 0) // template
})

test("cluster: auth-checks spread across many files → missing_module_consumers", () => {
  const planned = ["a.py", "b.py", "c.py", "d.py", "e.py"].map((file, i) => {
    const f = mkFinding({
      id: `F${i}`,
      rule_id: "auth-checks",
      file,
      confidence: 0.85,
    })
    return { finding: f, plan: planFix(f) }
  })
  const clusters = clusterFindings(planned)
  const moduleCluster = clusters.find((c) => c.kind === "missing_module_consumers")
  assert.ok(moduleCluster, "expected missing_module_consumers cluster")
  assert.ok(moduleCluster!.files.length >= 3)
})

test("cluster: user-input-dangerous-code across files → cross_file_taint at source", () => {
  // 1 source file (input.py) + 3 sinks in different files.
  const findings: { finding: PlannerFinding; plan: ReturnType<typeof planFix> }[] = []
  for (const [i, file] of ["input.py", "sink1.py", "sink2.py", "sink3.py"].entries()) {
    const f = mkFinding({
      id: `F${i}`,
      rule_id: "user-input-dangerous-code",
      file,
      confidence: 0.8,
    })
    findings.push({ finding: f, plan: planFix(f) })
  }
  const clusters = clusterFindings(findings)
  const taint = clusters.find((c) => c.kind === "cross_file_taint")
  assert.ok(taint, "expected cross_file_taint cluster")
  // Source is the file with the fewest findings (here all = 1; we just
  // assert we pinned ONE source file, not all four).
  assert.equal(taint!.files.length, 1)
})

test("cluster: totalEstimatedLlmCalls is 0 for template-only set", () => {
  const planned = [1, 2].map((i) => {
    const f = mkFinding({ id: `F${i}`, rule_id: "human-approval", line: i * 5 })
    return { finding: f, plan: planFix(f) }
  })
  const clusters = clusterFindings(planned)
  assert.equal(totalEstimatedLlmCalls(clusters), 0)
})
