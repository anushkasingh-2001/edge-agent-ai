import type { Project } from "./projects"
import type { ScanReport } from "./scan-report"

export type ScanIntelligenceMode = "save" | "auto" | "pro" | "max" | "manual"
export type ScanAiProviderMode = "hosted" | "byok"

/** Mode/provider metadata stamped onto each scan, surfaced in the
 *  Findings tab and reused as the re-scan default. Optional so legacy
 *  entries still load. */
export interface ScanModeMetadata {
  intelligenceMode: ScanIntelligenceMode
  modeLabel: string
  aiProviderMode: ScanAiProviderMode
  manualModelSelection?: Record<string, string>
  estimatedCost?: number
  actualCost?: number
  creditsUsed?: number
}

export type ScanHistoryItem = {
  id: string
  projectId: string
  projectName: string
  projectPath: string
  branch: string
  timestamp: string // ISO 8601
  riskScore: number
  summary: ScanReport["summary"]
  findingCount: number
  report: ScanReport
  /** Intelligence-mode + AI-provider metadata for this scan. */
  meta?: ScanModeMetadata
}

export const MODE_LABELS: Record<ScanIntelligenceMode, string> = {
  save: "Save / Deterministic+Explain",
  auto: "Auto / Smart Routing",
  pro: "Pro / High Accuracy",
  max: "Max / Deep Review",
  manual: "Manual / Select Model",
}

const STORAGE_KEY = "edge-agent-ai.scanHistory"
/** Hard cap on stored scans to keep localStorage bounded. */
const MAX_ENTRIES = 20

function isItem(value: unknown): value is ScanHistoryItem {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.projectId === "string" &&
    typeof v.projectName === "string" &&
    (typeof v.projectPath === "string" ||
      // Tolerate legacy entries that didn't carry projectPath; fall back to
      // the report's scan_root so we can still render them.
      (typeof v.report === "object" &&
        v.report !== null &&
        typeof (v.report as { scan_root?: unknown }).scan_root === "string")) &&
    typeof v.branch === "string" &&
    typeof v.timestamp === "string" &&
    typeof v.riskScore === "number" &&
    typeof v.findingCount === "number" &&
    typeof v.summary === "object" &&
    v.summary !== null &&
    typeof v.report === "object" &&
    v.report !== null
  )
}

function normalize(item: ScanHistoryItem): ScanHistoryItem {
  // Backfill projectPath from the report root for legacy entries.
  if (!item.projectPath || item.projectPath.trim() === "") {
    return { ...item, projectPath: item.report?.scan_root ?? "" }
  }
  return item
}

function safeParse(raw: string | null): ScanHistoryItem[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data.filter(isItem).map(normalize)
  } catch {
    return []
  }
}

/** Load scan history newest-first (sorted descending by timestamp). */
export function loadScanHistory(): ScanHistoryItem[] {
  if (typeof window === "undefined") return []
  const items = safeParse(window.localStorage.getItem(STORAGE_KEY))
  return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

/**
 * Append a scan to history, dedupe by id, sort newest-first, cap at
 * MAX_ENTRIES, and handle localStorage quota errors by progressively
 * dropping older entries until the write succeeds.
 */
export function appendScanToHistory(
  item: ScanHistoryItem
): ScanHistoryItem[] {
  if (typeof window === "undefined") return [item]
  const existing = loadScanHistory().filter((s) => s.id !== item.id)
  let next = [item, ...existing]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_ENTRIES)
  // Try writes with progressively smaller windows on quota errors. The full
  // report payload can be sizeable; better to lose old scans than fail loudly.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    } catch (e) {
      const isQuota =
        e instanceof DOMException &&
        (e.name === "QuotaExceededError" ||
          e.name === "NS_ERROR_DOM_QUOTA_REACHED")
      if (!isQuota || next.length <= 1) {
        // Give up rather than corrupt the store. Caller still gets the
        // in-memory list back.
        return next
      }
      next = next.slice(0, Math.max(1, Math.floor(next.length / 2)))
    }
  }
  return next
}

export function clearScanHistory(): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(STORAGE_KEY)
}

/** Return only the entries belonging to a given project. Caller already
 * gets newest-first ordering from `loadScanHistory`. */
export function scanHistoryForProject(
  history: ScanHistoryItem[],
  projectId: string | null | undefined
): ScanHistoryItem[] {
  if (!projectId) return []
  return history.filter((s) => s.projectId === projectId)
}

/** Build a history item for a freshly-completed scan. */
export function scanItemFromReport(
  report: ScanReport,
  project: Project,
  branch: string,
  meta?: ScanModeMetadata
): ScanHistoryItem {
  return {
    id: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    branch,
    timestamp: report.generated_at || new Date().toISOString(),
    riskScore: report.risk_score,
    summary: report.summary,
    findingCount: report.summary.total,
    report,
    meta,
  }
}

export function formatScanTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  } catch {
    return iso
  }
}
