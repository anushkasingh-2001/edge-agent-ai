/**
 * Server-side policy loader and "previous scan" snapshot store.
 *
 * Two responsibilities, intentionally co-located so every callsite that
 * gates a Git operation goes through the same code path:
 *
 *   1. Loading `<projectPath>/.edgeagent/policy.yaml` (or returning the
 *      DEFAULT_POLICY) — replaces the four near-identical copies that
 *      were previously inlined into commit/push/PR-create/evaluate
 *      routes. Any drift between those copies (different error
 *      handling, different cache, etc.) is now impossible.
 *
 *   2. Persisting and reading a tiny per-project snapshot of the
 *      *last scan that gated a successful Git operation* at
 *      `<projectPath>/.edgeagent/last-scan.json`. The commit/push/PR
 *      routes use this snapshot as the `baseReport` argument to
 *      `evaluatePolicy`, which is what unlocks delta rules like
 *      `block_if_high_increased` and `require_risk_score_not_increase`.
 *      Without a baseline those rules silently fall through as
 *      "inapplicable" — that's the bug the rest of this PR fixes.
 *
 * Snapshot semantics:
 *   - We write the snapshot AFTER a commit/push/PR succeeds. That way
 *     the file always represents the state that was last "blessed" by
 *     a Git operation, and the *next* commit's pre-scan can detect
 *     "you regressed since your last accepted change."
 *   - Branch Compare and the bare /api/scan endpoint do NOT update the
 *     snapshot — they're observational and would otherwise reset the
 *     baseline before the user had a chance to react to a regression.
 *   - First-ever commit (no snapshot) = no baseline = delta rules
 *     marked inapplicable, only absolute rules apply. That's the
 *     correct behaviour: there's nothing to regress from.
 *
 * Storage format is a deliberately tiny subset of ScanReport — we only
 * read `risk_score` and `summary` in the evaluator, so persisting more
 * would just bloat the file and risk leaking source paths into a
 * checked-in repo.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_POLICY,
  parsePolicyYaml,
  type Policy,
} from "@/lib/policy"
import type { ScanReport } from "@/lib/scan-report"
import { runGit } from "@/lib/server-git"
import { runScannerOn, type ScanReportLite } from "@/lib/server-scan"

export const POLICY_REL_PATH = ".edgeagent/policy.yaml"
export const LAST_SCAN_REL_PATH = ".edgeagent/last-scan.json"

/* -------------------------------------------------------------------------- */
/* Policy file                                                                */
/* -------------------------------------------------------------------------- */

export interface LoadPolicyResult {
  policy: Policy
  /** "file" iff the YAML existed and parsed (even with warnings).
   *  "default" when the file was missing or unreadable. */
  policySource: "file" | "default"
  /** Lenient parse warnings. Always empty when policySource === "default". */
  policyErrors: string[]
  /** Absolute path we tried to read. `null` when no file exists. */
  policyPath: string | null
}

export function loadPolicyFor(projectPath: string): LoadPolicyResult {
  const absolute = path.join(projectPath, POLICY_REL_PATH)
  if (!fs.existsSync(absolute)) {
    return {
      policy: DEFAULT_POLICY,
      policySource: "default",
      policyErrors: [],
      policyPath: null,
    }
  }
  let text: string
  try {
    text = fs.readFileSync(absolute, "utf-8")
  } catch (e) {
    return {
      policy: DEFAULT_POLICY,
      policySource: "default",
      policyErrors: [
        `Failed to read ${POLICY_REL_PATH}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      ],
      policyPath: absolute,
    }
  }
  const { policy, errors } = parsePolicyYaml(text)
  return {
    policy,
    policySource: "file",
    policyErrors: errors,
    policyPath: absolute,
  }
}

/* -------------------------------------------------------------------------- */
/* Last-scan snapshot                                                         */
/* -------------------------------------------------------------------------- */

export type LastScanSummary = {
  critical: number
  high: number
  medium: number
  low: number
  total: number
}

export interface LastScanSnapshot {
  risk_score: number
  summary: LastScanSummary
  /** ISO timestamp of when the snapshot was captured. */
  generated_at: string
  /** Branch the snapshot was taken on. Optional — we still compare
   *  cross-branch when missing. */
  branch?: string | null
  /** Short SHA at the time of the snapshot. Helps users disambiguate
   *  in the UI ("compared against abc1234"). */
  sha?: string | null
  /** Which Git operation produced this snapshot. */
  source: "commit" | "push" | "pr"
}

/**
 * Read the persisted snapshot. Returns `null` for any failure mode
 * (missing file, malformed JSON, missing required fields) so callers
 * can treat "no baseline" uniformly.
 */
export function readLastScan(projectPath: string): LastScanSnapshot | null {
  const file = path.join(projectPath, LAST_SCAN_REL_PATH)
  if (!fs.existsSync(file)) return null
  try {
    const raw = fs.readFileSync(file, "utf-8")
    const parsed = JSON.parse(raw) as Partial<LastScanSnapshot>
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.risk_score !== "number" ||
      !parsed.summary ||
      typeof parsed.summary.critical !== "number" ||
      typeof parsed.summary.high !== "number" ||
      typeof parsed.summary.medium !== "number" ||
      typeof parsed.summary.low !== "number" ||
      typeof parsed.summary.total !== "number"
    ) {
      return null
    }
    return {
      risk_score: parsed.risk_score,
      summary: {
        critical: parsed.summary.critical,
        high: parsed.summary.high,
        medium: parsed.summary.medium,
        low: parsed.summary.low,
        total: parsed.summary.total,
      },
      generated_at:
        typeof parsed.generated_at === "string"
          ? parsed.generated_at
          : new Date().toISOString(),
      branch: typeof parsed.branch === "string" ? parsed.branch : null,
      sha: typeof parsed.sha === "string" ? parsed.sha : null,
      source:
        parsed.source === "commit" || parsed.source === "push" || parsed.source === "pr"
          ? parsed.source
          : "commit",
    }
  } catch {
    return null
  }
}

/**
 * Atomically persist a new snapshot. Creates the `.edgeagent/`
 * directory if it doesn't yet exist (mode 0755 — not secret, just
 * per-project state).
 *
 * Atomic write via tmp-then-rename so a crash mid-write can never
 * leave the file truncated and break the next commit's pre-scan.
 */
export function writeLastScan(
  projectPath: string,
  snapshot: LastScanSnapshot
): { ok: true } | { ok: false; error: string } {
  const dir = path.join(projectPath, ".edgeagent")
  const file = path.join(dir, "last-scan.json")
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const tmp = `${file}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o644 })
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Convenience adaptor for callers that already have a fresh scan and
 * want to hand it to `evaluatePolicy` as `baseReport`. The evaluator
 * only reads `risk_score` and `summary`, so we cast the lite shape
 * through `unknown` rather than fabricating empty `findings`/etc.
 */
export function snapshotToBaseReport(
  snap: LastScanSnapshot | null
): ScanReport | undefined {
  if (!snap) return undefined
  return {
    risk_score: snap.risk_score,
    summary: snap.summary,
  } as unknown as ScanReport
}

/* -------------------------------------------------------------------------- */
/* Base-branch scan (the proper baseline for delta rules)                     */
/* -------------------------------------------------------------------------- */

/**
 * Why this exists:
 *   The per-project last-scan snapshot has a bootstrap problem. When a
 *   user creates a feature branch from main and the very first commit
 *   on that branch introduces a regression, no snapshot exists yet, so
 *   the policy evaluator marks every delta rule "inapplicable" and the
 *   commit/push/PR slips through. The Branch Compare panel correctly
 *   spots the regression because it scans `main` AND the feature
 *   branch and diffs the two — that's the comparison the gates need
 *   to do too.
 *
 *   `loadBaseBranchScan` is the exact mechanism used by Branch
 *   Compare's /api/git/compare-scan, factored out so commit/push/PR
 *   can use it as the `baseReport` for `evaluatePolicy`. Result is
 *   cached on disk keyed by the base branch's HEAD SHA so repeated
 *   commits against an unchanged main don't re-scan main every time
 *   (a 5-30s saving per gate operation on real repos).
 */

const BASE_SCAN_CACHE_REL = ".edgeagent/base-scan-cache.json"

export interface BaseScanResult {
  /** Lite snapshot suitable for passing to `evaluatePolicy` as
   *  `baseReport`. `null` whenever no usable base could be produced
   *  (no main branch, scanner failed, on the base branch itself, etc).
   *  Callers should fall back to `readLastScan` in that case. */
  snapshot: LastScanSnapshot | null
  /** Where the snapshot came from. Surfaced in the API response so the
   *  UI can show "compared against main@abc1234" or "no base available
   *  — first commit of the project". */
  source:
    | "cache"          // cache hit on the base SHA → cheap path
    | "fresh"          // cache miss or stale → ran a worktree scan
    | "current_branch" // current === base, no comparison possible
    | "no_base"        // couldn't resolve any base branch
    | "error"          // worktree/scan failure
  /** Resolved base branch name (e.g. "main"). null when source = "no_base"/"error". */
  branch: string | null
  /** Base branch HEAD SHA. null when source = "no_base"/"error". */
  sha: string | null
  /** When this snapshot was captured. ISO-8601. Lets the UI render
   *  "scanned 5m ago" so users can spot a stale baseline. */
  cachedAt: string | null
  /** Human-readable explanation when source = "error" / "no_base". */
  message?: string
}

/**
 * Pick the base branch name to compare against. Priority:
 *   1. policy.pull_request.base_branch (user-configured)
 *   2. local "main"
 *   3. local "master"
 *   4. remote "origin/main" / "origin/master" (handles fresh clones
 *      with no local checkout of main yet)
 * Returns null when none of the above resolve.
 */
function pickBaseBranch(projectPath: string, policy: Policy): string | null {
  const candidates: string[] = []
  const explicit = policy.pull_request?.base_branch
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    candidates.push(explicit.trim())
  }
  candidates.push("main", "master", "origin/main", "origin/master")

  for (const ref of candidates) {
    const r = runGit(projectPath, ["rev-parse", "--verify", "--quiet", ref])
    if (r.status === 0 && r.stdout.trim().length > 0) {
      // Strip "origin/" prefix so the worktree command and UI label
      // both use the human-readable branch name.
      return ref.replace(/^origin\//, "")
    }
  }
  return null
}

function resolveSha(projectPath: string, ref: string): string | null {
  // Prefer local ref but fall through to remote if missing locally —
  // matches the resolveRef helper in server-git but inlined here to
  // avoid importing it (and to be lenient about quiet failures).
  for (const candidate of [ref, `origin/${ref}`]) {
    const r = runGit(projectPath, ["rev-parse", "--verify", "--quiet", candidate])
    if (r.status === 0) {
      const sha = r.stdout.trim()
      if (sha) return sha
    }
  }
  return null
}

function detectCurrentBranch(projectPath: string): string | null {
  const r = runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (r.status !== 0) return null
  const b = r.stdout.trim()
  if (!b || b === "HEAD") return null
  return b
}

interface BaseScanCacheEntry {
  branch: string
  sha: string
  scan: ScanReportLite
  cached_at: string
}

function readBaseScanCache(projectPath: string): BaseScanCacheEntry | null {
  const file = path.join(projectPath, BASE_SCAN_CACHE_REL)
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<BaseScanCacheEntry>
    if (
      !parsed ||
      typeof parsed.branch !== "string" ||
      typeof parsed.sha !== "string" ||
      !parsed.scan ||
      typeof parsed.scan.risk_score !== "number" ||
      !parsed.scan.summary
    ) {
      return null
    }
    return {
      branch: parsed.branch,
      sha: parsed.sha,
      scan: parsed.scan,
      cached_at:
        typeof parsed.cached_at === "string"
          ? parsed.cached_at
          : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

function writeBaseScanCache(
  projectPath: string,
  entry: BaseScanCacheEntry
): void {
  const dir = path.join(projectPath, ".edgeagent")
  const file = path.join(dir, "base-scan-cache.json")
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const tmp = `${file}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o644 })
    fs.renameSync(tmp, file)
  } catch {
    /* ignore — cache miss is recoverable, hard error isn't worth bubbling */
  }
}

function addWorktree(repo: string, dest: string, sha: string): void {
  const r = runGit(repo, ["worktree", "add", "--detach", dest, sha], {
    timeoutMs: 60_000,
  })
  if (r.status !== 0) {
    throw new Error(
      `git worktree add failed for ${sha}: ${r.stderr.slice(0, 1000)}`
    )
  }
}

function removeWorktree(dest: string): void {
  try {
    if (!fs.existsSync(dest)) return
    spawnSync("git", ["--no-pager", "worktree", "remove", "--force", dest], {
      encoding: "utf-8",
      timeout: 30_000,
    })
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true })
    }
    const parent = path.dirname(dest)
    spawnSync("git", ["--no-pager", "-C", parent, "worktree", "prune"], {
      encoding: "utf-8",
      timeout: 10_000,
    })
  } catch {
    /* ignore — best-effort cleanup */
  }
}

function scanToSnapshot(
  scan: ScanReportLite,
  branch: string,
  sha: string
): LastScanSnapshot {
  return {
    risk_score: scan.risk_score,
    summary: { ...scan.summary },
    generated_at: new Date().toISOString(),
    branch,
    sha,
    source: "commit", // arbitrary — base-branch snapshots aren't written through writeLastScan
  }
}

/**
 * Resolve the base branch, run (or load from cache) a scan of it, and
 * return it as a `LastScanSnapshot` suitable for `evaluatePolicy`'s
 * `baseReport`. Never throws — every failure mode produces a result
 * with `source` set to one of the non-success values and `snapshot:
 * null`, so callers can just check `snapshot` and fall back.
 */
export async function loadBaseBranchScan(
  projectPath: string,
  options: {
    policy: Policy
    /** When equal to the resolved base branch we skip the scan (would
     *  be the same code) and let the caller fall back to the
     *  per-branch snapshot. */
    currentBranch?: string | null
    /** When true, ignore any cached entry and re-scan. */
    skipCache?: boolean
  }
): Promise<BaseScanResult> {
  const baseBranch = pickBaseBranch(projectPath, options.policy)
  if (!baseBranch) {
    return {
      snapshot: null,
      source: "no_base",
      branch: null,
      sha: null,
      cachedAt: null,
      message:
        "Could not resolve a base branch (looked for policy.pull_request.base_branch, main, master).",
    }
  }
  const current =
    options.currentBranch ?? detectCurrentBranch(projectPath)
  if (current && current === baseBranch) {
    // Comparing a branch to itself is meaningless; the caller will
    // fall back to the per-branch last-scan snapshot.
    return {
      snapshot: null,
      source: "current_branch",
      branch: baseBranch,
      sha: null,
      cachedAt: null,
    }
  }
  const baseSha = resolveSha(projectPath, baseBranch)
  if (!baseSha) {
    return {
      snapshot: null,
      source: "no_base",
      branch: baseBranch,
      sha: null,
      cachedAt: null,
      message: `Could not resolve SHA for base branch '${baseBranch}'.`,
    }
  }

  if (!options.skipCache) {
    const cached = readBaseScanCache(projectPath)
    if (cached && cached.branch === baseBranch && cached.sha === baseSha) {
      return {
        snapshot: scanToSnapshot(cached.scan, baseBranch, baseSha),
        source: "cache",
        branch: baseBranch,
        sha: baseSha,
        cachedAt: cached.cached_at,
      }
    }
  }

  // Cache miss — materialise the base branch into a worktree and scan.
  const stamp = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  const wt = path.join(os.tmpdir(), `edge-base-scan-${stamp}-${rand}`)
  const cachedAt = new Date().toISOString()
  try {
    addWorktree(projectPath, wt, baseSha)
    const scan = await runScannerOn(wt)
    writeBaseScanCache(projectPath, {
      branch: baseBranch,
      sha: baseSha,
      scan,
      cached_at: cachedAt,
    })
    return {
      snapshot: scanToSnapshot(scan, baseBranch, baseSha),
      source: "fresh",
      branch: baseBranch,
      sha: baseSha,
      cachedAt,
    }
  } catch (e) {
    return {
      snapshot: null,
      source: "error",
      branch: baseBranch,
      sha: baseSha,
      cachedAt: null,
      message: `Base-branch scan failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  } finally {
    removeWorktree(wt)
  }
}

/**
 * Pick the best available `baseReport` for a gate, in priority order:
 *   1. A fresh-or-cached scan of the configured base branch (the
 *      semantically correct comparison — matches Branch Compare).
 *   2. The per-branch last-scan snapshot — used when current === base
 *      branch (e.g. user is committing on main itself), or when the
 *      base scan failed for any reason.
 *   3. `null` — no comparison possible. Delta rules will be marked
 *      inapplicable; only absolute rules (block_if_critical) fire.
 *
 * Returns both the report and a description of where it came from so
 * the API response can tell the UI exactly what was compared.
 */
export async function loadComparisonBaseline(
  projectPath: string,
  options: {
    policy: Policy
    currentBranch?: string | null
    /** Force a fresh scan of the base branch, ignoring any cached
     *  entry. Used by the "Re-scan main" button so users can recover
     *  from a stale baseline (e.g. they updated rules, edited
     *  scanner, or just want certainty). */
    skipBaseCache?: boolean
  }
): Promise<{
  baseReport: ScanReport | undefined
  baseSource: "base_branch" | "snapshot" | "none"
  baseBranchScan: BaseScanResult
  snapshot: LastScanSnapshot | null
}> {
  const baseBranchScan = await loadBaseBranchScan(projectPath, {
    policy: options.policy,
    currentBranch: options.currentBranch,
    skipCache: options.skipBaseCache,
  })
  const snapshot = readLastScan(projectPath)

  if (baseBranchScan.snapshot) {
    return {
      baseReport: snapshotToBaseReport(baseBranchScan.snapshot),
      baseSource: "base_branch",
      baseBranchScan,
      snapshot,
    }
  }
  if (snapshot) {
    return {
      baseReport: snapshotToBaseReport(snapshot),
      baseSource: "snapshot",
      baseBranchScan,
      snapshot,
    }
  }
  return {
    baseReport: undefined,
    baseSource: "none",
    baseBranchScan,
    snapshot: null,
  }
}
