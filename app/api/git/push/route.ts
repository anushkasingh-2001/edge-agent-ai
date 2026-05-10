import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
  runGit,
  validateRef,
} from "@/lib/server-git"
import { runScannerOn, ScannerError } from "@/lib/server-scan"

/**
 * POST /api/git/push
 *
 * Body:
 *   {
 *     projectPath: string
 *     branch: string
 *     runScanBeforePush: boolean
 *     warnOnCriticalFindings: boolean
 *   }
 *
 * Behaviour:
 *   1. Resolve + authorise projectPath. Ensure it's a Git repo.
 *   2. Validate `branch`.
 *   3. If `runScanBeforePush`, run the scanner. If
 *      `warnOnCriticalFindings` and the scan reports any critical or
 *      high findings, return 409 with `{ blocked: true, report }` so
 *      the UI can let the user review before retrying.
 *   4. `git push origin <branch>` (no `--force`, no shell).
 *
 * Network credentials come from the user's existing git config; we
 * never prompt (GIT_TERMINAL_PROMPT=0 is set in `runGit`), so missing
 * credentials surface cleanly via stderr instead of hanging.
 */

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      branch?: string
      runScanBeforePush?: boolean
      warnOnCriticalFindings?: boolean
    }

    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)
    const branch = validateRef(body.branch, "branch")

    const runScan = !!body.runScanBeforePush
    const warnOnCritical = !!body.warnOnCriticalFindings

    let scan: Awaited<ReturnType<typeof runScannerOn>> | null = null
    if (runScan) {
      try {
        scan = await runScannerOn(resolved)
      } catch (e) {
        const err = e as ScannerError
        return NextResponse.json(
          {
            ok: false,
            phase: "scan",
            error: "Pre-push scan failed",
            message: err.message,
            stderr: err.stderr,
          },
          { status: 500 }
        )
      }
      if (
        warnOnCritical &&
        scan &&
        (scan.summary.critical > 0 || scan.summary.high > 0)
      ) {
        return NextResponse.json(
          {
            ok: false,
            blocked: true,
            phase: "scan",
            reason: "critical_or_high_findings",
            message: `Push blocked: scanner reports ${scan.summary.critical} critical and ${scan.summary.high} high finding(s).`,
            report: {
              risk_score: scan.risk_score,
              summary: scan.summary,
            },
          },
          { status: 409 }
        )
      }
    }

    const push = runGit(resolved, ["push", "origin", branch], {
      timeoutMs: 90_000,
    })
    if (push.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          phase: "push",
          message: "git push failed",
          stderr: push.stderr.slice(0, 4000),
          stdout: push.stdout.slice(0, 2000),
        },
        { status: 502 }
      )
    }

    return NextResponse.json({
      ok: true,
      branch,
      message: `Pushed '${branch}' to origin.`,
      stdout: push.stdout.trim(),
      stderr: push.stderr.trim(),
      report: scan
        ? { risk_score: scan.risk_score, summary: scan.summary }
        : null,
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
