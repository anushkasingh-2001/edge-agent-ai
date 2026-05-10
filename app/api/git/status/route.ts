import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import {
  GitError,
  listStashesForBranch,
  resolveProjectPath,
  runGit,
} from "@/lib/server-git"
import {
  attributeUntrackedFiles,
  listUntrackedFiles,
} from "@/lib/server-untracked-attribution"

/**
 * GET /api/git/status?projectPath=/abs/path
 *
 * Returns the basic state of the working tree for the Git Workflow card:
 *   - currentBranch (HEAD short name, or null when detached)
 *   - remote (origin URL, or null)
 *   - workingTreeStatus ("clean" | "uncommitted") — INCLUSIVE.
 *     "uncommitted" whenever there are tracked-modified files OR
 *     ANY untracked files OR a `git stash` entry attributed to the
 *     current branch. We deliberately don't filter cross-branch
 *     leakage out of the dirty signal: the user wants to know git
 *     would consider the tree dirty, period. Stashes count too —
 *     a stash on `main` makes `main` look "uncommitted" even when
 *     the working tree is empty, so the user can see "you have a
 *     WIP for this branch waiting to be committed".
 *   - trackedModifiedCount: tracked files with uncommitted edits.
 *   - ownBranchUntrackedCount / crossBranchUntrackedCount: split of
 *     untracked files by attribution (which branch we believe each
 *     came from). Used purely for INFORMATIONAL display in tooltips
 *     and the commit dialog — both buckets count toward "dirty" and
 *     both get committed.
 *   - crossBranchUntrackedBranches: distinct other-branch names so
 *     the UI can mention them in tooltips.
 *   - currentBranchStashCount: number of `git stash` entries whose
 *     subject indicates they were created on the current branch.
 *   - latestCurrentBranchStashRef / latestCurrentBranchStashMessage:
 *     ref ("stash@{N}") and subject of the most recent stash for
 *     the current branch, or null when there isn't one. The commit
 *     route uses the ref to pop+commit the stash on demand.
 *   - lastCommitSha (short)
 *   - lastCommitMessage (subject only)
 *
 * Non-Git folders return `isRepo: false` with the rest as null so the UI
 * can render an empty state instead of an error.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const { resolved } = resolveProjectPath(url.searchParams.get("projectPath"))

    const dotGit = path.join(resolved, ".git")
    if (!fs.existsSync(dotGit)) {
      return NextResponse.json({
        isRepo: false,
        currentBranch: null,
        remote: null,
        workingTreeStatus: null,
        trackedModifiedCount: 0,
        ownBranchUntrackedCount: 0,
        crossBranchUntrackedCount: 0,
        crossBranchUntrackedBranches: [],
        currentBranchStashCount: 0,
        latestCurrentBranchStashRef: null,
        latestCurrentBranchStashMessage: null,
        lastCommitSha: null,
        lastCommitMessage: null,
      })
    }

    const head = runGit(resolved, ["rev-parse", "--abbrev-ref", "HEAD"])
    const currentBranch =
      head.status === 0 ? head.stdout.trim() || null : null

    const remoteRun = runGit(resolved, ["remote", "get-url", "origin"])
    const remote =
      remoteRun.status === 0 && remoteRun.stdout.trim()
        ? remoteRun.stdout.trim()
        : null

    /* ----- Inclusive dirty calculation --------------------------- */
    //
    // 1. Count tracked-modified files. We use --untracked-files=no so
    //    untracked entries don't sneak in and double-count.
    // 2. List untracked files (already filters .edgeagent/) and
    //    partition by branch attribution — purely for display.
    // 3. "Dirty for the UI" = tracked-modified > 0 OR ANY untracked
    //    file present, regardless of attribution. The user asked us
    //    to treat any untracked file as committable on the current
    //    branch (matches what `git commit -A` would do), so the
    //    dirty signal mirrors that.
    const trackedStatus = runGit(resolved, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ])
    const trackedModifiedCount =
      trackedStatus.status === 0
        ? trackedStatus.stdout.split("\n").filter((l) => l.length > 0).length
        : 0

    const allUntracked = listUntrackedFiles(resolved)
    const attribution = attributeUntrackedFiles(
      resolved,
      currentBranch,
      allUntracked
    )
    const ownBranchUntrackedCount = attribution.ownBranch.length
    const crossBranchUntrackedCount = attribution.otherBranch.length
    const crossBranchUntrackedBranches = Array.from(
      new Set(attribution.otherBranch.map((e) => e.branch))
    )

    /* ----- Per-branch stash detection ---------------------------- */
    //
    // `git stash list` enumerates every stash with a subject like
    //   "WIP on main: 1234abc fix bug"
    //   "On low: my custom -m message"
    // The branch name after "on" tells us which branch the stash was
    // created on. We surface only stashes for the CURRENT branch so
    // a `main` stash never makes `low` look dirty (and vice versa).
    // The latest such stash's ref is what `commit` will pop when
    // the user clicks Commit on a stash-only-dirty branch.
    const branchStashes = listStashesForBranch(resolved, currentBranch)
    const currentBranchStashCount = branchStashes.length
    const latestCurrentBranchStashRef =
      branchStashes.length > 0 ? branchStashes[0].ref : null
    const latestCurrentBranchStashMessage =
      branchStashes.length > 0 ? branchStashes[0].subject : null

    // Inclusive "dirty": tracked-modified counts, AND any untracked
    // file counts (own-branch or cross-branch), AND any stash that
    // belongs to this branch. Attribution is kept for tooltip
    // detail only — it no longer gates the yellow dot.
    const dirtyForCurrentBranch =
      trackedModifiedCount > 0 ||
      ownBranchUntrackedCount > 0 ||
      crossBranchUntrackedCount > 0 ||
      currentBranchStashCount > 0
    const workingTreeStatus =
      trackedStatus.status === 0
        ? dirtyForCurrentBranch
          ? "uncommitted"
          : "clean"
        : null

    const sha = runGit(resolved, ["rev-parse", "--short", "HEAD"])
    const lastCommitSha =
      sha.status === 0 ? sha.stdout.trim() || null : null

    const subject = runGit(resolved, ["log", "-1", "--pretty=%s"])
    const lastCommitMessage =
      subject.status === 0 ? subject.stdout.trim() || null : null

    return NextResponse.json({
      isRepo: true,
      currentBranch,
      remote,
      workingTreeStatus,
      trackedModifiedCount,
      ownBranchUntrackedCount,
      crossBranchUntrackedCount,
      crossBranchUntrackedBranches,
      currentBranchStashCount,
      latestCurrentBranchStashRef,
      latestCurrentBranchStashMessage,
      lastCommitSha,
      lastCommitMessage,
    })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { error: err.message, stderr: err.stderr || undefined },
        { status: err.status }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
