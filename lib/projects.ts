export type ProjectSource = "local" | "github"

export type Project = {
  id: string
  name: string
  path: string
  source: ProjectSource
  githubUrl?: string
  branch?: string
  lastOpenedAt: string
}

const STORAGE_KEY = "edge-agent-ai.recentProjects"
const MAX_ENTRIES = 12

/**
 * Names that used to be hardcoded in the v0 mock UI. We never want them to
 * appear in the recent-projects list, even if they were persisted before this
 * fix landed.
 */
const DUMMY_PROJECT_NAMES: ReadonlySet<string> = new Set([
  "customer-service-agent",
  "code-review-bot",
  "data-analyst-agent",
])

function isProject(value: unknown): value is Project {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.path === "string" &&
    (v.source === "local" || v.source === "github") &&
    typeof v.lastOpenedAt === "string" &&
    (v.githubUrl === undefined || typeof v.githubUrl === "string") &&
    (v.branch === undefined || typeof v.branch === "string")
  )
}

function isRealProject(p: Project): boolean {
  // Reject anything matching the v0 mock names or with an obviously fake path.
  if (DUMMY_PROJECT_NAMES.has(p.name)) return false
  if (!p.path || p.path.trim() === "") return false
  return true
}

function safeParse(raw: string | null): Project[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data.filter(isProject).filter(isRealProject)
  } catch {
    return []
  }
}

/**
 * Load recent projects from localStorage. Silently rewrites storage if the
 * cleaned list differs from what was on disk (drops legacy dummy entries).
 */
export function loadRecentProjects(): Project[] {
  if (typeof window === "undefined") return []
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const cleaned = safeParse(raw)
  if (raw !== null && raw !== JSON.stringify(cleaned)) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned))
    } catch {
      /* ignore quota / serialization issues */
    }
  }
  return cleaned
}

export function saveRecentProject(entry: Project): void {
  if (typeof window === "undefined") return
  if (!isRealProject(entry)) return
  const existing = loadRecentProjects().filter((p) => p.path !== entry.path)
  const next = [entry, ...existing].slice(0, MAX_ENTRIES)
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function clearRecentProjects(): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(STORAGE_KEY)
}

export function projectIdFromPath(path: string): string {
  // Stable id derived from absolute path
  let h = 0
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) | 0
  }
  return `proj_${(h >>> 0).toString(36)}`
}

export function formatRecentTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  } catch {
    return ""
  }
}
