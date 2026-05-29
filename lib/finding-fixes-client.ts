/**
 * Client-side mirror of the fix-engine contract + the fetcher used by
 * the three "Fix" dropdowns (FindingDrawer, Findings table top bar,
 * Behavioral test row).
 *
 * **Hosted-only contract.** The browser NEVER sends `apiKey` /
 * `baseUrl` / `provider`. Hosted AI is included in the user's plan;
 * the server resolves the credential from env.
 *
 * Routed through `apiFetch`, which today keeps fix/patch on the LOCAL
 * server (they read & write the user's files). Their model-generation
 * step is the part that needs the cloud backend — see the
 * "generation/apply split" TODO in docs/DESKTOP-PACKAGING.md.
 */

import { apiFetch } from "@/lib/api-fetch"

export type FixMode = "suggest" | "apply"
export type FixRisk = "safe-insert" | "edits-line" | "no-op"
export type FixErrorKind =
  | "unsupported_file_type"
  | "missing_template"
  | "file_unreadable"
  | "write_failed"
  | "path_escape"

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
  absolute_path: string
  title: string
  description: string
  risk: FixRisk
  before: string
  after: string
  diff: string
  applied: boolean
  error: string | null
  error_kind: FixErrorKind | null
  retryable: boolean
  backup_path: string | null
  /** True when the "fix" is just a TODO/Manual-suggestion comment
   *  (fallback template), NOT a real code change. */
  marker_only: boolean
}

export interface RunFixesResult {
  mode: FixMode
  total: number
  applied: number
  skipped: number
  failed: number
  proposals: FixProposal[]
  /** Hosted contract metadata (never a key). */
  apiKeySource?: "hosted"
  creditsUsed?: number
  quotaRemaining?: number
  /** Set when the resolver refused (plan/quota/missing hosted key). */
  error?: string
  code?: string
  upgrade?: boolean
}

/** Provider kinds the server-side resolver understands. Kept on the
 *  type so older callers compile, but the client never sends this
 *  field anymore — the resolver chooses the provider. */
export type FixProviderKind =
  | "openai_compatible"
  | "anthropic"
  | "google"
  | "custom"

/**
 * Submit a fix request. `mode: "suggest"` is a pure read; `mode: "apply"`
 * writes files (with `.edge-agent.bak` backups) before returning.
 *
 * Hosted contract: no apiKey, no baseUrl, no provider. The server
 * resolves the credential from env.
 */
export async function runFindingFixesApi(args: {
  projectPath: string
  mode: FixMode
  targets: FixTarget[]
  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  manualModelSelection?: Record<string, string>
  manualModels?: Record<string, string>
  signal?: AbortSignal
}): Promise<RunFixesResult> {
  const manualMap = args.manualModelSelection ?? args.manualModels
  const res = await apiFetch("/api/findings/fix", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectPath: args.projectPath,
      mode: args.mode,
      targets: args.targets,
      intelligenceMode: args.intelligenceMode,
      // Hosted contract: aiProviderMode is informational; the server
      // defaults to hosted regardless. We send it for parity with the
      // explain client and to make the wire shape obvious in logs.
      aiProviderMode: "hosted" as const,
      manualModelSelection: manualMap,
      manualModels: manualMap,
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
