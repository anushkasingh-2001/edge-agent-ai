/**
 * Fix Clustering (NEW FILE → lib/server-fix-clustering.ts)
 *
 * Powers "Fix filtered". Groups many selected findings into a handful of
 * clusters so we make ONE fix per root cause instead of one per finding.
 *
 * Real-world distributions are spiky: 100 findings are often 60 in one
 * file. So file/function and root-cause keys matter more than rule_id
 * alone. Clustering keys, applied in priority order (first match assigns
 * the cluster signature):
 *
 *   1. rule_id + normalized code shape   → identical fix, batch deterministically
 *   2. file + function                   → coordinate one patch, avoid diff conflicts
 *   3. endpoint / route                  → one auth fix per endpoint
 *   4. taint path signature              → fix at the shared source once
 *   5. false-positive class              → batch-suppress, never call LLM
 *   6. missing-auth pattern              → one parameterized template per framework
 *   7. prompt-contract missing field     → one fix per missing field
 *
 * The cluster's `strategy` tells the pipeline how to handle it:
 *   deterministic_batch | suppress_batch | llm_single_representative
 */

export interface ClusterableFinding {
  id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  file: string
  line: number
  /** Containing symbol (function/class) if the scanner knows it. */
  symbol?: string | null
  /** Verbatim offending expression — used to compute code shape. */
  code?: string | null
  /** Route path if this is an endpoint finding (RouteNode.path). */
  endpoint?: string | null
  /** Framework (fastapi/express/...) for parameterized auth templates. */
  framework?: string | null
  /** Stable signature of the taint/evidence path, if any. */
  taint_path_sig?: string | null
  /** Set true by the FP analyzer (e.g. React UI-state). */
  false_positive_class?: string | null
  /** For prompt-contract findings, the missing field name. */
  missing_contract_field?: string | null
  /** Whether a deterministic template covers this rule. */
  template_coverable?: boolean
}

export type ClusterStrategy =
  | "deterministic_batch"
  | "suppress_batch"
  | "llm_single_representative"

export interface FindingCluster {
  /** Stable key identifying this cluster (also used in the cache key). */
  signature: string
  strategy: ClusterStrategy
  rule_id: string
  /** All findings in the cluster. */
  members: ClusterableFinding[]
  /** The representative whose full context we send to the LLM (if any). */
  representative: ClusterableFinding
  /** Why these were grouped — surfaced in the grouped preview header. */
  label: string
}

/** Normalize a code expression so cosmetically-different-but-structurally-
 *  identical findings collapse: strip string/number literals, collapse
 *  whitespace, lowercase identifiers' surrounding punctuation. Cheap and
 *  good enough to group "os.system(x)" with "os.system( y )". */
export function codeShape(code: string | null | undefined): string {
  if (!code) return ""
  return code
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
    .replace(/\b\d+(?:\.\d+)?\b/g, "0") // numbers
    .replace(/\s+/g, " ")
    .trim()
}

/** Decide which clustering key a finding belongs to. Returns the signature
 *  string. Order matters — see file header. */
function signatureFor(f: ClusterableFinding): { sig: string; label: string } {
  // 5. False positives short-circuit to suppression (highest priority so we
  //    never spend an LLM call on something we'll suppress).
  if (f.false_positive_class) {
    return {
      sig: `fp:${f.false_positive_class}`,
      label: `Suppress false-positive class: ${f.false_positive_class}`,
    }
  }
  // 1. Same rule + same code shape.
  const shape = codeShape(f.code)
  if (shape) {
    return {
      sig: `rule-shape:${f.rule_id}:${shape}`,
      label: `${f.rule_id}: identical code pattern`,
    }
  }
  // 6. Missing auth by framework.
  if (f.rule_id === "missing-auth" || f.rule_id === "auth-checks") {
    return {
      sig: `auth:${f.framework ?? "unknown"}`,
      label: `Missing auth (${f.framework ?? "framework"} routes)`,
    }
  }
  // 3. Same endpoint.
  if (f.endpoint) {
    return { sig: `endpoint:${f.endpoint}`, label: `Endpoint ${f.endpoint}` }
  }
  // 4. Shared taint path.
  if (f.taint_path_sig) {
    return { sig: `taint:${f.taint_path_sig}`, label: "Shared taint path" }
  }
  // 7. Prompt-contract missing field.
  if (f.missing_contract_field) {
    return {
      sig: `contract:${f.missing_contract_field}`,
      label: `Prompt contract missing '${f.missing_contract_field}'`,
    }
  }
  // 2. Same file + function (catch-all for concentration in one file).
  return {
    sig: `loc:${f.file}:${f.symbol ?? "_"}`,
    label: `${f.file}${f.symbol ? ` › ${f.symbol}()` : ""}`,
  }
}

function pickStrategy(sig: string, members: ClusterableFinding[]): ClusterStrategy {
  if (sig.startsWith("fp:")) return "suppress_batch"
  // If every member is template-coverable, batch deterministically (no LLM).
  if (members.every((m) => m.template_coverable)) return "deterministic_batch"
  return "llm_single_representative"
}

/** Pick the representative: highest severity, then longest code (most
 *  context), then lowest line for determinism. */
function pickRepresentative(members: ClusterableFinding[]): ClusterableFinding {
  const sevRank = { critical: 3, high: 2, medium: 1, low: 0 }
  return [...members].sort((a, b) => {
    const s = sevRank[b.severity] - sevRank[a.severity]
    if (s !== 0) return s
    const c = (b.code?.length ?? 0) - (a.code?.length ?? 0)
    if (c !== 0) return c
    return a.line - b.line
  })[0]
}

/**
 * Cluster a selection of findings. Deterministic — no LLM. The result is
 * the unit of work the bulk pipeline iterates over.
 */
export function clusterFindings(findings: ClusterableFinding[]): FindingCluster[] {
  const bySig = new Map<string, { label: string; members: ClusterableFinding[] }>()

  for (const f of findings) {
    const { sig, label } = signatureFor(f)
    const bucket = bySig.get(sig)
    if (bucket) bucket.members.push(f)
    else bySig.set(sig, { label, members: [f] })
  }

  const clusters: FindingCluster[] = []
  for (const [signature, { label, members }] of bySig) {
    const strategy = pickStrategy(signature, members)
    clusters.push({
      signature,
      strategy,
      rule_id: members[0].rule_id,
      members,
      representative: pickRepresentative(members),
      label: `${label} (${members.length} finding${members.length > 1 ? "s" : ""})`,
    })
  }

  // Order: deterministic/suppress first (instant, free), LLM clusters last,
  // biggest first so the heaviest work starts streaming sooner.
  const stratRank: Record<ClusterStrategy, number> = {
    deterministic_batch: 0,
    suppress_batch: 1,
    llm_single_representative: 2,
  }
  return clusters.sort((a, b) => {
    const s = stratRank[a.strategy] - stratRank[b.strategy]
    return s !== 0 ? s : b.members.length - a.members.length
  })
}

/** How many LLM calls this selection will cost — for the UI estimate. */
export function estimateLlmCalls(clusters: FindingCluster[]): number {
  return clusters.filter((c) => c.strategy === "llm_single_representative").length
}
