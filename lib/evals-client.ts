/**
 * Typed fetchers for the /api/evals/* endpoints. Mirrors the
 * server-side types in `lib/server-evals.ts` but with the JSON
 * shapes only (no Node-only types like `spawnSync` results).
 */

/**
 * Per-agent config-time lint finding produced by `lintEvalsConfig`
 * on the server (see lib/server-evals.ts). Surfaced through
 * /api/evals/config so the Evaluations view can render warnings on
 * each agent card BEFORE the user clicks Run.
 */
export type AgentLintIssue = {
  code: "script_not_found" | "cwd_not_found" | "path_doubling"
  severity: "error" | "warning"
  message: string
  /** The exact token / path the issue is about, if any. */
  ref?: string
}

export type EvalConfigEntry = {
  name: string
  command: string
  timeoutMs: number | null
  cwd: string | null
  metrics: {
    accuracy?: boolean
    runtime_ms?: boolean
    tool_selection?: boolean
  } | null
  /** Names of env vars the user defined for this agent. Values are
   *  stripped server-side to avoid leaking secrets. */
  envKeys: string[]
  /** Config-time lint findings for THIS agent. Empty array means
   *  the agent looks healthy as far as static checks go (it can
   *  still fail at runtime — the runner does its own checks). */
  lint: AgentLintIssue[]
}

export type EvalsConfigResponse = {
  /** True when `.edgeagent/evals.yaml` exists. */
  exists: boolean
  /** Absolute path the server looked at — surfaced for the empty
   *  state ("create a file at /abs/path"). */
  configPath: string
  /** Canonical relative path (`.edgeagent/evals.yaml`). */
  configRelPath: string
  agents: EvalConfigEntry[]
  /** YAML / schema errors. Empty when the config parsed cleanly. */
  errors: string[]
  /** Top-level error (e.g. invalid project path). Mutually exclusive
   *  with the fields above. */
  error?: string
}

/**
 * Per-test row in `EvalResultJson.tests`. Mirrors the server's
 * `EvalTestCase` shape (see `lib/server-evals.ts`); kept as a
 * separate `type` so client code never has to import server-only
 * Zod schemas.
 *
 * Only `status` is required; the more fields the eval populates,
 * the richer the drill-down panel becomes.
 */
export type EvalTestCase = {
  id?: string
  name?: string
  status: "pass" | "fail" | "skip" | "error"
  runtime_ms?: number
  input?: string
  expected?: string
  actual?: string
  error?: string
  tags?: string[]
}

export type EvalResultJson = {
  agent: string
  accuracy?: number
  runtime_ms_p50?: number
  runtime_ms_p95?: number
  runtime_ms_p99?: number
  runtime_ms_max?: number
  tool_selection_pass_rate?: number
  tests_total?: number
  tests_passed?: number
  notes?: string
  /** Optional per-test rows. Capped server-side at 1000. Empty
   *  / undefined means the eval only emitted aggregates. */
  tests?: EvalTestCase[]
}

export type AgentRunReport = {
  agent: string
  status:
    | "ok"
    | "non_zero_exit"
    | "spawn_failed"
    | "timeout"
    | "bad_json"
    | "bad_shape"
    /** Pre-flight catch: the agent's `command:` references a
     *  script that doesn't exist anywhere on disk (HEAD,
     *  working tree, or any applied stash). Surfaced separately
     *  so the UI can render a "create the file or remove this
     *  agent" hint instead of a Python `[Errno 2]`. */
    | "script_not_found"
    /** Post-spawn: the BINARY (vitest, pnpm, python3, etc.) that
     *  the user's command tries to invoke isn't on PATH inside the
     *  eval worktree. Distinguished from `non_zero_exit` so the UI
     *  can suggest "install X" instead of "debug your script". */
    | "binary_not_found"
  exitCode: number | null
  durationMs: number
  stderrTail: string
  result: EvalResultJson | null
  error: string | null
}

export type PersistedEvalRun = {
  id: string
  ranAt: string
  branch: string
  sha: string
  includeStashes: boolean
  /** True iff the user's tracked-modified + untracked files were
   *  mirrored into the worktree before running. Optional /
   *  defaults to `true` for legacy entries written before the
   *  field existed. */
  includeWorkingTree?: boolean
  /** Files (relative to repo root) copied from the user's real
   *  working tree into the eval worktree. Empty when the working
   *  tree was clean OR when `includeWorkingTree: false`. */
  mirroredFiles?: string[]
  appliedStashes: { ref: string; subject: string }[]
  skippedStashes: { ref: string; subject: string; reason: string }[]
  reports: AgentRunReport[]
}

export type EvalRunResponse =
  | {
      ok: true
      run: PersistedEvalRun
      historyWritten: boolean
      historyError: string | null
    }
  | {
      ok: false
      error: string
      configPath?: string
      errors?: string[]
    }

export type EvalHistoryResponse = {
  runs: PersistedEvalRun[]
  limit: number
  error?: string
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as
    | (T & { error?: string })
    | { error?: string }
  if (!res.ok) {
    const msg =
      (data && "error" in data && typeof data.error === "string"
        ? data.error
        : null) || `Request failed with status ${res.status}`
    throw new Error(msg)
  }
  return data as T
}

export async function fetchEvalsConfig(
  projectPath: string
): Promise<EvalsConfigResponse> {
  const url = `/api/evals/config?projectPath=${encodeURIComponent(projectPath)}`
  const res = await fetch(url, { method: "GET" })
  return jsonOrThrow<EvalsConfigResponse>(res)
}

export async function runEvals(args: {
  projectPath: string
  branch?: string
  agents?: string[]
  /** When true the server layers every `git stash` attributed to
   *  `branch` onto the worktree before running the eval commands.
   *  No-op when the branch has zero stashes. */
  includeStashes?: boolean
  /** When true (DEFAULT — omit to get this behaviour) the server
   *  also mirrors the user's tracked-modified + untracked files
   *  from the real working tree into the eval worktree, so an
   *  uncommitted `evals/run_my_eval.py` actually runs. Pass
   *  `false` to score pristine HEAD only. */
  includeWorkingTree?: boolean
}): Promise<EvalRunResponse> {
  const res = await fetch("/api/evals/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  // 4xx responses (e.g. missing config) carry a structured `{ ok:
  // false, error }` payload — surface that instead of throwing so
  // the UI can render an inline message.
  return (await res.json()) as EvalRunResponse
}

export async function fetchEvalsHistory(args: {
  projectPath: string
  limit?: number
}): Promise<EvalHistoryResponse> {
  const params = new URLSearchParams({ projectPath: args.projectPath })
  if (args.limit) params.set("limit", String(args.limit))
  const res = await fetch(`/api/evals/history?${params.toString()}`)
  return jsonOrThrow<EvalHistoryResponse>(res)
}

export async function clearEvalsHistory(
  projectPath: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `/api/evals/history?projectPath=${encodeURIComponent(projectPath)}`,
    { method: "DELETE" }
  )
  return (await res.json().catch(() => ({ ok: false, error: "bad json" }))) as {
    ok: boolean
    error?: string
  }
}
