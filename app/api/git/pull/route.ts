import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
  runGit,
  validateRef,
} from "@/lib/server-git"
import {
  attributeUntrackedFiles,
  listUntrackedFiles,
} from "@/lib/server-untracked-attribution"

/**
 * POST /api/git/pull
 *
 * Body:
 *   { projectPath: string, branch: string }
 *
 * Behaviour:
 *   1. Resolve + authorise projectPath (must be inside the allow root).
 *   2. Ensure it's a Git repo.
 *   3. Refuse with 409 if the working tree has uncommitted changes —
 *      the user is expected to commit / stash first so we never silently
 *      create a merge-conflict mess.
 *   4. `git fetch origin` then `git pull --ff-only origin <branch>`.
 *      `--ff-only` means git refuses to create a merge commit; if a
 *      fast-forward isn't possible we surface the failure rather than
 *      doing anything destructive.
 *
 * All git invocations go through the spawnSync wrapper in `lib/server-git.ts`
 * (no shell strings, hard timeouts, --no-pager).
 */

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      branch?: string
    }

    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)
    const branch = validateRef(body.branch, "branch")

    /* ----- Attribution-aware "is dirty?" gate -------------------- */
    //
    // Old behaviour: refuse pull on ANY working-tree change. That
    // included untracked files leaked from other branches (e.g.
    // `dang.py` created on `low` while we now want to pull on
    // `main`), which surprised users — Commit showed "clean" but
    // Pull said "uncommitted".
    //
    // New behaviour: the gate only fires for THIS branch's own
    // changes (tracked-modified + untracked attributed to current
    // branch). Untracked files belonging to other branches don't
    // block the pull; if a real overlap occurs git itself will
    // refuse the merge and we surface that error.
    const trackedStatus = runGit(resolved, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ])
    if (trackedStatus.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "git status failed",
          stderr: trackedStatus.stderr.slice(0, 2000),
        },
        { status: 500 }
      )
    }
    const trackedModifiedCount = trackedStatus.stdout
      .split("\n")
      .filter((l) => l.length > 0).length

    const headInfo = runGit(resolved, ["rev-parse", "--abbrev-ref", "HEAD"])
    const headBranch =
      headInfo.status === 0 ? headInfo.stdout.trim() || null : null
    const allUntracked = listUntrackedFiles(resolved)
    const attribution = attributeUntrackedFiles(
      resolved,
      headBranch,
      allUntracked
    )
    // Only block on own-branch changes. Cross-branch leaked files
    // are git-safe with --ff-only — git itself refuses if a real
    // overlap would happen, and we surface that error to the user.
    const ownDirty =
      trackedModifiedCount > 0 || attribution.ownBranch.length > 0
    if (ownDirty) {
      return NextResponse.json(
        {
          ok: false,
          blocked: true,
          reason: "uncommitted_changes",
          message: `Working tree has uncommitted changes on '${
            headBranch ?? "this branch"
          }' (${trackedModifiedCount} tracked, ${
            attribution.ownBranch.length
          } untracked). Commit or stash before pulling.`,
          workingTreeStatus: "uncommitted",
          stdout: trackedStatus.stdout.slice(0, 2000),
        },
        { status: 409 }
      )
    }

    const fetchProc = runGit(resolved, ["fetch", "origin"], {
      timeoutMs: 60_000,
    })
    if (fetchProc.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          phase: "fetch",
          message: "git fetch origin failed",
          stderr: fetchProc.stderr.slice(0, 4000),
          stdout: fetchProc.stdout.slice(0, 2000),
        },
        { status: 502 }
      )
    }

    const pullProc = runGit(
      resolved,
      ["pull", "--ff-only", "origin", branch],
      { timeoutMs: 60_000 }
    )
    if (pullProc.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          phase: "pull",
          message:
            "git pull --ff-only failed (non fast-forward, divergence, or remote error). Resolve manually.",
          stderr: pullProc.stderr.slice(0, 4000),
          stdout: pullProc.stdout.slice(0, 2000),
        },
        { status: 502 }
      )
    }

    return NextResponse.json({
      ok: true,
      branch,
      message: `Pulled latest changes for '${branch}' (fast-forward only).`,
      stdout: pullProc.stdout.trim(),
      stderr: pullProc.stderr.trim(),
    })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { ok: false, error: err.message, stderr: err.stderr || undefined },
        { status: err.status }
      )
    }
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
