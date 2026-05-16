/**
 * POST /api/workflow/export
 *
 * Turns a previously generated WorkflowAnalysis into a Markdown report. The
 * client could technically render this on its own, but routing through the
 * server keeps the formatting logic in one place (lib/server-workflow.ts) so
 * future changes to the report layout don't need a frontend redeploy.
 *
 * Input:  { projectPath: string, workflow: WorkflowAnalysis }
 * Output: { markdown: string, filename: string }
 *
 * `projectPath` is validated against the scan allowlist for parity with
 * /api/workflow/analyze even though no filesystem read happens here — so a
 * caller can't slip a bogus path into the report headers.
 */

import fs from "node:fs"
import path from "node:path"

import { NextResponse } from "next/server"

import {
  getScanAllowRoot,
  isPathInside,
} from "@/lib/server-path-utils"
import { renderMarkdownReport } from "@/lib/server-workflow"
import type { WorkflowAnalysis } from "@/lib/workflow-types"

export const dynamic = "force-dynamic"

function isWorkflowAnalysis(x: unknown): x is WorkflowAnalysis {
  // Cheap structural check — the analyzer is the only legitimate producer.
  if (!x || typeof x !== "object") return false
  const o = x as Record<string, unknown>
  return (
    typeof o.projectName === "string" &&
    typeof o.generatedAt === "string" &&
    Array.isArray(o.components) &&
    Array.isArray(o.prompts) &&
    Array.isArray(o.tools) &&
    Array.isArray(o.modelCalls) &&
    Array.isArray(o.edges) &&
    typeof o.mermaid === "string" &&
    typeof o.summary === "string"
  )
}

export async function POST(request: Request) {
  let body: { projectPath?: string; workflow?: unknown } = {}
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
      { error: "projectPath is required" },
      { status: 400 }
    )
  }

  if (!isWorkflowAnalysis(body.workflow)) {
    return NextResponse.json(
      { error: "workflow must be a WorkflowAnalysis object" },
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
      { error: "projectPath is not a directory" },
      { status: 400 }
    )
  }

  try {
    const { markdown, filename } = renderMarkdownReport(body.workflow)
    return NextResponse.json(
      { markdown, filename },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    )
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to render workflow report",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}
