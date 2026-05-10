"use client"

/**
 * PolicyStatusCard renders the result of `evaluatePolicy(...)` in a
 * compact card that's reused across:
 *   - Overview (full variant, after each scan)
 *   - Branch Compare (full variant, after deep compare)
 *   - Commit / Push dialogs (compact variant, inline above the action
 *     buttons)
 *
 * It is a pure render component: callers pass in either a
 * `PolicyApiResponse` (preferred — gives source/errors metadata) or
 * just an evaluation. Loading and error states are first-class so
 * dialogs can show "Evaluating policy…" while a scan is running.
 */

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileWarning,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import {
  decisionBadgeClass,
  decisionLabel,
  type Decision,
  type Policy,
  type PolicyEvaluation,
} from "@/lib/policy"
import type { PolicyApiResponse } from "@/lib/policy-client"

interface PolicyStatusCardProps {
  /** Full server response when available — preferred so we can show
   * `policySource` and any parse errors. */
  response?: PolicyApiResponse | null
  /** When you only have an evaluation (e.g. mid-flight on the client),
   * pass this directly. `response` wins if both are supplied. */
  evaluation?: PolicyEvaluation | null
  policy?: Policy | null
  loading?: boolean
  error?: string | null
  /** Smaller variant for dialogs. */
  compact?: boolean
  /** Optional title override for the card header. */
  title?: string
}

function decisionIcon(d: Decision) {
  switch (d) {
    case "pass":
      return <ShieldCheck className="h-4 w-4 text-green-400" />
    case "warn":
      return <AlertTriangle className="h-4 w-4 text-yellow-400" />
    case "block":
      return <ShieldAlert className="h-4 w-4 text-red-400" />
    case "auto_merge_allowed":
      return <CheckCircle2 className="h-4 w-4 text-blue-400" />
  }
}

function deltaCell(label: string, n: number | null, invertSign = false) {
  if (n == null) return null
  const goodWhenNegative = !invertSign
  const isImprovement = goodWhenNegative ? n < 0 : n > 0
  const isRegression = goodWhenNegative ? n > 0 : n < 0
  const cls = isRegression
    ? "text-red-400"
    : isImprovement
      ? "text-green-400"
      : "text-muted-foreground"
  const sign = n > 0 ? "+" : ""
  return (
    <span className={`text-xs font-mono ${cls}`}>
      {label} {sign}
      {n}
    </span>
  )
}

export function PolicyStatusCard({
  response,
  evaluation: rawEvaluation,
  policy: rawPolicy,
  loading = false,
  error = null,
  compact = false,
  title,
}: PolicyStatusCardProps) {
  const [showWhy, setShowWhy] = useState(false)
  const [showErrors, setShowErrors] = useState(false)

  const evaluation = response?.evaluation ?? rawEvaluation ?? null
  const policy = response?.policy ?? rawPolicy ?? null
  const policySource = response?.policySource ?? null
  const policyErrors = response?.policyErrors ?? []
  const policyPath = response?.policyPath ?? null

  /* ------------------------------- Loading ------------------------------- */

  if (loading) {
    return (
      <Card className={compact ? "bg-secondary/20 border-border" : "bg-card border-border"}>
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full bg-yellow-400 animate-pulse" />
            Evaluating policy…
          </div>
        </CardContent>
      </Card>
    )
  }

  /* ------------------------------- Error -------------------------------- */

  if (error) {
    return (
      <Card className="bg-card border-border">
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-center gap-2 text-sm text-red-400">
            <XCircle className="h-4 w-4" />
            Policy evaluation failed: {error}
          </div>
        </CardContent>
      </Card>
    )
  }

  /* ------------------------------- Empty -------------------------------- */

  if (!evaluation) {
    return (
      <Card className="bg-card border-border">
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <FileWarning className="h-4 w-4" />
              {policy
                ? policySource === "file"
                  ? `Policy loaded from ${policyPath ?? ".edgeagent/policy.yaml"} — run a scan to evaluate.`
                  : "Using default policy — run a scan to evaluate."
                : "No policy evaluated yet."}
            </div>
            {policy?.mode && (
              <Badge variant="outline" className="text-[10px]">
                mode: {policy.mode}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  /* ------------------------------ Populated ----------------------------- */

  const { decision, reasons, failedConditions, passedConditions, deltas } =
    evaluation
  const isBlock = decision === "block"
  const isWarn = decision === "warn"
  const isAuto = decision === "auto_merge_allowed"

  return (
    <Card className="bg-card border-border">
      <CardHeader className={compact ? "p-3 pb-1" : "pb-2"}>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <div className="flex items-center gap-2">
            {decisionIcon(decision)}
            <span>{title ?? decisionLabel(decision)}</span>
            {(isWarn || isBlock || isAuto) && (
              <Badge
                variant="outline"
                className={`text-[10px] ${decisionBadgeClass(decision)}`}
              >
                {failedConditions.length > 0
                  ? `${failedConditions.length} ${
                      failedConditions.length === 1 ? "issue" : "issues"
                    }`
                  : isAuto
                    ? "all gates passed"
                    : "ok"}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {policy?.mode && (
              <Badge variant="outline" className="text-[10px]">
                mode: {policy.mode}
              </Badge>
            )}
            {policySource && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {policySource === "file" ? ".edgeagent/policy.yaml" : "default"}
              </Badge>
            )}
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className={compact ? "p-3 pt-0 space-y-2" : "space-y-3"}>
        {/* Headline reasons (top 3) */}
        {reasons.length > 0 && (
          <ul className="text-xs space-y-1">
            {reasons.slice(0, 3).map((r, i) => (
              <li
                key={i}
                className={`flex gap-2 ${
                  isBlock ? "text-red-300" : isWarn ? "text-yellow-300" : "text-muted-foreground"
                }`}
              >
                <span className="mt-0.5">•</span>
                <span>{r}</span>
              </li>
            ))}
            {reasons.length > 3 && !showWhy && (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => setShowWhy(true)}
                >
                  <ChevronRight className="h-3 w-3 mr-1" />
                  Show {reasons.length - 3} more
                </Button>
              </li>
            )}
            {showWhy &&
              reasons.slice(3).map((r, i) => (
                <li
                  key={`more-${i}`}
                  className="flex gap-2 text-muted-foreground"
                >
                  <span className="mt-0.5">•</span>
                  <span>{r}</span>
                </li>
              ))}
          </ul>
        )}

        {/* Delta strip */}
        {(deltas.risk != null ||
          deltas.critical != null ||
          deltas.high != null) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {deltaCell("risk", deltas.risk)}
            {deltaCell("critical", deltas.critical)}
            {deltaCell("high", deltas.high)}
            {deltaCell("medium", deltas.medium)}
            {deltaCell("low", deltas.low)}
          </div>
        )}

        {/* Per-agent deltas */}
        {Object.keys(deltas.perAgent).length > 0 && !compact && (
          <div className="rounded-md border border-border bg-secondary/10 p-2">
            <div className="text-[11px] font-medium text-muted-foreground mb-1">
              Per-agent metric deltas
            </div>
            <div className="space-y-1">
              {Object.entries(deltas.perAgent).map(([agent, d]) => (
                <div
                  key={agent}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]"
                >
                  <span className="font-mono">{agent}</span>
                  {deltaCell("acc", d.accuracy != null ? +(d.accuracy * 100).toFixed(2) : null)}
                  {deltaCell("rt(ms)", d.runtime_ms, /* invert */ true)}
                  {deltaCell(
                    "tool",
                    d.tool_selection_pass_rate != null
                      ? +(d.tool_selection_pass_rate * 100).toFixed(2)
                      : null
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Passed conditions roll-up */}
        {!compact && passedConditions.length > 0 && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none flex items-center gap-1">
              <ChevronDown className="h-3 w-3" />
              {passedConditions.length} condition
              {passedConditions.length === 1 ? "" : "s"} passed
            </summary>
            <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono">
              {passedConditions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        )}

        {/* Inapplicable conditions roll-up */}
        {!compact && evaluation.inapplicableConditions.length > 0 && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none flex items-center gap-1">
              <ChevronDown className="h-3 w-3" />
              {evaluation.inapplicableConditions.length} condition
              {evaluation.inapplicableConditions.length === 1 ? "" : "s"} skipped
              (no base / no metrics)
            </summary>
            <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono">
              {evaluation.inapplicableConditions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        )}

        {/* Policy file parse errors */}
        {policyErrors.length > 0 && (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-[11px] text-yellow-300">
            <button
              type="button"
              className="flex items-center gap-1 font-medium"
              onClick={() => setShowErrors((v) => !v)}
            >
              {showErrors ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {policyErrors.length} policy.yaml warning
              {policyErrors.length === 1 ? "" : "s"}
            </button>
            {showErrors && (
              <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono">
                {policyErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
