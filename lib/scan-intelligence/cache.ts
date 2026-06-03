/**
 * In-process cache for verifier and gap-audit results.
 *
 * Keyed by context_hash + model + mode + phase, so re-running the same
 * scan (or re-scanning unchanged code) reuses the LLM verdict instead of
 * paying for another call. Results are marked `cached: true` when served
 * from here.
 *
 * Scope is intentionally process-local (a single scan, or a warm dev
 * server). It is bounded so a long-lived server can't grow without
 * limit. Persistence to disk under EDGE_AGENT_HOME could be layered on
 * later; the interface stays the same.
 */
const MAX_ENTRIES = 2_000

type Phase = "verify" | "gap_audit"

const store = new Map<string, unknown>()

function key(parts: {
  phase: Phase
  contextHash: string
  model: string
  mode: string
}): string {
  return `${parts.phase}|${parts.mode}|${parts.model}|${parts.contextHash}`
}

export function getCached<T>(parts: {
  phase: Phase
  contextHash: string
  model: string
  mode: string
}): T | null {
  const k = key(parts)
  return store.has(k) ? (store.get(k) as T) : null
}

export function setCached<T>(
  parts: { phase: Phase; contextHash: string; model: string; mode: string },
  value: T,
): void {
  if (store.size >= MAX_ENTRIES) {
    // Evict the oldest entry (insertion order) — cheap LRU-ish bound.
    const first = store.keys().next().value
    if (first !== undefined) store.delete(first)
  }
  store.set(key(parts), value)
}

/** @internal Clear the cache between tests. */
export function _clearScanCacheForTests(): void {
  store.clear()
}
