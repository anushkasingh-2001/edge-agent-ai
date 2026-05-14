import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"
import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import { runBehavioralTests } from "@/lib/server-behavioral-tests"
import { ScanReportSchema } from "@/lib/scan-report"

/**
 * POST /api/findings/behavioral
 *
 * Generate AND run a fresh batch of behavioral / adversarial tests against
 * the project. Inputs rotate per call so successive runs probe with new
 * adversarial samples (matching the "auto-creating tests input each time"
 * UX). All execution is local + offline (no LLM / network) — the runner
 * inspects real source files for the defenses each probe expects.
 *
 * Body:
 *   {
 *     projectPath: string,         // absolute path inside scan allow-root
 *     scanReport: ScanReport,      // current report — drives which files
 *                                  //   each probe targets
 *     seed?: number,               // optional, for reproducible runs
 *     perCategoryCap?: number      // optional cap per category (default 3)
 *   }
 */
export async function POST(request: Request) {
  let body: {
    projectPath?: string
    scanReport?: unknown
    seed?: number
    perCategoryCap?: number
  } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  if (!body.projectPath || typeof body.projectPath !== "string" || !body.projectPath.trim()) {
    return NextResponse.json(
      { error: "projectPath is required." },
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

  // Allow callers to pass the report or omit it (in which case we run
  // probes that ALL fall through to skipped — useful for first-load
  // smoke). When present we validate against the canonical schema so a
  // partially-typed object doesn't crash deeper code.
  const parsed = body.scanReport
    ? ScanReportSchema.safeParse(body.scanReport)
    : null
  if (parsed && !parsed.success) {
    return NextResponse.json(
      { error: "scanReport failed validation", issues: parsed.error.issues.slice(0, 5) },
      { status: 400 }
    )
  }

  const seed =
    typeof body.seed === "number" && Number.isFinite(body.seed)
      ? Math.floor(body.seed)
      : undefined
  const perCategoryCap =
    typeof body.perCategoryCap === "number" &&
    body.perCategoryCap > 0 &&
    body.perCategoryCap <= 25
      ? Math.floor(body.perCategoryCap)
      : undefined

  try {
    const report = runBehavioralTests({
      projectPath: requested,
      scanReport: parsed?.success ? parsed.data : null,
      seed,
      perCategoryCap,
    })
    return NextResponse.json(report)
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `Behavioral test runner failed: ${e.message}`
            : "Behavioral test runner failed",
      },
      { status: 500 }
    )
  }
}
