/**
 * Client-side mirror of the fix-engine contract + the fetcher used by
 * the three "Fix" dropdowns (FindingDrawer, Findings table top bar,
 * Behavioral test row).
 */

export type FixMode = "suggest" | "apply"
export type FixRisk = "safe-insert" | "edits-line" | "no-op"

export interface FixTarget {
  ref_id: string
  rule_id: string
  file: string
  line: number
  title?: string
}

export interface FixProposal {
  ref_id: string
  rule_id: string
  file: string
  line: number
  title: string
  description: string
  risk: FixRisk
  before: string
  after: string
  diff: string
  applied: boolean
  error: string | null
  backup_path: string | null
}

export interface RunFixesResult {
  mode: FixMode
  total: number
  applied: number
  skipped: number
  failed: number
  proposals: FixProposal[]
}

/**
 * Submit a fix request. `mode: "suggest"` is a pure read; `mode: "apply"`
 * writes files (with `.edge-agent.bak` backups) before returning.
 */
export async function runFindingFixesApi(args: {
  projectPath: string
  mode: FixMode
  targets: FixTarget[]
  signal?: AbortSignal
}): Promise<RunFixesResult> {
  const res = await fetch("/api/findings/fix", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectPath: args.projectPath,
      mode: args.mode,
      targets: args.targets,
    }),
    signal: args.signal,
  })
  if (!res.ok) {
    let message: string | null = null
    try {
      const j = (await res.json()) as { error?: string }
      message = j?.error ?? null
    } catch {
      /* ignore */
    }
    throw new Error(message ?? `Fix request failed (HTTP ${res.status})`)
  }
  return (await res.json()) as RunFixesResult
}

export function riskTone(r: FixRisk): {
  label: string
  badge: string
  hint: string
} {
  switch (r) {
    case "safe-insert":
      return {
        label: "Safe insert",
        badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
        hint: "Adds a fenced guard block above the offending line. Never rewrites the original line — worst case the inserted block is unused.",
      }
    case "edits-line":
      return {
        label: "Edits line",
        badge: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
        hint: "Rewrites the original line in place. Review the diff before applying.",
      }
    case "no-op":
      return {
        label: "No-op",
        badge:
          "bg-muted-foreground/10 text-muted-foreground border-muted-foreground/20",
        hint: "Nothing to change — typically because a previous fix marker is already in place or the file type isn't supported.",
      }
  }
}
