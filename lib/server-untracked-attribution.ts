/**
 * Untracked-file attribution.
 *
 * Git itself has no concept of "this untracked file belongs to branch
 * X" — untracked files live in the filesystem and ride along when you
 * `git checkout` because git never knew about them. That produces a
 * very common Edge Agent AI footgun:
 *
 *   1. User on `main`, runs `git checkout -b low`, creates `dang.py`.
 *   2. `git checkout main` — the file follows.
 *   3. "Scan main" picks up `dang.py` and reports a regression on `main`
 *      that doesn't actually exist on `main@HEAD`.
 *
 * We can't fix the git side, but we *can* fix the app side. This
 * module remembers the first branch each untracked file was seen on
 * (per project, persisted to `.edgeagent/untracked-attribution.json`)
 * and tells the scan route which files to skip when scanning a branch
 * other than the file's home branch.
 *
 * Lifecycle:
 *  - First time we see file F while branch B is checked out → attribute
 *    F → B. Include in scans of B.
 *  - Same F seen later on a different branch → still attributed to B,
 *    so scans of any other branch exclude it.
 *  - F gets `git add`'d and committed → falls out of the untracked
 *    list naturally; the attribution entry is pruned the next time
 *    the file isn't seen as untracked.
 *  - F deleted from filesystem → same as above (entry pruned).
 *
 * The whole module is server-only; never import from a Client
 * Component.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ATTRIBUTION_REL_PATH = ".edgeagent/untracked-attribution.json"
const HEAD_SNAPSHOT_REL_PATH = ".edgeagent/head-snapshot.json"
/** Bump if the on-disk shape changes incompatibly. Reading a file
 *  with a different version returns empty — old bad entries get
 *  silently wiped on the next call.
 *
 *  Version history:
 *    v1: initial { branch, firstSeenAt }, optimistic default.
 *    v2: added "confidence" field with low-by-default. Too
 *        conservative — files the user ACTIVELY created on the
 *        current branch ended up in the "ambiguous" bucket and
 *        never lit up the yellow Commit dot. Wiped on upgrade.
 *    v3: back to optimistic default (new file = current branch's),
 *        but with HEAD-snapshot leakage detection so files that
 *        WERE on a previous branch when we switched away get
 *        attributed to that previous branch instead of current.
 */
const SCHEMA_VERSION = 3

interface AttributionEntry {
  /** Branch that owns this file. New files default to whichever
   *  branch was checked out the first time we saw them, except
   *  when HEAD-snapshot tells us they were actually leaked from a
   *  branch we just switched away from. */
  branch: string
  /** ISO 8601, debugging only. */
  firstSeenAt: string
}

interface AttributionFile {
  version: number
  /** POSIX-style relative path → entry. */
  entries: Record<string, AttributionEntry>
}

/**
 * The set of untracked files we observed the last time we ran on
 * this project, plus the branch that was checked out then. Used to
 * detect "the user just `git checkout`ed to a different branch
 * outside the app" and to attribute any pre-existing leftovers to
 * the branch we just LEFT (rather than auto-tagging them to the
 * branch we landed on).
 */
interface HeadSnapshot {
  version: number
  branch: string
  /** POSIX rel paths — what was untracked at snapshot time. */
  untracked: string[]
  capturedAt: string
}

function emptyFile(): AttributionFile {
  return { version: SCHEMA_VERSION, entries: {} }
}

function attributionPath(projectPath: string): string {
  return path.join(projectPath, ATTRIBUTION_REL_PATH)
}

function snapshotPath(projectPath: string): string {
  return path.join(projectPath, HEAD_SNAPSHOT_REL_PATH)
}

function readSnapshot(projectPath: string): HeadSnapshot | null {
  const p = snapshotPath(projectPath)
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, "utf-8")
    const parsed = JSON.parse(raw) as Partial<HeadSnapshot>
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.branch === "string" &&
      Array.isArray(parsed.untracked)
    ) {
      return {
        version: SCHEMA_VERSION,
        branch: parsed.branch,
        untracked: parsed.untracked.filter(
          (s): s is string => typeof s === "string"
        ),
        capturedAt:
          typeof parsed.capturedAt === "string"
            ? parsed.capturedAt
            : new Date().toISOString(),
      }
    }
  } catch {
    /* swallow — corrupt snapshot is treated as missing */
  }
  return null
}

function writeSnapshot(projectPath: string, snap: HeadSnapshot): void {
  const p = snapshotPath(projectPath)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({ ...snap, version: SCHEMA_VERSION }, null, 2),
      "utf-8"
    )
  } catch {
    /* swallow */
  }
}

/** Best-effort read. Bad/missing/old-version file ⇒ empty map.
 *  Auto-migration: a file with `version != SCHEMA_VERSION` is
 *  treated as missing, which silently wipes old wrong entries the
 *  first time the new code runs. */
function readAttribution(projectPath: string): AttributionFile {
  const p = attributionPath(projectPath)
  if (!fs.existsSync(p)) return emptyFile()
  try {
    const raw = fs.readFileSync(p, "utf-8")
    const parsed = JSON.parse(raw) as Partial<AttributionFile>
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null ||
      parsed.version !== SCHEMA_VERSION
    ) {
      return emptyFile()
    }
    const clean: Record<string, AttributionEntry> = {}
    for (const [k, v] of Object.entries(parsed.entries)) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as AttributionEntry).branch === "string" &&
        typeof (v as AttributionEntry).firstSeenAt === "string"
      ) {
        clean[k] = {
          branch: (v as AttributionEntry).branch,
          firstSeenAt: (v as AttributionEntry).firstSeenAt,
        }
      }
    }
    return { version: SCHEMA_VERSION, entries: clean }
  } catch {
    return emptyFile()
  }
}

/** Best-effort write. Creates `.edgeagent/` if missing. Swallows IO
 *  errors — failing to persist attribution shouldn't break a scan. */
function writeAttribution(projectPath: string, file: AttributionFile): void {
  const p = attributionPath(projectPath)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({ ...file, version: SCHEMA_VERSION }, null, 2),
      "utf-8"
    )
  } catch {
    /* swallow */
  }
}

/**
 * `.edgeagent/` (our own bookkeeping directory — policy.yaml,
 * last-scan.json, base-scan-cache.json, untracked-attribution.json)
 * is git-untracked unless the user added it to .gitignore manually,
 * which means it shows up in every "untracked" listing and would
 * pollute attribution + scan exclusion. Always our files, never
 * the user's.
 */
function isEdgeAgentInternalPath(rel: string): boolean {
  return rel === ".edgeagent" || rel.startsWith(".edgeagent/")
}

/**
 * Return the POSIX-style relative paths of files git considers
 * untracked-but-not-ignored under `projectPath`. Empty array when
 * the directory isn't a git repo, git isn't available, or the tree
 * is fully tracked. NUL-separated output (`-z`) so paths with spaces,
 * newlines, etc. round-trip correctly. `.edgeagent/` is always
 * filtered out — it's our own bookkeeping, never the user's.
 *
 * Co-located with `attributeUntrackedFiles` because every existing
 * caller pairs them anyway. /api/scan, /api/git/commit, and
 * /api/git/discard all want exactly this set.
 */
export function listUntrackedFiles(projectPath: string): string[] {
  let isRepo
  try {
    isRepo = spawnSync(
      "git",
      ["-C", projectPath, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf-8" }
    )
  } catch {
    return []
  }
  if (isRepo.status !== 0 || isRepo.stdout.trim() !== "true") return []

  const ls = spawnSync(
    "git",
    [
      "-C",
      projectPath,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 }
  )
  if (ls.error || ls.status !== 0) return []
  return ls.stdout
    .split("\0")
    .filter((p) => p.length > 0 && !isEdgeAgentInternalPath(p))
}

export interface AttributionResult {
  /** Untracked files that belong to the current branch (either we
   *  saw them here first, or they were created here and we have no
   *  evidence they came from elsewhere). Counted toward "dirty"
   *  and staged on commit. */
  ownBranch: string[]
  /** Files attributed to a *different* branch — leaked from
   *  somewhere we just switched away from. Excluded from this
   *  branch's dirty signal and skipped during commit. */
  otherBranch: { path: string; branch: string }[]
}

/**
 * Compute attribution buckets for the supplied untracked file list.
 * Updates `.edgeagent/untracked-attribution.json` (prunes stale,
 * records newly-observed) and refreshes `.edgeagent/head-snapshot.
 * json` so the next call can detect HEAD changes.
 *
 * If `currentBranch` is null (detached HEAD or git unavailable),
 * everything goes into `ownBranch` — without a current branch we
 * have no way to tell what's "elsewhere".
 *
 * Algorithm — optimistic with leakage detection:
 *
 *   For every currently-untracked file F:
 *     - If F has an existing entry in the map → use that (we've
 *       made up our mind already; preserve stickiness so the file
 *       doesn't bounce between branches as the user navigates).
 *     - Else (first time we've seen F):
 *       - If snapshot.branch != currentBranch (HEAD just changed)
 *         AND F was already in snapshot.untracked → F was on the
 *         previous branch when we left it, so it leaked here. Tag
 *         it to snapshot.branch (the branch we just left).
 *       - Else → tag to current branch.
 *
 * Trade-off this picks: a file the user genuinely created on the
 * current branch lights up the yellow Commit dot immediately
 * (optimistic default). The cost is that a file already on disk
 * the very first time the app sees the project gets attributed to
 * whatever branch the user happens to be on then; if it really
 * belonged elsewhere we won't know unless the user then switches
 * to that branch (HEAD-snapshot moves the attribution back).
 */
export function attributeUntrackedFiles(
  projectPath: string,
  currentBranch: string | null,
  untrackedRelPaths: string[]
): AttributionResult {
  if (!currentBranch || untrackedRelPaths.length === 0) {
    return { ownBranch: [...untrackedRelPaths], otherBranch: [] }
  }

  const file = readAttribution(projectPath)
  const stillPresent = new Set(untrackedRelPaths)
  const now = new Date().toISOString()
  const snapshot = readSnapshot(projectPath)
  const headChanged =
    snapshot !== null && snapshot.branch !== currentBranch
  const previousUntrackedSet = new Set<string>(
    snapshot ? snapshot.untracked : []
  )
  const leftBranch = headChanged ? snapshot!.branch : null

  // Prune entries for files that are no longer untracked (committed,
  // deleted, or stashed away).
  let mutated = false
  for (const k of Object.keys(file.entries)) {
    if (!stillPresent.has(k)) {
      delete file.entries[k]
      mutated = true
    }
  }

  const ownBranch: string[] = []
  const otherBranch: { path: string; branch: string }[] = []

  for (const rel of untrackedRelPaths) {
    const existing = file.entries[rel]
    if (existing) {
      if (existing.branch === currentBranch) {
        ownBranch.push(rel)
      } else {
        otherBranch.push({ path: rel, branch: existing.branch })
      }
      continue
    }

    // First time we've seen this file. Pick its home branch.
    let home: string
    if (
      headChanged &&
      leftBranch &&
      previousUntrackedSet.has(rel)
    ) {
      // F was already untracked on the branch we just LEFT. It
      // followed us across the checkout; tag it to where it came
      // from so it doesn't pollute the current branch.
      home = leftBranch
    } else {
      // No leakage signal — assume it belongs to current. Either
      // the user just created it here, or there's no prior context.
      home = currentBranch
    }
    file.entries[rel] = { branch: home, firstSeenAt: now }
    mutated = true
    if (home === currentBranch) {
      ownBranch.push(rel)
    } else {
      otherBranch.push({ path: rel, branch: home })
    }
  }

  if (mutated) writeAttribution(projectPath, file)

  // Refresh the snapshot AFTER computing so a future call can
  // diff against this state. Last so a crash mid-attribution
  // doesn't wipe the previous baseline.
  writeSnapshot(projectPath, {
    version: SCHEMA_VERSION,
    branch: currentBranch,
    untracked: untrackedRelPaths.slice(),
    capturedAt: now,
  })

  return { ownBranch, otherBranch }
}

/**
 * Wipe the entire attribution map AND the head snapshot. The next
 * call to `attributeUntrackedFiles` rebuilds from scratch using the
 * reflog + mtime heuristic. Exposed so the UI can offer a "re-
 * attribute everything" escape hatch when the user knows the map is
 * locked in wrong.
 *
 * Returns counts so the caller can render a meaningful toast.
 */
export function resetAttribution(projectPath: string): {
  removedEntries: number
  hadSnapshot: boolean
} {
  const file = readAttribution(projectPath)
  const removedEntries = Object.keys(file.entries).length
  let hadSnapshot = false
  try {
    const ap = attributionPath(projectPath)
    if (fs.existsSync(ap)) fs.rmSync(ap, { force: true })
  } catch {
    /* ignore */
  }
  try {
    const sp = snapshotPath(projectPath)
    if (fs.existsSync(sp)) {
      hadSnapshot = true
      fs.rmSync(sp, { force: true })
    }
  } catch {
    /* ignore */
  }
  return { removedEntries, hadSnapshot }
}
