"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { OverviewAgentCard } from "@/lib/scan-report"
import { loadSavedSuites, type TestSuite } from "@/lib/test-cases"
import { SECURITY_CHECKS } from "@/lib/security-checks"
import { SCANNER_RULE_IDS } from "@/lib/scan-report"
import type { PolicyApiResponse } from "@/lib/policy-client"
import type { Project } from "@/lib/projects"
import { PolicyStatusCard } from "@/components/policy-status-card"
import { PrGateStatusCard, CreatePrDialog } from "@/components/git-pr-dialog"
import {
  AlertTriangle,
  Shield,
  Clock,
  CheckCircle2,
  XCircle,
  Play,
  TrendingUp,
  GitBranch,
  FileCode,
  Bot,
  Download,
  Upload,
  ArrowUpFromLine,
  TestTube,
} from "lucide-react"

const recentScans: { id: number; branch: string; status: string; issues: number; time: string }[] = []

function getRiskLevel(score: number): { label: string; color: string; badgeColor: string } {
  if (score >= 86) return { label: "Critical", color: "text-red-400", badgeColor: "border-red-500/50 text-red-400 bg-red-500/10" }
  if (score >= 61) return { label: "High", color: "text-orange-400", badgeColor: "border-orange-500/50 text-orange-400 bg-orange-500/10" }
  if (score >= 31) return { label: "Medium", color: "text-yellow-400", badgeColor: "border-yellow-500/50 text-yellow-400 bg-yellow-500/10" }
  return { label: "Low", color: "text-green-400", badgeColor: "border-green-500/50 text-green-400 bg-green-500/10" }
}

interface OverviewProps {
  onNavigate: (view: string) => void
  riskScore: number
  currentBranch: string
  projectLabel?: string
  /** Used to scope user-defined test suites to the active project. */
  projectId?: string
  scanSummary: { critical: number; high: number; medium: number; low: number; total: number } | null
  topFindings: { title: string; severity: string; file: string; line: number }[]
  detectedAgents: OverviewAgentCard[]
  lastScanLabel: string
  hasProject?: boolean
  hasScan?: boolean
  /** The user-defined suite queued for the next scan (lifted from Scan
   * Center). Drives the "User-Defined Tests" tile so it reflects what's
   * actually active rather than summing every saved suite. */
  activeSuite?: TestSuite | null
  /** Distinct scanner rule_ids that produced at least one finding in the
   * latest scan. Used to compute "X / Y tests passed" in the Tests tile so
   * the count refreshes with every scan. */
  failedRuleIds?: string[]
  /** Latest evaluation of `.edgeagent/policy.yaml` against this scan.
   * Lives at the page level so the same evaluation is reused by the
   * Branch Compare and commit/push dialogs. */
  policyResponse?: PolicyApiResponse | null
  policyLoading?: boolean
  /** Force a fresh scan of the policy's base branch (default `main`)
   * and re-evaluate. Surfaced as the "Re-scan main" button on the
   * policy card; lets the user recover from a stale baseline without
   * restarting the dev server. */
  onRefreshPolicyBaseline?: () => void
  /** Selected project path — required for the PR Gate card to fetch
   * GitHub PR status. Optional so old call sites still compile. */
  projectPath?: string | null
  /** Full selected project — passed into PolicyStatusCard so the
   *  Export Policy Report button can look up the latest result. */
  project?: Project | null
  /** ISO timestamp of when the latest scan + policy evaluation
   * completed. Drives the "Last gate run" stat. */
  lastGateRunAt?: string | null
  /** All branches in the repo. Forwarded to CreatePrDialog so users
   * can pick the head branch directly without bouncing through the
   * top-bar branch picker. */
  branches?: string[]
  /** Subset of `branches` that exist only on the remote. Forwarded to
   *  CreatePrDialog so the Head picker can disable them (you can't
   *  push a ref that isn't local). */
  remoteOnlyBranches?: string[]
}

export function Overview({
  onNavigate,
  riskScore,
  currentBranch,
  projectLabel = "No project opened",
  projectId,
  scanSummary,
  topFindings,
  detectedAgents,
  lastScanLabel,
  hasProject = false,
  hasScan = false,
  activeSuite = null,
  failedRuleIds = [],
  policyResponse = null,
  policyLoading = false,
  onRefreshPolicyBaseline,
  projectPath = null,
  project = null,
  lastGateRunAt = null,
  branches = [],
  remoteOnlyBranches = [],
}: OverviewProps) {
  // Local "Create PR" dialog so the Overview's PR card button can open
  // the same flow without bouncing the user up to the top bar.
  const [createPrOpen, setCreatePrOpen] = useState(false)
  const riskInfo = getRiskLevel(riskScore)
  const criticalIssues = scanSummary?.critical ?? 0
  const sev = scanSummary ?? { critical: 0, high: 0, medium: 0, low: 0, total: 0 }

  // Pull user-defined suites from localStorage for the active project. We
  // re-read on every mount + when the project changes so navigating into
  // Overview after defining/saving a suite reflects the latest count.
  // Replaces the previous hard-coded "42/48 Tests Passing" card — there's
  // no test runner wired yet, so faking a pass rate misled users.
  const [userSuites, setUserSuites] = useState<TestSuite[]>([])
  useEffect(() => {
    const all = loadSavedSuites()
    setUserSuites(
      projectId ? all.filter((s) => !s.projectId || s.projectId === projectId) : all
    )
    // activeSuite changing usually means the user just saved/picked a new
    // suite — re-read so the count stays in sync.
  }, [projectId, hasScan, activeSuite])
  const userTestCount = userSuites.reduce((sum, s) => sum + s.tests.length, 0)

  // Each built-in security check that has scanner backing is a "test that
  // ran" in the latest scan. SCANNER_RULE_IDS lists the ones the Python
  // engine actually executes today — the remaining UI checks are stubs and
  // shouldn't be counted in pass/fail until they're wired up. User-defined
  // tests don't have a runner yet either, so they're excluded from
  // pass/fail and surfaced separately in the subtitle.
  const ranTestCount = SCANNER_RULE_IDS.length
  const failedSet = new Set(failedRuleIds)
  const failedRanCount = SCANNER_RULE_IDS.reduce(
    (n, id) => n + (failedSet.has(id) ? 1 : 0),
    0
  )
  const passedRanCount = ranTestCount - failedRanCount
  const stubbedCheckCount = SECURITY_CHECKS.length - SCANNER_RULE_IDS.length

  if (!hasProject) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Overview</h1>
            <p className="text-muted-foreground">Security status</p>
          </div>
        </div>
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center space-y-3">
            <p className="text-base font-medium">No project opened</p>
            <p className="text-sm text-muted-foreground">
              Open a local repo or clone from GitHub to start scanning.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!hasScan) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Overview</h1>
            <p className="text-muted-foreground">Security status for {projectLabel}</p>
          </div>
          <Button onClick={() => onNavigate("scan-center")}>
            <Play className="h-4 w-4 mr-2" />
            Run Scan
          </Button>
        </div>
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center space-y-3">
            <p className="text-base font-medium">No scan results yet</p>
            <p className="text-sm text-muted-foreground">
              Run a scan from the Scan Center to populate findings, risk score, and detected agents.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-muted-foreground">Security status for {projectLabel}</p>
        </div>
        <Button onClick={() => onNavigate("scan-center")}>
          <Play className="h-4 w-4 mr-2" />
          Run Scan
        </Button>
      </div>

      {/* Policy status — surfaces .edgeagent/policy.yaml decision against
          the latest scan. Empty state explains "no policy file" without
          shouting; populated state shows pass/warn/block + reasons. */}
      <PolicyStatusCard
        response={policyResponse}
        loading={policyLoading}
        onRefreshBaseline={onRefreshPolicyBaseline}
        refreshing={policyLoading}
        project={project}
        onEditPolicy={() => {
          if (typeof window !== "undefined") {
            window.location.hash = "policy-rules"
          }
          onNavigate("settings")
        }}
      />

      {/* PR Gate Status — current branch / base / PR / last gate run,
          plus a Create PR shortcut. Hidden until we know enough to
          render anything useful (project + branch). */}
      {projectPath && currentBranch && (
        <PrGateStatusCard
          projectPath={projectPath}
          headBranch={currentBranch}
          policy={policyResponse}
          decision={policyResponse?.evaluation?.decision ?? null}
          lastGateRunAt={lastGateRunAt}
          onCreatePr={() => setCreatePrOpen(true)}
        />
      )}
      {/* Mounted unconditionally so the dialog can render its own
          hard-block panel ("No project is open", etc.) instead of
          silently no-op'ing when the gate card's button is clicked
          before the project finishes loading. */}
      <CreatePrDialog
        open={createPrOpen}
        onOpenChange={setCreatePrOpen}
        projectPath={projectPath || null}
        headBranch={currentBranch || null}
        branches={branches}
        remoteOnlyBranches={remoteOnlyBranches}
      />

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Risk Score
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className={`text-3xl font-bold ${riskInfo.color}`}>{riskScore}</span>
              <span className="text-muted-foreground">/100</span>
              <span className={`text-sm ${riskInfo.color}`}>{riskInfo.label}</span>
            </div>
            {scanSummary && scanSummary.total > 0 ? (
              <div className="flex items-center gap-1 mt-1 text-sm text-muted-foreground">
                <TrendingUp className="h-3 w-3" />
                <span>{scanSummary.total} open findings</span>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground mt-2">
              0-30 Low | 31-60 Medium | 61-85 High | 86-100 Critical
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Critical Issues
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-red-400">{criticalIssues}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <TestTube className="h-4 w-4" />
              Tests
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* "X / Y" reads as "X passed out of Y that ran in this scan".
             * Refreshes every scan because failedRuleIds is derived from
             * the latest scanReport. We deliberately don't lump in
             * stubbed checks or user-defined tests — those didn't run, so
             * counting them as "passed" would be a lie. They're called out
             * in the subtitle instead. */}
            <div className="flex items-baseline gap-2">
              <span
                className={`text-3xl font-bold ${
                  failedRanCount === 0 ? "text-green-400" : "text-orange-400"
                }`}
              >
                {passedRanCount}
              </span>
              <span className="text-muted-foreground">/ {ranTestCount}</span>
              <span className="text-sm text-muted-foreground">passed</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {failedRanCount > 0
                ? `${failedRanCount} failing · `
                : ""}
              {stubbedCheckCount > 0
                ? `${stubbedCheckCount} stubbed`
                : "all wired"}
              {userTestCount > 0
                ? ` · ${userTestCount} user-defined (no runner)`
                : ""}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Last Scan
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-semibold">{lastScanLabel}</span>
            </div>
            <div className="text-sm text-muted-foreground mt-1">Branch: {currentBranch}</div>
          </CardContent>
        </Card>
      </div>

      {/* Detected Agents */}
      <Card className="bg-card border-border">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Detected Agents</CardTitle>
            <CardDescription>Per-agent risk scores and status</CardDescription>
          </div>
          <Badge variant="outline" className="text-xs">
            {detectedAgents.length} agents
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-5 gap-3">
            {detectedAgents.map((agent) => {
              const agentRisk = getRiskLevel(agent.risk)
              return (
                <Card key={agent.name} className="bg-secondary/30 border-border">
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4 text-accent" />
                        <span className="font-medium text-sm">{agent.name}</span>
                      </div>
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div>Framework: {agent.framework}</div>
                      <div>Tools: {agent.tools}</div>
                      <div>Prompts: {agent.prompts}</div>
                    </div>
                    <Badge variant="outline" className={`text-xs ${agentRisk.badgeColor}`}>
                      Risk: {agent.risk}/100 {agentRisk.label}
                    </Badge>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Findings by Severity */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">Findings by Severity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-8">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <div>
                <div className="text-2xl font-bold">{sev.critical}</div>
                <div className="text-sm text-muted-foreground">Critical</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-orange-500" />
              <div>
                <div className="text-2xl font-bold">{sev.high}</div>
                <div className="text-sm text-muted-foreground">High</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-yellow-500" />
              <div>
                <div className="text-2xl font-bold">{sev.medium}</div>
                <div className="text-sm text-muted-foreground">Medium</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-blue-500" />
              <div>
                <div className="text-2xl font-bold">{sev.low}</div>
                <div className="text-sm text-muted-foreground">Low</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Git Workflow Card */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Git Workflow
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <div className="text-muted-foreground">Current branch:</div>
                <div className="font-mono">{currentBranch}</div>
                <div className="text-muted-foreground">Remote:</div>
                <div className="font-mono">origin</div>
                <div className="text-muted-foreground">Status:</div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-green-400">clean</span>
                </div>
                <div className="text-muted-foreground">Last commit SHA:</div>
                <div className="font-mono text-xs bg-secondary/50 px-2 py-0.5 rounded w-fit">a1b2c3d</div>
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                Git actions apply to the selected branch. Run scans before commit or push to catch risky agent changes.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button variant="outline" size="sm" className="gap-2">
                <Download className="h-4 w-4" />
                Pull from GitHub
              </Button>
              <Button variant="outline" size="sm" className="gap-2">
                <Upload className="h-4 w-4" />
                Commit Changes
              </Button>
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowUpFromLine className="h-4 w-4" />
                Push to GitHub
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-6">
        {/* Top Findings */}
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Top Findings</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("findings")}>
              View all
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {topFindings.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No findings in the latest scan.</p>
              ) : null}
              {topFindings.map((finding, i) => (
                <div
                  key={`${finding.file}:${finding.line}:${i}`}
                  className="flex items-start gap-3 p-3 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer"
                >
                  <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                    finding.severity === "critical" ? "bg-red-500" :
                    finding.severity === "high" ? "bg-orange-500" :
                    finding.severity === "medium" ? "bg-yellow-500" : "bg-blue-500"
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{finding.title}</div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      <FileCode className="h-3 w-3" />
                      <span>{finding.file}:{finding.line}</span>
                    </div>
                  </div>
                  <Badge variant="outline" className={`shrink-0 text-xs ${
                    finding.severity === "critical" ? "border-red-500/50 text-red-400" :
                    finding.severity === "high" ? "border-orange-500/50 text-orange-400" :
                    finding.severity === "medium" ? "border-yellow-500/50 text-yellow-400" : "border-blue-500/50 text-blue-400"
                  }`}>
                    {finding.severity}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Scans */}
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Recent Scans</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("scan-center")}>
              View all
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentScans.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  Latest scan shown above. Run more scans to build history.
                </p>
              ) : null}
              {recentScans.map((scan) => (
                <div key={scan.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/30">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-secondary rounded-md">
                      <GitBranch className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">{scan.branch}</div>
                      <div className="text-xs text-muted-foreground">{scan.time}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {scan.issues > 0 ? (
                      <Badge variant="outline" className="border-orange-500/50 text-orange-400">
                        {scan.issues} issues
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-green-500/50 text-green-400">
                        Clean
                      </Badge>
                    )}
                    {scan.status === "completed" ? (
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-400" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
