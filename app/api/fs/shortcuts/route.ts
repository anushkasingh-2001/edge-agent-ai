import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { NextResponse } from "next/server"
import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"

/**
 * Returns common starting locations for the Open Local Project
 * folder browser. Each entry is filtered to:
 *   - actually exist on the user's machine (no broken icons)
 *   - be inside `getScanAllowRoot()` (same security envelope as
 *     the scan API)
 *
 * The list is best-effort and platform-agnostic: we probe a known set
 * of directory names rather than reading platform-specific user
 * folders APIs (which would require a native dependency).
 */
export async function GET() {
  const home = os.homedir()
  const allowRoot = getScanAllowRoot()

  // Edge Agent AI keeps cloned GitHub projects under
  // `~/.edge-agent-workspace`; surface that as a first-class
  // shortcut so users can hop right back to a previously cloned repo.
  const workspace = path.join(home, ".edge-agent-workspace")

  const candidates: { id: string; label: string; path: string }[] = [
    { id: "home", label: "Home", path: home },
    { id: "desktop", label: "Desktop", path: path.join(home, "Desktop") },
    { id: "documents", label: "Documents", path: path.join(home, "Documents") },
    { id: "downloads", label: "Downloads", path: path.join(home, "Downloads") },
    { id: "developer", label: "Developer", path: path.join(home, "Developer") },
    { id: "projects", label: "Projects", path: path.join(home, "Projects") },
    { id: "code", label: "Code", path: path.join(home, "Code") },
    { id: "workspace", label: "Edge Agent workspace", path: workspace },
  ]

  const out: typeof candidates = []
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c.path)) continue
      if (!fs.statSync(c.path).isDirectory()) continue
      if (!isPathInside(c.path, allowRoot)) continue
      out.push(c)
    } catch {
      // Permission errors etc. — silently skip the shortcut.
    }
  }

  return NextResponse.json({ ok: true, allowRoot, shortcuts: out })
}
