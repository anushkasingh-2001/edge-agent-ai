import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Directory inside which scan/clone/validate paths must sit.
 * - Production: app cwd only (unless EDGE_AGENT_SCAN_ALLOWLIST is set).
 * - Development: user home (unless EDGE_AGENT_SCAN_ALLOWLIST is set) so local repos outside the app folder work.
 */

export function expandUserPath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === "~") return os.homedir()
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return trimmed
}

/**
 * macOS (HFS+/APFS default) and Windows (NTFS) are case-insensitive.
 * Comparing absolute paths byte-for-byte breaks the boundary check when the
 * user types `/users/anushka/...` and the OS canonical is `/Users/anushka/...`.
 */
const PLATFORM_CASE_INSENSITIVE =
  process.platform === "darwin" || process.platform === "win32"

function tryRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

/**
 * Returns true iff `child` is inside (or equal to) `parent`.
 * Resolves symlinks and case differences via realpath when possible, and
 * falls back to a platform-aware case comparison when realpath can't run
 * (e.g. when the child path doesn't exist yet — used by the clone flow).
 */
export function isPathInside(child: string, parent: string): boolean {
  const cReal = tryRealpath(child)
  const pReal = tryRealpath(parent)
  const direct = path.relative(pReal, cReal)
  if (direct === "" || (!direct.startsWith("..") && !path.isAbsolute(direct))) {
    return true
  }
  if (PLATFORM_CASE_INSENSITIVE) {
    const ci = path.relative(pReal.toLowerCase(), cReal.toLowerCase())
    return ci === "" || (!ci.startsWith("..") && !path.isAbsolute(ci))
  }
  return false
}

export function getScanAllowRoot(): string {
  if (process.env.EDGE_AGENT_SCAN_ALLOWLIST?.trim()) {
    return path.resolve(expandUserPath(process.env.EDGE_AGENT_SCAN_ALLOWLIST.trim()))
  }
  if (process.env.NODE_ENV === "production") {
    return process.cwd()
  }
  return os.homedir()
}

export function assertReadableDirectory(resolved: string, allowRoot: string): void {
  if (!isPathInside(resolved, allowRoot)) {
    throw new Error("Path is outside the allowed directory")
  }
  if (!fs.existsSync(resolved)) {
    throw new Error("Path does not exist")
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error("Path is not a directory")
  }
}
