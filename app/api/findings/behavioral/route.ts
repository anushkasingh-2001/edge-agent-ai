import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"
import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import {
  runBehavioralTests,
  type UserProbeInput,
} from "@/lib/server-behavioral-tests"
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
    disabledProbeIds?: unknown
    userProbes?: unknown
    disableBuiltIns?: unknown
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

  // Sanitise user-supplied probe configuration. We never trust the
  // wire — bad shapes get silently dropped instead of crashing the
  // runner.
  const disabledProbeIds = Array.isArray(body.disabledProbeIds)
    ? (body.disabledProbeIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0
      ) as string[]).slice(0, 200)
    : []
  const userProbes = sanitiseUserProbes(body.userProbes)
  const disableBuiltIns = body.disableBuiltIns === true

  try {
    const report = runBehavioralTests({
      projectPath: requested,
      scanReport: parsed?.success ? parsed.data : null,
      seed,
      perCategoryCap,
      disabledProbeIds,
      userProbes,
      disableBuiltIns,
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

const ALLOWED_SEVERITIES = new Set(["critical", "high", "medium", "low"])
const ALLOWED_SCENARIOS = new Set([
  "prompt_to_output",
  "agent_to_agent",
  "multi_agent_to_one",
])
const MAX_USER_PROBES = 100
const MAX_INPUTS_PER_PROBE = 50
const MAX_PATTERNS_PER_PROBE = 25
const MAX_STRING_LEN = 4_000

function asTrimmedString(v: unknown, maxLen = MAX_STRING_LEN): string {
  if (typeof v !== "string") return ""
  const t = v.trim()
  return t.length > maxLen ? t.slice(0, maxLen) : t
}

function asStringArray(v: unknown, maxCount: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    const s = asTrimmedString(item)
    if (s) out.push(s)
    if (out.length >= maxCount) break
  }
  return out
}

/**
 * Coerce the wire-format `userProbes` payload into the strict
 * `UserProbeInput[]` the runner expects. We never throw — anything
 * malformed gets dropped so a single bad probe can't take down the
 * whole run.
 */
function sanitiseUserProbes(raw: unknown): UserProbeInput[] {
  if (!Array.isArray(raw)) return []
  const out: UserProbeInput[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const id = asTrimmedString(o.id, 200)
    const name = asTrimmedString(o.name, 200)
    const category = asTrimmedString(o.category, 200)
    const severity = asTrimmedString(o.severity, 16)
    const scenario = asTrimmedString(o.scenario, 32)
    if (
      !id.startsWith("user.") ||
      !name ||
      !category ||
      !ALLOWED_SEVERITIES.has(severity) ||
      !ALLOWED_SCENARIOS.has(scenario)
    ) {
      continue
    }
    const inputs = asStringArray(o.inputs, MAX_INPUTS_PER_PROBE)
    if (inputs.length === 0) continue
    const defense_patterns = asStringArray(o.defense_patterns, MAX_PATTERNS_PER_PROBE)
    const agents = asStringArray(o.agents, 8)
    const ruleId = asTrimmedString(o.rule_id, 64)
    const targetFile = asTrimmedString(o.target_file, 1_000)
    const accuracyTarget =
      typeof o.accuracy_target === "number" && Number.isFinite(o.accuracy_target)
        ? Math.max(0, Math.min(1, o.accuracy_target))
        : null
    out.push({
      id,
      rule_id: ruleId || null,
      category,
      severity: severity as UserProbeInput["severity"],
      name,
      scenario: scenario as UserProbeInput["scenario"],
      inputs,
      expected_defense: asTrimmedString(o.expected_defense, 2_000),
      defense_patterns,
      target_file: targetFile || null,
      agents,
      accuracy_target: accuracyTarget,
      failure_observed: asTrimmedString(o.failure_observed, 2_000),
    })
    if (out.length >= MAX_USER_PROBES) break
  }
  return out
}
