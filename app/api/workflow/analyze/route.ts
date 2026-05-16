/**
 * POST /api/workflow/analyze
 *
 * Runs the static workflow analyzer against the requested project path and
 * returns a JSON WorkflowAnalysis. Mirrors the validation conventions used by
 * /api/scan: projectPath must be a non-empty string, must resolve to a
 * directory, and must live under the configured scan allowlist (so a packaged
 * desktop user can't be tricked into analyzing /etc).
 *
 * The analyzer itself never executes user code — see lib/server-workflow.ts.
 */

import fs from "node:fs"
import path from "node:path"

import { NextResponse } from "next/server"

import {
  getScanAllowRoot,
  isPathInside,
} from "@/lib/server-path-utils"
import { analyzeWorkflow } from "@/lib/server-workflow"

// Workflow output reflects on-disk state at request time; never cache.
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let body: { projectPath?: string } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  if (
    !body.projectPath ||
    typeof body.projectPath !== "string" ||
    !body.projectPath.trim()
  ) {
    return NextResponse.json(
      {
        error:
          "projectPath is required. Open a local project or clone from GitHub before analyzing the workflow.",
      },
      { status: 400 }
    )
  }

  const allowRoot = getScanAllowRoot()
  const requested = path.resolve(body.projectPath.trim())

  if (!isPathInside(requested, allowRoot)) {
    return NextResponse.json(
      {
        error:
          "projectPath is outside the allowed directory (set EDGE_AGENT_SCAN_ALLOWLIST or choose a folder under your home directory).",
      },
      { status: 403 }
    )
  }

  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    return NextResponse.json(
      { error: "projectPath is not a directory" },
      { status: 400 }
    )
  }

  try {
    const analysis = analyzeWorkflow(requested)
    return NextResponse.json(analysis, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: "Workflow analysis failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}
