/**
 * Client-side mirror of the fix-engine contract + the fetcher used by
 * the three "Fix" dropdowns (FindingDrawer, Findings table top bar,
 * Behavioral test row).
 */

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
   *  (fallback template), NOT a real code change. The UI uses this to
   *  render "Manual suggestion" instead of "Applied" and to leave the
   *  finding in the table — a TODO marker doesn't clear the finding.
   *  Always present (default false) so consumers can rely on it. */
  marker_only: boolean
}

export interface RunFixesResult {
  mode: FixMode
  total: number
  applied: number
  skipped: number
  failed: number
  proposals: FixProposal[]
}

/** Provider kinds the server-side resolver understands today. Mirrors
 *  ``ProviderKind`` in ``lib/server-model-router.ts``; redefined here
 *  so client code doesn't import server-only modules. */
export type FixProviderKind =
  | "openai_compatible"
  | "anthropic"
  | "google"
  | "custom"

/**
 * Submit a fix request. `mode: "suggest"` is a pure read; `mode: "apply"`
 * writes files (with `.edge-agent.bak` backups) before returning.
 */
export async function runFindingFixesApi(args: {
  projectPath: string
  mode: FixMode
  targets: FixTarget[]
  /** Intelligence mode selected in the Findings toolbar. Server uses
   *  it to size context, pick model tier, and decide whether the LLM
   *  patch path runs at all. */
  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  /** Retained on the type for legacy callers. The server forces
   *  BYOK regardless; this is just informational. */
  aiProviderMode?: "hosted" | "byok"
  /** BYOK provider type (openai_compatible / anthropic / google /
   *  custom). Always forwarded — required when the mode actually
   *  needs an LLM call. */
  provider?: FixProviderKind
  /** Caller's API key from Settings. REQUIRED for any AI upgrade
   *  (Auto/Pro/Max/Manual) — the route returns a structured
   *  ``missing_api_key`` error when omitted, which we surface as
   *  the canonical CTA in the UI. */
  apiKey?: string
  /** Optional override for OpenAI-compatible endpoints (Together,
   *  Groq, Ollama, etc). Forwarded alongside ``apiKey``. */
  baseUrl?: string
  /** Manual-mode per-task model picks. Both ``manualModelSelection``
   *  (canonical) and ``manualModels`` (legacy alias) are accepted and
   *  forwarded. */
  manualModelSelection?: Record<string, string>
  /** Backward-compat alias; same shape as ``manualModelSelection``. */
  manualModels?: Record<string, string>
  signal?: AbortSignal
}): Promise<RunFixesResult> {
  // Normalise the manual map: a caller may pass either name. The
  // server normalises again, but doing it here keeps the wire payload
  // stable. BYOK fields are always forwarded — the server is the
  // single point of truth for "is this key/model valid?".
  const manualMap = args.manualModelSelection ?? args.manualModels
  const res = await fetch("/api/findings/fix", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectPath: args.projectPath,
      mode: args.mode,
      targets: args.targets,
      intelligenceMode: args.intelligenceMode,
      // BYOK-only post-MVP. We still send the field so older server
      // builds that branched on it stay compatible.
      aiProviderMode: "byok",
      provider: args.provider,
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      manualModelSelection: manualMap,
      // Backward-compat for the legacy patch name. Server normalises both.
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
