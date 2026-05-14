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
import { listUntrackedFiles } from "@/lib/server-untracked-attribution"

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
/**
 * Per-test detail row inside the eval result. The contract is "all
 * fields except `status` are optional", so a brand-new eval that
 * just emits `[{ "status": "pass" }, ...]` works — but the more
 * fields the user populates, the richer the drill-down panel in
 * the Evaluations view becomes.
 *
 * Field semantics:
 *   - `id`          stable identifier (used as React key + filter
 *                   target). Falls back to the row index when missing.
 *   - `name`        human label shown in the row header.
 *   - `status`      pass / fail / skip / error. Drives row colour.
 *                   `error` is for "the test couldn't even run"
 *                   (timeout, exception in setup) vs `fail`
 *                   ("test ran, assertion didn't hold"). UI-wise
 *                   they look similar but the distinction matters
 *                   when the user is debugging "is my eval broken
 *                   or is my agent broken?".
 *   - `runtime_ms`  per-test wall-clock. Lets the UI show a tail-
 *                   latency breakdown without trusting the
 *                   aggregate percentiles.
 *   - `input`       what the agent was asked. Free-form text.
 *   - `expected`    the ground truth the eval compared against.
 *   - `actual`      what the agent returned.
 *   - `error`       traceback / assertion message when status !==
 *                   "pass". Rendered as monospace.
 *   - `tags`        optional category labels ("translation:fr",
 *                   "tool:retrieve") so the UI can group and the
 *                   user can filter beyond just pass/fail.
 *
 * We deliberately don't constrain the shape of `input` / `expected`
 * / `actual` further — different eval types (transcription,
 * translation, QA) will want very different blobs. The UI renders
 * whatever the script provides, monospace, with overflow-scroll.
 */
const EvalTestCaseSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  status: z.enum(["pass", "fail", "skip", "error"]),
  runtime_ms: z.number().nonnegative().optional(),
  input: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  error: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

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
  /** Optional per-test detail rows. When non-empty, the Evaluations
   *  view shows an expand button on the agent card revealing each
   *  test's name / status / runtime / input / expected / actual.
   *  Capped at 1000 entries by the parser to protect the UI from
   *  a runaway eval that emits a row per token. */
  tests: z.array(EvalTestCaseSchema).max(1000).optional(),
})

export type EvalResult = z.infer<typeof EvalResultSchema>
export type EvalTestCase = z.infer<typeof EvalTestCaseSchema>

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export type AgentRunReport = {
  agent: string
  status:
    | "ok"
    | "non_zero_exit"
    | "spawn_failed"
    | "timeout"
    | "bad_json"
    | "bad_shape"
    /** Pre-flight: the agent's `command:` references a script
     *  (e.g. `python evals/foo.py`) that doesn't exist in HEAD,
     *  the user's working tree, or any applied stash. We catch
     *  this BEFORE spawning so the user gets a structured error
     *  with concrete next steps instead of a Python `[Errno 2]`. */
    | "script_not_found"
    /** Post-spawn: shell exited 127 OR stderr matches a "command
     *  not found" / "No such file or directory: <bin>" pattern
     *  for the FIRST token of the command. Almost always means the
     *  user is missing a runtime (vitest, pnpm, python3) — the
     *  fix is "install X" or "swap to a different runner", which
     *  is what this status's error message says verbatim. */
    | "binary_not_found"
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

  // Pre-flight: catch the very common "evals.yaml references a
  // script that hasn't been written yet" failure BEFORE spawning,
  // so the user gets a structured error pointing them at the right
  // file to create instead of a Python `[Errno 2] No such file or
  // directory` traceback in `stderrTail`.
  //
  // Heuristic — match the cases that catch the 95% without
  // false-positives on hand-rolled commands:
  //   1. Tokenise on whitespace (good enough for the shell forms
  //      eval scripts actually use; we deliberately don't try to
  //      parse pipes/redirects/env-prefixes — those produce
  //      multiple script tokens that we just check independently).
  //   2. Keep tokens that contain '/' AND end in a script
  //      extension (.py / .sh / .ts / .js / etc.). Pure-binary
  //      tokens like `python`, `node`, `pnpm` are excluded
  //      automatically (no slash, no script ext). Data files like
  //      `evals/data/foo.jsonl` are also excluded (wrong ext) —
  //      missing data files are the script's problem to surface.
  //   3. Strip surrounding quotes and a leading `./`.
  //   4. Resolve each token relative to the agent's cwd. If it's
  //      absolute, leave it alone.
  //   5. ALL such paths must exist; the first that doesn't blocks
  //      the run.
  const missing = findMissingScriptPaths(cfg.command, cwd)
  if (missing.length > 0) {
    const first = missing[0]
    const more =
      missing.length > 1
        ? ` (also missing: ${missing.slice(1).join(", ")})`
        : ""
    return {
      agent: name,
      status: "script_not_found",
      exitCode: null,
      durationMs: 0,
      stderrTail: "",
      result: null,
      error: `Script '${first}' doesn't exist in HEAD, your working tree, or any applied stash on this branch${more}. Create the file or remove '${name}' from .edgeagent/evals.yaml.`,
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
    // Distinguish "missing binary" from "binary ran and exited
    // non-zero" — the fix is wildly different (install the runtime
    // vs. debug your script) and surfacing it as a typed status
    // saves the user from chasing a misleading exit code.
    //
    // Heuristic — be conservative because evals legitimately exit
    // 127 sometimes:
    //   - exit 127 (POSIX "command not found") AND
    //   - stderr mentions "command not found" or "not found" or
    //     "No such file or directory" AND
    //   - the missing binary is the FIRST shell token of the
    //     user's command (or a binary that appears as a token —
    //     covers pipelines like `pnpm exec vitest | python ...`)
    const missingBin = detectMissingBinary(cfg.command, stderrTail, proc.status)
    if (missingBin) {
      return {
        agent: name,
        status: "binary_not_found",
        exitCode: proc.status ?? null,
        durationMs,
        stderrTail,
        result: null,
        error: `'${missingBin}' isn't on PATH inside the eval worktree. Install it (e.g. \`pip install ${missingBin}\`, \`npm i -g ${missingBin}\`, or activate the right venv) or change '${name}'.command in .edgeagent/evals.yaml to use a binary you have.`,
      }
    }
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
 * Script extensions we treat as "this is the executable the user is
 * invoking". Matching is purely lexical — we don't actually run
 * `file(1)` against the path. Order doesn't matter, but `.py`
 * comes first because it's by far the most common eval shape.
 *
 * Deliberately excludes data extensions like `.json`, `.jsonl`,
 * `.yaml`, `.csv`, `.parquet`. A missing dataset is the script's
 * problem to surface — false-positiving on `--dataset evals/data/
 * foo.jsonl` would block runs the user explicitly wired up.
 */
const SCRIPT_EXTENSIONS = [
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".rb",
  ".pl",
  ".lua",
] as const

/**
 * Best-effort extraction of script paths from a shell command, used
 * by `runOneAgent`'s pre-flight check. Returns the relative paths
 * (as written by the user) of every script-looking token whose
 * resolved path doesn't exist on disk.
 *
 * What counts as a "script-looking token":
 *   - contains a `/` (relative or absolute path; a bare `foo.py`
 *     could be a positional arg to something like `pytest`, so we
 *     skip it to avoid false positives)
 *   - ends in one of `SCRIPT_EXTENSIONS`
 *   - isn't a flag (doesn't start with `-`)
 *   - the token, after stripping surrounding quotes and a leading
 *     `./`, resolves to a path that doesn't exist relative to
 *     `cwd` (or, if it's absolute, doesn't exist at all)
 *
 * Tokenisation is whitespace-only — we don't try to be a real
 * shell parser. Pipes and redirects naturally split into separate
 * tokens, so `... | python evals/foo.py` still finds `evals/foo.py`.
 * The cost is that something cursed like `python "evals/path with
 * spaces/foo.py"` slips through — that's an acceptable miss for
 * 30 lines of code that catches the headline case.
 */
function findMissingScriptPaths(command: string, cwd: string): string[] {
  const found = collectScriptTokens(command)
  const missing: string[] = []
  for (const t of found) {
    const abs = path.isAbsolute(t) ? t : path.resolve(cwd, t)
    if (!fs.existsSync(abs)) {
      missing.push(t)
    }
  }
  return missing
}

/**
 * Same tokeniser as `findMissingScriptPaths` but factored out so the
 * config-time linter (which doesn't want to do disk I/O per agent
 * twice — once for path-doubling detection, once for existence) can
 * consume the token list once and decide what to check itself.
 */
function collectScriptTokens(command: string): string[] {
  const tokens = command.split(/\s+/).filter(Boolean)
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tokens) {
    if (raw.startsWith("-")) continue
    let t = raw
    if (
      (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
      (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
    ) {
      t = t.slice(1, -1)
    }
    if (t.startsWith("./")) t = t.slice(2)
    if (!t.includes("/")) continue
    const lower = t.toLowerCase()
    if (!SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Config linter                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One actionable issue with a single agent's config. Rendered in the
 * Evaluations view as a yellow exclamation badge on the agent card,
 * with the `message` shown on hover/expand. `severity` lets the UI
 * prioritise: errors block "Run" UX-wise (we still let the runner
 * decide for real), warnings just hint.
 *
 * The shape is wire-friendly (plain JSON, no Date objects, no
 * regexes), so we can route it straight through /api/evals/config to
 * the client.
 */
export type AgentLintIssue = {
  /** Stable string ID so the UI can dedupe and pick icons. */
  code:
    | "script_not_found"
    | "cwd_not_found"
    | "path_doubling"
  severity: "error" | "warning"
  message: string
  /** The specific token / path the issue is about, if any. Lets the
   *  UI render it in monospace inline with the message. */
  ref?: string
}

/**
 * Walk every agent in `config` and flag the issues that the runner
 * would otherwise discover the hard way. Pure file-system checks
 * against the live working tree under `projectPath` — no git, no
 * spawning. Cheap enough to run on every config GET.
 *
 * Detected issues:
 *
 *   - `script_not_found` (error) — same logic as the runtime
 *     pre-flight, but reported to the UI BEFORE the user clicks
 *     Run so they see "this agent will fail" up front.
 *   - `cwd_not_found` (error) — `cwd:` points at a directory that
 *     doesn't exist relative to the project. Spawn would fail with
 *     "spawn_failed: cwd '...' does not exist".
 *   - `path_doubling` (warning) — `cwd: "evals"` plus a command
 *     containing a token that starts with `evals/` is almost
 *     always a copy-paste bug (resolves to `evals/evals/...`). We
 *     warn rather than error because there's a tiny chance the
 *     user genuinely wants the deeper path.
 */
export function lintEvalsConfig(
  projectPath: string,
  config: EvalsConfig
): Record<string, AgentLintIssue[]> {
  const result: Record<string, AgentLintIssue[]> = {}
  for (const [name, cfg] of Object.entries(config.agents)) {
    const issues: AgentLintIssue[] = []
    const cwd = cfg.cwd
      ? path.resolve(projectPath, cfg.cwd)
      : projectPath

    /* cwd_not_found ------------------------------------------------ */
    if (
      cfg.cwd &&
      (!fs.existsSync(cwd) ||
        (() => {
          try {
            return !fs.statSync(cwd).isDirectory()
          } catch {
            return true
          }
        })())
    ) {
      issues.push({
        code: "cwd_not_found",
        severity: "error",
        message: `cwd '${cfg.cwd}' doesn't exist or isn't a directory in your project`,
        ref: cfg.cwd,
      })
    }

    /* path_doubling (cwd-vs-command prefix overlap) ---------------- */
    // Only meaningful when cwd exists; if cwd is missing we already
    // surfaced that and re-flagging the doubling would just be noise.
    if (cfg.cwd && fs.existsSync(cwd)) {
      const cwdNorm = cfg.cwd.replace(/^\.\//, "").replace(/\/$/, "")
      if (cwdNorm && cwdNorm !== ".") {
        const prefix = cwdNorm + "/"
        for (const token of collectScriptTokens(cfg.command)) {
          if (token.startsWith(prefix)) {
            issues.push({
              code: "path_doubling",
              severity: "warning",
              message: `Command path '${token}' starts with the cwd '${cwdNorm}/' — that resolves to '${cwdNorm}/${token}'. Did you mean '${token.slice(prefix.length)}'?`,
              ref: token,
            })
          }
        }
      }
    }

    /* script_not_found -------------------------------------------- */
    // Skip if cwd_not_found already fired — paths can't resolve
    // against a missing cwd, so the doubling/existence check would
    // produce false positives.
    if (!issues.some((i) => i.code === "cwd_not_found")) {
      for (const missing of findMissingScriptPaths(cfg.command, cwd)) {
        issues.push({
          code: "script_not_found",
          severity: "error",
          message: `Script '${missing}' doesn't exist on disk. Create the file or remove '${name}' from .edgeagent/evals.yaml.`,
          ref: missing,
        })
      }
    }

    if (issues.length > 0) result[name] = issues
  }
  return result
}

/**
 * Best-effort "did the shell fail because a binary the user invoked
 * doesn't exist?" detector for `runOneAgent`. Returns the offending
 * binary name on a hit, or `null` on no-hit.
 *
 * Conditions (all must hold to avoid false positives — non-zero
 * exit codes are common in evals that legitimately fail tests):
 *
 *   1. `exitCode === 127` (POSIX "command not found"). bash/zsh/sh
 *      use this consistently. We don't try to handle 126 (found but
 *      not executable) — that one's rare and the error message
 *      would still be misleading.
 *   2. stderr mentions one of three canonical phrasings:
 *        - `command not found`            (bash, zsh)
 *        - `: not found`                  (POSIX sh / dash)
 *        - `No such file or directory`    (busybox, some shells)
 *      AND the offending binary token appears in stderr next to
 *      the phrasing.
 *   3. The detected binary token also appears as a non-flag,
 *      slash-free token in the user's `command:` string. This rules
 *      out cases where a SCRIPT (e.g. `python evals/foo.py`) goes
 *      missing AND prints a "no such file or directory" inside its
 *      own logic — those should still surface as `non_zero_exit`
 *      because the binary itself ran fine.
 */
function detectMissingBinary(
  command: string,
  stderrTail: string,
  exitCode: number | null
): string | null {
  if (exitCode !== 127) return null
  if (!stderrTail) return null

  const commandTokens = new Set(
    command
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => {
        // strip surrounding quotes
        let s = t
        if (
          (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
          (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
        ) {
          s = s.slice(1, -1)
        }
        return s
      })
      .filter((t) => !t.startsWith("-") && !t.includes("/"))
  )
  if (commandTokens.size === 0) return null

  // bash:  "<bin>: command not found"
  // zsh:   "zsh: command not found: <bin>"
  // dash:  "sh: 1: <bin>: not found"
  // also catches: "/bin/sh: <bin>: command not found"
  const patterns: RegExp[] = [
    /(?:^|[\s:])([\w.+-]+):\s*command not found/i,
    /command not found:\s*([\w.+-]+)/i,
    /(?:^|[\s:])([\w.+-]+):\s*not found/i,
  ]
  for (const re of patterns) {
    const m = stderrTail.match(re)
    if (m && m[1] && commandTokens.has(m[1])) {
      return m[1]
    }
  }
  return null
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
 * directory and optionally layer extra material on top:
 *
 *   - When `includeWorkingTree: true` (default) — mirror every
 *     tracked-modified file and every untracked file from the
 *     user's REAL working tree into the worktree. This is what
 *     the user almost always wants when iterating on an eval
 *     script that's not yet committed: "run THIS code in front
 *     of me", not "run a snapshot of HEAD that doesn't include
 *     my new file". Matches the same pattern `/api/scan` uses
 *     for virtual checkouts.
 *
 *   - When `includeStashes: true` — apply every `git stash`
 *     attributed to `branch` on top of the worktree (oldest →
 *     newest, latest wins on per-file conflicts). Same model as
 *     Branch Compare.
 *
 * Both flags can be combined. The order of operations is HEAD
 * → working-tree mirror → stashes, so a stash for a file the
 * user has also modified locally will WIN, mirroring what the
 * user would see if they ran `git stash pop` themselves.
 *
 * The returned `dir` is the absolute path the caller hands to
 * `runAgentEvals`; `cleanup` MUST be called after the eval run
 * (use try/finally).
 */
export type EvalWorktreeSetup = {
  dir: string
  branch: string
  sha: string
  stashApply: StashApplyResult
  /** Files mirrored in from the user's working tree (relative
   *  paths). Empty when `includeWorkingTree: false` or when the
   *  working tree was already clean. The route surfaces this list
   *  so the UI can show "ran with N uncommitted files mirrored
   *  in". */
  mirroredFiles: string[]
  cleanup: () => void
}

export function setupEvalWorktree(args: {
  repo: string
  branch: string
  sha: string
  includeStashes: boolean
  /** Default: true. When true, copies tracked-modified +
   *  untracked files from the user's real working tree into the
   *  eval worktree before running. When false, scans pristine
   *  HEAD only — useful for "what would my accuracy be if I
   *  merged the PR right now?". */
  includeWorkingTree?: boolean
}): EvalWorktreeSetup {
  const {
    repo,
    branch,
    sha,
    includeStashes,
    includeWorkingTree = true,
  } = args
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

  /* ---- Mirror the user's working tree ---------------------- */
  // Both tracked-modified AND untracked, because "run my eval
  // script" is the headline use case. Paths come back relative
  // to the repo root so we can join them onto the worktree dir
  // 1:1. Best-effort copy — a file we can't read just gets
  // skipped rather than failing the whole run.
  const mirroredFiles: string[] = []
  if (includeWorkingTree) {
    const seen = new Set<string>()
    // Tracked-modified files: `git diff --name-only HEAD` lists
    // anything in the working tree that differs from HEAD,
    // including staged changes. `-z` for safe \0-delimited paths.
    const modProc = runGit(
      repo,
      ["diff", "--name-only", "--no-renames", "-z", "HEAD"],
      { timeoutMs: 15_000 }
    )
    if (modProc.status === 0) {
      for (const rel of (modProc.stdout ?? "").split("\0")) {
        const r = rel.trim()
        if (r && !seen.has(r)) seen.add(r)
      }
    }
    // Untracked files (respecting .gitignore via
    // --exclude-standard, plus our own internal-paths filter
    // baked into listUntrackedFiles).
    for (const rel of listUntrackedFiles(repo)) {
      if (!seen.has(rel)) seen.add(rel)
    }

    for (const rel of seen) {
      const src = path.join(repo, rel)
      const dst = path.join(dir, rel)
      try {
        if (!fs.existsSync(src)) continue
        const st = fs.statSync(src)
        if (!st.isFile()) continue
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
        mirroredFiles.push(rel)
      } catch {
        /* swallow — best-effort. A single unreadable file
           shouldn't sink the whole eval run. */
      }
    }
    mirroredFiles.sort()
  }

  /* ---- Layer stashes ON TOP of the mirrored working tree --- */
  // Apply order matters: HEAD → working-tree mirror → stashes,
  // so a stash containing a newer version of the same file the
  // user just edited locally wins. Mirrors what `git stash pop`
  // would do.
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
  return { dir, branch, sha, stashApply, mirroredFiles, cleanup }
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
  /** True iff the user's tracked-modified + untracked files were
   *  mirrored into the worktree before running. Defaults to true
   *  for new runs; absent on legacy entries (treat as `true` for
   *  display since pre-mirror runs effectively scanned HEAD only
   *  but the field didn't exist yet). */
  includeWorkingTree?: boolean
  /** Files (relative to repo root) copied from the user's real
   *  working tree into the eval worktree. Empty when the working
   *  tree was clean OR when `includeWorkingTree: false`. Absent
   *  on legacy entries. */
  mirroredFiles?: string[]
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
