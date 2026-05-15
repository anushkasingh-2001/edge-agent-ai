import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { NextResponse } from "next/server"
import {
  GitError,
  applyBranchStashesInWorktree,
  assertGitRepo,
  resolveProjectPath,
  resolveRef,
  runGit,
  validateRef,
  type StashApplyResult,
} from "@/lib/server-git"
import {
  ScannerError,
  buildScannerCommand,
} from "@/lib/server-scan"

/**
 * POST /api/git/compare-scan
 *
 * Body: { projectPath, base, target }
 *
 * Materialises both refs into throwaway `git worktree` directories, runs
 * the Python scanner against each, and returns a diff of the two scan
 * reports — added / removed / persistent findings, plus risk-score delta.
 *
 * This is the "real" comparison the UI's heuristic categorical summary
 * cannot give: a heuristic can say "5 prompt files changed → re-run the
 * prompt-injection check"; this endpoint actually re-runs every check on
 * each branch and tells you which findings disappeared and which were
 * introduced.
 *
 * Worktrees instead of branch checkout because:
 *   - we never disturb the user's working tree or HEAD,
 *   - shallow / single-branch clones still work after the branches API
 *     widens the refspec,
 *   - cleanup is `git worktree remove --force` regardless of scan outcome.
 *
 * Each scan call uses the same Python entrypoint /api/scan uses, so the
 * report format is identical (same Zod schema accepted by the UI).
 */

type FindingLite = {
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  title: string
  file: string
  line: number
}

type ScanReportLite = {
  risk_score: number
  summary: { critical: number; high: number; medium: number; low: number; total: number }
  findings: FindingLite[]
}

const SEVERITY_RANK: Record<FindingLite["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/**
 * Approximate risk weight per severity, mirroring the shape of the
 * scanner's `risk_score = critical*25 + high*12 + medium*6 + low*2` so a
 * per-file delta column reads in the same units as the headline tile.
 */
const SEVERITY_WEIGHT: Record<FindingLite["severity"], number> = {
  critical: 25,
  high: 12,
  medium: 6,
  low: 2,
}

type PerFileImpact = {
  file: string
  /** Findings present in base but no longer in target (good). */
  fixed: FindingLite[]
  /** Findings present in target but not in base (bad). */
  introduced: FindingLite[]
  /** Approximate risk delta from this file: + introduced − fixed, weighted. */
  riskDelta: number
  /** Lines added in target (from git diff --numstat). 0 if not in diff. */
  linesAdded: number
  /** Lines deleted in target (from git diff --numstat). 0 if not in diff. */
  linesDeleted: number
  /** "improved" | "regressed" | "mixed" — derived bucket for the UI. */
  verdict: "improved" | "regressed" | "mixed"
}

function findingKey(f: FindingLite): string {
  // file+line+rule is usually enough to identify the same logical issue
  // across two scans even though the engine generates a fresh `id` each
  // time. Title is included to disambiguate when one rule emits multiple
  // distinct findings on the same line.
  return `${f.rule_id}::${f.file}::${f.line}::${f.title}`
}

function topN<T>(arr: T[], n: number, cmp: (a: T, b: T) => number): T[] {
  return [...arr].sort(cmp).slice(0, n)
}

export async function POST(request: Request) {
  let baseWt: string | null = null
  let targetWt: string | null = null
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      base?: string
      target?: string
      /** When true, every `git stash` entry attributed to the BASE
       *  branch (via "WIP on <baseBranch>:" subject) is layered onto
       *  the base worktree before the scanner runs. Stashes are
       *  applied oldest → newest so the most recent WIP wins on per-
       *  file conflicts. No-op when the base branch has zero stashes. */
      baseIncludeStashes?: boolean
      /** Same as `baseIncludeStashes` but for the TARGET branch. */
      targetIncludeStashes?: boolean
    }
    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const baseInput = validateRef(body.base, "base")
    const targetInput = validateRef(body.target, "target")
    const baseRef = resolveRef(resolved, baseInput)
    const targetRef = resolveRef(resolved, targetInput)
    const baseIncludeStashes = body.baseIncludeStashes === true
    const targetIncludeStashes = body.targetIncludeStashes === true

    // Same-SHA early exit only fires when neither side asks to layer
    // stashes — once stashes enter the picture the effective trees
    // can differ even when the branch SHAs are identical.
    if (
      baseRef.sha === targetRef.sha &&
      !baseIncludeStashes &&
      !targetIncludeStashes
    ) {
      return NextResponse.json({
        base: baseInput,
        target: targetInput,
        baseSha: baseRef.sha,
        targetSha: targetRef.sha,
        sameSha: true,
        baseScan: null,
        targetScan: null,
        delta: null,
        introduced: [],
        fixed: [],
        persistent: 0,
        baseStashes: stashSummary(null),
        targetStashes: stashSummary(null),
      })
    }

    const stamp = Date.now()
    const rand = Math.random().toString(36).slice(2, 8)
    baseWt = path.join(os.tmpdir(), `edge-cmp-base-${stamp}-${rand}`)
    targetWt = path.join(
      os.tmpdir(),
      `edge-cmp-target-${stamp}-${rand}`
    )

    addWorktree(resolved, baseWt, baseRef.sha)
    addWorktree(resolved, targetWt, targetRef.sha)

    // Layer in any branch-attributed stashes the caller asked for.
    // The branch name comes from the user's dropdown choice (the
    // *input* string before resolveRef alias-walking), not the
    // canonical ref, because stash subjects record short branch
    // names like "WIP on low:" — not "refs/remotes/origin/low".
    const baseStashApply: StashApplyResult = baseIncludeStashes
      ? applyBranchStashesInWorktree(resolved, baseWt, baseInput)
      : { applied: [], skipped: [] }
    const targetStashApply: StashApplyResult = targetIncludeStashes
      ? applyBranchStashesInWorktree(resolved, targetWt, targetInput)
      : { applied: [], skipped: [] }

    // Both scans are independent and CPU-bound on the Python side. Running
    // them in parallel turns the wall-clock from 2× into ~1× the slower of
    // the two — the single biggest wait on this endpoint. We use the
    // async `spawn`-based scanner runner so Node actually overlaps them.
    const [baseScan, targetScan] = await Promise.all([
      runScannerOnAsync(baseWt),
      runScannerOnAsync(targetWt),
    ])

    const baseMap = new Map<string, FindingLite>()
    for (const f of baseScan.findings) baseMap.set(findingKey(f), f)
    const targetMap = new Map<string, FindingLite>()
    for (const f of targetScan.findings) targetMap.set(findingKey(f), f)

    const introduced: FindingLite[] = []
    const fixed: FindingLite[] = []
    let persistent = 0
    for (const [k, f] of targetMap) {
      if (baseMap.has(k)) persistent += 1
      else introduced.push(f)
    }
    for (const [k, f] of baseMap) {
      if (!targetMap.has(k)) fixed.push(f)
    }

    const sevOrder = (a: FindingLite, b: FindingLite) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]

    // ---- Per-file attribution ------------------------------------------------
    // Map every introduced/fixed finding back to the file it lives in so the
    // UI can answer "which files improved security and which regressed it".
    // Files don't have to appear in the git diff at all to show up here —
    // a config change elsewhere can flip a finding on a file that wasn't
    // edited — but we enrich rows with line-change stats from `--numstat`
    // when they are in the diff so the user has context.
    const numstat = readNumstat(resolved, baseRef.canonical, targetRef.canonical)

    const perFile = new Map<string, PerFileImpact>()
    function bucket(file: string): PerFileImpact {
      let row = perFile.get(file)
      if (!row) {
        const stat = numstat.get(file)
        row = {
          file,
          fixed: [],
          introduced: [],
          riskDelta: 0,
          linesAdded: stat?.added ?? 0,
          linesDeleted: stat?.deleted ?? 0,
          verdict: "improved",
        }
        perFile.set(file, row)
      }
      return row
    }
    for (const f of fixed) {
      const row = bucket(f.file)
      row.fixed.push(f)
      row.riskDelta -= SEVERITY_WEIGHT[f.severity]
    }
    for (const f of introduced) {
      const row = bucket(f.file)
      row.introduced.push(f)
      row.riskDelta += SEVERITY_WEIGHT[f.severity]
    }
    for (const row of perFile.values()) {
      if (row.introduced.length > 0 && row.fixed.length > 0) row.verdict = "mixed"
      else if (row.introduced.length > 0) row.verdict = "regressed"
      else row.verdict = "improved"
    }

    // Sort per-file rows by absolute risk impact (most-impactful first) so
    // the UI shows the biggest movers up top.
    const perFileRows = Array.from(perFile.values()).sort((a, b) => {
      const aw = Math.abs(a.riskDelta)
      const bw = Math.abs(b.riskDelta)
      if (bw !== aw) return bw - aw
      // Tie-break by counts so files with more activity win.
      return (b.fixed.length + b.introduced.length) - (a.fixed.length + a.introduced.length)
    })
    const improvers = perFileRows.filter((r) => r.verdict === "improved")
    const regressors = perFileRows.filter((r) => r.verdict === "regressed")
    const mixed = perFileRows.filter((r) => r.verdict === "mixed")

    // ---- Per-category aggregation -------------------------------------------
    // Bucket findings by their human-readable category (the same string the
    // scanner stamps on each finding). For each category we report:
    //   - baseCount / targetCount of findings in that bucket
    //   - delta = target − base (negative = improvement)
    //   - filesImproved / filesRegressed: which file paths fixed or
    //     introduced findings in this category
    // This is the "what improved due to which files" answer the UI uses to
    // build the Prompt Quality / MCP Servers / Dangerous Tools etc. cards.
    type CatAgg = {
      category: string
      ruleIds: Set<string>
      baseCount: number
      targetCount: number
      fixedCount: number
      introducedCount: number
      filesImproved: Map<string, number>
      filesRegressed: Map<string, number>
      sampleFixed: FindingLite[]
      sampleIntroduced: FindingLite[]
    }
    const catMap = new Map<string, CatAgg>()
    function catBucket(cat: string): CatAgg {
      let c = catMap.get(cat)
      if (!c) {
        c = {
          category: cat,
          ruleIds: new Set(),
          baseCount: 0,
          targetCount: 0,
          fixedCount: 0,
          introducedCount: 0,
          filesImproved: new Map(),
          filesRegressed: new Map(),
          sampleFixed: [],
          sampleIntroduced: [],
        }
        catMap.set(cat, c)
      }
      return c
    }
    for (const f of baseScan.findings) {
      const c = catBucket(f.category)
      c.baseCount += 1
      c.ruleIds.add(f.rule_id)
    }
    for (const f of targetScan.findings) {
      const c = catBucket(f.category)
      c.targetCount += 1
      c.ruleIds.add(f.rule_id)
    }
    for (const f of fixed) {
      const c = catBucket(f.category)
      c.fixedCount += 1
      c.filesImproved.set(f.file, (c.filesImproved.get(f.file) ?? 0) + 1)
      if (c.sampleFixed.length < 3) c.sampleFixed.push(f)
    }
    for (const f of introduced) {
      const c = catBucket(f.category)
      c.introducedCount += 1
      c.filesRegressed.set(f.file, (c.filesRegressed.get(f.file) ?? 0) + 1)
      if (c.sampleIntroduced.length < 3) c.sampleIntroduced.push(f)
    }
    const byCategory = Array.from(catMap.values())
      .map((c) => {
        const delta = c.targetCount - c.baseCount
        // Percent change. Standard semantics:
        //   - base > 0: pctDelta = (delta / base) * 100, signed.
        //   - base = 0 && target > 0: brand-new category for this branch
        //     → null (UI shows "new"), since dividing by 0 is meaningless.
        //   - base = 0 && target = 0: 0% (no change).
        // We round to one decimal to keep the cell tight without lying.
        let pctDelta: number | null
        if (c.baseCount === 0) {
          pctDelta = c.targetCount === 0 ? 0 : null
        } else {
          pctDelta = Math.round((delta / c.baseCount) * 1000) / 10
        }
        // The fixed/introduced counts can drift dramatically when both
        // sides hit the per-rule cap (sorted-stable now, but historic
        // reports may still see this). Surface a flag so the UI can
        // de-emphasise the noisy "X fixed · Y introduced" suffix when
        // the net delta is 0 — that combination is almost always cap
        // churn rather than real movement.
        const cappedChurn = delta === 0 && c.fixedCount > 0 && c.fixedCount === c.introducedCount
        return {
          category: c.category,
          ruleIds: Array.from(c.ruleIds).sort(),
          baseCount: c.baseCount,
          targetCount: c.targetCount,
          delta,
          pctDelta,
          fixedCount: c.fixedCount,
          introducedCount: c.introducedCount,
          cappedChurn,
          filesImproved: Array.from(c.filesImproved.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([file, count]) => ({ file, count })),
          filesRegressed: Array.from(c.filesRegressed.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([file, count]) => ({ file, count })),
          sampleFixed: c.sampleFixed,
          sampleIntroduced: c.sampleIntroduced,
        }
      })
      // Most-impactful categories first. Now ranked by absolute %
      // change rather than absolute count — a small repo dropping all 5
      // of its secrets findings is a bigger story than a big repo
      // moving 7 dependency findings out of 600. Falls back to absolute
      // delta and finally alphabetical so ties are stable.
      .sort((a, b) => {
        const ap = a.pctDelta == null ? 9999 : Math.abs(a.pctDelta)
        const bp = b.pctDelta == null ? 9999 : Math.abs(b.pctDelta)
        if (bp !== ap) return bp - ap
        const ad = Math.abs(a.delta)
        const bd = Math.abs(b.delta)
        if (bd !== ad) return bd - ad
        const aTouched = a.fixedCount + a.introducedCount
        const bTouched = b.fixedCount + b.introducedCount
        if (bTouched !== aTouched) return bTouched - aTouched
        return a.category.localeCompare(b.category)
      })

    return NextResponse.json({
      base: baseInput,
      target: targetInput,
      baseSha: baseRef.sha,
      targetSha: targetRef.sha,
      sameSha: false,
      baseScan: {
        risk_score: baseScan.risk_score,
        summary: baseScan.summary,
      },
      targetScan: {
        risk_score: targetScan.risk_score,
        summary: targetScan.summary,
      },
      baseStashes: stashSummary(baseIncludeStashes ? baseStashApply : null),
      targetStashes: stashSummary(
        targetIncludeStashes ? targetStashApply : null
      ),
      delta: {
        risk: targetScan.risk_score - baseScan.risk_score,
        total: targetScan.summary.total - baseScan.summary.total,
        critical: targetScan.summary.critical - baseScan.summary.critical,
        high: targetScan.summary.high - baseScan.summary.high,
        medium: targetScan.summary.medium - baseScan.summary.medium,
        low: targetScan.summary.low - baseScan.summary.low,
      },
      // Top-N kept around for callers that only want a quick list, but the
      // primary surface is now per-file attribution below.
      introduced: topN(introduced, 10, sevOrder),
      fixed: topN(fixed, 10, sevOrder),
      introducedTotal: introduced.length,
      fixedTotal: fixed.length,
      persistent,
      perFile: {
        improvers: improvers.slice(0, 50),
        regressors: regressors.slice(0, 50),
        mixed: mixed.slice(0, 50),
        improversTotal: improvers.length,
        regressorsTotal: regressors.length,
        mixedTotal: mixed.length,
      },
      byCategory,
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
  } finally {
    // Cleanup is best-effort. Worktrees are tagged with a unique tmpdir
    // path so a stale one is harmless; we also `git worktree prune` so
    // the repo's worktree list doesn't grow forever.
    if (baseWt) safeRemoveWorktree(baseWt)
    if (targetWt) safeRemoveWorktree(targetWt)
  }
}

/* -------------------------------------------------------------------------- */

function addWorktree(repo: string, dest: string, sha: string) {
  // `--detach` puts the worktree on a detached HEAD at the given commit
  // so we don't pollute the branch namespace. `--force` not used —
  // `dest` is a fresh path in os.tmpdir() so collisions are not expected.
  const r = runGit(
    repo,
    ["worktree", "add", "--detach", dest, sha],
    { timeoutMs: 60_000 }
  )
  if (r.status !== 0) {
    throw new GitError(
      `git worktree add failed for ${sha}`,
      500,
      r.stderr.slice(0, 4000)
    )
  }
}

function safeRemoveWorktree(dest: string) {
  try {
    if (!fs.existsSync(dest)) return
    // Use `--force` because the scanner may have left .pyc files etc.
    spawnSync("git", ["--no-pager", "worktree", "remove", "--force", dest], {
      encoding: "utf-8",
      timeout: 30_000,
    })
    // Belt-and-suspenders: if `worktree remove` leaves the dir behind
    // (rare, e.g. cross-filesystem), nuke it directly.
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true })
    }
    // Keep the parent repo's worktree list tidy.
    const parent = path.dirname(dest)
    spawnSync("git", ["--no-pager", "-C", parent, "worktree", "prune"], {
      encoding: "utf-8",
      timeout: 10_000,
    })
  } catch {
    /* ignore — this is cleanup */
  }
}

/**
 * Async equivalent of `runScannerOn` — spawns the scanner without
 * blocking the Node thread so two scans can actually overlap when
 * awaited via `Promise.all`. Returns the parsed report or throws a
 * `GitError` matching the sync version's behaviour.
 */
function runScannerOnAsync(targetPath: string): Promise<ScanReportLite> {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(
      os.tmpdir(),
      `edge-cmp-scan-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    )
    let cmd
    try {
      cmd = buildScannerCommand({ targetPath, outFile: tmpFile })
    } catch (err) {
      const e = err as ScannerError
      reject(
        new GitError(
          e?.message ?? "scanner package not found under project root",
          e?.status ?? 500
        )
      )
      return
    }
    const proc = spawn(cmd.cmd, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      // Capture stderr only — stdout is just the "Wrote ..." line.
      stdio: ["ignore", "ignore", "pipe"],
    })

    let stderr = ""
    proc.stderr.on("data", (chunk) => {
      // Cap stderr buffering — we only need the first 4KB for diagnostics.
      if (stderr.length < 4000) stderr += chunk.toString()
    })

    // Hard timeout so a runaway scan can't hang the request forever.
    const timeoutMs = 120_000
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
    }, timeoutMs)

    proc.on("error", (err) => {
      clearTimeout(timer)
      safeUnlink(tmpFile)
      reject(new GitError(`Failed to spawn scanner: ${err.message}`, 500))
    })

    proc.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        safeUnlink(tmpFile)
        reject(
          new GitError(
            `Scanner failed on ${targetPath}`,
            500,
            stderr.slice(0, 2000)
          )
        )
        return
      }
      try {
        const raw = fs.readFileSync(tmpFile, "utf-8")
        const json = JSON.parse(raw) as ScanReportLite
        resolve(json)
      } catch (e) {
        reject(
          new GitError(
            `Failed to read scanner output: ${
              e instanceof Error ? e.message : String(e)
            }`,
            500
          )
        )
      } finally {
        safeUnlink(tmpFile)
      }
    })
  })
}

function safeUnlink(p: string) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {
    /* ignore */
  }
}

/**
 * Shape the per-side StashApplyResult for the JSON response. `null`
 * means the caller didn't ask to include stashes for this side, so
 * we surface `included: false` and empty arrays — distinct from
 * `included: true, applied: []` which means "the user asked but the
 * branch has zero stashes" and is also a perfectly valid state.
 */
function stashSummary(apply: StashApplyResult | null) {
  if (!apply) {
    return {
      included: false,
      appliedCount: 0,
      skippedCount: 0,
      applied: [] as { ref: string; subject: string }[],
      skipped: [] as { ref: string; subject: string; reason: string }[],
    }
  }
  return {
    included: true,
    appliedCount: apply.applied.length,
    skippedCount: apply.skipped.length,
    applied: apply.applied.map((s) => ({
      ref: s.ref,
      subject: s.subject,
    })),
    skipped: apply.skipped.map((s) => ({
      ref: s.entry.ref,
      subject: s.entry.subject,
      reason: s.reason,
    })),
  }
}

/**
 * Run `git diff --numstat base..target` and return a path → {added, deleted}
 * map. Binary files come back as `-\t-\t<path>` and we record them as
 * 0/0 so they still appear if the scanner attributed a finding to them.
 */
function readNumstat(
  repo: string,
  base: string,
  target: string
): Map<string, { added: number; deleted: number }> {
  const r = runGit(repo, [
    "diff",
    "--numstat",
    "--no-renames",
    `${base}..${target}`,
  ])
  const out = new Map<string, { added: number; deleted: number }>()
  if (r.status !== 0) return out
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split("\t")
    if (parts.length < 3) continue
    const added = parts[0] === "-" ? 0 : Number(parts[0]) || 0
    const deleted = parts[1] === "-" ? 0 : Number(parts[1]) || 0
    out.set(parts[2], { added, deleted })
  }
  return out
}
