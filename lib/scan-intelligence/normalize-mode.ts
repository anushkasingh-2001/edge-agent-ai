/**
 * Map any incoming mode string to a canonical scan-time `ScanMode`.
 *
 * Legacy compatibility (per spec section D):
 *   save  -> lite
 *   auto  -> balanced
 *   pro   -> deep
 *   max   -> exhaustive
 *   manual-> balanced  (advanced/manual fallback for scan-time today)
 *
 * Unknown / missing values default to "balanced" — the recommended
 * everyday mode — so a stray request never crashes the scan.
 */
import type { ScanMode } from "./types"

const LEGACY_TO_SCAN: Record<string, ScanMode> = {
  // Legacy wire ids.
  save: "lite",
  auto: "balanced",
  pro: "deep",
  max: "exhaustive",
  manual: "balanced",
  // Canonical ids (idempotent).
  lite: "lite",
  balanced: "balanced",
  deep: "deep",
  exhaustive: "exhaustive",
}

export function normalizeScanMode(raw: unknown): ScanMode {
  if (typeof raw !== "string") return "balanced"
  const key = raw.trim().toLowerCase()
  return LEGACY_TO_SCAN[key] ?? "balanced"
}

/** Friendly label for the UI / summaries. */
export function scanModeLabel(mode: ScanMode): string {
  switch (mode) {
    case "lite":
      return "Lite"
    case "balanced":
      return "Balanced"
    case "deep":
      return "Deep"
    case "exhaustive":
      return "Exhaustive"
  }
}
