/**
 * Fix Cache.
 *
 * Extends the existing on-disk explanation cache pattern
 * (`.edgeagent/cache/explanations.json`) into four namespaces so we
 * never re-bill for re-opening a finding or re-previewing an unchanged
 * patch.
 *
 *   explanations  → already exists (owned by server-finding-explanations).
 *   suggestions   → suggestion text per finding+context.
 *   patch_previews→ validated patch + confidence per finding+file hash.
 *   grouped_fixes → cluster-level patches keyed on the cluster signature.
 *
 * Cache key composition (universal):
 *   sha256(model | scanner_version | fileHash(es) | findingId(s)
 *          | contextHash | promptTemplateVersion)
 *
 * The model id is part of the key (NOT just the provider) so switching
 * from `gpt-4.1-mini` to `gpt-4.1` or to `claude-sonnet-4-5` always
 * misses and regenerates — invariant 4 of the integration brief.
 *
 * CRITICAL invalidation rule: patch_previews and grouped_fixes MUST
 * include the file hash. A cached patch against a file that has since
 * changed is dangerous, so a changed file = cache miss = regenerate.
 * The route's "apply" step ADDITIONALLY re-verifies the file hash at
 * apply time (via `previewMatchesCurrentFile`) — the cache key alone
 * isn't enough because cache hits short-circuit BEFORE we've read the
 * current file.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type CacheNamespace =
  | "explanations"
  | "suggestions"
  | "patch_previews"
  | "grouped_fixes"

const CACHE_DIR = ".edgeagent/cache"

const FILE_FOR: Record<CacheNamespace, string> = {
  explanations: "explanations.json",
  suggestions: "suggestions.json",
  patch_previews: "patch_previews.json",
  grouped_fixes: "grouped_fixes.json",
}

/** Bump when a prompt template changes so old cached AI output is
 *  dropped (matches the pattern in server-finding-explanations.ts). */
export const PROMPT_TEMPLATE_VERSION = "fix-v1"

export interface KeyParts {
  model: string
  scannerVersion: string
  /** One or more file hashes (sha256 of file contents). Order-insensitive. */
  fileHashes: string[]
  /** One or more finding ids. Order-insensitive. */
  findingIds: string[]
  /** Hash of the assembled graph-bounded context bundle. */
  contextHash: string
}

export function hashFileContents(contents: string): string {
  return crypto.createHash("sha256").update(contents).digest("hex").slice(0, 16)
}

export function buildCacheKey(parts: KeyParts): string {
  const payload = [
    parts.model,
    parts.scannerVersion,
    [...parts.fileHashes].sort().join(","),
    [...parts.findingIds].sort().join(","),
    parts.contextHash,
    PROMPT_TEMPLATE_VERSION,
  ].join("|")
  return crypto.createHash("sha256").update(payload).digest("hex")
}

function cacheFilePath(projectPath: string, ns: CacheNamespace): string {
  return path.join(projectPath, CACHE_DIR, FILE_FOR[ns])
}

function readStore(
  projectPath: string,
  ns: CacheNamespace,
): Record<string, unknown> {
  const fp = cacheFilePath(projectPath, ns)
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8")) as Record<string, unknown>
  } catch {
    return {} // missing or corrupt → treat as empty
  }
}

function writeStore(
  projectPath: string,
  ns: CacheNamespace,
  store: Record<string, unknown>,
): void {
  const fp = cacheFilePath(projectPath, ns)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  // Atomic-ish write: temp then rename, so a crash mid-write can't
  // corrupt a cache other readers depend on.
  const tmp = `${fp}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8")
  fs.renameSync(tmp, fp)
}

export function cacheGet<T = unknown>(
  projectPath: string,
  ns: CacheNamespace,
  key: string,
): T | null {
  const store = readStore(projectPath, ns)
  const hit = store[key]
  return hit === undefined ? null : (hit as T)
}

export function cacheSet<T = unknown>(
  projectPath: string,
  ns: CacheNamespace,
  key: string,
  value: T,
): void {
  const store = readStore(projectPath, ns)
  store[key] = value
  writeStore(projectPath, ns, store)
}

/** Enumerate every value in a namespace. Used by the patch route to
 *  look up a preview by id when the route only has the
 *  pipeline-generated `previewId` (a derivative of the cache key, not
 *  the cache key itself). Cheap because per-project cache files are
 *  bounded — both in number of entries (one per finding) and in size
 *  per entry. */
export function cacheList<T = unknown>(
  projectPath: string,
  ns: CacheNamespace,
): T[] {
  const store = readStore(projectPath, ns)
  return Object.values(store) as T[]
}

/** Drop every cached entry whose key embedded a now-stale file hash.
 *  Coarse purge for the namespace — callers re-issue a `buildCacheKey`
 *  with the new file hash and miss, which is the normal flow; this
 *  helper just keeps the JSON from growing unbounded over time. */
export function purgeNamespace(
  projectPath: string,
  ns: CacheNamespace,
): void {
  writeStore(projectPath, ns, {})
}

/* ------------------------------------------------------------------ *
 *  Preview hashing helpers used by the safe-apply path                *
 * ------------------------------------------------------------------ */

/**
 * The route stores a `previewFileHash` alongside the cached preview so
 * a subsequent `mode:"apply"` request can re-hash the current
 * on-disk file and refuse to apply if it changed in the meantime.
 *
 * Lives here (not in the route) because both the patch route and the
 * fix-filtered route need the exact same comparison logic.
 */
export interface PreviewHashRecord {
  file: string
  previewFileHash: string
}

export function previewMatchesCurrentFile(
  projectPath: string,
  record: PreviewHashRecord,
): boolean {
  const absFile = path.resolve(projectPath, record.file)
  try {
    const current = fs.readFileSync(absFile, "utf8")
    return hashFileContents(current) === record.previewFileHash
  } catch {
    return false
  }
}
