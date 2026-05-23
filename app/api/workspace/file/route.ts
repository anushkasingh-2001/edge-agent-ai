/**
 * GET /api/workspace/file?root=<absPath>&path=<relPath>
 *
 * Returns the text content of a file inside the workspace, along with
 * metadata the editor needs (language hint for Monaco, byte size,
 * mtime for dirty-state comparisons).
 *
 * Failure modes the client cares about:
 *   * 404 not_found    — path doesn't exist (or was an ignored dir)
 *   * 400 is_dir       — the path points at a directory
 *   * 413 too_large    — file is bigger than MAX_EDITOR_FILE_BYTES
 *   * 415 binary       — the file sniffed as binary
 *   * 400 outside_workspace / absolute_path / ignored — security
 *
 * The editor uses the body's `error` + `code` to render a read-only
 * placeholder when we refuse to load the content.
 */

import { NextRequest, NextResponse } from "next/server"

import {
  readWorkspaceFile,
  resolveWorkspaceRoot,
  WorkspaceError,
} from "@/lib/server-workspace"

export const runtime = "nodejs"

function statusFor(code: WorkspaceError["code"]): number {
  switch (code) {
    case "invalid_root":
    case "absolute_path":
    case "outside_workspace":
    case "ignored":
    case "is_dir":
      return 400
    case "not_found":
      return 404
    case "too_large":
      return 413
    case "binary":
      return 415
    default:
      return 500
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  try {
    const root = resolveWorkspaceRoot(sp.get("root"))
    const file = readWorkspaceFile(root, sp.get("path") ?? "")
    return NextResponse.json(file)
  } catch (e) {
    if (e instanceof WorkspaceError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: statusFor(e.code) })
    }
    return NextResponse.json(
      { error: (e as Error).message ?? "internal error", code: "io_error" },
      { status: 500 },
    )
  }
}
