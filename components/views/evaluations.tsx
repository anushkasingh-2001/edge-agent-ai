"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Clock,
  FilePlus2,
  Gauge,
  GitBranch,
  Loader2,
  PlayCircle,
  RefreshCw,
  Trash2,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react"
import {
  clearEvalsHistory,
  fetchEvalsConfig,
  fetchEvalsHistory,
  runEvals,
  type AgentLintIssue,
  type AgentRunReport,
  type EvalConfigEntry,
  type EvalRunResponse,
  type EvalResultJson,
  type EvalTestCase,
  type EvalsConfigResponse,
  type PersistedEvalRun,
} from "@/lib/evals-client"

/**
 * Phase 3 — Evaluations view.
 *
 * Reads `.edgeagent/evals.yaml` from the open project, lists each
 * configured agent, and lets the user run them against:
 *
 *   - Working tree            — HEAD with the user's tracked-
 *                               modified + untracked files mirrored
 *                               on top. This is the headline mode:
 *                               the user is iterating on an eval
 *                               script that almost certainly isn't
 *                               committed yet, and they want THAT
 *                               script to run — not a snapshot of
 *                               HEAD that doesn't include it.
 *   - Working tree + N stashes — same, but with every `git stash`
 *                               attributed to that branch layered
 *                               on top of the mirrored working tree
 *                               (oldest → newest, latest wins on
 *                               per-file conflicts). Same model as
 *                               Branch Compare.
 *
 * Per-agent results are persisted to `.edgeagent/eval-history.jsonl`
 * so the bottom of the page can render a trend (last vs previous).
 */

interface EvaluationsProps {
  projectPath?: string
  isGitRepo?: boolean
  branches?: string[]
  remoteOnlyBranches?: string[]
  /** Currently checked-out branch — default for the "Run on" picker. */
  currentBranch?: string
  /** Per-branch stash counts (from /api/git/branches). Used to
   *  enable/disable the "Commits + stashes" toggle. */
  stashesByBranch?: Record<string, number>
}

const EXAMPLE_YAML = `agents:
  SalesAgent:
    command: "python evals/run_sales_eval.py --json"
    metrics:
      accuracy: true
      runtime_ms: true
      tool_selection: true
`

export function Evaluations({
  projectPath,
  isGitRepo = false,
  branches = [],
  remoteOnlyBranches = [],
  currentBranch = "",
  stashesByBranch = {},
}: EvaluationsProps) {
  const [config, setConfig] = useState<EvalsConfigResponse | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [history, setHistory] = useState<PersistedEvalRun[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  // Per-side scope toggle, same pattern as Branch Compare. Default
  // is "working" (HEAD + mirrored working tree) — running with
  // stashes layered changes the effective tree, so we don't want
  // to silently include them. Internally we keep the legacy values
  // ("commits" / "commits+stashes") so older history rows compare
  // cleanly; the LABELS are the only thing the user sees.
  type Scope = "commits" | "commits+stashes"
  const [scope, setScope] = useState<Scope>("commits")
  const [runBranch, setRunBranch] = useState<string>("HEAD")

  // Per-agent in-flight flag and last response (so the user sees
  // the most recent run inline with each agent card without
  // scrolling to History).
  const [runningAgent, setRunningAgent] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastRunByAgent, setLastRunByAgent] = useState<
    Record<string, AgentRunReport>
  >({})

  const branchOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { value: string; label: string; remote?: boolean }[] = []
    out.push({ value: "HEAD", label: "HEAD (currently checked out)" })
    for (const b of branches) {
      if (seen.has(b)) continue
      seen.add(b)
      out.push({ value: b, label: b })
    }
    for (const b of remoteOnlyBranches) {
      if (seen.has(b)) continue
      seen.add(b)
      out.push({ value: b, label: b, remote: true })
    }
    return out
  }, [branches, remoteOnlyBranches])

  // Resolve which branch name to use for stash-count lookups when
  // the user picks "HEAD". `currentBranch` is the parent's source
  // of truth, falls back to the first listed branch.
  const effectiveBranchName =
    runBranch === "HEAD" ? currentBranch || branches[0] || "" : runBranch
  const branchStashCount = stashesByBranch[effectiveBranchName] ?? 0
  // Auto-revert scope back to "commits" when the user picks a
  // branch with no stashes. Otherwise the request would carry a
  // no-op `includeStashes: true` that's misleading in the response.
  useEffect(() => {
    if (branchStashCount === 0 && scope === "commits+stashes") {
      setScope("commits")
    }
  }, [branchStashCount, scope])

  const reloadConfig = useCallback(async () => {
    if (!projectPath) {
      setConfig(null)
      return
    }
    setConfigLoading(true)
    setConfigError(null)
    try {
      const data = await fetchEvalsConfig(projectPath)
      setConfig(data)
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : "Failed to load config")
    } finally {
      setConfigLoading(false)
    }
  }, [projectPath])

  const reloadHistory = useCallback(async () => {
    if (!projectPath) {
      setHistory([])
      return
    }
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const data = await fetchEvalsHistory({ projectPath, limit: 50 })
      setHistory(data.runs ?? [])
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : "Failed to load history")
    } finally {
      setHistoryLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    void reloadConfig()
    void reloadHistory()
  }, [reloadConfig, reloadHistory])

  async function runOne(agentName: string) {
    if (!projectPath) return
    setRunningAgent(agentName)
    setRunError(null)
    try {
      const res: EvalRunResponse = await runEvals({
        projectPath,
        branch: runBranch,
        agents: [agentName],
        includeStashes: scope === "commits+stashes",
      })
      if (!res.ok) {
        setRunError(res.error)
        return
      }
      // Stamp the latest report into the per-agent map so the row
      // re-renders without waiting for the history reload.
      const report = res.run.reports.find((r) => r.agent === agentName)
      if (report) {
        setLastRunByAgent((prev) => ({ ...prev, [agentName]: report }))
      }
      // Refresh history so the trend below picks up the new entry.
      void reloadHistory()
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Run failed")
    } finally {
      setRunningAgent(null)
    }
  }

  async function runAll() {
    if (!projectPath || !config) return
    setRunningAgent("__all__")
    setRunError(null)
    try {
      const res: EvalRunResponse = await runEvals({
        projectPath,
        branch: runBranch,
        includeStashes: scope === "commits+stashes",
      })
      if (!res.ok) {
        setRunError(res.error)
        return
      }
      const next: Record<string, AgentRunReport> = {}
      for (const r of res.run.reports) next[r.agent] = r
      setLastRunByAgent((prev) => ({ ...prev, ...next }))
      void reloadHistory()
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Run failed")
    } finally {
      setRunningAgent(null)
    }
  }

  async function clearHistory() {
    if (!projectPath) return
    if (
      !window.confirm(
        "Clear all persisted eval history for this project? This cannot be undone."
      )
    ) {
      return
    }
    const r = await clearEvalsHistory(projectPath)
    if (!r.ok) {
      setHistoryError(r.error ?? "Failed to clear history")
      return
    }
    setHistory([])
  }

  /* --------------- Render -------------------------------------- */

  if (!projectPath) {
    return (
      <div className="p-6 space-y-6">
        <Header />
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Open a project to run evaluations.
          </CardContent>
        </Card>
      </div>
    )
  }
  if (!isGitRepo) {
    return (
      <div className="p-6 space-y-6">
        <Header />
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            The selected project is not a git repository — evaluations require a
            git repo so we can materialise a clean worktree (and optionally
            layer stashes) per run.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Evaluations</h1>
          <p className="text-muted-foreground">
            Run accuracy / runtime evals defined in{" "}
            <span className="font-mono text-xs">.edgeagent/evals.yaml</span> and
            track them across runs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={reloadConfig}
            disabled={configLoading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1 ${configLoading ? "animate-spin" : ""}`}
            />
            Reload config
          </Button>
          <Button
            onClick={runAll}
            disabled={
              runningAgent !== null ||
              !config?.exists ||
              (config?.agents.length ?? 0) === 0
            }
          >
            {runningAgent === "__all__" ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <PlayCircle className="h-4 w-4 mr-2" />
                Run all agents
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Run scope card: branch + commits/commits+stashes. */}
      <Card className="bg-card border-border">
        <CardContent className="pt-6 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-muted-foreground mb-2 block">
                Run against
              </label>
              <Select value={runBranch} onValueChange={setRunBranch}>
                <SelectTrigger className="bg-secondary/50">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    <SelectValue />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {branchOptions.map((b) => (
                    <SelectItem key={b.value} value={b.value}>
                      <span className="flex items-center gap-2">
                        {b.label}
                        {b.remote && (
                          <span className="text-[10px] text-muted-foreground">
                            remote
                          </span>
                        )}
                        {(stashesByBranch[b.value] ?? 0) > 0 && (
                          <span
                            className="text-[10px] text-blue-300 inline-flex items-center gap-0.5"
                            title={`${stashesByBranch[b.value]} stash${
                              stashesByBranch[b.value] === 1 ? "" : "es"
                            } on this branch`}
                          >
                            <Archive className="h-2.5 w-2.5" />
                            {stashesByBranch[b.value]}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm text-muted-foreground mb-2 block">
                Scope
              </label>
              <ScopeToggle
                value={scope}
                onChange={setScope}
                stashCount={branchStashCount}
                branchName={effectiveBranchName || runBranch}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            <span className="font-medium">Working tree</span> runs the eval
            against the branch HEAD with your tracked-modified and untracked
            files mirrored on top — so an as-yet-uncommitted{" "}
            <span className="font-mono">evals/run_*.py</span> actually runs.{" "}
            <span className="font-medium">Working tree + stashes</span> also
            layers every stash attributed to that branch (oldest → newest;
            latest version of each file wins) — useful for answering
            &quot;what would my accuracy look like if I committed the stashed
            WIP right now?&quot;
          </p>
        </CardContent>
      </Card>

      {runError && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{runError}</span>
        </div>
      )}

      {configError && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{configError}</span>
        </div>
      )}

      <ConfigSection
        config={config}
        configLoading={configLoading}
        runningAgent={runningAgent}
        lastRunByAgent={lastRunByAgent}
        onRun={runOne}
      />

      <HistorySection
        history={history}
        loading={historyLoading}
        error={historyError}
        onReload={reloadHistory}
        onClear={clearHistory}
      />
    </div>
  )
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Evaluations</h1>
      <p className="text-muted-foreground">
        Accuracy and runtime evaluation runner.
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Scope toggle                                                                */
/* -------------------------------------------------------------------------- */

function ScopeToggle({
  value,
  onChange,
  stashCount,
  branchName,
}: {
  value: "commits" | "commits+stashes"
  onChange: (v: "commits" | "commits+stashes") => void
  stashCount: number
  branchName: string
}) {
  const stashesAvailable = stashCount > 0
  const stashLabel =
    stashCount === 1
      ? "1 stash"
      : stashCount > 1
        ? `${stashCount} stashes`
        : "no stashes"
  const titleStashes = stashesAvailable
    ? `Layer all ${stashLabel} on '${branchName}' (oldest → newest, latest wins on per-file conflicts)`
    : `Branch '${branchName}' has no stashes — nothing to layer`
  return (
    <div
      role="radiogroup"
      aria-label="Eval run scope"
      className="inline-flex items-center rounded-md border border-border/60 bg-secondary/30 p-0.5 text-xs"
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === "commits"}
        onClick={() => onChange("commits")}
        className={`px-3 py-1 rounded-sm transition-colors inline-flex items-center gap-1 ${
          value === "commits"
            ? "bg-foreground/10 text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title={`HEAD of '${branchName}' with your tracked-modified + untracked files mirrored on top. The default — picks up uncommitted eval scripts.`}
      >
        <FilePlus2 className="h-3 w-3" />
        Working tree
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "commits+stashes"}
        onClick={() => stashesAvailable && onChange("commits+stashes")}
        disabled={!stashesAvailable}
        className={`px-3 py-1 rounded-sm transition-colors inline-flex items-center gap-1 ${
          value === "commits+stashes"
            ? "bg-blue-500/15 text-blue-300"
            : stashesAvailable
              ? "text-muted-foreground hover:text-foreground"
              : "text-muted-foreground/40 cursor-not-allowed"
        }`}
        title={
          stashesAvailable
            ? `Working tree + every stash attributed to '${branchName}' (${stashLabel}, oldest → newest, latest wins on per-file conflicts)`
            : titleStashes
        }
      >
        <Archive className="h-3 w-3" />
        Working tree + {stashLabel}
      </button>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Config section                                                              */
/* -------------------------------------------------------------------------- */

function ConfigSection({
  config,
  configLoading,
  runningAgent,
  lastRunByAgent,
  onRun,
}: {
  config: EvalsConfigResponse | null
  configLoading: boolean
  runningAgent: string | null
  lastRunByAgent: Record<string, AgentRunReport>
  onRun: (name: string) => void
}) {
  if (configLoading && !config) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading evals.yaml…
        </CardContent>
      </Card>
    )
  }
  if (!config) return null
  if (!config.exists || config.agents.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">No eval config yet</CardTitle>
          <CardDescription>
            Create a YAML file at{" "}
            <span className="font-mono">{config.configRelPath}</span> in your
            project root to start running evals. Each entry is one agent;{" "}
            <span className="font-mono">command</span> must print a single JSON
            object on stdout.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="rounded-md border border-border/60 bg-secondary/20 p-3 text-xs font-mono overflow-x-auto whitespace-pre">
{EXAMPLE_YAML}
          </pre>
          <p className="text-[11px] text-muted-foreground mt-2">
            The full path your project would use is:{" "}
            <span className="font-mono">{config.configPath}</span>
          </p>
          <ContractHint />
        </CardContent>
      </Card>
    )
  }
  if (config.errors.length > 0) {
    return (
      <Card className="bg-card border-border border-red-500/40">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-400" />
            evals.yaml has errors
          </CardTitle>
          <CardDescription>
            Fix these before the &quot;Run all agents&quot; button can fire.
            File:{" "}
            <span className="font-mono">{config.configPath}</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="text-sm text-red-400 space-y-1 font-mono pl-5 list-disc">
            {config.errors.map((e, idx) => (
              <li key={idx}>{e}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    )
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Configured agents · {config.agents.length}
        </h2>
        <p className="text-[11px] text-muted-foreground font-mono">
          {config.configRelPath}
        </p>
      </div>
      {config.agents.map((agent) => (
        <AgentCard
          key={agent.name}
          agent={agent}
          running={runningAgent === agent.name || runningAgent === "__all__"}
          disabled={runningAgent !== null}
          last={lastRunByAgent[agent.name] ?? null}
          onRun={() => onRun(agent.name)}
        />
      ))}
      <ContractHint />
    </div>
  )
}

function ContractHint() {
  return (
    <details className="text-[11px] text-muted-foreground mt-3">
      <summary className="cursor-pointer select-none">
        Output JSON contract
      </summary>
      <pre className="mt-2 rounded-md border border-border/60 bg-secondary/20 p-2 font-mono overflow-x-auto whitespace-pre">
{`{
  "agent": "SalesAgent",
  "accuracy": 0.91,
  "runtime_ms_p50": 800,
  "runtime_ms_p95": 1400,
  "tool_selection_pass_rate": 0.94,
  "tests_total": 50,
  "tests_passed": 46
}`}
      </pre>
      <p className="mt-1">
        All fields except <span className="font-mono">agent</span> are optional.
        Print exactly one JSON object on stdout (anything before it is
        ignored).
      </p>
    </details>
  )
}

function AgentCard({
  agent,
  running,
  disabled,
  last,
  onRun,
}: {
  agent: EvalConfigEntry
  running: boolean
  disabled: boolean
  last: AgentRunReport | null
  onRun: () => void
}) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Gauge className="h-4 w-4 text-purple-400" />
              {agent.name}
            </CardTitle>
            <CardDescription className="font-mono text-xs mt-1 truncate">
              {agent.command}
            </CardDescription>
            <div className="flex items-center gap-2 flex-wrap mt-2 text-[10px] text-muted-foreground">
              {agent.cwd && (
                <Badge
                  variant="outline"
                  className="border-border/60 font-mono"
                  title="Working directory the command runs in (relative to worktree root)"
                >
                  cwd: {agent.cwd}
                </Badge>
              )}
              {agent.timeoutMs && (
                <Badge variant="outline" className="border-border/60 font-mono">
                  timeout: {Math.round(agent.timeoutMs / 1000)}s
                </Badge>
              )}
              {agent.envKeys.length > 0 && (
                <Badge
                  variant="outline"
                  className="border-border/60 font-mono"
                  title="Extra env vars set for this command (values stripped from this view to avoid leaking secrets)"
                >
                  env: {agent.envKeys.join(", ")}
                </Badge>
              )}
              {agent.metrics?.accuracy && (
                <Badge variant="outline" className="border-border/60">
                  accuracy
                </Badge>
              )}
              {agent.metrics?.runtime_ms && (
                <Badge variant="outline" className="border-border/60">
                  runtime_ms
                </Badge>
              )}
              {agent.metrics?.tool_selection && (
                <Badge variant="outline" className="border-border/60">
                  tool_selection
                </Badge>
              )}
            </div>
          </div>
          <Button
            size="sm"
            onClick={onRun}
            disabled={disabled}
            variant="outline"
          >
            {running ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <PlayCircle className="h-3.5 w-3.5 mr-1.5" />
                Run
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      {(agent.lint?.length ?? 0) > 0 && (
        <CardContent className="pt-0 pb-3">
          <LintBanner issues={agent.lint} />
        </CardContent>
      )}
      {last && (
        <CardContent className="pt-0">
          <RunReportRow report={last} />
        </CardContent>
      )}
    </Card>
  )
}

/**
 * Inline warning panel rendered on each AgentCard when the
 * /api/evals/config response carried lint findings for this agent.
 * Errors get a red border, warnings yellow; both stay non-blocking
 * (the user can still hit Run — the runner does its own checks
 * and will produce a structured failure if the issue is real).
 */
function LintBanner({ issues }: { issues: AgentLintIssue[] }) {
  const hasError = issues.some((i) => i.severity === "error")
  const wrap = hasError
    ? "border-red-500/30 bg-red-500/5 text-red-200"
    : "border-amber-500/30 bg-amber-500/5 text-amber-200"
  const Icon = hasError ? AlertCircle : AlertTriangle
  return (
    <div
      className={`rounded-md border ${wrap} px-3 py-2 text-xs space-y-1.5`}
    >
      <div className="flex items-center gap-2 font-medium">
        <Icon className="h-3.5 w-3.5" />
        <span>
          {hasError
            ? "This agent will fail until the issue below is fixed"
            : "Heads up — possible config issue"}
        </span>
      </div>
      <ul className="space-y-1 pl-5 list-disc">
        {issues.map((iss, idx) => (
          <li key={idx}>
            <span className="opacity-90">{iss.message}</span>
            {iss.ref && (
              <span className="ml-1 font-mono text-[10px] opacity-70">
                ({iss.ref})
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Run report row                                                              */
/* -------------------------------------------------------------------------- */

function RunReportRow({ report }: { report: AgentRunReport }) {
  if (report.status !== "ok" || !report.result) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300 space-y-1">
        <div className="flex items-center gap-2">
          <XCircle className="h-4 w-4" />
          <span className="font-medium">{statusLabel(report.status)}</span>
          <span className="text-xs text-muted-foreground">
            · exit {report.exitCode ?? "n/a"} · {report.durationMs}ms
          </span>
        </div>
        {report.error && <div className="text-xs">{report.error}</div>}
        {report.stderrTail && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none">stderr (tail)</summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-secondary/30 p-2 font-mono whitespace-pre-wrap">
              {report.stderrTail}
            </pre>
          </details>
        )}
      </div>
    )
  }
  const r = report.result
  return (
    <div className="rounded-md border border-green-500/20 bg-green-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm text-green-300">
        <CheckCircle2 className="h-4 w-4" />
        <span className="font-medium">Run succeeded</span>
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {report.durationMs}ms
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <Metric label="Accuracy" value={fmtPct(r.accuracy)} />
        <Metric label="Tool select" value={fmtPct(r.tool_selection_pass_rate)} />
        <Metric label="p50 (ms)" value={fmtNum(r.runtime_ms_p50)} />
        <Metric label="p95 (ms)" value={fmtNum(r.runtime_ms_p95)} />
        {r.runtime_ms_p99 !== undefined && (
          <Metric label="p99 (ms)" value={fmtNum(r.runtime_ms_p99)} />
        )}
        {r.runtime_ms_max !== undefined && (
          <Metric label="max (ms)" value={fmtNum(r.runtime_ms_max)} />
        )}
        {r.tests_total !== undefined && (
          <Metric
            label="Tests"
            value={`${r.tests_passed ?? "?"} / ${r.tests_total}`}
          />
        )}
      </div>
      {r.notes && (
        <p className="text-xs text-muted-foreground italic">{r.notes}</p>
      )}
      <TestDetailsPanel result={r} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Per-test drill-down                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Collapsible "View N test details" panel rendered under the metrics
 * grid whenever the eval result includes a non-empty `tests:` array.
 *
 * Behaviour:
 *   - Hidden entirely when the eval didn't emit `tests` (back-compat
 *     with old aggregate-only stubs).
 *   - When `tests_total` is set but `tests` is empty, shows a hint
 *     telling the user how to populate the array — most users don't
 *     know they CAN until they see the affordance.
 *   - "All / Failed only" filter; default is "All" so the user sees
 *     the full distribution. Switches to "Failed only" automatically
 *     when the user toggles, and persists per-mount via local state.
 *   - Each row is its own `<details>` so opening one doesn't push
 *     siblings around. Top-level chevron is also `<details>` so
 *     keyboard nav (space/enter) works for free.
 */
function TestDetailsPanel({ result }: { result: EvalResultJson }) {
  const tests = result.tests ?? []
  const total = tests.length
  if (total === 0) {
    // Tell the user how to opt in if they reported aggregates but
    // no per-test rows. Easy to miss in the schema docs.
    if (result.tests_total && result.tests_total > 0) {
      return (
        <div className="text-[11px] text-muted-foreground italic">
          Tip: emit a <span className="font-mono">{`"tests": [...]`}</span> array
          in this agent&apos;s JSON output to see per-test pass/fail and
          input/expected/actual here.
        </div>
      )
    }
    return null
  }
  return <TestDetailsPanelInner tests={tests} />
}

type TestFilter = "all" | "failed"

function TestDetailsPanelInner({ tests }: { tests: EvalTestCase[] }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<TestFilter>("all")
  const counts = useMemo(() => {
    let pass = 0
    let fail = 0
    let skip = 0
    let err = 0
    for (const t of tests) {
      if (t.status === "pass") pass++
      else if (t.status === "fail") fail++
      else if (t.status === "skip") skip++
      else err++
    }
    return { pass, fail, skip, err }
  }, [tests])
  const visible = useMemo(() => {
    if (filter === "all") return tests
    return tests.filter(
      (t) => t.status === "fail" || t.status === "error"
    )
  }, [tests, filter])

  return (
    <div className="rounded-md border border-border/60 bg-secondary/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-secondary/20"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <ChevronRight
            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
          <span className="font-medium text-foreground">
            {open ? "Hide" : "View"} {tests.length} test
            {tests.length === 1 ? "" : "s"} detail
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="text-green-300">{counts.pass} pass</span>
          {counts.fail > 0 && (
            <span className="text-red-300">· {counts.fail} fail</span>
          )}
          {counts.err > 0 && (
            <span className="text-red-400">· {counts.err} error</span>
          )}
          {counts.skip > 0 && (
            <span className="text-muted-foreground">· {counts.skip} skip</span>
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/60 p-2 space-y-1.5">
          {/* Filter toggle. Disabled when there are no failures so
            * the button can't trick the user into an empty list. */}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
            <div
              role="radiogroup"
              aria-label="Test filter"
              className="inline-flex items-center rounded-md border border-border/60 bg-secondary/30 p-0.5"
            >
              <button
                type="button"
                role="radio"
                aria-checked={filter === "all"}
                onClick={() => setFilter("all")}
                className={`px-2 py-0.5 rounded-sm transition-colors ${
                  filter === "all"
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                All ({tests.length})
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={filter === "failed"}
                onClick={() =>
                  (counts.fail + counts.err > 0) && setFilter("failed")
                }
                disabled={counts.fail + counts.err === 0}
                className={`px-2 py-0.5 rounded-sm transition-colors ${
                  filter === "failed"
                    ? "bg-red-500/15 text-red-300"
                    : counts.fail + counts.err > 0
                      ? "text-muted-foreground hover:text-foreground"
                      : "text-muted-foreground/40 cursor-not-allowed"
                }`}
              >
                Failed only ({counts.fail + counts.err})
              </button>
            </div>
            <span>{visible.length} shown</span>
          </div>
          {visible.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-muted-foreground italic">
              No tests match the current filter.
            </p>
          ) : (
            <div className="space-y-1">
              {visible.map((t, idx) => (
                <TestRow key={t.id ?? `${idx}`} test={t} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TestRow({ test }: { test: EvalTestCase }) {
  const dot =
    test.status === "pass"
      ? "bg-green-400"
      : test.status === "fail" || test.status === "error"
        ? "bg-red-400"
        : "bg-muted-foreground/40"
  const statusLabel =
    test.status === "pass"
      ? "pass"
      : test.status === "fail"
        ? "fail"
        : test.status === "error"
          ? "error"
          : "skip"
  // Show the expand chevron when there's something to drill into.
  // Aggregates-only rows (just status + name) collapse to a one-liner.
  const hasDetail = Boolean(
    test.input || test.expected || test.actual || test.error
  )
  return (
    <details
      className="group rounded border border-border/40 bg-card/40 open:bg-secondary/15"
    >
      <summary
        className={`flex items-center gap-2 px-2 py-1.5 text-[11px] ${
          hasDetail
            ? "cursor-pointer select-none hover:bg-secondary/20"
            : "cursor-default list-none [&::-webkit-details-marker]:hidden"
        }`}
      >
        {hasDetail && (
          <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" />
        )}
        {!hasDetail && <span className="w-3 shrink-0" aria-hidden />}
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="font-medium text-foreground truncate flex-1 min-w-0">
          {test.name ?? test.id ?? "(unnamed test)"}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
          {statusLabel}
        </span>
        {typeof test.runtime_ms === "number" && test.runtime_ms > 0 && (
          <span className="text-[10px] text-muted-foreground shrink-0 inline-flex items-center gap-0.5">
            <Clock className="h-2.5 w-2.5" />
            {test.runtime_ms}ms
          </span>
        )}
        {test.tags && test.tags.length > 0 && (
          <span className="hidden md:inline text-[9px] font-mono text-muted-foreground shrink-0 truncate max-w-[40%]">
            {test.tags.join(" · ")}
          </span>
        )}
      </summary>
      {hasDetail && (
        <div className="border-t border-border/40 px-2 py-2 space-y-1.5 text-[11px]">
          {test.input && <Field label="Input" value={test.input} />}
          {test.expected && <Field label="Expected" value={test.expected} />}
          {test.actual && (
            <Field
              label="Actual"
              value={test.actual}
              tone={test.status === "pass" ? "ok" : "bad"}
            />
          )}
          {test.error && (
            <Field label="Error" value={test.error} tone="bad" />
          )}
        </div>
      )}
    </details>
  )
}

function Field({
  label,
  value,
  tone = "neutral",
}: {
  label: string
  value: string
  tone?: "ok" | "bad" | "neutral"
}) {
  const wrap =
    tone === "bad"
      ? "border-red-500/30 bg-red-500/5 text-red-200"
      : tone === "ok"
        ? "border-green-500/30 bg-green-500/5 text-green-200"
        : "border-border/40 bg-secondary/20 text-foreground"
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-0.5">
        {label}
      </div>
      <pre
        className={`rounded border px-2 py-1 font-mono text-[11px] whitespace-pre-wrap break-words max-h-48 overflow-auto ${wrap}`}
      >
        {value}
      </pre>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/60 bg-secondary/20 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
    </div>
  )
}

function statusLabel(s: AgentRunReport["status"]): string {
  switch (s) {
    case "ok":
      return "Run succeeded"
    case "non_zero_exit":
      return "Eval command exited non-zero"
    case "spawn_failed":
      return "Failed to spawn eval command"
    case "timeout":
      return "Eval command timed out"
    case "bad_json":
      return "Could not parse JSON output"
    case "bad_shape":
      return "Output JSON didn't match the expected shape"
    case "script_not_found":
      return "Eval script not found"
    case "binary_not_found":
      return "Eval binary not found on PATH"
    default:
      return s
  }
}

function fmtPct(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "—"
  return `${(n * 100).toFixed(1)}%`
}
function fmtNum(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "—"
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/* -------------------------------------------------------------------------- */
/* History                                                                     */
/* -------------------------------------------------------------------------- */

function HistorySection({
  history,
  loading,
  error,
  onReload,
  onClear,
}: {
  history: PersistedEvalRun[]
  loading: boolean
  error: string | null
  onReload: () => void
  onClear: () => void
}) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base">Run history</CardTitle>
            <CardDescription>
              Persisted to{" "}
              <span className="font-mono">.edgeagent/eval-history.jsonl</span>{" "}
              · newest first.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onReload}
              disabled={loading}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
            {history.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={onClear}
                title="Wipe persisted eval history (cannot be undone)"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Clear
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400 mb-3">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {history.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No runs yet. Hit &quot;Run all agents&quot; or run an individual
            agent above to populate this list.
          </p>
        ) : (
          <ScrollArea className="max-h-[60vh] pr-2">
            <div className="space-y-3">
              {history.map((run, idx) => (
                <RunCard
                  key={run.id}
                  run={run}
                  previous={previousMatchingRun(history, idx)}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Find the first OLDER run (higher index, since `history` is
 * newest-first) that targeted the same branch with the same scope
 * flags. Used as the baseline for delta arrows so a "main / working
 * tree" run is never compared against a "main / pristine HEAD" run
 * (and likewise for stash inclusion).
 *
 * Legacy entries written before `includeWorkingTree` existed are
 * normalised to `true` — pre-mirror runs technically scored
 * pristine HEAD, but those rows are months stale by now and forcing
 * a baseline mismatch on every modern run would silently kill all
 * delta arrows.
 */
function previousMatchingRun(
  history: PersistedEvalRun[],
  idx: number
): PersistedEvalRun | null {
  const cur = history[idx]
  const curMirror = cur.includeWorkingTree !== false
  for (let i = idx + 1; i < history.length; i++) {
    const prev = history[i]
    const prevMirror = prev.includeWorkingTree !== false
    if (
      prev.branch === cur.branch &&
      prev.includeStashes === cur.includeStashes &&
      prevMirror === curMirror
    ) {
      return prev
    }
  }
  return null
}

function RunCard({
  run,
  previous,
}: {
  run: PersistedEvalRun
  previous: PersistedEvalRun | null
}) {
  const [open, setOpen] = useState(false)
  const okCount = run.reports.filter((r) => r.status === "ok").length
  const errCount = run.reports.length - okCount
  const ranAt = new Date(run.ranAt)
  // Legacy entries (pre-mirror) won't carry these fields — treat
  // them as "no mirror" so the badge doesn't appear out of nothing.
  const mirroredFiles = run.mirroredFiles ?? []
  const mirroredCount = mirroredFiles.length
  // `includeWorkingTree` is optional on the wire; explicit `false`
  // means the user opted into "pristine HEAD only", which is rare
  // enough that we want to surface it as its own badge.
  const pristineMode = run.includeWorkingTree === false
  return (
    <div className="rounded-lg border border-border bg-secondary/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-secondary/20"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant="outline"
              className="border-border/60 font-mono text-[10px]"
            >
              <GitBranch className="h-2.5 w-2.5 mr-1" />
              {run.branch}
              {run.sha && (
                <span className="ml-1 text-muted-foreground">
                  @{run.sha.slice(0, 7)}
                </span>
              )}
            </Badge>
            {pristineMode ? (
              <Badge
                variant="outline"
                className="border-border/60 text-muted-foreground text-[10px]"
                title="This run scored pristine HEAD only — the user's working tree was NOT mirrored in"
              >
                pristine HEAD
              </Badge>
            ) : (
              mirroredCount > 0 && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 text-amber-300 text-[10px]"
                  title={`${mirroredCount} file${
                    mirroredCount === 1 ? "" : "s"
                  } mirrored from your working tree:\n${mirroredFiles
                    .slice(0, 30)
                    .join("\n")}${
                    mirroredFiles.length > 30
                      ? `\n…and ${mirroredFiles.length - 30} more`
                      : ""
                  }`}
                >
                  <FilePlus2 className="h-2.5 w-2.5 mr-1" />+{mirroredCount} working tree
                </Badge>
              )
            )}
            {run.includeStashes && (
              <Badge
                variant="outline"
                className="border-blue-500/40 text-blue-300 text-[10px]"
                title={
                  run.appliedStashes.length > 0
                    ? `Stashes layered: ${run.appliedStashes
                        .map((s) => s.ref)
                        .join(", ")}`
                    : "Run requested stash inclusion but the branch had none"
                }
              >
                <Archive className="h-2.5 w-2.5 mr-1" />+{run.appliedStashes.length} stash
                {run.appliedStashes.length === 1 ? "" : "es"}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {ranAt.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">
              · {okCount} ok
              {errCount > 0 && (
                <span className="text-red-400"> · {errCount} failed</span>
              )}
            </span>
          </div>
          {/* One-line top metrics for the first OK report so the user
            * can scan trends without expanding every row. */}
          <TopLineMetrics
            reports={run.reports}
            previousReports={previous?.reports}
          />
        </div>
        <ChevronRight
          className={`h-4 w-4 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      {open && (
        <div className="border-t border-border/60 p-3 space-y-3">
          {mirroredCount > 0 && (
            <details className="text-[11px] text-amber-300">
              <summary className="cursor-pointer select-none">
                <FilePlus2 className="inline h-3 w-3 mr-1" />
                {mirroredCount} file{mirroredCount === 1 ? "" : "s"} mirrored
                from your working tree
              </summary>
              <ul className="list-disc pl-4 space-y-0.5 font-mono mt-1 max-h-40 overflow-auto">
                {mirroredFiles.slice(0, 200).map((f) => (
                  <li key={f}>{f}</li>
                ))}
                {mirroredFiles.length > 200 && (
                  <li className="text-muted-foreground italic">
                    …and {mirroredFiles.length - 200} more
                  </li>
                )}
              </ul>
            </details>
          )}
          {run.skippedStashes.length > 0 && (
            <div className="text-[11px] text-red-300">
              <div className="font-medium mb-1">
                Skipped {run.skippedStashes.length} stash
                {run.skippedStashes.length === 1 ? "" : "es"} (apply conflict):
              </div>
              <ul className="list-disc pl-4 space-y-0.5 font-mono">
                {run.skippedStashes.map((s) => (
                  <li key={s.ref} title={s.reason}>
                    {s.ref} — {s.subject}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-2">
            {run.reports.map((r) => (
              <div key={r.agent}>
                <div className="text-xs font-semibold text-muted-foreground mb-1">
                  {r.agent}
                </div>
                <RunReportRow report={r} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * One-line summary of accuracy / runtime / tool-selection averaged
 * across every OK agent in the run, with delta arrows when a prior
 * matching run exists.
 */
function TopLineMetrics({
  reports,
  previousReports,
}: {
  reports: AgentRunReport[]
  previousReports?: AgentRunReport[]
}) {
  const cur = aggregateMetrics(reports)
  const prev = previousReports ? aggregateMetrics(previousReports) : null
  if (
    cur.accuracy == null &&
    cur.runtime_p95 == null &&
    cur.tool == null
  ) {
    return null
  }
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <DeltaCell
        label="acc"
        cur={cur.accuracy}
        prev={prev?.accuracy ?? null}
        format={fmtPct}
        higherIsBetter
      />
      <DeltaCell
        label="tool"
        cur={cur.tool}
        prev={prev?.tool ?? null}
        format={fmtPct}
        higherIsBetter
      />
      <DeltaCell
        label="p95"
        cur={cur.runtime_p95}
        prev={prev?.runtime_p95 ?? null}
        format={fmtNum}
        higherIsBetter={false}
      />
    </div>
  )
}

function aggregateMetrics(reports: AgentRunReport[]): {
  accuracy: number | null
  tool: number | null
  runtime_p95: number | null
} {
  const ok = reports.filter((r) => r.status === "ok" && r.result)
  if (ok.length === 0) return { accuracy: null, tool: null, runtime_p95: null }
  function avg(pick: (r: AgentRunReport) => number | undefined): number | null {
    const vals = ok
      .map(pick)
      .filter((v): v is number => typeof v === "number" && !Number.isNaN(v))
    if (vals.length === 0) return null
    return vals.reduce((a, b) => a + b, 0) / vals.length
  }
  return {
    accuracy: avg((r) => r.result?.accuracy),
    tool: avg((r) => r.result?.tool_selection_pass_rate),
    runtime_p95: avg((r) => r.result?.runtime_ms_p95),
  }
}

function DeltaCell({
  label,
  cur,
  prev,
  format,
  higherIsBetter,
}: {
  label: string
  cur: number | null
  prev: number | null
  format: (v: number | undefined) => string
  higherIsBetter: boolean
}) {
  if (cur == null) return null
  const delta = prev == null ? null : cur - prev
  const isImprovement =
    delta == null
      ? false
      : higherIsBetter
        ? delta > 0
        : delta < 0
  const isRegression =
    delta == null
      ? false
      : higherIsBetter
        ? delta < 0
        : delta > 0
  const color = isImprovement
    ? "text-green-400"
    : isRegression
      ? "text-red-400"
      : "text-muted-foreground"
  const Icon = isImprovement
    ? TrendingUp
    : isRegression
      ? TrendingDown
      : null
  return (
    <span className="inline-flex items-center gap-1">
      <span className="uppercase tracking-wide text-[10px]">{label}</span>
      <span className="font-medium text-foreground">{format(cur)}</span>
      {delta != null && Icon && (
        <span className={`inline-flex items-center gap-0.5 ${color}`}>
          <Icon className="h-3 w-3" />
          {format(Math.abs(delta))}
        </span>
      )}
    </span>
  )
}
