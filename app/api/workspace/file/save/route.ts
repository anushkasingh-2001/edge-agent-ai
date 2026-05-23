/**
 * POST /api/workspace/file/save
 * Body: { root, path, content }
 *
 * Writes a file inside the workspace using an atomic tmp+rename so a
 * crash mid-write can't leave a half-file. Returns the new
 * size+mtimeMs so the client can re-baseline its dirty state.
 *
 * Same security envelope as GET /api/workspace/file: every path goes
 * through `resolveInsideWorkspace`. Absolute paths, traversal, and
 * ignored directories are all rejected before any IO happens.
 */

import { NextRequest, NextResponse } from "next/server"

import {
  resolveWorkspaceRoot,
  WorkspaceError,
  writeWorkspaceFile,
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
    default:
      return 500
  }
}

interface SaveBody {
  root?: string
  path?: string
  content?: string
}

export async function POST(req: NextRequest) {
  let body: SaveBody
  try {
    body = (await req.json()) as SaveBody
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (typeof body?.content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 })
  }
  try {
    const root = resolveWorkspaceRoot(body.root)
    const saved = writeWorkspaceFile(root, body.path ?? "", body.content)
    return NextResponse.json({ ...saved, ok: true })
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
