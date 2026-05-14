/**
 * Client-side mirror of the server behavioral-test types + the fetcher
 * the Findings UI uses to drive the runner.
 *
 * We can't import from `lib/server-behavioral-tests.ts` directly because
 * that module pulls in `node:fs` / `node:path` which Next refuses to ship
 * to the browser. Mirroring the small contract here keeps the client
 * bundle clean.
 */

import type { ScanReport } from "./scan-report"

export type BehavioralSeverity = "critical" | "high" | "medium" | "low"
export type BehavioralStatus = "pass" | "fail" | "skip"

export interface BehavioralTurn {
  speaker: "user" | "agent_a" | "agent_b" | "system"
  text: string
}

export interface BehavioralTestCase {
  id: string
  category: string
  rule_id: string | null
  probe_id: string
  name: string
  severity: BehavioralSeverity
  input: string
  conversation: BehavioralTurn[]
  expected_defense: string
  observed: string
  target_file: string | null
  target_line: number | null
  evidence: string | null
  status: BehavioralStatus
  notes: string | null
}

export interface BehavioralCategorySummary {
  category: string
  severity: BehavioralSeverity
  rule_id: string | null
  total: number
  passed: number
  failed: number
  skipped: number
  /** passed / (passed + failed). Null when only skipped tests exist. */
  accuracy: number | null
}

export interface BehavioralRunReport {
  generated_at: string
  project_path: string
  seed: number
  tests: BehavioralTestCase[]
  by_category: BehavioralCategorySummary[]
  totals: {
    total: number
    passed: number
    failed: number
    skipped: number
    accuracy: number | null
  }
}

/**
 * Trigger a fresh behavioral test run on the server. The runner uses a
 * different seed each call by default, so successive invocations probe
 * with different adversarial inputs (matching the user's "auto-create
 * test inputs each time" requirement).
 */
export async function runBehavioralTestsApi(args: {
  projectPath: string
  scanReport: ScanReport | null
  seed?: number
  perCategoryCap?: number
  signal?: AbortSignal
}): Promise<BehavioralRunReport> {
  const res = await fetch("/api/findings/behavioral", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectPath: args.projectPath,
      scanReport: args.scanReport,
      seed: args.seed,
      perCategoryCap: args.perCategoryCap,
    }),
    signal: args.signal,
  })
  if (!res.ok) {
    let message: string | null = null
    try {
      const j = (await res.json()) as { error?: string }
      message = j?.error ?? null
    } catch {
      /* ignore */
    }
    throw new Error(
      message ?? `Behavioral test request failed (HTTP ${res.status})`
    )
  }
  return (await res.json()) as BehavioralRunReport
}

export function severityTone(s: BehavioralSeverity): {
  badge: string
  dot: string
} {
  switch (s) {
    case "critical":
      return {
        badge: "bg-red-500/10 text-red-400 border-red-500/20",
        dot: "bg-red-500",
      }
    case "high":
      return {
        badge: "bg-orange-500/10 text-orange-400 border-orange-500/20",
        dot: "bg-orange-500",
      }
    case "medium":
      return {
        badge: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
        dot: "bg-yellow-500",
      }
    case "low":
      return {
        badge: "bg-blue-500/10 text-blue-400 border-blue-500/20",
        dot: "bg-blue-500",
      }
  }
}

export function statusTone(s: BehavioralStatus): {
  label: string
  badge: string
  dot: string
} {
  switch (s) {
    case "pass":
      return {
        label: "Pass",
        badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
        dot: "bg-emerald-500",
      }
    case "fail":
      return {
        label: "Fail",
        badge: "bg-red-500/10 text-red-400 border-red-500/30",
        dot: "bg-red-500",
      }
    case "skip":
      return {
        label: "Skipped",
        badge:
          "bg-muted-foreground/10 text-muted-foreground border-muted-foreground/20",
        dot: "bg-muted-foreground/60",
      }
  }
}

export function formatAccuracyPct(a: number | null): string {
  if (a === null) return "—"
  return `${Math.round(a * 100)}%`
}

export function accuracyTone(a: number | null): string {
  if (a === null) return "text-muted-foreground"
  if (a >= 0.85) return "text-emerald-400"
  if (a >= 0.6) return "text-yellow-400"
  return "text-red-400"
}
