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
  resetAttribution,
} from "@/lib/server-untracked-attribution"

/**
 * POST /api/git/reattribute
 *
 * Body: { projectPath: string, confirm: true }
 *
 * Wipes `.edgeagent/untracked-attribution.json` and the head
 * snapshot, then runs one fresh attribution pass against the current
 * working tree. The fresh pass uses the reflog + mtime heuristic
 * (see `lib/server-untracked-attribution.ts`) instead of any
 * previously-cached entries.
 *
 * Use case: the attribution map got locked in with wrong entries
 * (e.g. files were tagged to `main` because that was the branch
 * checked out the very first time the app ran, even though the
 * files were really created on a feature branch). The user clicks
 * "Re-attribute" and we get a fresh inference.
 *
 * Returns:
 *   {
 *     ok: true,
 *     removedEntries: number,    // entries dropped from old map
 *     ownBranch: string[],       // files now attributed to current
 *     otherBranch: { path, branch }[],  // files now attributed elsewhere
 *     branch: string | null,     // current branch
 *   }
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      confirm?: boolean
    }
    if (body.confirm !== true) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Re-attribute requires explicit confirmation (confirm: true).",
        },
        { status: 400 }
      )
    }

    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const { removedEntries } = resetAttribution(resolved)

    const headInfo = runGit(resolved, ["rev-parse", "--abbrev-ref", "HEAD"])
    const branch =
      headInfo.status === 0 ? headInfo.stdout.trim() || null : null

    const untracked = listUntrackedFiles(resolved)
    // First call after reset has no prior snapshot. Every file gets
    // attributed to the current branch (optimistic default) since
    // we have no evidence they came from elsewhere.
    const result = attributeUntrackedFiles(resolved, branch, untracked)

    return NextResponse.json({
      ok: true,
      removedEntries,
      branch,
      ownBranch: result.ownBranch,
      otherBranch: result.otherBranch,
      message: `Re-attributed ${untracked.length} untracked file${
        untracked.length === 1 ? "" : "s"
      }: ${result.ownBranch.length} on '${branch ?? "?"}', ${
        result.otherBranch.length
      } on other branches.`,
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
