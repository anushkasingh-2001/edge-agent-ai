import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import YAML from "yaml"
import {
  applyBranchStashesInWorktree,
  runGit,
  type StashApplyResult,
} from "@/lib/server-git"

/**
 * Phase 3 — Accuracy / runtime evaluation runner.
 *
 * The scanner is static; it can't tell you whether your agent's
 * accuracy improved or its tool selection regressed. For that the
 * user has to actually run their tests. This module wires the
 * "user has tests, app runs them" loop:
 *
 *   1. Read the per-project config at `.edgeagent/evals.yaml`
 *      (one block per agent, each with a shell command to run).
 *   2. Materialise a worktree at the chosen branch's HEAD —
 *      optionally with every `git stash` attributed to that branch
 *      layered on top, so the user can answer "what would my
 *      accuracy be if I committed everything in stashes right now?".
 *   3. Run each agent's command in the worktree with a hard
 *      timeout, parse the JSON the command prints to stdout, and
 *      persist the result to `.edgeagent/eval-history.jsonl`.
 *
 * The expected output JSON shape is documented on `EvalResultSchema`
 * below; every metric except `agent` is optional so a project can
 * start with one number and add more over time without our parser
 * complaining.
 */

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

export const EVALS_CONFIG_REL_PATH = ".edgeagent/evals.yaml"
export const EVAL_HISTORY_REL_PATH = ".edgeagent/eval-history.jsonl"

/**
 * One entry per agent in `.edgeagent/evals.yaml`. Only `command` is
 * required — everything else has a sensible default. We accept loose
 * shapes (extra unknown keys are dropped) so adding new fields
 * later is a non-breaking change.
 */
export const EvalAgentConfigSchema = z.object({
  /** Shell command to invoke (run via `sh -c`). MUST print the
   *  result JSON to stdout. Anything written to stderr is captured
   *  and surfaced for debugging but otherwise ignored. */
  command: z.string().min(1, "command is required"),
  /** Hard wall-clock limit in milliseconds. Default 120s — long
   *  enough for a real test suite, short enough that a hung
   *  process can't pin a worktree forever. */
  timeout_ms: z.number().int().positive().max(30 * 60_000).optional(),
  /** Working directory for the command, RELATIVE to the worktree
   *  root. Defaults to the worktree root itself. Useful when the
   *  eval lives under e.g. `evals/` and the script expects to be
   *  invoked from there. */
  cwd: z.string().optional(),
  /** Extra environment variables. Merged on top of the parent
   *  process env, so the command sees both these and the usual
   *  PATH / HOME / etc. Don't use this for secrets — it ends up
   *  in the persisted history file as part of the run summary
   *  (without values). */
  env: z.record(z.string(), z.string()).optional(),
  /** Self-documenting hint about which metric fields the command
   *  produces. We don't enforce these — the JSON output is the
   *  source of truth — but the UI uses them to decide which
   *  columns to render before the first run. */
  metrics: z
    .object({
      accuracy: z.boolean().optional(),
      runtime_ms: z.boolean().optional(),
      tool_selection: z.boolean().optional(),
    })
    .optional(),
})

export const EvalsConfigSchema = z.object({
  agents: z.record(z.string(), EvalAgentConfigSchema),
})

export type EvalAgentConfig = z.infer<typeof EvalAgentConfigSchema>
export type EvalsConfig = z.infer<typeof EvalsConfigSchema>

export type LoadedEvalsConfig = {
  /** True when `.edgeagent/evals.yaml` exists. False with empty
   *  agents map when it doesn't — the UI uses this to render an
   *  empty-state with copy-pasteable example YAML. */
  exists: boolean
  /** Parsed config. Always has `{ agents: {} }` shape even when
   *  the file is missing or malformed, so callers don't have to
   *  null-check. */
  config: EvalsConfig
  /** Schema or YAML parse errors. Empty when everything parsed
   *  cleanly. Surfaced verbatim to the UI so the user can fix
   *  their YAML without having to dig into server logs. */
  errors: string[]
  /** Absolute path the loader looked at — handy for the empty-
   *  state hint ("create a file at /abs/path/.edgeagent/evals.yaml"). */
  configPath: string
}

export function loadEvalsConfig(projectPath: string): LoadedEvalsConfig {
  const configPath = path.join(projectPath, EVALS_CONFIG_REL_PATH)
  if (!fs.existsSync(configPath)) {
    return {
      exists: false,
      config: { agents: {} },
      errors: [],
      configPath,
    }
  }
  let raw: string
  try {
    raw = fs.readFileSync(configPath, "utf-8")
  } catch (e) {
    return {
      exists: true,
      config: { agents: {} },
      errors: [
        `Failed to read evals.yaml: ${e instanceof Error ? e.message : String(e)}`,
      ],
      configPath,
    }
  }
  let parsed: unknown
  try {
    parsed = YAML.parse(raw)
  } catch (e) {
    return {
      exists: true,
      config: { agents: {} },
      errors: [`YAML parse error: ${e instanceof Error ? e.message : String(e)}`],
      configPath,
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      exists: true,
      config: { agents: {} },
      errors: ["evals.yaml must be a YAML object with an `agents:` key"],
      configPath,
    }
  }
  const result = EvalsConfigSchema.safeParse(parsed)
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join(".") || "<root>"}: ${i.message}`
    )
    return {
      exists: true,
      config: { agents: {} },
      errors,
      configPath,
    }
  }
  return {
    exists: true,
    config: result.data,
    errors: [],
    configPath,
  }
}

/* -------------------------------------------------------------------------- */
/* Result schema (what the user's command must print)                          */
/* -------------------------------------------------------------------------- */

/**
 * The contract the user's eval command writes to stdout. Every
 * field except `agent` is optional — a brand-new project can ship
 * just `accuracy` and we won't reject the run. Numbers outside the
 * obvious ranges (accuracy not in [0, 1] etc.) are passed through
 * as-is rather than rejected; the UI clamps for display. We trust
 * the user knows what their numbers mean.
 */
export const EvalResultSchema = z.object({
  agent: z.string().min(1),
  /** 0..1 fraction of evals that passed end-to-end. */
  accuracy: z.number().optional(),
  /** Per-eval wall-clock latency, milliseconds. p50 + p95 is the
   *  minimum-useful pair: median for "feels like" and p95 for
   *  tail behaviour. p99 / max are accepted but only displayed
   *  when present. */
  runtime_ms_p50: z.number().optional(),
  runtime_ms_p95: z.number().optional(),
  runtime_ms_p99: z.number().optional(),
  runtime_ms_max: z.number().optional(),
  /** 0..1 fraction of evals where the agent picked the right tool
   *  (or right tool sequence, depending on what the user's eval
   *  scores). */
  tool_selection_pass_rate: z.number().optional(),
  /** Absolute counts. `tests_total` doubles as a sanity check on
   *  the percentages above — accuracy=1.0 with tests_total=0 is
   *  always a config bug. */
  tests_total: z.number().int().nonnegative().optional(),
  tests_passed: z.number().int().nonnegative().optional(),
  /** Free-form notes the eval wants to surface. */
  notes: z.string().optional(),
})

export type EvalResult = z.infer<typeof EvalResultSchema>

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export type AgentRunReport = {
  agent: string
  status: "ok" | "non_zero_exit" | "spawn_failed" | "timeout" | "bad_json" | "bad_shape"
  /** Exit code from the spawned process. `null` when we never got
   *  to the spawn / process state (e.g. spawn_failed). */
  exitCode: number | null
  /** Wall-clock duration of the eval command itself (NOT including
   *  worktree setup). Useful as a sanity check against the user's
   *  own runtime numbers. */
  durationMs: number
  /** First 2KB of stderr. We cap the buffer because a chatty
   *  Python eval can dump megabytes of progress text. */
  stderrTail: string
  /** Parsed result if `status === "ok"`. */
  result: EvalResult | null
  /** Human-readable error message — always set when status !==
   *  "ok" so the UI can render a single error string per agent. */
  error: string | null
}

/**
 * Run every agent's command listed in `agents` against `worktreeDir`
 * and return one report per agent. Sequential (not parallel)
 * because evals tend to hit the same Python venv / GPU / API rate
 * limit and stepping on each other produces flaky numbers.
 *
 * The list of agents is whatever the caller passes — `runAllAgents`
 * resolves that against the loaded config; this lower-level helper
 * just runs whatever it's given so you can do "run only SalesAgent"
 * without re-parsing the config.
 */
export function runAgentEvals(args: {
  worktreeDir: string
  agents: Array<{ name: string; config: EvalAgentConfig }>
}): AgentRunReport[] {
  const reports: AgentRunReport[] = []
  for (const { name, config } of args.agents) {
    reports.push(runOneAgent(args.worktreeDir, name, config))
  }
  return reports
}

function runOneAgent(
  worktreeDir: string,
  name: string,
  cfg: EvalAgentConfig
): AgentRunReport {
  const cwd = cfg.cwd
    ? path.resolve(worktreeDir, cfg.cwd)
    : worktreeDir
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return {
      agent: name,
      status: "spawn_failed",
      exitCode: null,
      durationMs: 0,
      stderrTail: "",
      result: null,
      error: `cwd '${cfg.cwd ?? "."}' does not exist inside worktree`,
    }
  }
  const env = {
    ...process.env,
    ...(cfg.env ?? {}),
    // Help eval scripts that want to know where the project root is.
    EDGEAGENT_PROJECT_ROOT: worktreeDir,
    EDGEAGENT_AGENT: name,
  }
  const timeoutMs = cfg.timeout_ms ?? 120_000
  const start = Date.now()
  let proc: ReturnType<typeof spawnSync>
  try {
    // `sh -c` so users can use shell features (pipes, env-var
    // interpolation) the same way they'd test interactively. Bigger
    // maxBuffer than git commands because evals dump test output.
    proc = spawnSync("sh", ["-c", cfg.command], {
      cwd,
      env,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (e) {
    return {
      agent: name,
      status: "spawn_failed",
      exitCode: null,
      durationMs: Date.now() - start,
      stderrTail: "",
      result: null,
      error: `Failed to spawn eval command: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }
  const durationMs = Date.now() - start
  const stderrTail = (proc.stderr ?? "").toString().slice(-2_000)

  // Node's spawnSync surfaces a timeout via `error.code === "ETIMEDOUT"`
  // OR signal === "SIGTERM" depending on platform; check both.
  if (
    (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    proc.signal === "SIGTERM"
  ) {
    return {
      agent: name,
      status: "timeout",
      exitCode: proc.status ?? null,
      durationMs,
      stderrTail,
      result: null,
      error: `Eval command exceeded ${timeoutMs}ms timeout`,
    }
  }

  if (proc.status !== 0) {
    return {
      agent: name,
      status: "non_zero_exit",
      exitCode: proc.status ?? null,
      durationMs,
      stderrTail,
      result: null,
      error: `Eval command exited with code ${proc.status}`,
    }
  }

  // Pull JSON out of stdout. The contract is "command prints JSON",
  // but we tolerate leading text (e.g. pytest's own progress lines)
  // by walking back to the last `{` that opens a complete-looking
  // object. Anything fancier and the user should pipe to `jq` and
  // capture the result themselves.
  const stdout = (proc.stdout ?? "").toString()
  const jsonText = extractJsonObject(stdout)
  if (!jsonText) {
    return {
      agent: name,
      status: "bad_json",
      exitCode: proc.status,
      durationMs,
      stderrTail,
      result: null,
      error:
        "Eval command did not print a JSON object on stdout. Make sure your script writes the result to stdout (not stderr).",
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (e) {
    return {
      agent: name,
      status: "bad_json",
      exitCode: proc.status,
      durationMs,
      stderrTail,
      result: null,
      error: `Failed to parse eval JSON: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }
  const validated = EvalResultSchema.safeParse(parsed)
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ")
    return {
      agent: name,
      status: "bad_shape",
      exitCode: proc.status,
      durationMs,
      stderrTail,
      result: null,
      error: `Eval JSON did not match the expected shape: ${issues}`,
    }
  }
  // Default the agent name to the config key so a script that
  // forgets to echo the agent doesn't crash the row.
  const result: EvalResult = {
    ...validated.data,
    agent: validated.data.agent || name,
  }
  return {
    agent: name,
    status: "ok",
    exitCode: 0,
    durationMs,
    stderrTail,
    result,
    error: null,
  }
}

/**
 * Walk back from the END of a string to find the last balanced
 * `{...}` object. Tolerates a stdout like:
 *
 *   ====== test session starts ======
 *   ........
 *   {"agent": "SalesAgent", "accuracy": 0.91}
 *
 * The parser only needs the last JSON object in stdout, since the
 * contract is "command prints exactly one result object at the
 * end". Returns null if it can't find a parseable object.
 */
function extractJsonObject(stdout: string): string | null {
  const trimmed = stdout.trimEnd()
  if (!trimmed) return null
  // Last `}` is the most-likely end of the JSON object. Walk
  // forward from each candidate `{` to find a matching depth-0
  // close — accept the first that produces valid JSON.
  const lastClose = trimmed.lastIndexOf("}")
  if (lastClose < 0) return null
  // Search for the matching open by depth-counting backwards.
  let depth = 0
  for (let i = lastClose; i >= 0; i--) {
    const c = trimmed[i]
    if (c === "}") depth++
    else if (c === "{") {
      depth--
      if (depth === 0) {
        const candidate = trimmed.slice(i, lastClose + 1)
        try {
          JSON.parse(candidate)
          return candidate
        } catch {
          // Keep searching back — there might be a brace inside a
          // string that confused the simple counter.
        }
      }
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Worktree materialisation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create a detached `git worktree` at `sha` inside the OS temp
 * directory and (optionally) layer every stash attributed to
 * `branch` on top of it. The returned `dir` is the absolute path
 * the caller hands to `runAgentEvals`; `cleanup` MUST be called
 * after the eval run (use try/finally).
 */
export type EvalWorktreeSetup = {
  dir: string
  branch: string
  sha: string
  stashApply: StashApplyResult
  cleanup: () => void
}

export function setupEvalWorktree(args: {
  repo: string
  branch: string
  sha: string
  includeStashes: boolean
}): EvalWorktreeSetup {
  const { repo, branch, sha, includeStashes } = args
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const dir = path.join(os.tmpdir(), `edge-eval-${stamp}`)
  const wt = runGit(repo, ["worktree", "add", "--detach", dir, sha], {
    timeoutMs: 60_000,
  })
  if (wt.status !== 0) {
    throw new Error(
      `git worktree add failed: ${(wt.stderr ?? "").slice(0, 1000).trim()}`
    )
  }
  let stashApply: StashApplyResult = { applied: [], skipped: [] }
  if (includeStashes) {
    stashApply = applyBranchStashesInWorktree(repo, dir, branch)
  }
  const cleanup = () => {
    try {
      spawnSync("git", ["--no-pager", "worktree", "remove", "--force", dir], {
        encoding: "utf-8",
        timeout: 30_000,
      })
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
    try {
      spawnSync("git", ["--no-pager", "-C", repo, "worktree", "prune"], {
        encoding: "utf-8",
        timeout: 10_000,
      })
    } catch {
      /* ignore */
    }
  }
  return { dir, branch, sha, stashApply, cleanup }
}

/* -------------------------------------------------------------------------- */
/* History persistence                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One persisted entry per RUN (which itself contains many per-agent
 * reports). Stored as JSONL so appending is atomic and old entries
 * never have to be rewritten — the API just reads the file and
 * returns the last N lines.
 *
 * Per-run metadata captures everything the user might want to filter
 * by later: branch, SHA, whether stashes were folded in, and a
 * timestamp.
 */
export type PersistedEvalRun = {
  /** UUID-ish stamp so the UI can dedupe / re-render incrementally. */
  id: string
  /** ISO-8601 UTC time the run completed. */
  ranAt: string
  branch: string
  sha: string
  /** True iff stashes were layered onto the worktree. */
  includeStashes: boolean
  /** Refs that ended up applied (oldest → newest). */
  appliedStashes: { ref: string; subject: string }[]
  /** Refs we tried but couldn't (apply conflict against earlier
   *  applied content). */
  skippedStashes: { ref: string; subject: string; reason: string }[]
  /** One report per agent the user asked to run. */
  reports: AgentRunReport[]
}

export const HISTORY_LINE_LIMIT = 500

export function appendEvalRun(
  projectPath: string,
  entry: PersistedEvalRun
): { ok: true } | { ok: false; error: string } {
  const dir = path.join(projectPath, ".edgeagent")
  const file = path.join(projectPath, EVAL_HISTORY_REL_PATH)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    // One line per entry, newline-terminated, so partial writes
    // never produce malformed JSON.
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8")
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: `Failed to append eval history: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }
}

/**
 * Read the last `limit` runs (newest-first) from
 * `.edgeagent/eval-history.jsonl`. Tolerant of malformed lines (a
 * single bad line never blocks the rest); returns [] when the file
 * doesn't exist or is empty.
 */
export function readEvalHistory(
  projectPath: string,
  limit = HISTORY_LINE_LIMIT
): PersistedEvalRun[] {
  const file = path.join(projectPath, EVAL_HISTORY_REL_PATH)
  if (!fs.existsSync(file)) return []
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    return []
  }
  const out: PersistedEvalRun[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as PersistedEvalRun)
    } catch {
      // Bad line — skip silently. We don't want one corrupt entry
      // to turn the whole history view into a 500.
    }
  }
  // Newest-first — the user almost always wants to see the most
  // recent run at the top of the list.
  out.reverse()
  return out.slice(0, limit)
}

export function clearEvalHistory(
  projectPath: string
): { ok: true } | { ok: false; error: string } {
  const file = path.join(projectPath, EVAL_HISTORY_REL_PATH)
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: `Failed to clear eval history: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }
}

/**
 * Generate a short ID for an eval run. Not cryptographic — just
 * needs to be unique within the same millisecond on the same host.
 */
export function newEvalRunId(): string {
  return `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
