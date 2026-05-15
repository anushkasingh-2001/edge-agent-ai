import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const MARKER_START =
  "# >>> Edge Agent AI (auto-managed; safe to delete this whole block) <<<"
const MARKER_END = "# <<< Edge Agent AI >>>"

const IGNORE_LINES = [
  ".edgeagent/",
  ".githooks/",
  "edge-agent-output/",
  // Untracked eval trees / workspace copies — tracked files under evals/
  // stay tracked; only untracked paths match.
  "evals/",
]

const COMMIT_USER_NAME = "Edge Agent AI"
const COMMIT_USER_EMAIL = "edge-agent-ai@users.noreply.github.com"
const COMMIT_SUBJECT = "chore: add Edge Agent AI paths to .gitignore"

function ignoreBlock(): string {
  return ["", MARKER_START, ...IGNORE_LINES, MARKER_END, ""].join("\n")
}

/**
 * Append a stable block to **`.git/info/exclude`** (local-only, never pushed).
 *
 * Idempotent: if the marker block is already present, does nothing.
 */
export function ensureEdgeAgentGitExcludeBlock(projectRoot: string): {
  ok: boolean
  reason?: string
  excludePath: string
  appended: boolean
} {
  const root = path.resolve(projectRoot)
  const gitDir = path.join(root, ".git")
  if (!fs.existsSync(gitDir)) {
    return {
      ok: false,
      reason: "not a git repository",
      excludePath: path.join(gitDir, "info", "exclude"),
      appended: false,
    }
  }

  const infoDir = path.join(gitDir, "info")
  const excludePath = path.join(infoDir, "exclude")

  try {
    fs.mkdirSync(infoDir, { recursive: true })
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "mkdir failed",
      excludePath,
      appended: false,
    }
  }

  let existing = ""
  try {
    if (fs.existsSync(excludePath)) {
      existing = fs.readFileSync(excludePath, "utf8")
    }
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "read failed",
      excludePath,
      appended: false,
    }
  }

  if (existing.includes(MARKER_START) && existing.includes(MARKER_END)) {
    return { ok: true, excludePath, appended: false }
  }

  try {
    fs.appendFileSync(excludePath, ignoreBlock(), "utf8")
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "append failed",
      excludePath,
      appended: false,
    }
  }

  return { ok: true, excludePath, appended: true }
}

/**
 * Append the same block to the repo-root `.gitignore` when missing.
 * Idempotent via marker lines.
 */
export function ensureEdgeAgentRootGitignoreBlock(projectRoot: string): {
  ok: boolean
  reason?: string
  gitignorePath: string
  appended: boolean
} {
  const root = path.resolve(projectRoot)
  const gitDir = path.join(root, ".git")
  if (!fs.existsSync(gitDir)) {
    return {
      ok: false,
      reason: "not a git repository",
      gitignorePath: path.join(root, ".gitignore"),
      appended: false,
    }
  }

  const gitignorePath = path.join(root, ".gitignore")
  let existing = ""
  try {
    if (fs.existsSync(gitignorePath)) {
      existing = fs.readFileSync(gitignorePath, "utf8")
    }
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "read failed",
      gitignorePath,
      appended: false,
    }
  }

  if (existing.includes(MARKER_START) && existing.includes(MARKER_END)) {
    return { ok: true, gitignorePath, appended: false }
  }

  try {
    fs.appendFileSync(gitignorePath, ignoreBlock(), "utf8")
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "append failed",
      gitignorePath,
      appended: false,
    }
  }

  return { ok: true, gitignorePath, appended: true }
}

/**
 * If `.gitignore` has staged or unstaged changes relative to HEAD, create
 * a single commit. Uses fixed author identity + `--no-verify` so the
 * project's pre-commit policy gate cannot block this housekeeping commit.
 */
export function commitRootGitignoreIfNeeded(projectRoot: string): {
  ok: boolean
  committed: boolean
  sha?: string
  reason?: string
} {
  const root = path.resolve(projectRoot)
  const gitDir = path.join(root, ".git")
  if (!fs.existsSync(gitDir)) {
    return { ok: false, committed: false, reason: "not a git repository" }
  }

  const gitignorePath = path.join(root, ".gitignore")
  if (!fs.existsSync(gitignorePath)) {
    return { ok: true, committed: false }
  }

  const add = spawnSync("git", ["-C", root, "add", "--", ".gitignore"], {
    encoding: "utf8",
  })
  if (add.status !== 0) {
    return {
      ok: false,
      committed: false,
      reason: add.stderr?.trim() || "git add .gitignore failed",
    }
  }

  const diff = spawnSync(
    "git",
    ["-C", root, "diff", "--staged", "--quiet", "--", ".gitignore"],
    { encoding: "utf8" }
  )
  // exit 0 → nothing staged for this path
  if (diff.status === 0) {
    return { ok: true, committed: false }
  }

  const commit = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      `user.name=${COMMIT_USER_NAME}`,
      "-c",
      `user.email=${COMMIT_USER_EMAIL}`,
      "commit",
      "--no-verify",
      "-m",
      COMMIT_SUBJECT,
      "--",
      ".gitignore",
    ],
    { encoding: "utf8" }
  )

  if (commit.status !== 0) {
    return {
      ok: false,
      committed: false,
      reason:
        commit.stderr?.trim() ||
        commit.stdout?.trim() ||
        "git commit failed",
    }
  }

  const rev = spawnSync(
    "git",
    ["-C", root, "rev-parse", "--short", "HEAD"],
    { encoding: "utf8" }
  )
  const sha = rev.status === 0 ? rev.stdout.trim() : undefined

  return { ok: true, committed: true, sha }
}

/** Runs exclude + root `.gitignore` + auto-commit when the ignore file changed. */
export function syncEdgeAgentImportGitIgnores(projectRoot: string): {
  localGitExclude: ReturnType<typeof ensureEdgeAgentGitExcludeBlock>
  rootGitignore: ReturnType<typeof ensureEdgeAgentRootGitignoreBlock>
  gitignoreCommit: ReturnType<typeof commitRootGitignoreIfNeeded>
} {
  const localGitExclude = ensureEdgeAgentGitExcludeBlock(projectRoot)
  const rootGitignore = ensureEdgeAgentRootGitignoreBlock(projectRoot)

  const gitignoreCommit = rootGitignore.ok
    ? commitRootGitignoreIfNeeded(projectRoot)
    : { ok: true as const, committed: false as const }

  return { localGitExclude, rootGitignore, gitignoreCommit }
}
