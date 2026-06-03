/**
 * Cluster deterministic findings by root cause.
 *
 * Clustering uses, in priority order:
 *   1. the scanner `fingerprint` (sha of rule_id|sink_kind|guard|path)
 *      — present on the RAW report before the client Zod parse strips it;
 *   2. a fallback key of rule_id | file | sink_kind | nearby-line-bucket.
 *
 * Clustering is purely deterministic (no LLM) and never mutates a
 * finding. It only decides which findings share a root cause so the
 * verifier reviews a cluster once instead of every duplicate.
 */
import type { Cluster, ScanFinding } from "./types"

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** Derive a sink kind from the evidence path (last node) or category. */
export function sinkKindOf(f: ScanFinding): string {
  const path = f.evidence_path
  if (Array.isArray(path) && path.length > 0) {
    const sink = [...path].reverse().find((n) => n.kind === "sink")
    if (sink) return sink.label || sink.kind
    return path[path.length - 1]?.kind ?? f.category
  }
  return f.category
}

/** Bucket a line number into a ~25-line window so nearby duplicates of
 *  the same rule in the same file group together. */
function lineBucket(line: number): number {
  return Math.floor((Number.isFinite(line) ? line : 0) / 25)
}

function clusterKey(f: ScanFinding): string {
  if (typeof f.fingerprint === "string" && f.fingerprint) {
    return `fp:${f.fingerprint}`
  }
  return `k:${f.rule_id}|${f.file}|${sinkKindOf(f)}|${lineBucket(f.line)}`
}

function isCrossFile(f: ScanFinding): boolean {
  const path = f.evidence_path
  if (!Array.isArray(path)) return false
  const files = new Set<string>()
  for (const n of path) {
    if (n.file) files.add(n.file)
  }
  return files.size > 1
}

export function clusterFindings(findings: ScanFinding[]): Cluster[] {
  const groups = new Map<string, ScanFinding[]>()
  for (const f of findings) {
    const key = clusterKey(f)
    const arr = groups.get(key)
    if (arr) arr.push(f)
    else groups.set(key, [f])
  }

  const clusters: Cluster[] = []
  let i = 0
  for (const [key, group] of groups) {
    // Representative = highest severity, then highest confidence, then
    // longest evidence path (richest context).
    const representative = [...group].sort((a, b) => {
      const sev = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
      if (sev !== 0) return sev
      const conf = (b.confidence ?? 0) - (a.confidence ?? 0)
      if (conf !== 0) return conf
      return (b.evidence_path?.length ?? 0) - (a.evidence_path?.length ?? 0)
    })[0]

    const maxSeverity = group.reduce<ScanFinding["severity"]>((acc, f) => {
      return (SEVERITY_RANK[f.severity] ?? 9) < (SEVERITY_RANK[acc] ?? 9)
        ? f.severity
        : acc
    }, "low")

    clusters.push({
      id: `cluster-${i++}-${key.slice(0, 24)}`,
      representative,
      findings: group,
      ruleId: representative.rule_id,
      file: representative.file,
      sinkKind: sinkKindOf(representative),
      maxSeverity,
      crossFile: group.some(isCrossFile),
    })
  }
  return clusters
}
