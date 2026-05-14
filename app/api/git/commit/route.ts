import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  listStashes,
  resolveProjectPath,
  runGit,
} from "@/lib/server-git"
import { runScannerOn, ScannerError } from "@/lib/server-scan"
import { evaluatePolicy, type PolicyEvaluation } from "@/lib/policy"
import {
  loadComparisonBaseline,
  loadPolicyFor,
  writeLastScan,
} from "@/lib/server-policy"
import type { ScanReport } from "@/lib/scan-report"
import {
  attributeUntrackedFiles,
  listUntrackedFiles,
} from "@/lib/server-untracked-attribution"

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
 *   4. If `stashRef` was provided AND the policy gate passed,
 *      `git stash pop <stashRef>` so the stashed contents land in the
 *      working tree before staging. On conflict we bail with
 *      `{ blocked: true, reason: "stash_pop_conflict" }` and the
 *      stash is left intact for the user to resolve manually.
 *   5. `git status --short`; if empty, return `{ ok: true, noChanges: true }`.
 *   6. `git add -A` then `git commit -m <message>`.
 *
 * The route never pushes — push is a separate, explicitly confirmed
 * action under /api/git/push.
 *
 * The optional `stashRef` field lets the UI commit a "stash-only-
 * dirty" branch (yellow Commit dot driven purely by the stash) in a
 * single click: scan + policy gate first (the scan route already
 * auto-merges stash@{0} contents), then pop and commit.
 */

const MAX_MESSAGE_LEN = 4000
const STASH_REF_RE = /^stash@\{\d+\}$/

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      message?: string
      runScanBeforeCommit?: boolean
      warnOnCriticalFindings?: boolean
      stashRef?: string
    }

    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    // Validate stashRef strictly — git accepts a lot of refspecs and
    // we don't want to forward arbitrary user input to `git stash pop`.
    // The format must be exactly "stash@{N}".
    let requestedStashRef: string | null = null
    if (typeof body.stashRef === "string" && body.stashRef.trim()) {
      const candidate = body.stashRef.trim()
      if (!STASH_REF_RE.test(candidate)) {
        return NextResponse.json(
          {
            ok: false,
            error: `Invalid stashRef "${candidate}" — must look like "stash@{0}".`,
          },
          { status: 400 }
        )
      }
      requestedStashRef = candidate
    }

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

    // Load policy FIRST so we can force the scan whenever it's in
    // block mode. Otherwise a stale `runScanBeforeCommit: false` in
    // the user's localStorage (left over from before that toggle
    // defaulted to on) would silently skip the entire policy gate
    // and the commit would slip through even though the policy file
    // says it should block. The policy file is now authoritative —
    // not a UI checkbox.
    const loaded = loadPolicyFor(resolved)
    // The commit section of the policy now controls whether we MUST
    // run the scan and whether a `block` decision actually blocks. The
    // policy file is authoritative; client toggles in the dialog are
    // a UX hint that policy can override either way.
    const commitPolicy = loaded.policy.commit ?? {}
    const policyEnforces = loaded.policy.mode === "block"
    const policyForcesScan = commitPolicy.run_scan_before_commit !== false
    const requestedScan = !!body.runScanBeforeCommit
    const runScan = policyEnforces || policyForcesScan || requestedScan
    const scanForcedByPolicy =
      (policyEnforces || policyForcesScan) && !requestedScan
    const blockOnPolicyBlock = commitPolicy.block_if_policy_blocks !== false
    const warnOnCritical = !!body.warnOnCriticalFindings

    let scan: Awaited<ReturnType<typeof runScannerOn>> | null = null
    let policyEval: PolicyEvaluation | null = null
    let policyMeta:
      | {
          policySource: "file" | "default"
          policyErrors: string[]
          baseSource: "base_branch" | "snapshot" | "none"
          baseBranch: string | null
          baseSha: string | null
          scanForcedByPolicy: boolean
        }
      | null = null
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

      // Policy file (when present) supersedes the simple critical/high
      // toggle. We only block when policy says "block"; a pure "warn"
      // result lets the commit through but the UI still surfaces it.
      //
      // The baseline we compare against is, in priority order:
      //   1. A scan of the configured base branch (default "main"),
      //      which mirrors what Branch Compare does. This is what
      //      detects "you regressed vs main" — the case the
      //      per-project snapshot misses on first-commit-on-feature-
      //      branch.
      //   2. The per-branch last-scan snapshot, used when we're
      //      committing on the base branch itself or the base scan
      //      failed.
      //   3. None — only absolute rules (block_if_critical) apply.
      const branchInfo = runGit(resolved, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])
      const currentBranch =
        branchInfo.status === 0 ? branchInfo.stdout.trim() || null : null
      const baseline = await loadComparisonBaseline(resolved, {
        policy: loaded.policy,
        currentBranch,
      })
      policyEval = evaluatePolicy({
        baseReport: baseline.baseReport ?? null,
        targetReport: {
          risk_score: scan.risk_score,
          summary: scan.summary,
        } as unknown as ScanReport,
        policy: loaded.policy,
        context: { branch: currentBranch ?? undefined },
      })
      policyMeta = {
        policySource: loaded.policySource,
        policyErrors: loaded.policyErrors,
        baseSource: baseline.baseSource,
        baseBranch: baseline.baseBranchScan.branch,
        baseSha: baseline.baseBranchScan.sha,
        scanForcedByPolicy,
      }

      const policyBlocks =
        policyEval.decision === "block" && blockOnPolicyBlock
      const fallbackBlocks =
        loaded.policySource === "default" &&
        warnOnCritical &&
        (scan.summary.critical > 0 || scan.summary.high > 0)
      if (policyBlocks || fallbackBlocks) {
        return NextResponse.json(
          {
            ok: false,
            blocked: true,
            phase: "scan",
            reason: policyBlocks
              ? "policy_block"
              : "critical_or_high_findings",
            message: policyBlocks
              ? `Commit blocked by policy: ${
                  policyEval.reasons[0] ?? "see details"
                }`
              : `Commit blocked: scanner reports ${scan.summary.critical} critical and ${scan.summary.high} high finding(s).`,
            report: {
              risk_score: scan.risk_score,
              summary: scan.summary,
            },
            policy: loaded.policy,
            policySource: loaded.policySource,
            policyErrors: loaded.policyErrors,
            baseSource: policyMeta?.baseSource,
            baseBranch: policyMeta?.baseBranch,
            baseSha: policyMeta?.baseSha,
            scanForcedByPolicy: policyMeta?.scanForcedByPolicy,
            evaluation: policyEval,
          },
          { status: 409 }
        )
      }
    }

    /* ----- Optional stash pop ------------------------------------- */
    //
    // Runs only after the policy gate passed (or was skipped). The
    // pre-commit scan already auto-merges `stash@{0}` contents, so
    // policy was effectively evaluated against working-tree + stash.
    // Now we materialise the stash into the working tree so the
    // upcoming `git add -A` picks it up. On conflict we surface a
    // 409 — the stash itself is preserved by `git stash pop` when
    // apply fails, so the user can resolve manually.
    let stashPopped: { ref: string; subject: string } | null = null
    if (requestedStashRef) {
      const stashes = listStashes(resolved)
      const entry = stashes.find((s) => s.ref === requestedStashRef)
      if (!entry) {
        return NextResponse.json(
          {
            ok: false,
            phase: "stash_pop",
            error: `Stash ${requestedStashRef} not found. The stash may have been popped or dropped externally — refresh and try again.`,
          },
          { status: 404 }
        )
      }
      const pop = runGit(resolved, ["stash", "pop", requestedStashRef], {
        timeoutMs: 30_000,
      })
      if (pop.status !== 0) {
        return NextResponse.json(
          {
            ok: false,
            blocked: true,
            reason: "stash_pop_conflict",
            phase: "stash_pop",
            message: `Could not apply ${requestedStashRef}: ${
              pop.stderr.split("\n")[0] || "conflict while applying stash"
            }. The stash was kept — resolve manually with \`git stash pop\` and commit again.`,
            stderr: pop.stderr.slice(0, 4000),
            stdout: pop.stdout.slice(0, 2000),
          },
          { status: 409 }
        )
      }
      stashPopped = { ref: requestedStashRef, subject: entry.subject }
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
        evaluation: policyEval,
        policySource: policyMeta?.policySource,
        policyErrors: policyMeta?.policyErrors,
        baseSource: policyMeta?.baseSource,
        baseBranch: policyMeta?.baseBranch,
        baseSha: policyMeta?.baseSha,
        scanForcedByPolicy: policyMeta?.scanForcedByPolicy,
        stashPopped,
      })
    }

    /* ----- Inclusive staging -------------------------------------- */
    //
    // We snapshot untracked files BEFORE `git add -A` (since adding
    // moves them into the index and makes them "tracked" from
    // `ls-files --others`'s perspective). The attribution map is
    // updated for informational reporting — tooltips can say "3
    // untracked from `low` were also committed" — but we no longer
    // skip cross-branch files. The user asked for `git commit` to
    // behave like `git commit -A` and commit everything visible.
    const headBranchInfo = runGit(resolved, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ])
    const headBranch =
      headBranchInfo.status === 0 ? headBranchInfo.stdout.trim() || null : null
    const allUntrackedPreStage = listUntrackedFiles(resolved)
    const attribution = attributeUntrackedFiles(
      resolved,
      headBranch,
      allUntrackedPreStage
    )

    const addAll = runGit(resolved, ["add", "-A"], { timeoutMs: 60_000 })
    if (addAll.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          phase: "add",
          message: "git add -A failed",
          stderr: addAll.stderr.slice(0, 4000),
        },
        { status: 500 }
      )
    }

    const untrackedStaged = allUntrackedPreStage.length
    const untrackedSkipped = 0

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

    // Persist the post-commit snapshot so the NEXT commit's pre-scan
    // can detect "you regressed since the last accepted change."
    // Only do this when we actually ran a scan and it passed the gate
    // — otherwise we'd have no data to record, or worse, would lock
    // in a state we never verified.
    if (scan) {
      const branchInfo = runGit(resolved, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])
      const branch =
        branchInfo.status === 0 ? branchInfo.stdout.trim() || null : null
      writeLastScan(resolved, {
        risk_score: scan.risk_score,
        summary: { ...scan.summary },
        generated_at: new Date().toISOString(),
        branch,
        sha: shortSha,
        source: "commit",
      })
    }

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
      evaluation: policyEval,
      policySource: policyMeta?.policySource,
      policyErrors: policyMeta?.policyErrors,
      baseSource: policyMeta?.baseSource,
      baseBranch: policyMeta?.baseBranch,
      baseSha: policyMeta?.baseSha,
      scanForcedByPolicy: policyMeta?.scanForcedByPolicy,
      // Attribution-aware reporting (informational): how many of the
      // staged untracked files we believed belong to `headBranch`
      // vs another branch. Both buckets were committed; the split
      // lets the UI show "N untracked from `low` also committed."
      staging: {
        untrackedStaged,
        untrackedSkipped,
        untrackedFromOtherBranches: attribution.otherBranch
          .slice(0, 10)
          .map((e) => ({ path: e.path, branch: e.branch })),
        untrackedFromOtherBranchCount: attribution.otherBranch.length,
      },
      stashPopped,
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
