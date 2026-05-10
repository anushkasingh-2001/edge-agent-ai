import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import { countStashesByBranch } from "@/lib/server-git"

/**
 * GET /api/git/branches?projectPath=/abs/path[&expand=1]
 *
 * Lists branches (local + remote-tracking) for an imported project. All git
 * invocations:
 *   - go through `spawnSync` with an explicit arg array (no shell, no
 *     interpolation),
 *   - run with `git -C <projectPath>` so we never `chdir` the server,
 *   - have `--no-pager` so they can't hang waiting for `less`,
 *   - reject project paths outside the platform allow-root (same one
 *     `/api/scan` uses), so a malicious caller can't point us at `/etc`.
 *
 * For non-Git folders we return `isRepo: false` with an empty branch list
 * (HTTP 200) so the UI can render a graceful empty state instead of treating
 * it as an error.
 *
 * Single-branch clones (the legacy default for `git clone --depth 1` made
 * before we added `--no-single-branch`) are auto-expanded once: we widen
 * `remote.origin.fetch` to `*` and run a depth-1 `git fetch` so the dropdown
 * can show every branch the remote has. The expansion uses a generous timeout
 * because giant repos like openclaw can have thousands of branches; a failure
 * still returns the local list rather than 500.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectPath = (url.searchParams.get("projectPath") ?? "").trim()
  const forceExpand = url.searchParams.get("expand") === "1"

  if (!projectPath) {
    return NextResponse.json({ error: "projectPath is required" }, { status: 400 })
  }

  const allowRoot = getScanAllowRoot()
  const requested = path.resolve(projectPath)

  if (!isPathInside(requested, allowRoot)) {
    return NextResponse.json(
      { error: "projectPath is outside the allowed directory" },
      { status: 403 }
    )
  }

  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    return NextResponse.json(
      { error: "projectPath is not a directory" },
      { status: 400 }
    )
  }

  // Quick check: is this even a Git repo? `rev-parse --is-inside-work-tree`
  // exits non-zero with no stdout if not, which we treat as "not a repo"
  // rather than a hard error.
  const isInside = runGit(requested, ["rev-parse", "--is-inside-work-tree"])
  if (isInside.status !== 0 || isInside.stdout.trim() !== "true") {
    return NextResponse.json({
      isRepo: false,
      branches: [],
      remoteOnly: [],
      currentBranch: null,
      expanded: false,
    })
  }

  // If the clone was made `--single-branch` (every `--depth 1` clone before
  // we passed `--no-single-branch` lands here) the remote.origin.fetch
  // refspec is something like `+refs/heads/main:refs/remotes/origin/main`
  // instead of `+refs/heads/*:...`. In that state `git branch -r` will only
  // ever show the one branch we cloned. We widen the refspec and re-fetch so
  // the user sees what GitHub shows.
  let expanded = false
  if (isSingleBranchRefspec(requested) || forceExpand) {
    expanded = expandRemoteRefspec(requested)
  }

  // Local branches: short names (no `refs/heads/` prefix), one per line.
  const localProc = runGit(requested, ["branch", "--format=%(refname:short)"])
  if (localProc.status !== 0) {
    return NextResponse.json(
      { error: "git branch failed", stderr: localProc.stderr.slice(0, 4000) },
      { status: 500 }
    )
  }
  const localBranches = localProc.stdout
    .split("\n")
    .map((line) => line.trim())
    // Drop blanks and pseudo-entries like "(HEAD detached at cec934b)" which
    // git emits but aren't real refs you can switch to.
    .filter((line) => line.length > 0 && !line.startsWith("("))
  const localSet = new Set(localBranches)

  // Remote-tracking branches: e.g. `origin/main`, `origin/feat/foo`,
  // sometimes `origin/HEAD` (a symbolic alias we strip).
  const remoteProc = runGit(requested, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes",
  ])
  const remoteOnly: string[] = []
  if (remoteProc.status === 0) {
    const seen = new Set<string>()
    for (const line of remoteProc.stdout.split("\n")) {
      const ref = line.trim()
      if (!ref) continue
      // Strip the remote name prefix (e.g. `origin/feat/x` -> `feat/x`).
      const slash = ref.indexOf("/")
      if (slash <= 0) continue
      const branchName = ref.slice(slash + 1)
      // Skip the `origin/HEAD` alias and anything that resolves to HEAD.
      if (branchName === "HEAD" || branchName === "" || branchName.startsWith("HEAD ->")) {
        continue
      }
      if (localSet.has(branchName)) continue
      if (seen.has(branchName)) continue
      seen.add(branchName)
      remoteOnly.push(branchName)
    }
  }

  // Sort remote-only branches alphabetically; locals keep git's order so the
  // user's checked-out branch tends to be near the top.
  remoteOnly.sort((a, b) => a.localeCompare(b))

  // Resolve HEAD. On a detached HEAD this returns "HEAD"; we surface it as a
  // pseudo-branch so the user still sees what's checked out.
  const headProc = runGit(requested, ["rev-parse", "--abbrev-ref", "HEAD"])
  const currentBranch =
    headProc.status === 0 ? headProc.stdout.trim() || null : null

  // Per-branch stash counts. The Branch Compare view uses this to
  // enable/disable the "commits + stashes" toggle per side without
  // a second round-trip. Cheap (`git stash list` + parse) and
  // returns {} for repos with no stashes.
  const stashesByBranch = countStashesByBranch(requested)

  return NextResponse.json({
    isRepo: true,
    branches: [...localBranches, ...remoteOnly],
    remoteOnly,
    currentBranch,
    expanded,
    stashesByBranch,
  })
}

/**
 * Returns true iff `remote.origin.fetch` is restricted to a single branch
 * (i.e. doesn't end in `*`). New clones made via `/api/projects/clone` after
 * we added `--no-single-branch` will not match this.
 */
function isSingleBranchRefspec(cwd: string): boolean {
  const proc = runGit(cwd, ["config", "--get-all", "remote.origin.fetch"])
  if (proc.status !== 0) return false
  const lines = proc.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return false
  // If any refspec uses `*`, the user can already see every branch.
  return !lines.some((l) => l.includes("*"))
}

/**
 * Widen the origin refspec to `*` and pull every branch tip at depth 1.
 * Returns true on success. Best-effort: if fetch fails (offline, auth, etc.)
 * we still want to serve whatever local refs exist.
 */
function expandRemoteRefspec(cwd: string): boolean {
  const setRefspec = runGit(cwd, [
    "remote",
    "set-branches",
    "origin",
    "*",
  ])
  if (setRefspec.status !== 0) return false
  // `git fetch` on a giant repo can take a while; allow more time than the
  // default 10s used for cheap commands.
  const fetch = spawnSync(
    "git",
    [
      "--no-pager",
      "-C",
      cwd,
      "fetch",
      "--depth",
      "1",
      "--no-tags",
      "--prune",
      "origin",
    ],
    {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    }
  )
  return fetch.status === 0
}

/**
 * Run a git command inside `cwd` with no shell. We always prepend
 * `--no-pager` so the process can't block on a pager, and use a 10s timeout
 * to avoid wedging the request on a corrupt repo.
 */
function runGit(cwd: string, args: string[]) {
  return spawnSync("git", ["--no-pager", "-C", cwd, ...args], {
    encoding: "utf-8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  })
}
