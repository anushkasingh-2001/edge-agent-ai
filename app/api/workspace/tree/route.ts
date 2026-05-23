/**
 * GET /api/workspace/tree
 *
 * Lazy directory listing for the in-app file tree. Pass `root=<repo
 * absolute path>` (the same one the Findings/scan flow uses) and
 * optionally `path=<rel>` to drill into a subfolder. The response
 * contains only the immediate children of the requested directory;
 * the client expands further levels by issuing more requests as the
 * user clicks. This keeps the tree responsive on huge repos.
 *
 * Security: every read goes through `resolveInsideWorkspace`, which
 * rejects absolute paths, traversal, and ignored directories.
 */

import { NextRequest, NextResponse } from "next/server"

import {
  listDirectory,
  resolveWorkspaceRoot,
  WorkspaceError,
} from "@/lib/server-workspace"

export const runtime = "nodejs"

function statusFor(code: WorkspaceError["code"]): number {
  switch (code) {
    case "invalid_root":
      return 400
    case "absolute_path":
    case "outside_workspace":
    case "ignored":
      return 400
    case "not_found":
      return 404
    case "is_file":
      return 400
    default:
      return 500
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  try {
    const root = resolveWorkspaceRoot(sp.get("root"))
    const relPath = sp.get("path") ?? ""
    const entries = listDirectory(root, relPath)
    return NextResponse.json({ root, path: relPath, entries })
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
