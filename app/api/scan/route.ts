import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { NextResponse } from "next/server"
import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import {
  attributeUntrackedFiles,
  listUntrackedFiles,
} from "@/lib/server-untracked-attribution"
import {
  GitError,
  detectRepoDefaultBranch,
  listStashesForBranch,
  resolveRef,
  softResolveRef,
} from "@/lib/server-git"
import {
  ScannerError,
  buildScannerCommand,
  type ScannerCommand,
} from "@/lib/server-scan"

export async function POST(request: Request) {
  let body: {
    projectPath?: string
    checks?: string[]
    /** When true, untracked files are *included* in the scan (default
     *  true). Pre-commit gate flows can set this to false to scan only
     *  what would actually land on the branch. */
    includeUntracked?: boolean
    /** Branch to scan. When omitted or equal to the currently
     *  checked-out branch, scans the working tree in place (and
     *  reports dirty-tree status). When set to a *different* branch
     *  the route materialises a temp `git worktree` at that branch's
     *  HEAD SHA and scans there — letting users get accurate counts
     *  for branches they aren't currently checked out on (the fix
     *  for "select gt in dropdown → still see main's findings"). */
    branch?: string
    // NOTE: intelligenceMode / aiProviderMode / manualModelSelection are
    // intentionally NOT on this body. The scanner is deterministic and
    // doesn't consult them; routes that DO consume them are
    //   /api/scan/estimate, /api/finding/explain, /api/finding/patch,
    //   /api/findings/fix, /api/findings/fix-filtered.
    // The client stamps the mode onto scan history via
    // `scanItemFromReport`, so the round-trip preserves it without
    // a server-side echo. See the audit in
    // tests/all-modes-e2e-wiring.test.ts for the contract.
  } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  if (!body.projectPath || typeof body.projectPath !== "string" || !body.projectPath.trim()) {
    return NextResponse.json(
      {
        error:
          "projectPath is required. Open a local project or clone from GitHub before scanning.",
      },
      { status: 400 }
    )
  }

  const allowRoot = getScanAllowRoot()
  const requested = path.resolve(body.projectPath.trim())

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

  // Scanner resolution (binary > EDGE_AGENT_PYTHON > <cwd>/scanner)
  // happens lazily inside `buildScannerCommand` further down — once we
  // know the actual `scanTarget` (working tree vs virtual worktree).
  // We don't probe ahead of time here because a misconfigured
  // EDGE_AGENT_SCANNER_BIN should fail with the binary-specific
  // error, not a generic "scanner package not found".

  /* ---------------------------------------------------------------- */
  /* Decide: virtual branch checkout, or in-place scan?               */
  /* ---------------------------------------------------------------- */
  //
  // Stash scans are NOT a separate mode: every in-place scan below
  // automatically folds `stash@{0}` contents into the report (see
  // the auto-merge block further down). One scan = committed code
  // + working tree + stashed WIP, always.

  const currentHead = detectBranch(requested)
  const requestedBranch =
    typeof body.branch === "string" && body.branch.trim().length > 0
      ? body.branch.trim()
      : null

  // ── Gracefully handle stale branch records ──────────────────────────
  // The most common cause of a 400 here used to be:
  //   "ref 'main' could not be resolved as a local branch, remote-
  //    tracking branch, or commit"
  // … which fired when an older clone path baked `branch: "main"`
  // into the project's localStorage, but the repo's actual default
  // is `master` (or `develop`, `trunk`, …). The user's intent in
  // that case is "scan whatever I'm on" — NOT "fail with a cryptic
  // git error". So we soft-resolve the requested branch; if it
  // doesn't exist, fall back to current HEAD and tell the client we
  // did, so it can heal its stored record.
  let effectiveBranch = requestedBranch
  let branchCorrection: { from: string; to: string | null } | null = null
  if (requestedBranch) {
    const resolved = softResolveRef(requested, requestedBranch)
    if (!resolved) {
      const fallback =
        currentHead ?? detectRepoDefaultBranch(requested) ?? null
      branchCorrection = { from: requestedBranch, to: fallback }
      effectiveBranch = fallback
    }
  }

  // Virtual checkout iff the user asked for a *different* branch than
  // the one currently checked out. Same-branch requests fall through to
  // in-place scan so we still report dirty-tree state etc.
  const wantsVirtualCheckout =
    !!effectiveBranch && currentHead !== effectiveBranch

  let scanTarget = requested
  let virtualCheckout: {
    branch: string
    sha: string
    worktreeDir: string
  } | null = null

  if (wantsVirtualCheckout) {
    try {
      // Resolve the (effective) branch name to a concrete SHA.
      // effectiveBranch is guaranteed resolvable here because the
      // soft-resolve block above either confirmed the original ref
      // or downgraded us to currentHead (which by definition resolves
      // on a non-detached repo). Use the strict resolveRef so we
      // surface a structured error if something pathological happens
      // (e.g. someone deleted the branch between our two calls).
      const resolved = resolveRef(requested, effectiveBranch!)
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const worktreeDir = path.join(
        os.tmpdir(),
        `edge-scan-worktree-${stamp}`
      )
      addWorktree(requested, worktreeDir, resolved.sha)
      virtualCheckout = {
        branch: effectiveBranch!,
        sha: resolved.sha,
        worktreeDir,
      }
      scanTarget = worktreeDir
    } catch (err) {
      if (err instanceof GitError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }
      return NextResponse.json(
        {
          error: `Failed to materialise virtual checkout for '${effectiveBranch}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
        { status: 500 }
      )
    }
  }

  // Hoisted so the `finally` block can clean up regardless of where
  // we threw inside the try. We may set up MULTIPLE stash worktrees
  // (one per stash that belongs to the current branch) plus a single
  // merged-extract dir that combines them — every one of those temp
  // paths needs to be removed on every code path.
  const autoStashSetups: ReturnType<typeof setupStashScan>[] = []
  let mergedStashExtractDir: string | null = null

  // Wrap the rest in try/finally so worktree cleanup runs even if the
  // scanner crashes or the response throws.
  try {
    const tmpFile = path.join(
      os.tmpdir(),
      `edge-scan-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    )

    const checks = Array.isArray(body.checks) ? body.checks : []

    /* ------------- Untracked-file handling ----------------------- */
    //
    // In-place scan (no virtual checkout):
    //   - includeUntracked=true (default): scan EVERYTHING in the
    //     working tree. Don't exclude anything based on attribution
    //     — the user explicitly wants to see findings for whatever
    //     code is sitting in front of them, regardless of which
    //     branch the file came from.
    //   - includeUntracked=false (pre-commit gate): exclude every
    //     untracked file — only scan what's already committed.
    //
    // Virtual checkout (scanning a different branch via worktree):
    //   - The temp worktree has zero untracked files of its own.
    //   - We copy EVERY untracked file from the user's working tree
    //     into it so the scan reflects what's actually on disk.
    //     (Previously we only mirrored files attributed to the
    //     requested branch, which felt magic and surprising.)
    const includeUntracked = body.includeUntracked !== false
    let untrackedExcluded: string[] = []
    let untrackedAllAttribution: {
      ownBranch: string[]
      otherBranch: { path: string; branch: string }[]
    } = { ownBranch: [], otherBranch: [] }
    let untrackedCopiedIntoWorktree: string[] = []

    if (!virtualCheckout) {
      if (!includeUntracked) {
        untrackedExcluded = listUntrackedFiles(requested)
        // Excludes are passed through `buildScannerCommand` below, not
        // mutated onto an args array here — keeps the spawn shape
        // centralised for the binary / venv / fallback branches.
      } else {
        // Refresh the attribution map (so the next status call sees
        // the current snapshot) but DO NOT pass --exclude args.
        // Every untracked file gets scanned.
        const allUntracked = listUntrackedFiles(requested)
        const attribution = attributeUntrackedFiles(
          requested,
          currentHead,
          allUntracked
        )
        untrackedAllAttribution = attribution
      }
    } else if (includeUntracked) {
      // Mirror the entire untracked set into the virtual worktree.
      // Best-effort copy: a file we can't read just gets skipped.
      const allUntracked = listUntrackedFiles(requested)
      // Refresh attribution as a side-effect so the in-place dirty
      // signal stays accurate after this scan.
      attributeUntrackedFiles(requested, currentHead, allUntracked)
      for (const rel of allUntracked) {
        const src = path.join(requested, rel)
        const dst = path.join(scanTarget, rel)
        try {
          if (!fs.existsSync(src)) continue
          const st = fs.statSync(src)
          if (!st.isFile()) continue
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          fs.copyFileSync(src, dst)
          untrackedCopiedIntoWorktree.push(rel)
        } catch {
          /* swallow — best-effort copy. A single unreadable file
             shouldn't sink the whole scan. */
        }
      }
    }

    let primaryCmd: ScannerCommand
    try {
      primaryCmd = buildScannerCommand({
        targetPath: scanTarget,
        outFile: tmpFile,
        checks,
        excludes: untrackedExcluded,
      })
    } catch (err) {
      const e = err as ScannerError
      return NextResponse.json(
        { error: e?.message ?? "Failed to resolve scanner" },
        { status: e?.status ?? 500 }
      )
    }

    const primary = runScanner({ cmd: primaryCmd, tmpFile })
    if (!primary.ok) {
      return primary.errorResp
    }

    /* ----- Auto-include EVERY stash on the current branch --------- */
    //
    // The user's expectation: "scan multiple files from multiple
    // stashes in a git branch — unique files and code change from
    // multiple stashes + current tracked committed files". So we:
    //
    //   1. Enumerate every `git stash` entry whose subject says
    //      "WIP on <currentBranch>:" / "On <currentBranch>:".
    //      Stashes belonging to OTHER branches are ignored — they're
    //      not "this branch's WIP".
    //   2. For each one, materialise just the touched files into a
    //      per-stash extract dir (existing `setupStashScan` helper).
    //   3. UNION them into a single merged dir, processed
    //      OLDEST → NEWEST so when two stashes touch the same
    //      file the newest version (closer to what the user is
    //      working on right now) wins. That gives us "unique files +
    //      code change from multiple stashes" — one copy per path,
    //      latest wins.
    //   4. Run the scanner once over the merged dir and fold its
    //      findings into the working-tree report (existing
    //      `mergeFindingsIntoReport` dedupes per-file/line/rule_id).
    //
    // Only fires for in-place scans:
    //   - `virtualCheckout` scans a different branch; including the
    //     CURRENT working tree's stash would be misleading there.
    //   - `includeUntracked: false` is the pre-commit gate, which
    //     deliberately excludes anything not committed; honour it.
    let autoStashReport: Record<string, unknown> | null = null
    let mergedStashFiles: string[] = []
    if (!virtualCheckout && includeUntracked) {
      const branchStashes = listStashesForBranch(requested, currentHead)
      if (branchStashes.length > 0) {
        try {
          // `listStashesForBranch` returns newest-first (matches
          // `git stash list`). Reverse to oldest-first so the copy
          // loop below ends with the newest content on disk.
          const orderedOldestFirst = [...branchStashes].reverse()
          for (const s of orderedOldestFirst) {
            try {
              autoStashSetups.push(setupStashScan(requested, s.ref))
            } catch {
              /* per-stash failures are non-fatal; we still want to
                 scan the ones that DID extract cleanly. */
            }
          }

          if (autoStashSetups.length > 0) {
            const stamp = `${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`
            mergedStashExtractDir = path.join(
              os.tmpdir(),
              `edge-stash-merged-${stamp}`
            )
            fs.mkdirSync(mergedStashExtractDir, { recursive: true })

            // Newer stashes overwrite older ones for the same file
            // because we iterate in oldest-first order. Track the
            // unique set so we can report it accurately.
            const seen = new Set<string>()
            for (const setup of autoStashSetups) {
              for (const rel of setup.files) {
                const src = path.join(setup.extractDir, rel)
                const dst = path.join(mergedStashExtractDir, rel)
                try {
                  if (!fs.existsSync(src)) continue
                  const st = fs.statSync(src)
                  if (!st.isFile()) continue
                  fs.mkdirSync(path.dirname(dst), { recursive: true })
                  fs.copyFileSync(src, dst)
                  seen.add(rel)
                } catch {
                  /* best-effort copy — a single unreadable file
                     shouldn't sink the whole stash merge. */
                }
              }
            }
            mergedStashFiles = Array.from(seen).sort()

            if (mergedStashFiles.length > 0) {
              // Re-run scanner against the merged extract dir. The
              // command is rebuilt from scratch (no `--exclude`
              // forwarded) so this second pass doesn't accidentally
              // inherit excludes that referenced the user's working
              // tree paths — they don't exist inside the merged
              // stash extract dir.
              //
              // The second pass is best-effort: any failure here
              // (resolution error, scanner crash) leaves
              // `autoStashReport` null and the merge becomes a
              // no-op. The primary scan results are still returned.
              let stashCmd: ScannerCommand | null = null
              try {
                stashCmd = buildScannerCommand({
                  targetPath: mergedStashExtractDir,
                  outFile: tmpFile,
                  checks,
                })
              } catch {
                stashCmd = null
              }
              if (stashCmd) {
                const stashRun = runScanner({ cmd: stashCmd, tmpFile })
                if (stashRun.ok && stashRun.report) {
                  autoStashReport = stashRun.report
                }
              }
            }
          }
        } catch {
          /* swallow — corrupt-stash / IO errors degrade to "no
             stash findings" rather than failing the whole scan. */
        }
      }
    }

    let report: Record<string, unknown> | null = primary.report
    try {
      if (autoStashReport && report) {
        report = mergeFindingsIntoReport(report, autoStashReport)
      }
      if (report) {

        if (virtualCheckout) {
          // Pristine checkout, plus any untracked files we copied in
          // from the user's working tree because they're attributed
          // to the requested branch. `untracked` reflects what got
          // mirrored; `virtual_checkout: true` still tells the UI
          // we're on a synthetic worktree (no porcelain status to
          // show).
          report.scan_root = requested // Report the *project* path, not the temp dir.
          report.working_tree = {
            clean: untrackedCopiedIntoWorktree.length === 0,
            branch: virtualCheckout.branch,
            untracked: untrackedCopiedIntoWorktree.length,
            modified: 0,
            total: untrackedCopiedIntoWorktree.length,
            virtual_checkout: true,
            virtual_checkout_sha: virtualCheckout.sha,
            untracked_mirrored_from_working_tree:
              untrackedCopiedIntoWorktree.length > 0,
            untracked_mirrored_paths: untrackedCopiedIntoWorktree.slice(
              0,
              25
            ),
          }
        } else {
          // In-place scan — collect porcelain status as before.
          // Attribution data is reported only as informational
          // metadata ("of those untracked files, N are tagged to
          // branch X"). The scanner already saw and processed
          // every one of them. When a stash was auto-included,
          // stamp the metadata so the UI can show "incl. stash"
          // alongside the untracked/modified counts.
          const wt = collectWorkingTreeStatus(requested)
          if (wt) {
            report.working_tree = {
              ...wt,
              untracked_excluded_from_scan: !includeUntracked,
              untracked_excluded_count: includeUntracked
                ? 0
                : untrackedExcluded.length,
              untracked_attributed_other_branch_count:
                untrackedAllAttribution.otherBranch.length,
              untracked_attributed_other_branches:
                untrackedAllAttribution.otherBranch
                  .slice(0, 10)
                  .map((e) => ({ path: e.path, branch: e.branch })),
              ...(autoStashSetups.length > 0 && autoStashReport
                ? (() => {
                    // `autoStashSetups` is oldest-first, so the LAST
                    // entry is the most recent stash (`stash@{0}`).
                    // Backward-compat fields (`stash_ref`, `stash_sha`,
                    // `stash_message`) all describe that latest stash;
                    // `stash_files` / `stash_file_count` describe the
                    // UNION across all included stashes (latest wins
                    // on per-file conflicts), which matches what the
                    // scanner actually walked.
                    const latest =
                      autoStashSetups[autoStashSetups.length - 1]
                    return {
                      stash_included: true,
                      stash_ref: latest.ref,
                      stash_sha: latest.sha,
                      stash_message: latest.message,
                      stash_files: mergedStashFiles.slice(0, 50),
                      stash_file_count: mergedStashFiles.length,
                      // Per-stash breakdown so the UI can show
                      // "3 stashes folded in: stash@{0} (2 files),
                      // stash@{1} (5 files), stash@{2} (1 file)".
                      // Listed newest-first to match `git stash list`.
                      stashes_included: [...autoStashSetups]
                        .reverse()
                        .map((s) => ({
                          ref: s.ref,
                          sha: s.sha,
                          message: s.message,
                          file_count: s.files.length,
                        })),
                      stashes_included_count: autoStashSetups.length,
                    }
                  })()
                : {}),
            }
          }
        }
      }
    } catch {
      // If something downstream (merge, working_tree shaping) blew
      // up, fall back to the raw primary report rather than dropping
      // the whole response. The client schema layer will surface any
      // remaining issues.
      report = primary.report
    }

    const out = report ? JSON.stringify(report) : ""
    // Surface "we scanned a different branch than you asked for"
    // via response headers so the client can heal its stored
    // project record without us breaking the JSON body shape.
    const respHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (branchCorrection) {
      respHeaders["X-Edge-Branch-Correction-From"] = branchCorrection.from
      if (branchCorrection.to) {
        respHeaders["X-Edge-Branch-Correction-To"] = branchCorrection.to
      }
    }
    return new NextResponse(out, {
      status: 200,
      headers: respHeaders,
    })
  } finally {
    // Best-effort cleanup of the temp worktree(s). Failures here
    // aren't user-visible — `git worktree prune` reaps stale
    // entries even if we leave one behind.
    if (virtualCheckout) {
      removeWorktree(requested, virtualCheckout.worktreeDir)
    }
    // Tear down every per-stash worktree + extract dir that we set
    // up. Run cleanup for ALL of them even if one throws, so a
    // single bad stash doesn't leave the others stranded on disk.
    for (const setup of autoStashSetups) {
      try {
        removeWorktree(requested, setup.worktreeDir)
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(setup.extractDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    if (mergedStashExtractDir) {
      try {
        fs.rmSync(mergedStashExtractDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Resolve the currently checked-out branch under `projectPath`, or
 * null when not on a branch (detached HEAD), not a git repo, or git
 * isn't available. Used as the attribution key for untracked files
 * AND as the "is this scan asking for a different branch?" check.
 */
function detectBranch(projectPath: string): string | null {
  try {
    const br = spawnSync(
      "git",
      ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf-8" }
    )
    if (br.status !== 0) return null
    const v = br.stdout.trim()
    return v && v !== "HEAD" ? v : null
  } catch {
    return null
  }
}

/**
 * Materialise `sha` from `repo` into a fresh detached worktree at
 * `dest`. `dest` must not already exist. Throws on failure.
 *
 * Inlined here rather than imported from `lib/server-policy` because
 * the policy module's helpers are private and adding an export
 * surface for one caller felt heavier than duplicating the 6 lines.
 * If a third caller appears, lift these into `lib/server-git.ts`.
 */
function addWorktree(repo: string, dest: string, sha: string): void {
  const r = spawnSync(
    "git",
    ["-C", repo, "worktree", "add", "--detach", dest, sha],
    { encoding: "utf-8", timeout: 60_000 }
  )
  if (r.status !== 0) {
    throw new Error(
      `git worktree add failed for ${sha}: ${(r.stderr ?? "").slice(0, 1000)}`
    )
  }
}

/**
 * Spawn the scanner described by `cmd` and parse its JSON output from
 * `tmpFile`. Returns `{ ok: true, report }` on success, or `{ ok:
 * false, errorResp }` with a NextResponse the caller returns verbatim.
 *
 * Error responses include enough provenance for the user to debug a
 * failed binary OR a failed venv invocation without spelunking the
 * server logs:
 *   - source       — "scanner_bin" | "python_venv" | "python_fallback"
 *   - scannerBin   — populated only on the binary branch
 *   - command      — the full argv that ran (paths only — no secrets;
 *                    scanner args never include credentials)
 *   - exitCode     — proc.status
 *   - stdout/stderr — truncated for response-size safety
 */
function runScanner(opts: {
  cmd: ScannerCommand
  tmpFile: string
}):
  | { ok: true; report: Record<string, unknown> | null; errorResp?: undefined }
  | { ok: false; report?: undefined; errorResp: NextResponse } {
  const { cmd, tmpFile } = opts
  const proc = spawnSync(cmd.cmd, cmd.args, {
    cwd: cmd.cwd,
    env: cmd.env,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  })

  if (proc.error) {
    return {
      ok: false,
      errorResp: NextResponse.json(
        {
          error: `Failed to spawn scanner: ${proc.error.message}`,
          source: cmd.source,
          scannerBin: cmd.scannerBin,
          command: [cmd.cmd, ...cmd.args],
        },
        { status: 500 }
      ),
    }
  }
  if (proc.status !== 0) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      errorResp: NextResponse.json(
        {
          error: "Scanner process failed",
          source: cmd.source,
          scannerBin: cmd.scannerBin,
          command: [cmd.cmd, ...cmd.args],
          exitCode: proc.status,
          stderr: proc.stderr?.slice(0, 8000),
          stdout: proc.stdout?.slice(0, 2000),
        },
        { status: 500 }
      ),
    }
  }

  let report: Record<string, unknown> | null = null
  try {
    const json = fs.readFileSync(tmpFile, "utf-8")
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      /* ignore */
    }
    const parsed: unknown = JSON.parse(json)
    if (parsed && typeof parsed === "object") {
      report = parsed as Record<string, unknown>
    }
  } catch {
    report = null
  }
  return { ok: true, report }
}

/**
 * Merge `addition`'s findings into `base`'s, recompute summary +
 * risk_score from the deduped union, and union the framework /
 * agent / tool detection arrays. Mirrors the Python scanner's
 * algorithms exactly so the merged report is indistinguishable
 * from one produced by a single scanner pass over both file sets:
 *
 *   - dedupe key: `(rule_id, file, line, title)` (matches
 *     `engine._dedupe_findings`)
 *   - severity weights: critical=25, high=15, medium=7, low=3,
 *     summed and capped at 100 (matches `engine._compute_risk_score`)
 *
 * `scan_root`, `generated_at`, and `working_tree` come from `base`
 * — the auto-stash pass shouldn't override them; only the *findings*
 * cross over.
 */
function mergeFindingsIntoReport(
  base: Record<string, unknown>,
  addition: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }

  // 1. Findings: concat then dedupe by (rule_id, file, line, title).
  const a = Array.isArray(base.findings) ? (base.findings as unknown[]) : []
  const b = Array.isArray(addition.findings)
    ? (addition.findings as unknown[])
    : []
  const seen = new Set<string>()
  const merged: Record<string, unknown>[] = []
  for (const f of [...a, ...b]) {
    if (!f || typeof f !== "object") continue
    const r = f as Record<string, unknown>
    const key = `${String(r.rule_id ?? "")}|${String(r.file ?? "")}|${String(
      r.line ?? ""
    )}|${String(r.title ?? "")}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(r)
  }
  out.findings = merged

  // 2. Summary: count from merged findings.
  let critical = 0
  let high = 0
  let medium = 0
  let low = 0
  for (const f of merged) {
    const s = String(f.severity ?? "low")
    if (s === "critical") critical++
    else if (s === "high") high++
    else if (s === "medium") medium++
    else low++
  }
  out.summary = {
    critical,
    high,
    medium,
    low,
    total: merged.length,
  }

  // 3. Risk score: same weights as the scanner, capped at 100.
  const score =
    critical * 25 + high * 15 + medium * 7 + low * 3
  out.risk_score = Math.min(100, score)

  // 4. Union detected lists. Use a stringified key so duplicates
  //    across the two reports collapse cleanly.
  const unionBy = <T>(
    listA: unknown,
    listB: unknown,
    keyFn: (item: T) => string
  ): T[] => {
    const result: T[] = []
    const taken = new Set<string>()
    for (const list of [listA, listB]) {
      if (!Array.isArray(list)) continue
      for (const item of list as T[]) {
        const k = keyFn(item)
        if (taken.has(k)) continue
        taken.add(k)
        result.push(item)
      }
    }
    return result
  }
  out.frameworks_detected = unionBy(
    base.frameworks_detected,
    addition.frameworks_detected,
    (item: { name?: unknown }) => String(item?.name ?? "")
  )
  out.agents_detected = unionBy(
    base.agents_detected,
    addition.agents_detected,
    (item: { file?: unknown; name?: unknown }) =>
      `${String(item?.file ?? "")}|${String(item?.name ?? "")}`
  )
  out.tools_detected = unionBy(
    base.tools_detected,
    addition.tools_detected,
    (item: { file?: unknown; name?: unknown }) =>
      `${String(item?.file ?? "")}|${String(item?.name ?? "")}`
  )

  // 5. files_scanned: sum across both passes. Without this, the "N
  //    files scanned" badge in Recent Scans would only reflect the
  //    primary working-tree pass and a multi-stash scan would look
  //    like "1 file scanned, 3 findings", which is exactly the
  //    misleading number the user spotted. Sum the per-extension
  //    breakdown the same way so the tooltip is consistent.
  const baseFiles = typeof base.files_scanned === "number" ? base.files_scanned : 0
  const addFiles = typeof addition.files_scanned === "number" ? addition.files_scanned : 0
  if (baseFiles || addFiles) {
    out.files_scanned = baseFiles + addFiles
  }
  const baseExt = (base.files_scanned_by_ext ?? {}) as Record<string, unknown>
  const addExt = (addition.files_scanned_by_ext ?? {}) as Record<string, unknown>
  if (Object.keys(baseExt).length || Object.keys(addExt).length) {
    const mergedExt: Record<string, number> = {}
    for (const [k, v] of Object.entries(baseExt)) {
      if (typeof v === "number") mergedExt[k] = (mergedExt[k] ?? 0) + v
    }
    for (const [k, v] of Object.entries(addExt)) {
      if (typeof v === "number") mergedExt[k] = (mergedExt[k] ?? 0) + v
    }
    out.files_scanned_by_ext = mergedExt
  }

  return out
}

/** Thrown by `setupStashScan` for predictable failure cases (no such
 *  stash, repo missing, apply conflict). The route catches it and
 *  surfaces the message + status to the client. */
class StashScanError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "StashScanError"
    this.status = status
  }
}

/**
 * Set up everything needed to scan exactly one stash entry's contents.
 *
 *   1. Resolve the stash ref to a concrete SHA (`git rev-parse
 *      <ref>^{commit}`). 404 if it doesn't exist.
 *   2. Read the stash subject so we can show "WIP on main: …" in the
 *      report header.
 *   3. Create a fresh detached worktree at HEAD inside the OS temp
 *      dir. Detached so `git stash apply` doesn't try to move a
 *      branch ref.
 *   4. `git stash apply <sha>` inside the worktree. Conflicts bail
 *      with a 409.
 *   5. Enumerate the files the stash actually touched: `git diff
 *      --name-only HEAD` for modified/added tracked files plus
 *      `git ls-files --others --exclude-standard` for new untracked
 *      ones. Anything not in this list is HEAD-as-is and would
 *      pollute the scan with committed code.
 *   6. Copy ONLY those files into a separate clean temp dir (no
 *      `.git`, no committed code, no surprises). The scanner walks
 *      that dir.
 *
 * On success: returns `{ ref, sha, message, worktreeDir, extractDir,
 * files }`. The caller must pass `worktreeDir` and `extractDir` to
 * `removeWorktree` / `fs.rmSync` in its `finally` block.
 */
function setupStashScan(
  repo: string,
  ref: string
): {
  ref: string
  sha: string
  message: string
  worktreeDir: string
  extractDir: string
  files: string[]
} {
  // 1. Resolve to commit SHA. `^{commit}` peels through any tag-like
  //    indirection and surfaces "unknown revision" in stderr if the
  //    stash slot is empty.
  const rev = spawnSync(
    "git",
    ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`],
    { encoding: "utf-8" }
  )
  if (rev.status !== 0) {
    throw new StashScanError(
      `Stash ref '${ref}' not found. Run 'git stash list' to see available stashes.`,
      404
    )
  }
  const sha = rev.stdout.trim()

  // 2. Subject line ("WIP on main: a1d57d6 fix bug"). Best-effort —
  //    a stash with no subject is rare but harmless.
  const sub = spawnSync(
    "git",
    ["-C", repo, "log", "-1", "--format=%s", sha],
    { encoding: "utf-8" }
  )
  const message = sub.status === 0 ? sub.stdout.trim() : ref

  // 3. Detached worktree at HEAD. We use HEAD (not the stash's first
  //    parent) so the worktree mirrors what the user is currently
  //    working from, then layer the stash on top — same effective
  //    state as `git stash pop` without touching the user's tree.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const worktreeDir = path.join(os.tmpdir(), `edge-stash-wt-${stamp}`)
  const extractDir = path.join(os.tmpdir(), `edge-stash-extract-${stamp}`)
  try {
    addWorktree(repo, worktreeDir, "HEAD")
  } catch (e) {
    throw new StashScanError(
      `Failed to materialise temp worktree for stash scan: ${
        e instanceof Error ? e.message : String(e)
      }`,
      500
    )
  }

  // 4. Apply the stash. Use `--index` so staged-vs-unstaged is
  //    preserved where possible; fall back to plain apply on conflict
  //    so the most common "files don't overlap" case still succeeds.
  let apply = spawnSync(
    "git",
    ["-C", worktreeDir, "stash", "apply", "--index", sha],
    { encoding: "utf-8", timeout: 30_000 }
  )
  if (apply.status !== 0) {
    apply = spawnSync(
      "git",
      ["-C", worktreeDir, "stash", "apply", sha],
      { encoding: "utf-8", timeout: 30_000 }
    )
  }
  if (apply.status !== 0) {
    throw new StashScanError(
      `Failed to apply ${ref} into temp worktree: ${(apply.stderr ?? "")
        .slice(0, 500)
        .trim()}`,
      409
    )
  }

  // 5. Enumerate touched files. Modified/added tracked files via
  //    `diff --name-only HEAD`, then untracked-via-`-u` via the
  //    standard `ls-files --others` invocation.
  const touched = new Set<string>()
  const diff = spawnSync(
    "git",
    [
      "-C",
      worktreeDir,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "HEAD",
    ],
    { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 }
  )
  if (diff.status === 0) {
    for (const p of diff.stdout.split("\0")) {
      if (p && !isEdgeAgentInternalPath(p)) touched.add(p)
    }
  }
  const others = spawnSync(
    "git",
    [
      "-C",
      worktreeDir,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 }
  )
  if (others.status === 0) {
    for (const p of others.stdout.split("\0")) {
      if (p && !isEdgeAgentInternalPath(p)) touched.add(p)
    }
  }

  // 6. Copy them into a clean dir. The scanner walks `extractDir`
  //    and sees nothing else — committed code never enters the scan.
  fs.mkdirSync(extractDir, { recursive: true })
  const files: string[] = []
  for (const rel of Array.from(touched).sort()) {
    const src = path.join(worktreeDir, rel)
    const dst = path.join(extractDir, rel)
    try {
      if (!fs.existsSync(src)) continue
      const st = fs.statSync(src)
      if (!st.isFile()) continue
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
      files.push(rel)
    } catch {
      /* skip — best-effort. A single unreadable file shouldn't
         sink the whole stash scan. */
    }
  }

  return { ref, sha, message, worktreeDir, extractDir, files }
}

/** Best-effort tear-down. Removes the worktree if git knows about it,
 *  then nukes the directory if anything is left over, then prunes
 *  stale entries. Swallowed errors are logged nowhere — these are
 *  cleanup-only and shouldn't block the response. */
function removeWorktree(repo: string, dest: string): void {
  try {
    if (!fs.existsSync(dest)) return
    spawnSync(
      "git",
      ["--no-pager", "-C", repo, "worktree", "remove", "--force", dest],
      { encoding: "utf-8", timeout: 30_000 }
    )
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true })
    }
    spawnSync("git", ["--no-pager", "-C", repo, "worktree", "prune"], {
      encoding: "utf-8",
      timeout: 10_000,
    })
  } catch {
    /* best-effort */
  }
}

/**
 * `.edgeagent/` (our own bookkeeping directory — policy.yaml,
 * last-scan.json, base-scan-cache.json, untracked-attribution.json)
 * is git-untracked unless the user added it to .gitignore manually,
 * which means without this filter it shows up in every "untracked"
 * count. The `listUntrackedFiles` helper already filters this for
 * us; we keep this local copy just for the porcelain parser below.
 */
function isEdgeAgentInternalPath(rel: string): boolean {
  return rel === ".edgeagent" || rel.startsWith(".edgeagent/")
}

/**
 * Run `git status --porcelain` against the scanned directory and
 * summarise the result. Returns null when the directory isn't a git
 * repo (or git isn't available), which the caller treats as "unknown
 * working-tree state".
 *
 * `--untracked-files=all` makes sure files inside untracked
 * directories are individually counted; otherwise git collapses them
 * into the directory header and the count is misleading.
 */
function collectWorkingTreeStatus(
  projectPath: string
): {
  clean: boolean
  branch: string | null
  untracked: number
  modified: number
  total: number
} | null {
  try {
    const isRepo = spawnSync(
      "git",
      ["-C", projectPath, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf-8" }
    )
    if (isRepo.status !== 0 || isRepo.stdout.trim() !== "true") return null
  } catch {
    return null
  }

  let branch: string | null = null
  try {
    const br = spawnSync(
      "git",
      ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf-8" }
    )
    if (br.status === 0) {
      const v = br.stdout.trim()
      branch = v && v !== "HEAD" ? v : null
    }
  } catch {
    branch = null
  }

  const status = spawnSync(
    "git",
    ["-C", projectPath, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 }
  )
  if (status.error || status.status !== 0) {
    return null
  }

  let untracked = 0
  let modified = 0
  for (const raw of status.stdout.split("\n")) {
    if (!raw) continue
    const rel = raw.slice(3)
    if (isEdgeAgentInternalPath(rel)) continue
    if (raw.startsWith("??")) untracked++
    else modified++
  }
  const total = untracked + modified
  return {
    clean: total === 0,
    branch,
    untracked,
    modified,
    total,
  }
}
