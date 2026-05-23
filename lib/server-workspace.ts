/**
 * Shared server helpers for the in-app workspace (file tree / editor /
 * save) APIs that back `app/api/workspace/*`.
 *
 * Goals:
 *   * Make path validation impossible to forget. Every public helper
 *     re-derives the absolute path from `(root, relPath)` and verifies
 *     it sits inside `root` via {@link isPathInside}. Absolute paths
 *     from the client are rejected.
 *   * Centralise "what counts as binary / too big / ignored" so the
 *     tree and the file endpoints agree.
 *   * Stay framework-agnostic — these are plain functions that throw
 *     `Error` instances with stable codes; the route handlers map
 *     them onto HTTP status codes.
 *
 * Nothing in this module should ever call `fs` outside of `root`. Tests
 * in `tests/workspace-api.test.ts` exercise the traversal-rejection
 * surface explicitly.
 */

import fs from "node:fs"
import path from "node:path"

import { expandUserPath, isPathInside } from "./server-path-utils"

/** Max file size we'll load into the editor as text. Bigger files come
 *  back as a placeholder so the editor doesn't have to ship 50MB of
 *  minified JS to the browser. */
export const MAX_EDITOR_FILE_BYTES = 1024 * 1024 // 1 MiB

/** Hide these everywhere — the tree listing skips them and the file
 *  endpoint refuses to read inside them. Mirrors the scanner's
 *  SKIP_DIR_NAMES so users see the same picture in the editor as the
 *  scanner sees on disk. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
  ".DS_Store",
])

/** Files we always treat as binary regardless of magic-byte sniffing —
 *  saves a stat + read for predictably non-textual content. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".rar",
  ".7z",
  ".tar",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".wasm",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".class",
  ".pyc",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
])

export interface ResolvedPath {
  /** The vetted, absolute on-disk path. Always inside `root`. */
  absolute: string
  /** Path relative to `root`, normalised (no leading slash, no `..`). */
  relative: string
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    /** Maps onto HTTP status in the route handlers. */
    public readonly code:
      | "invalid_root"
      | "outside_workspace"
      | "not_found"
      | "is_dir"
      | "is_file"
      | "ignored"
      | "too_large"
      | "binary"
      | "absolute_path"
      | "io_error",
  ) {
    super(message)
    this.name = "WorkspaceError"
  }
}

/**
 * Normalise and validate a user-supplied workspace root. Accepts `~`
 * shorthand and returns the canonical absolute path. Throws
 * WorkspaceError if the directory doesn't exist or isn't a directory.
 *
 * We deliberately do NOT apply `getScanAllowRoot()` here — the scan
 * flow already constrains which roots the user can open, so by the
 * time a root reaches this helper it has been vetted upstream. We
 * still re-verify it's a real directory.
 */
export function resolveWorkspaceRoot(input: string | null | undefined): string {
  if (!input || typeof input !== "string" || !input.trim()) {
    throw new WorkspaceError("workspace root is required", "invalid_root")
  }
  const expanded = expandUserPath(input)
  const abs = path.resolve(expanded)
  try {
    const stat = fs.statSync(abs)
    if (!stat.isDirectory()) {
      throw new WorkspaceError("workspace root is not a directory", "invalid_root")
    }
  } catch (e) {
    if (e instanceof WorkspaceError) throw e
    throw new WorkspaceError("workspace root does not exist", "invalid_root")
  }
  return abs
}

/**
 * Take a root + a client-supplied relative path and return the safe
 * absolute counterpart. Throws on:
 *   * absolute paths from the client (we never want them — they can
 *     point anywhere)
 *   * paths that resolve outside `root` (path traversal)
 *   * paths whose segments include an ignored directory
 */
export function resolveInsideWorkspace(root: string, relPath: string | null | undefined): ResolvedPath {
  if (relPath == null) relPath = ""
  if (typeof relPath !== "string") {
    throw new WorkspaceError("path must be a string", "outside_workspace")
  }
  // Empty string means "the root itself" — that's valid for the tree
  // endpoint but the file endpoint will reject it as a directory.
  const trimmed = relPath.trim()
  if (trimmed === "" || trimmed === "." || trimmed === "./") {
    return { absolute: root, relative: "" }
  }
  // Absolute and Windows-drive paths are explicit rejections so a
  // sloppy client cannot accidentally exfiltrate `/etc/passwd`.
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new WorkspaceError("absolute paths are not allowed", "absolute_path")
  }
  // Normalise to collapse `./`, `foo/../bar`, etc., then reject any
  // segment that climbs above root after normalisation. We rely on
  // both the string-level check AND `isPathInside` realpath check.
  const normalised = path
    .normalize(trimmed)
    .replace(/^\.[\\/]+/, "")
    .replace(/^\/+|^\\+/, "")
  if (normalised === "." || normalised === "") {
    return { absolute: root, relative: "" }
  }
  if (normalised.startsWith("..") || normalised.includes(`..${path.sep}`)) {
    throw new WorkspaceError("path escapes workspace root", "outside_workspace")
  }
  // Hidden / generated / vendored directories are off-limits even if
  // the user has them on disk — keeps the tree clean and the save
  // endpoint from clobbering generated content.
  const segments = normalised.split(/[\\/]+/).filter(Boolean)
  for (const seg of segments) {
    if (IGNORED_DIRS.has(seg)) {
      throw new WorkspaceError(`path is inside ignored directory: ${seg}`, "ignored")
    }
  }
  const abs = path.resolve(root, normalised)
  if (!isPathInside(abs, root)) {
    // Defence in depth: even after the string-level check, the
    // realpath-aware comparison catches symlink games where a symlink
    // inside the workspace points outside.
    throw new WorkspaceError("path escapes workspace root", "outside_workspace")
  }
  return { absolute: abs, relative: normalised }
}

export interface TreeEntry {
  name: string
  /** Path relative to the workspace root. */
  path: string
  type: "file" | "dir"
  /** Size in bytes (files only). */
  size: number | null
}

/**
 * List the immediate children of `relPath` inside `root`. Lazy by
 * design — the tree component asks per folder so opening a huge repo
 * never costs more than a single `readdir` round-trip.
 *
 * Directories sort before files, both alphabetically. Ignored
 * directories never appear.
 */
export function listDirectory(root: string, relPath: string): TreeEntry[] {
  const { absolute } = resolveInsideWorkspace(root, relPath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(absolute)
  } catch {
    throw new WorkspaceError("directory not found", "not_found")
  }
  if (!stat.isDirectory()) {
    throw new WorkspaceError("path is not a directory", "is_file")
  }
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(absolute, { withFileTypes: true })
  } catch {
    throw new WorkspaceError("could not read directory", "io_error")
  }
  const out: TreeEntry[] = []
  for (const d of dirents) {
    if (IGNORED_DIRS.has(d.name)) continue
    const childRel = relPath ? path.join(relPath, d.name) : d.name
    if (d.isDirectory()) {
      out.push({ name: d.name, path: childRel, type: "dir", size: null })
    } else if (d.isFile()) {
      let size: number | null = null
      try {
        size = fs.statSync(path.join(absolute, d.name)).size
      } catch {
        // Permission/IO error on stat: skip the file rather than
        // failing the entire listing.
        continue
      }
      out.push({ name: d.name, path: childRel, type: "file", size })
    }
    // Symlinks/sockets/etc. are skipped — neither the editor nor the
    // scanner is prepared to handle them.
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

export interface FilePayload {
  path: string
  size: number
  encoding: "utf-8"
  content: string
  /** Best-effort language hint based on extension; the client uses it
   *  to pick a Monaco syntax mode. Never authoritative — the editor
   *  is happy with `plaintext` for unknown types. */
  language: string
  /** Convenience for the dirty-state baseline; mtimeMs from `stat`. */
  mtimeMs: number
}

/**
 * Read a text file inside the workspace. Throws on:
 *   * directory targets (`is_dir`)
 *   * files > {@link MAX_EDITOR_FILE_BYTES} (`too_large`)
 *   * known/sniffed binary content (`binary`)
 *
 * The editor uses the size/binary errors to render a read-only
 * placeholder instead of attempting to load megabytes of binary data
 * into the browser.
 */
export function readWorkspaceFile(root: string, relPath: string): FilePayload {
  const { absolute, relative } = resolveInsideWorkspace(root, relPath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(absolute)
  } catch {
    throw new WorkspaceError("file not found", "not_found")
  }
  if (stat.isDirectory()) {
    throw new WorkspaceError("path is a directory", "is_dir")
  }
  if (!stat.isFile()) {
    throw new WorkspaceError("path is not a regular file", "not_found")
  }
  if (stat.size > MAX_EDITOR_FILE_BYTES) {
    throw new WorkspaceError(
      `file too large for editor (${stat.size} bytes > ${MAX_EDITOR_FILE_BYTES})`,
      "too_large",
    )
  }
  const ext = path.extname(absolute).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) {
    throw new WorkspaceError("file is binary", "binary")
  }
  let buf: Buffer
  try {
    buf = fs.readFileSync(absolute)
  } catch {
    throw new WorkspaceError("could not read file", "io_error")
  }
  if (looksBinary(buf)) {
    throw new WorkspaceError("file is binary", "binary")
  }
  return {
    path: relative,
    size: stat.size,
    encoding: "utf-8",
    content: buf.toString("utf-8"),
    language: guessLanguage(ext),
    mtimeMs: stat.mtimeMs,
  }
}

/**
 * Write a file inside the workspace. Uses tmp+rename for atomicity so
 * a crash mid-write can't leave a half-file behind.
 *
 * Refuses to:
 *   * create files outside the workspace
 *   * write to ignored directories
 *   * write to a path that currently is a directory
 *   * write content larger than {@link MAX_EDITOR_FILE_BYTES} (defence
 *     in depth — the route handler should reject earlier)
 */
export function writeWorkspaceFile(
  root: string,
  relPath: string,
  content: string,
): { path: string; size: number; mtimeMs: number } {
  if (typeof content !== "string") {
    throw new WorkspaceError("content must be a string", "io_error")
  }
  if (Buffer.byteLength(content, "utf-8") > MAX_EDITOR_FILE_BYTES) {
    throw new WorkspaceError("content too large", "too_large")
  }
  const { absolute, relative } = resolveInsideWorkspace(root, relPath)
  // The parent dir must exist (we don't auto-mkdir; that surface is
  // bigger than the editor needs today).
  const parent = path.dirname(absolute)
  if (!fs.existsSync(parent)) {
    throw new WorkspaceError("parent directory does not exist", "not_found")
  }
  if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
    throw new WorkspaceError("target path is a directory", "is_dir")
  }
  const tmp = `${absolute}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o644 })
    fs.renameSync(tmp, absolute)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // best-effort cleanup
    }
    throw new WorkspaceError(`write failed: ${(e as Error).message}`, "io_error")
  }
  const stat = fs.statSync(absolute)
  return { path: relative, size: stat.size, mtimeMs: stat.mtimeMs }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sniff the leading bytes of a file for NUL or high-density non-text
 *  bytes. Mirrors the heuristic `git` uses for "binary?" classification:
 *  any NUL in the first ~8KB means binary. */
export function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** Map a file extension to a Monaco-recognised language id. Falls back
 *  to `plaintext` for anything we don't know about. The editor still
 *  loads the file, it just doesn't highlight. */
export function guessLanguage(ext: string): string {
  const e = ext.toLowerCase()
  switch (e) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript"
    case ".tsx":
      return "typescript"
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript"
    case ".jsx":
      return "javascript"
    case ".py":
    case ".pyi":
      return "python"
    case ".go":
      return "go"
    case ".rs":
      return "rust"
    case ".rb":
      return "ruby"
    case ".java":
      return "java"
    case ".kt":
    case ".kts":
      return "kotlin"
    case ".c":
    case ".h":
      return "c"
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hpp":
      return "cpp"
    case ".cs":
      return "csharp"
    case ".php":
      return "php"
    case ".swift":
      return "swift"
    case ".scala":
      return "scala"
    case ".sh":
    case ".bash":
    case ".zsh":
      return "shell"
    case ".json":
      return "json"
    case ".yml":
    case ".yaml":
      return "yaml"
    case ".toml":
      return "toml"
    case ".md":
    case ".markdown":
      return "markdown"
    case ".html":
    case ".htm":
      return "html"
    case ".css":
      return "css"
    case ".scss":
    case ".sass":
      return "scss"
    case ".sql":
      return "sql"
    case ".xml":
      return "xml"
    case ".dockerfile":
      return "dockerfile"
    default:
      return "plaintext"
  }
}
