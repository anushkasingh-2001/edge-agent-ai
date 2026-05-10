import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {
  expandUserPath,
  getScanAllowRoot,
  isPathInside,
} from "@/lib/server-path-utils"

/**
 * Server-side git helpers used by /api/git/*.
 *
 * Every shell invocation goes through `runGit(cwd, args, opts)` which:
 *   - calls `git` directly (no shell, no string interpolation)
 *   - prefixes `--no-pager` so we never get an interactive paginator
 *   - uses `-C <cwd>` so the project directory is explicit
 *   - enforces a hard timeout and a stdout buffer cap
 *
 * Refs and relative paths coming from the frontend are validated with the
 * narrow allow-lists below before being handed to git.
 */

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024 // 10 MiB

export class GitError extends Error {
  status: number
  stderr: string
  constructor(message: string, status = 500, stderr = "") {
    super(message)
    this.status = status
    this.stderr = stderr
  }
}

export type ProjectPathResolution = {
  resolved: string
  allowRoot: string
}

/**
 * Resolve and authorise a project path coming from the API. Mirrors the
 * checks already performed by /api/scan so the two flows agree.
 */
export function resolveProjectPath(rawPath: unknown): ProjectPathResolution {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new GitError(
      "projectPath is required. Open a local project before using git endpoints.",
      400
    )
  }
  const allowRoot = getScanAllowRoot()
  const resolved = path.resolve(expandUserPath(rawPath))
  if (!isPathInside(resolved, allowRoot)) {
    throw new GitError("projectPath is outside the allowed directory", 403)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new GitError("projectPath is not a directory", 400)
  }
  return { resolved, allowRoot }
}

export function assertGitRepo(projectPath: string): void {
  // `.git` may be a directory (regular repo) or a file (worktree pointer).
  const dotGit = path.join(projectPath, ".git")
  if (!fs.existsSync(dotGit)) {
    throw new GitError(
      "Selected project is not a git repository (missing .git).",
      400
    )
  }
}

/**
 * Refs (branch names, commit SHAs) are restricted to the conservative set
 * Git treats as safe: letters, digits, `_`, `-`, `.`, `/`. We additionally
 * reject leading `-` (would be parsed as a flag) and `..` (path traversal),
 * and any whitespace.
 */
const REF_RE = /^[A-Za-z0-9._\-/]+$/

export function validateRef(ref: unknown, label = "ref"): string {
  if (typeof ref !== "string") {
    throw new GitError(`${label} is required`, 400)
  }
  const trimmed = ref.trim()
  if (!trimmed) throw new GitError(`${label} cannot be empty`, 400)
  if (trimmed.length > 256) throw new GitError(`${label} is too long`, 400)
  if (trimmed.startsWith("-")) {
    throw new GitError(`${label} cannot start with '-'`, 400)
  }
  if (trimmed.includes("..") || trimmed.includes(" ")) {
    throw new GitError(`${label} contains illegal characters`, 400)
  }
  if (!REF_RE.test(trimmed)) {
    throw new GitError(`${label} contains illegal characters`, 400)
  }
  return trimmed
}

/**
 * File paths returned by `git diff --name-status` and re-sent for diff
 * lookup must stay relative and never escape the project directory or sneak
 * through as a flag.
 */
export function validateRelPath(file: unknown, label = "file"): string {
  if (typeof file !== "string" || !file.trim()) {
    throw new GitError(`${label} is required`, 400)
  }
  const trimmed = file.trim()
  if (trimmed.startsWith("-")) {
    throw new GitError(`${label} cannot start with '-'`, 400)
  }
  if (path.isAbsolute(trimmed)) {
    throw new GitError(`${label} must be a project-relative path`, 400)
  }
  const norm = path.posix.normalize(trimmed.replace(/\\/g, "/"))
  if (norm.startsWith("..") || norm.split("/").includes("..")) {
    throw new GitError(`${label} escapes the project directory`, 400)
  }
  return norm
}

export type GitRunResult = {
  stdout: string
  stderr: string
  status: number | null
}

export function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}
): GitRunResult {
  const env = {
    ...process.env,
    ...opts.env,
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  }
  const proc: SpawnSyncReturns<string> = spawnSync(
    "git",
    ["--no-pager", "-C", cwd, ...args],
    {
      encoding: "utf-8",
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      env,
    }
  )
  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new GitError("git executable not found on PATH", 500)
    }
    throw new GitError(`git invocation failed: ${proc.error.message}`, 500)
  }
  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    status: proc.status,
  }
}

/** Convenience: run `git`, throw on non-zero exit, return trimmed stdout. */
export function gitOk(
  cwd: string,
  args: string[],
  opts?: Parameters<typeof runGit>[2]
): string {
  const r = runGit(cwd, args, opts)
  if (r.status !== 0) {
    throw new GitError(
      `git ${args[0] ?? ""} failed`,
      500,
      r.stderr.slice(0, 4000)
    )
  }
  return r.stdout.replace(/\r\n/g, "\n").replace(/\n+$/, "")
}

/**
 * Try to resolve a user-supplied branch name to something `git` can use.
 * The branches dropdown lists *short* names — including remote-only ones
 * with their `origin/` prefix stripped (e.g. `origin/325` becomes `325`).
 * If the bare name doesn't resolve we fall through to common alternates so
 * Branch Compare works for shallow clones / remote-only refs without
 * forcing the user to check the branch out first.
 */
export function resolveRef(
  cwd: string,
  ref: string
): { canonical: string; sha: string } {
  const candidates = [
    ref,
    `refs/heads/${ref}`,
    `origin/${ref}`,
    `refs/remotes/origin/${ref}`,
  ]
  let lastStderr = ""
  for (const c of candidates) {
    const r = runGit(cwd, ["rev-parse", "--verify", `${c}^{commit}`])
    if (r.status === 0 && r.stdout.trim().length >= 4) {
      return { canonical: c, sha: r.stdout.trim().slice(0, 12) }
    }
    if (r.stderr) lastStderr = r.stderr
  }
  throw new GitError(
    `ref '${ref}' could not be resolved as a local branch, remote-tracking branch, or commit`,
    400,
    lastStderr.slice(0, 4000)
  )
}

/** Verify a ref resolves to a commit. Returns the resolved short SHA. */
export function verifyRef(cwd: string, ref: string): string {
  return resolveRef(cwd, ref).sha
}

/* -------------------------------------------------------------------------- */
/* Change classification                                                      */
/* -------------------------------------------------------------------------- */

export type ChangeCategory =
  | "prompt"
  | "tool"
  | "schema"
  | "mcp"
  | "dependency"
  | "code"

const DEPENDENCY_FILES = new Set([
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "poetry.lock",
  "pipfile",
  "pipfile.lock",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
])

function hasDirSegment(p: string, segment: string): boolean {
  return p.startsWith(`${segment}/`) || p.includes(`/${segment}/`)
}

export function classifyChangedFile(filePath: string): ChangeCategory {
  const p = filePath.replace(/\\/g, "/").toLowerCase()
  const base = p.split("/").pop() ?? p

  if (hasDirSegment(p, "mcp") || base.includes("mcp") || base.endsWith(".mcp.json")) {
    return "mcp"
  }
  if (DEPENDENCY_FILES.has(base)) {
    return "dependency"
  }
  if (
    base === "openapi.yaml" ||
    base === "openapi.yml" ||
    base === "openapi.json" ||
    base.startsWith("openapi.") ||
    base.startsWith("schema.") ||
    base.endsWith(".schema.json") ||
    hasDirSegment(p, "schemas") ||
    hasDirSegment(p, "openapi")
  ) {
    return "schema"
  }
  if (
    hasDirSegment(p, "prompts") ||
    hasDirSegment(p, "prompt_templates") ||
    base.endsWith(".prompt") ||
    base.endsWith(".prompt.txt") ||
    base.endsWith(".prompt.md") ||
    /system_?prompt/.test(base)
  ) {
    return "prompt"
  }
  if (
    hasDirSegment(p, "tools") ||
    /(_|^)tool\.py$/.test(base) ||
    /tools?\.py$/.test(base) ||
    /(_|^)tool\.ts$/.test(base) ||
    /tools?\.ts$/.test(base)
  ) {
    return "tool"
  }
  return "code"
}

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T"

export type ChangedFile = {
  path: string
  oldPath?: string
  status: ChangeStatus
  category: ChangeCategory
}

const VALID_STATUS = new Set<ChangeStatus>(["A", "M", "D", "R", "C", "T"])

export function parseNameStatus(stdout: string): ChangedFile[] {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean)
  const out: ChangedFile[] = []
  for (const line of lines) {
    const parts = line.split("\t")
    if (parts.length < 2) continue
    const rawStatus = parts[0]
    const code = rawStatus[0] as ChangeStatus
    if (!VALID_STATUS.has(code)) continue
    if ((code === "R" || code === "C") && parts.length >= 3) {
      const oldPath = parts[1]
      const newPath = parts[2]
      out.push({
        path: newPath,
        oldPath,
        status: code,
        category: classifyChangedFile(newPath),
      })
    } else {
      const file = parts[1]
      out.push({
        path: file,
        status: code,
        category: classifyChangedFile(file),
      })
    }
  }
  return out
}

export function explainChange(
  status: ChangeStatus,
  category: ChangeCategory,
  filePath: string
): string {
  const verb =
    status === "A"
      ? "added"
      : status === "D"
        ? "removed"
        : status === "R" || status === "C"
          ? "renamed/copied"
          : status === "T"
            ? "had its type changed"
            : "modified"
  switch (category) {
    case "prompt":
      return `Prompt file ${verb}. Prompt edits frequently change agent behaviour, tone, and tool-selection logic — re-run prompt regression tests and any vague-prompt / prompt-injection checks.`
    case "tool":
      return `Tool implementation ${verb}. Tool changes can introduce dangerous side-effects (shell execution, network calls, refunds) — re-run the dangerous-tools check and any user-input-to-dangerous-code flow analysis.`
    case "schema":
      return `Schema / OpenAPI file ${verb}. Schema drift can break tool calls and validation guarantees — re-run openapi-schema and dependent integration tests.`
    case "mcp":
      return `MCP configuration ${verb}. New or removed MCP servers/tools change the agent's capability surface — re-run the mcp-security check and audit which agents can reach the new endpoints.`
    case "dependency":
      return `Dependency manifest ${verb} (${filePath}). Pinned-version drift can pull in vulnerable packages — re-run the dependency-risks check and verify lockfile consistency.`
    case "code":
    default:
      return `Application code ${verb}. Re-run the full scanner against the target branch to surface any new findings introduced by this change.`
  }
}

export type StashEntry = {
  /** e.g. "stash@{0}" — usable directly with `git stash apply/pop`. */
  ref: string
  /** Subject line, e.g. "WIP on main: a1b2c3d fix bug" or "On low: my note". */
  subject: string
  /** Branch name parsed from the subject (after "WIP on " / "On "), or null. */
  branch: string | null
}

/**
 * Parse `git stash list` and return all stash entries in order
 * (newest = stash@{0} first). Each subject line is matched against
 * "(WIP )?[Oo]n <branch>:" so we can attribute the stash to the
 * branch it was created on.
 *
 * Returns [] when there are no stashes or the command fails — stash
 * support is optional, never fatal.
 */
export function listStashes(projectPath: string): StashEntry[] {
  const r = runGit(projectPath, ["stash", "list", "--format=%gd|%s"], {
    timeoutMs: 10_000,
  })
  if (r.status !== 0) return []
  const out: StashEntry[] = []
  for (const line of r.stdout.split("\n")) {
    if (!line) continue
    const idx = line.indexOf("|")
    if (idx <= 0) continue
    const ref = line.slice(0, idx)
    const subject = line.slice(idx + 1)
    const m = subject.match(/^(?:WIP )?[Oo]n (\S+?):/)
    out.push({ ref, subject, branch: m ? m[1] : null })
  }
  return out
}

/**
 * Return all stashes whose subject indicates they were created on
 * `branch`. Order matches `git stash list` (newest first), so the
 * caller can pop the first entry to grab the most recent WIP for
 * that branch.
 */
export function listStashesForBranch(
  projectPath: string,
  branch: string | null
): StashEntry[] {
  if (!branch) return []
  return listStashes(projectPath).filter((s) => s.branch === branch)
}
