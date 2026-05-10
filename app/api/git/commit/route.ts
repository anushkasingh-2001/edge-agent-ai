import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
  runGit,
} from "@/lib/server-git"
import { runScannerOn, ScannerError } from "@/lib/server-scan"

/**
 * POST /api/git/commit
 *
 * Body:
 *   {
 *     projectPath: string
 *     message: string
 *     runScanBeforeCommit: boolean
 *     warnOnCriticalFindings: boolean
 *   }
 *
 * Behaviour:
 *   1. Resolve + authorise projectPath. Ensure it's a Git repo.
 *   2. Validate `message` (required, capped length).
 *   3. If `runScanBeforeCommit`, run the scanner on the project. If
 *      `warnOnCriticalFindings` and the scan reports any critical/high
 *      findings, return 409 with `{ blocked: true, report }` so the UI
 *      can present the findings before letting the user proceed.
 *   4. `git status --short`; if empty, return `{ ok: true, noChanges: true }`.
 *   5. `git add -A` then `git commit -m <message>`.
 *
 * The route never pushes — push is a separate, explicitly confirmed
 * action under /api/git/push.
 */

const MAX_MESSAGE_LEN = 4000

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      message?: string
      runScanBeforeCommit?: boolean
      warnOnCriticalFindings?: boolean
    }

    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const rawMessage = typeof body.message === "string" ? body.message : ""
    const message = rawMessage.trim()
    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Commit message is required." },
        { status: 400 }
      )
    }
    if (message.length > MAX_MESSAGE_LEN) {
      return NextResponse.json(
        {
          ok: false,
          error: `Commit message too long (max ${MAX_MESSAGE_LEN} characters).`,
        },
        { status: 400 }
      )
    }

    const runScan = !!body.runScanBeforeCommit
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
            error: "Pre-commit scan failed",
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
            message: `Commit blocked: scanner reports ${scan.summary.critical} critical and ${scan.summary.high} high finding(s).`,
            report: {
              risk_score: scan.risk_score,
              summary: scan.summary,
            },
          },
          { status: 409 }
        )
      }
    }

    const status = runGit(resolved, ["status", "--short"])
    if (status.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "git status failed",
          stderr: status.stderr.slice(0, 2000),
        },
        { status: 500 }
      )
    }
    if (status.stdout.trim().length === 0) {
      return NextResponse.json({
        ok: true,
        noChanges: true,
        message: "No changes to commit.",
        report: scan
          ? { risk_score: scan.risk_score, summary: scan.summary }
          : null,
      })
    }

    const add = runGit(resolved, ["add", "-A"], { timeoutMs: 60_000 })
    if (add.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          phase: "add",
          message: "git add -A failed",
          stderr: add.stderr.slice(0, 4000),
        },
        { status: 500 }
      )
    }

    const commit = runGit(resolved, ["commit", "-m", message], {
      timeoutMs: 30_000,
    })
    if (commit.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          phase: "commit",
          message: "git commit failed",
          stderr: commit.stderr.slice(0, 4000),
          stdout: commit.stdout.slice(0, 2000),
        },
        { status: 500 }
      )
    }

    const sha = runGit(resolved, ["rev-parse", "--short", "HEAD"])
    const shortSha = sha.status === 0 ? sha.stdout.trim() || null : null

    return NextResponse.json({
      ok: true,
      message: `Committed${shortSha ? ` (${shortSha})` : ""}: ${
        message.split("\n")[0]
      }`,
      sha: shortSha,
      stdout: commit.stdout.slice(0, 2000),
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
