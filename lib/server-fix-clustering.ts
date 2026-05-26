/**
 * Fix Clustering.
 *
 * Groups findings into clusters that can be fixed by a SINGLE patch.
 * Without this, "Fix all 47 findings" → 47 LLM calls + 47 file writes.
 * With it, 47 findings collapse into ~6 clusters → ~6 LLM calls (and
 * many of those clusters resolve to a deterministic template, no LLM
 * at all).
 *
 * Cluster types (in deterministic priority order, first match wins):
 *   identical_root_cause      Same `(rule_id, file)`. One patch fixes
 *                             every call site (e.g. five
 *                             `dangerous-tools` hits in `agent.py`).
 *   missing_module_consumers  Many findings of the same shape across
 *                             the codebase whose root cause is a missing
 *                             module/decorator/utility — fix is to
 *                             introduce the helper module + apply it.
 *   cross_file_taint          One taint source flows to many sinks. Fix
 *                             at the source, not at every sink.
 *
 * Rule ids are pulled from `SCANNER_RULE_IDS` (lib/scan-report.ts) and
 * `ALL_RULE_IDS` (scanner/.../report.py) — synced via the same unit
 * test that guards `fix-planner.ts`.
 */

import type { PlannerFinding, FixClass } from "./fix-planner"

/** Rules where multiple findings in ONE file are commonly the same
 *  root-cause (e.g. unguarded `subprocess.run` at five call sites,
 *  always wanted the same allow-list). */
const CLUSTERABLE_BY_FILE = new Set<string>([
  "dangerous-tools",
  "human-approval",
  "secrets",
  "user-input-dangerous-code",
  "prompt-injection",
  "openapi-schema",
])

/** Rules where the "scattered everywhere" pattern usually points at a
 *  missing module/util/decorator. Fix = introduce the helper, then
 *  apply it. */
const MODULE_INTRODUCING_RULES = new Set<string>([
  "auth-checks",
  "prompt-contract",
  "openapi-schema",
])

/** Rules whose root cause is a taint source. One fix at the source
 *  defuses every downstream sink. */
const TAINT_SOURCE_RULES = new Set<string>([
  "user-input-dangerous-code",
])

export type ClusterKind =
  | "identical_root_cause"
  | "missing_module_consumers"
  | "cross_file_taint"
  | "singleton"

export interface FixCluster {
  cluster_id: string
  kind: ClusterKind
  rule_id: string
  /** Files the cluster touches. For taint-source clusters this is the
   *  source file (where the patch lands), not every consumer file. */
  files: string[]
  /** Every finding the cluster covers (so the UI can show "1 patch
   *  resolves 5 findings"). */
  finding_ids: string[]
  /** Estimated LLM calls. 0 for template-only clusters, 1 for most
   *  LLM clusters, 2 for plan-then-diff on complex ones. */
  estimated_llm_calls: number
  /** Effective fix class for the cluster (caller routes the model
   *  using this — same enum as the per-finding planner). */
  fix_class: FixClass
  reason: string
}

/* ------------------------------------------------------------------ *
 *  Internal helpers                                                   *
 * ------------------------------------------------------------------ */

interface PlannerInput extends PlannerFinding {
  _plan: { fix_class: FixClass; needs_llm: boolean }
}

function groupBy<T, K extends string>(
  items: T[],
  key: (t: T) => K,
): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const it of items) {
    const k = key(it)
    const arr = out.get(k)
    if (arr) arr.push(it)
    else out.set(k, [it])
  }
  return out
}

function makeId(prefix: string, parts: string[]): string {
  return `${prefix}__${parts.join("|")}`
}

function llmCallsFor(fixClass: FixClass, isCluster: boolean): number {
  if (fixClass === "template_fix" || fixClass === "scanner_rule_fix") return 0
  if (fixClass === "cannot_fix_safely" || fixClass === "needs_user_decision") return 0
  if (fixClass === "llm_complex_patch") return 2 // plan + diff
  // simple patch: a cluster still only fires once; singletons also one
  return isCluster ? 1 : 1
}

/* ------------------------------------------------------------------ *
 *  Public API                                                         *
 * ------------------------------------------------------------------ */

/**
 * Build clusters from already-planned findings.
 *
 * Inputs MUST already be passed through `planFix()` so the cluster
 * inherits the planner's class decision (e.g. low-confidence singletons
 * still surface as singletons with `needs_user_decision`).
 */
export function clusterFindings(
  planned: { finding: PlannerFinding; plan: { fix_class: FixClass; needs_llm: boolean } }[],
): FixCluster[] {
  const items: PlannerInput[] = planned.map((p) => ({
    ...p.finding,
    _plan: p.plan,
  }))

  const clusters: FixCluster[] = []
  const consumed = new Set<string>()

  // ---- 1. cross_file_taint: source rules with many findings ----
  // We treat a taint-source rule as a candidate when 3+ findings share
  // its rule_id AND span 2+ files; otherwise it behaves like a normal
  // singleton.
  for (const rule of TAINT_SOURCE_RULES) {
    const rows = items.filter((i) => i.rule_id === rule && !consumed.has(i.id))
    const files = new Set(rows.map((r) => r.file))
    if (rows.length >= 3 && files.size >= 2) {
      // Heuristic: source is the file with the FEWEST findings of the
      // rule (usually the input handler) — patch there.
      const byFile = groupBy(rows, (r) => r.file)
      let sourceFile = rows[0].file
      let minCount = Infinity
      for (const [f, list] of byFile) {
        if (list.length < minCount) {
          minCount = list.length
          sourceFile = f
        }
      }
      const fixClass: FixClass = "llm_complex_patch"
      clusters.push({
        cluster_id: makeId("taint", [rule, sourceFile]),
        kind: "cross_file_taint",
        rule_id: rule,
        files: [sourceFile],
        finding_ids: rows.map((r) => r.id),
        estimated_llm_calls: llmCallsFor(fixClass, true),
        fix_class: fixClass,
        reason: `Tainted input flows from ${sourceFile} into ${
          files.size
        } other files; fix at the source.`,
      })
      for (const r of rows) consumed.add(r.id)
    }
  }

  // ---- 2. missing_module_consumers: many same-rule findings across
  //         many files where the cure is "introduce a helper module" ----
  for (const rule of MODULE_INTRODUCING_RULES) {
    const rows = items.filter((i) => i.rule_id === rule && !consumed.has(i.id))
    const files = new Set(rows.map((r) => r.file))
    // Require 4+ findings across 3+ files for this to be worth doing as
    // one cluster — fewer and the per-file template fix is simpler.
    if (rows.length >= 4 && files.size >= 3) {
      const fixClass: FixClass = "llm_complex_patch"
      clusters.push({
        cluster_id: makeId("module", [rule]),
        kind: "missing_module_consumers",
        rule_id: rule,
        files: [...files].sort(),
        finding_ids: rows.map((r) => r.id),
        estimated_llm_calls: llmCallsFor(fixClass, true),
        fix_class: fixClass,
        reason: `${rows.length} findings of '${rule}' across ${files.size} files; introduce a shared helper and apply it.`,
      })
      for (const r of rows) consumed.add(r.id)
    }
  }

  // ---- 3. identical_root_cause: same (rule_id, file) ----
  const byRuleFile = groupBy(
    items.filter((i) => !consumed.has(i.id) && CLUSTERABLE_BY_FILE.has(i.rule_id)),
    (i) => `${i.rule_id}::${i.file}` as `${string}::${string}`,
  )
  for (const [key, rows] of byRuleFile) {
    if (rows.length < 2) continue
    const [rule_id, file] = key.split("::")
    // Honour the planner: if any row says needs_user_decision /
    // cannot_fix_safely, don't bundle.
    const allOk = rows.every(
      (r) =>
        r._plan.fix_class !== "needs_user_decision" &&
        r._plan.fix_class !== "cannot_fix_safely",
    )
    if (!allOk) continue
    // If all rows are template_fix, cluster fix_class is template too.
    const allTemplate = rows.every(
      (r) =>
        r._plan.fix_class === "template_fix" ||
        r._plan.fix_class === "scanner_rule_fix",
    )
    const fixClass: FixClass = allTemplate
      ? rows[0]._plan.fix_class
      : "llm_simple_patch"
    clusters.push({
      cluster_id: makeId("file", [rule_id, file]),
      kind: "identical_root_cause",
      rule_id,
      files: [file],
      finding_ids: rows.map((r) => r.id),
      estimated_llm_calls: llmCallsFor(fixClass, true),
      fix_class: fixClass,
      reason: `${rows.length} '${rule_id}' findings in ${file}; one patch covers all call sites.`,
    })
    for (const r of rows) consumed.add(r.id)
  }

  // ---- 4. Remaining findings become singletons ----
  for (const it of items) {
    if (consumed.has(it.id)) continue
    clusters.push({
      cluster_id: makeId("single", [it.id]),
      kind: "singleton",
      rule_id: it.rule_id,
      files: [it.file],
      finding_ids: [it.id],
      estimated_llm_calls: llmCallsFor(it._plan.fix_class, false),
      fix_class: it._plan.fix_class,
      reason:
        it._plan.fix_class === "template_fix"
          ? "Deterministic template fix; no LLM."
          : it._plan.fix_class === "needs_user_decision"
            ? "Human decision required."
            : it._plan.fix_class === "cannot_fix_safely"
              ? "No safe automated fix."
              : "Single-site fix.",
    })
  }

  return clusters
}

/** Total estimated LLM calls across a cluster set — surfaced in the
 *  bulk-fix UI so the user can see "Fix all 47" really means 6 calls. */
export function totalEstimatedLlmCalls(clusters: FixCluster[]): number {
  return clusters.reduce((sum, c) => sum + c.estimated_llm_calls, 0)
}
