import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"
import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import {
  buildAndMaybeApplyFixes,
  type FixTarget,
  type FixMode,
} from "@/lib/server-finding-fixes"

/**
 * POST /api/findings/fix
 *
 * Body:
 *   {
 *     projectPath: string,
 *     mode: "suggest" | "apply",
 *     targets: [{ ref_id, rule_id, file, line, title? }, ...]
 *   }
 *
 * Returns the per-target FixProposal list. In `suggest` mode we never
 * touch the filesystem. In `apply` mode we write each file atomically
 * after dropping a `.edge-agent.bak` backup so the user can revert
 * without git.
 */
export async function POST(request: Request) {
  let body: {
    projectPath?: string
    mode?: FixMode
    targets?: unknown
  } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  if (!body.projectPath || typeof body.projectPath !== "string") {
    return NextResponse.json(
      { error: "projectPath is required." },
      { status: 400 }
    )
  }
  if (body.mode !== "suggest" && body.mode !== "apply") {
    return NextResponse.json(
      { error: "mode must be either 'suggest' or 'apply'." },
      { status: 400 }
    )
  }
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return NextResponse.json(
      { error: "targets must be a non-empty array." },
      { status: 400 }
    )
  }
  if (body.targets.length > 200) {
    return NextResponse.json(
      { error: "too many targets (max 200 per request)." },
      { status: 400 }
    )
  }

  const allowRoot = getScanAllowRoot()
  const requested = path.resolve(body.projectPath.trim())
  if (!isPathInside(requested, allowRoot)) {
    return NextResponse.json(
      { error: "projectPath is outside the allowed directory" },
      { status: 403 }
    )
  }
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    return NextResponse.json(
      { error: "projectPath does not point to an existing directory" },
      { status: 404 }
    )
  }

  const targets: FixTarget[] = []
  for (const raw of body.targets as unknown[]) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    if (
      typeof r.ref_id !== "string" ||
      typeof r.rule_id !== "string" ||
      typeof r.file !== "string" ||
      typeof r.line !== "number" ||
      !Number.isFinite(r.line)
    ) {
      continue
    }
    targets.push({
      ref_id: r.ref_id,
      rule_id: r.rule_id,
      file: r.file,
      line: Math.max(1, Math.floor(r.line)),
      title: typeof r.title === "string" ? r.title : undefined,
    })
  }
  if (targets.length === 0) {
    return NextResponse.json(
      {
        error:
          "No valid targets after parsing. Each target needs ref_id, rule_id, file, and an integer line.",
      },
      { status: 400 }
    )
  }

  try {
    const result = buildAndMaybeApplyFixes({
      projectPath: requested,
      targets,
      mode: body.mode,
    })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `Fix engine failed: ${e.message}`
            : "Fix engine failed",
      },
      { status: 500 }
    )
  }
}
