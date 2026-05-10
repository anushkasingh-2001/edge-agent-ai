import { NextResponse } from "next/server"
import { GitError, resolveProjectPath } from "@/lib/server-git"
import {
  HISTORY_LINE_LIMIT,
  clearEvalHistory,
  readEvalHistory,
} from "@/lib/server-evals"

/**
 * GET /api/evals/history?projectPath=/abs/path[&limit=N]
 *
 * Returns the last `limit` runs (newest-first) from
 * `<projectPath>/.edgeagent/eval-history.jsonl`. Default limit is
 * `HISTORY_LINE_LIMIT` (500). Empty array when no runs have ever
 * been persisted — never a 500.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectPath = (url.searchParams.get("projectPath") ?? "").trim()
  const limitRaw = url.searchParams.get("limit")
  const limit = Math.max(
    1,
    Math.min(
      HISTORY_LINE_LIMIT,
      Number.parseInt(limitRaw ?? "", 10) || HISTORY_LINE_LIMIT
    )
  )
  if (!projectPath) {
    return NextResponse.json(
      { error: "projectPath is required" },
      { status: 400 }
    )
  }
  try {
    const { resolved } = resolveProjectPath(projectPath)
    const runs = readEvalHistory(resolved, limit)
    return NextResponse.json({ runs, limit })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/evals/history?projectPath=/abs/path
 *
 * Wipes the persisted eval-history file. Useful when the user
 * wants to start fresh after fixing a misconfigured eval that
 * polluted the trend chart with a chunk of bad data.
 */
export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const projectPath = (url.searchParams.get("projectPath") ?? "").trim()
  if (!projectPath) {
    return NextResponse.json(
      { error: "projectPath is required" },
      { status: 400 }
    )
  }
  try {
    const { resolved } = resolveProjectPath(projectPath)
    const r = clearEvalHistory(resolved)
    if (!r.ok) {
      return NextResponse.json({ error: r.error }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
