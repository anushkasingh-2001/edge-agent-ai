import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import {
  assertReadableDirectory,
  expandUserPath,
  getScanAllowRoot,
} from "@/lib/server-path-utils"

export async function POST(request: Request) {
  let body: { projectPath?: string } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const raw = typeof body.projectPath === "string" ? body.projectPath : ""
  if (!raw.trim()) {
    return NextResponse.json(
      { ok: false, error: "projectPath is required" },
      { status: 400 }
    )
  }

  const allowRoot = getScanAllowRoot()
  let resolved: string
  try {
    resolved = path.resolve(expandUserPath(raw))
    assertReadableDirectory(resolved, allowRoot)
    // Canonicalise case + symlinks so the sidebar/topbar shows the real folder
    // name (e.g. "Desktop" rather than the user-typed "desktop").
    try {
      resolved = fs.realpathSync.native(resolved)
    } catch {
      /* keep resolved as-is if realpath fails */
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid path"
    return NextResponse.json({ ok: false, error: msg }, { status: 400 })
  }

  const name = path.basename(resolved) || "Project"
  return NextResponse.json({ ok: true as const, name, path: resolved })
}
