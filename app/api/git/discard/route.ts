import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
  runGit,
} from "@/lib/server-git"
import {
  attributeUntrackedFiles,
  listUntrackedFiles,
} from "@/lib/server-untracked-attribution"

/**
 * POST /api/git/discard
 *
 * Body:
 *   { projectPath: string, confirm: true }
 *
 * Behaviour:
 *   1. Validate projectPath + confirm flag (`confirm: true` is
 *      required — this endpoint is destructive on tracked changes).
 *   2. `git reset --mixed HEAD` then `git checkout -- .` to revert
 *      tracked-file modifications and unstage anything in the
 *      index. (Equivalent to `git restore --staged --worktree .`,
 *      but works on older git too.)
 *   3. Untracked files are LEFT ALONE — never deleted. The user
 *      can always `git clean` themselves if they really want them
 *      gone, but discarding via this UI must be safe to call
 *      without losing files we don't already know about.
 *   4. Return `{ revertedTracked, keptUntracked, attribution }`
 *      so the dialog can say "reverted N tracked, kept M untracked
 *      (their origin branches: low, feature)."
 *
 * Why a custom endpoint instead of `git restore .`?
 *   - We need the count for the success toast.
 *   - We surface attribution info on the kept files so the user
 *     knows which branch each untracked file is associated with.
 */

interface RequestBody {
  projectPath?: string
  confirm?: boolean
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as RequestBody

    if (body.confirm !== true) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Discard requires explicit confirmation (confirm: true) — refusing to silently destroy work.",
        },
        { status: 400 }
      )
    }

    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    /* ----- Determine current branch (for attribution) ------------ */
    const headInfo = runGit(resolved, ["rev-parse", "--abbrev-ref", "HEAD"])
    const headBranch =
      headInfo.status === 0 ? headInfo.stdout.trim() || null : null

    /* ----- Step 1: revert tracked-modified files ----------------- */
    //
    // Capture the list of changed files first so we can report a
    // count back to the user. `--porcelain` is stable across git
    // versions; we only consume the count.
    const statusBefore = runGit(resolved, [
      "status",
      "--porcelain",
      "--untracked-files=no", // don't count untracked here — handled below
    ])
    const trackedChangedCount =
      statusBefore.status === 0
        ? statusBefore.stdout.split("\n").filter((l) => l.length > 0).length
        : 0

    let revertedTracked = 0
    let revertError: string | null = null
    if (trackedChangedCount > 0) {
      // `checkout -- .` reverts any tracked-file changes back to HEAD.
      // We also reset the index to HEAD first so partially-staged
      // changes get unstaged before being discarded — otherwise
      // checkout would leave staged-but-uncommitted hunks behind.
      const reset = runGit(resolved, ["reset", "--mixed", "HEAD"], {
        timeoutMs: 30_000,
      })
      if (reset.status !== 0) {
        revertError = `git reset --mixed HEAD failed: ${(reset.stderr ?? "").slice(0, 500)}`
      } else {
        const checkout = runGit(resolved, ["checkout", "--", "."], {
          timeoutMs: 30_000,
        })
        if (checkout.status !== 0) {
          revertError = `git checkout -- . failed: ${(checkout.stderr ?? "").slice(0, 500)}`
        } else {
          revertedTracked = trackedChangedCount
        }
      }
    }

    /* ----- Step 2: report untracked files (NEVER delete) --------- */
    //
    // We deliberately do NOT touch untracked files here. The user
    // explicitly asked us not to delete any untracked file when
    // discarding — they may want to commit those later, on the same
    // branch or another, and silently nuking them would destroy
    // work we have no backup of.
    //
    // We still compute attribution so the response can tell the
    // dialog which branches the kept files are tagged to ("kept 3
    // untracked: 1 on main, 2 on low").
    const untrackedAfterRevert = listUntrackedFiles(resolved)
    const attribution = attributeUntrackedFiles(
      resolved,
      headBranch,
      untrackedAfterRevert
    )
    const keptUntracked = untrackedAfterRevert.length
    const keptUntrackedByBranch: Record<string, number> = {}
    for (const rel of attribution.ownBranch) {
      const b = headBranch ?? "?"
      keptUntrackedByBranch[b] = (keptUntrackedByBranch[b] ?? 0) + 1
      void rel
    }
    for (const e of attribution.otherBranch) {
      keptUntrackedByBranch[e.branch] =
        (keptUntrackedByBranch[e.branch] ?? 0) + 1
    }

    const keptSummary = Object.entries(keptUntrackedByBranch)
      .map(([b, n]) => `${n} on '${b}'`)
      .join(", ")

    return NextResponse.json({
      ok: true,
      branch: headBranch,
      revertedTracked,
      keptUntracked,
      keptUntrackedByBranch,
      revertError,
      message:
        revertedTracked === 0
          ? keptUntracked === 0
            ? "Nothing to discard."
            : `Nothing tracked to revert. Kept ${keptUntracked} untracked file${
                keptUntracked === 1 ? "" : "s"
              }${keptSummary ? ` (${keptSummary})` : ""}.`
          : `Reverted ${revertedTracked} tracked file${
              revertedTracked === 1 ? "" : "s"
            }${
              keptUntracked > 0
                ? `. Kept ${keptUntracked} untracked file${
                    keptUntracked === 1 ? "" : "s"
                  }${keptSummary ? ` (${keptSummary})` : ""}.`
                : "."
            }`,
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
