import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import {
  expandUserPath,
  getScanAllowRoot,
  isPathInside,
} from "@/lib/server-path-utils"

/**
 * Lists the immediate contents of a directory. Used by the Open Local
 * Project dialog's folder browser so users don't have to type absolute
 * paths.
 *
 * Security: every requested path is resolved + checked against
 * `getScanAllowRoot()` (the user's home dir in dev, app cwd in prod).
 * We never traverse symlinks that escape that root, and we never
 * return file contents — just names + types.
 *
 * Query string:
 *   path: optional. When omitted (or empty / "~"), defaults to home.
 *   includeFiles: "1" to include non-directory entries (defaults to
 *     directories-only, which is what the picker needs).
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const raw = url.searchParams.get("path") ?? ""
  const includeFiles = url.searchParams.get("includeFiles") === "1"
  const allowRoot = getScanAllowRoot()

  // Default to allowRoot (home dir in dev) when nothing is passed.
  let target: string
  try {
    target = raw.trim() ? path.resolve(expandUserPath(raw)) : allowRoot
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Bad path" },
      { status: 400 }
    )
  }

  if (!isPathInside(target, allowRoot)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Path is outside the allowed root (${allowRoot}).`,
      },
      { status: 403 }
    )
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return NextResponse.json(
      { ok: false, error: "Path does not exist." },
      { status: 404 }
    )
  }
  if (!stat.isDirectory()) {
    return NextResponse.json(
      { ok: false, error: "Path is not a directory." },
      { status: 400 }
    )
  }

  let raw_entries: fs.Dirent[]
  try {
    raw_entries = fs.readdirSync(target, { withFileTypes: true })
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Read failed.",
      },
      { status: 500 }
    )
  }

  // Hide dotfiles by default — but keep `.git` discoverable since
  // users sometimes browse to a worktree root explicitly. We surface
  // an `isHidden` flag so the UI can grey them out instead of dropping.
  const entries = raw_entries
    .filter((d) => includeFiles || d.isDirectory())
    .map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
      isHidden: d.name.startsWith("."),
    }))
    // Directories first (alphabetical), then files (alphabetical).
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    })

  // Compute the parent only when we're not already at the allow root —
  // otherwise the UI's "Up" button could escape into protected paths.
  const parent =
    target === allowRoot ? null : path.dirname(target)

  return NextResponse.json({
    ok: true,
    path: target,
    parent,
    allowRoot,
    entries,
  })
}
