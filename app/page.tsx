"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AppSidebar, type ViewType } from "@/components/app-sidebar"
import { TopBar } from "@/components/top-bar"
import { Overview } from "@/components/views/overview"
import { ScanCenter } from "@/components/views/scan-center"
import { DetectedAgents } from "@/components/views/detected-agents"
import { UnderstandCodeWorkflow } from "@/components/views/understand-code-workflow"
import { Findings } from "@/components/views/findings"
import { RunTraces } from "@/components/views/run-traces"
import { BranchCompare } from "@/components/views/branch-compare"
import { Evaluations } from "@/components/views/evaluations"
import { PromptPlayground } from "@/components/views/prompt-playground"
import { ChatAssistant } from "@/components/views/chat-assistant"
import { PlanBilling } from "@/components/views/plan-billing"
import { OnboardingWelcome } from "@/components/onboarding-welcome"
import { Settings } from "@/components/views/settings"
import { OpenProjectDialog } from "@/components/open-project-dialog"
import { CloneGithubDialog } from "@/components/clone-github-dialog"
import {
  parseScanReport,
  mapReportToUiFindings,
  resolveChecksForApi,
  buildTopBarAgentsFromReport,
  buildOverviewAgentsFromReport,
  buildToolsInventoryFromReport,
  totalToolCountFromReport,
  topFindingsFromReport,
  type ScanReport,
} from "@/lib/scan-report"
import { normalizeScanMode } from "@/lib/scan-intelligence/normalize-mode"
import {
  loadRecentProjects,
  saveRecentProject,
  type Project,
} from "@/lib/projects"
import {
  appendScanToHistory,
  loadScanHistory,
  scanHistoryForProject,
  scanItemFromReport,
  MODE_LABELS,
  type ScanHistoryItem,
} from "@/lib/scan-history"
import type { TestSuite } from "@/lib/test-cases"
import {
  buildBridgedProbesFromSuite,
  replaceSuiteProbes,
  setUserOnly,
} from "@/lib/user-probes"
import { evaluatePolicyApi, type PolicyApiResponse } from "@/lib/policy-client"
import { saveLatestPolicyResult } from "@/lib/latest-policy-result"
import { apiFetch } from "@/lib/api-fetch"

type GitBranchesResponse = {
  isRepo: boolean
  branches: string[]
  remoteOnly: string[]
  currentBranch: string | null
  expanded: boolean
  /** Per-branch stash counts (from `git stash list` subjects). Empty
   *  map ↔ no stashes anywhere. Branches with zero stashes simply
   *  don't appear in the keys. */
  stashesByBranch: Record<string, number>
}

/**
 * Post-filter a fresh scan report so the UI only sees the findings the
 * active user-defined suite was generated from. Narrowing dimensions
 * (highest to lowest precision):
 *
 *  - `findingIds` — exact match on `f.id`. One AI-generated test ⇒ one
 *    finding, so a 12-test suite collapses to ~12 findings.
 *  - `ruleFileTuples` — `(rule_id, file)` pair match. The tightest
 *    dimension for *manually authored* suites: each tuple says
 *    "findings under this rule AND in this file". Catches the case the
 *    file-only fallback used to muff — five findings in `agents/x.py`
 *    no longer survive a one-test suite about a single rule.
 *  - `ruleIds` — rule_id-only match. Used when the suite cares about a
 *    rule but didn't pin a file (e.g. "test prompt injection anywhere").
 *  - `files` — legacy file-only fallback. Used when none of the above
 *    were stamped (older suites or imported ones).
 *
 * If every dimension is empty the report passes through unchanged. We
 * also recompute `summary` and `risk_score` so badges/donut/history
 * reflect the narrowed set instead of showing 100/100 next to a
 * handful of findings.
 */
function narrowReport(
  report: ScanReport,
  narrow: {
    findingIds?: string[]
    files?: string[]
    ruleIds?: string[]
    ruleFileTuples?: Array<{ ruleId: string; file: string }>
  }
): ScanReport {
  const findingIds = narrow.findingIds ?? []
  const files = narrow.files ?? []
  const ruleIds = narrow.ruleIds ?? []
  const tuples = narrow.ruleFileTuples ?? []
  if (
    findingIds.length === 0 &&
    files.length === 0 &&
    ruleIds.length === 0 &&
    tuples.length === 0
  ) {
    return report
  }

  // Precompute the lookup sets once; we'll consult them in the
  // precedence order described above.
  const idAllow = new Set(findingIds)
  const fileAllow = new Set(files)
  const ruleAllow = new Set(ruleIds)
  const tupleAllow = new Set(
    tuples.map((t) => `${t.ruleId}\u0000${t.file}`)
  )

  let filtered = report.findings

  if (findingIds.length > 0) {
    const byId = report.findings.filter((f) => idAllow.has(f.id))
    if (byId.length > 0) {
      filtered = byId
    } else if (tuples.length > 0) {
      // IDs went stale (new scan, new finding ids) — fall back to
      // tuples first since they're stricter than file-only.
      filtered = report.findings.filter((f) =>
        tupleAllow.has(`${f.rule_id ?? ""}\u0000${f.file}`)
      )
    } else if (files.length > 0) {
      filtered = report.findings.filter((f) => fileAllow.has(f.file))
    } else if (ruleIds.length > 0) {
      filtered = report.findings.filter(
        (f) => f.rule_id != null && ruleAllow.has(f.rule_id)
      )
    } else {
      filtered = []
    }
  } else if (tuples.length > 0) {
    filtered = report.findings.filter((f) =>
      tupleAllow.has(`${f.rule_id ?? ""}\u0000${f.file}`)
    )
  } else if (files.length > 0 && ruleIds.length > 0) {
    // AND the two dimensions — both signals were explicit, so a
    // finding has to satisfy both to be considered "in scope".
    filtered = report.findings.filter(
      (f) =>
        fileAllow.has(f.file) &&
        f.rule_id != null &&
        ruleAllow.has(f.rule_id)
    )
  } else if (files.length > 0) {
    filtered = report.findings.filter((f) => fileAllow.has(f.file))
  } else if (ruleIds.length > 0) {
    filtered = report.findings.filter(
      (f) => f.rule_id != null && ruleAllow.has(f.rule_id)
    )
  }

  const summary = {
    critical: filtered.filter((f) => f.severity === "critical").length,
    high: filtered.filter((f) => f.severity === "high").length,
    medium: filtered.filter((f) => f.severity === "medium").length,
    low: filtered.filter((f) => f.severity === "low").length,
    total: filtered.length,
  }
  // Same weighting the Python scanner uses (critical 25 / high 12 /
  // medium 6 / low 2, capped at 100).
  const raw =
    summary.critical * 25 +
    summary.high * 12 +
    summary.medium * 6 +
    summary.low * 2
  const risk_score = Math.min(100, raw)
  return { ...report, findings: filtered, summary, risk_score }
}

export default function Home() {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [recentProjects, setRecentProjects] = useState<Project[]>([])
  const [currentView, setCurrentView] = useState<ViewType>("overview")
  // First-run welcome gate. `null` = undecided (still checking), so we
  // don't flash the app or the onboarding before we know the auth state.
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null)
  /** Which inner tab Findings should land on. Reset to "code" any
   *  time the user navigates away from Findings so a later trip
   *  through the sidebar doesn't accidentally land them on
   *  Behavioral. */
  const [findingsInitialTab, setFindingsInitialTab] =
    useState<"code" | "behavioral">("code")
  const [currentBranch, setCurrentBranch] = useState("main")
  const [selectedAgents, setSelectedAgents] = useState<string[]>(["all"])
  // Intelligence mode selected before a scan. Default Auto. The
  // Findings + Scan Center toolbars read/write this same state.
  const [intelligenceMode, setIntelligenceMode] = useState<
    "save" | "auto" | "pro" | "max" | "manual"
  >("auto")
  // Hosted-only: AI access is included in the user's plan and resolved
  // server-side from env-managed provider credentials. The constant is
  // kept on the wire as a stable client→server signal, but the server
  // resolver is hosted-only regardless. See
  // lib/server-ai-provider-resolver.ts for the contract.
  const aiProviderMode = "hosted" as const
  const [manualModelSelection, setManualModelSelection] = useState<Record<string, string>>({})
  const [scanReport, setScanReport] = useState<ScanReport | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [openLocalDialog, setOpenLocalDialog] = useState(false)
  const [openCloneDialog, setOpenCloneDialog] = useState(false)
  const [gitInfo, setGitInfo] = useState<GitBranchesResponse | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [scanHistory, setScanHistory] = useState<ScanHistoryItem[]>([])
  // The user-defined suite that's queued for the next scan. Lifted up here
  // so views beyond Scan Center (Overview) can show the *currently active*
  // user-defined tests instead of summing across every saved suite.
  const [activeSuite, setActiveSuite] = useState<TestSuite | null>(null)
  // Monotonic counter the Behavioral Tests panel watches as a "force
  // re-read the per-project probe store from localStorage" signal.
  // Bumped after we mutate the store from this file (e.g. when
  // "Run user-defined + AI tests" flips `userOnly` back to false)
  // because neither `projectPath` nor `activeSuite.id` change in
  // that case and the panel would otherwise keep a stale snapshot.
  const [probeStoreVersion, setProbeStoreVersion] = useState(0)
  // Latest policy evaluation for the current scan, refreshed every time
  // a scan completes. Null when no scan has been run (or no project).
  const [policyResponse, setPolicyResponse] =
    useState<PolicyApiResponse | null>(null)
  const [policyLoading, setPolicyLoading] = useState(false)
  const policyEvalAbortRef = useRef<AbortController | null>(null)

  // Mirror the currently active user-defined suite into the Behavioral
  // Tests panel's probe store. The Define-User-Defined-Inputs dialog
  // already bridges at save time, but this effect covers:
  //   • suites authored before bridging existed (legacy entries on disk)
  //   • suites loaded from the Saved Tests picker
  //   • the user clearing the active suite (probes drop back to 0 bridged)
  // The bridge only ever replaces probes whose id starts with
  // `user.suite.` so stand-alone custom probes from the Behavioral
  // panel are never touched.
  useEffect(() => {
    const projectPath = selectedProject?.path
    if (!projectPath) return
    const bridged = buildBridgedProbesFromSuite(activeSuite)
    replaceSuiteProbes(projectPath, bridged)
  }, [activeSuite, selectedProject?.path])

  useEffect(() => {
    setRecentProjects(loadRecentProjects())
    setScanHistory(loadScanHistory())
  }, [])

  // Decide whether to show the welcome gate: skip it if the user already
  // dismissed it (localStorage) or already has a session (/api/plan).
  useEffect(() => {
    let cancelled = false
    const ONBOARDED_KEY = "edge-agent-ai.onboarded"
    // Force override for testing: `?welcome=1` (or `#welcome`) always
    // shows the gate, ignoring the dismissed flag AND any live session.
    // It also clears the dismissed flag so a normal reload behaves again.
    try {
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search)
        if (params.get("welcome") === "1" || window.location.hash === "#welcome") {
          window.localStorage.removeItem(ONBOARDED_KEY)
          setShowOnboarding(true)
          return
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (typeof window !== "undefined" && window.localStorage.getItem(ONBOARDED_KEY) === "1") {
        setShowOnboarding(false)
        return
      }
    } catch {
      /* localStorage unavailable — fall through to the auth check */
    }
    apiFetch("/api/plan")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { authenticated?: boolean } | null) => {
        if (cancelled) return
        setShowOnboarding(!json?.authenticated)
      })
      .catch(() => {
        if (!cancelled) setShowOnboarding(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dismissOnboarding = useCallback(() => {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem("edge-agent-ai.onboarded", "1")
    } catch {
      /* best-effort */
    }
    setShowOnboarding(false)
  }, [])

  /**
   * Reusable branch refresher. Pulled out so Branch Compare can re-run it
   * (with `expand=true`) when the user clicks "Refresh branches" on a
   * shallow / single-branch clone where only `main` showed up initially.
   *
   * `expand` adds the `?expand=1` query that the API uses to widen the
   * remote refspec and re-fetch — cheap when a repo already has every
   * branch, helpful when it doesn't.
   */
  const refreshBranches = useCallback(
    async (project: Project | null, opts?: { expand?: boolean }) => {
      if (!project) {
        setGitInfo(null)
        setGitLoading(false)
        return
      }
      setGitLoading(true)
      try {
        const url = `/api/git/branches?projectPath=${encodeURIComponent(
          project.path
        )}${opts?.expand ? "&expand=1" : ""}`
        const res = await fetch(url)
        const data = (await res.json()) as Partial<GitBranchesResponse> & {
          error?: string
        }
        if (!res.ok || !data || typeof data.isRepo !== "boolean") {
          setGitInfo({
            isRepo: false,
            branches: [],
            remoteOnly: [],
            currentBranch: null,
            expanded: false,
            stashesByBranch: {},
          })
          return
        }
        const info: GitBranchesResponse = {
          isRepo: data.isRepo,
          branches: Array.isArray(data.branches) ? data.branches : [],
          remoteOnly: Array.isArray(data.remoteOnly) ? data.remoteOnly : [],
          currentBranch: data.currentBranch ?? null,
          expanded: Boolean(data.expanded),
          stashesByBranch:
            data.stashesByBranch &&
            typeof data.stashesByBranch === "object"
              ? (data.stashesByBranch as Record<string, number>)
              : {},
        }
        setGitInfo(info)
        // Reconcile the stored project record with what git actually
        // says HEAD is. Three cases:
        //
        //   1. Project record has no branch → use live HEAD. (existing)
        //   2. Project record's branch is in the real branch list →
        //      keep it (user might be intentionally on a feature branch).
        //   3. Project record's branch is NOT in the real list →
        //      it's stale (e.g. older clone code baked in `"main"` on
        //      a repo whose default is `master`). Snap to the real
        //      HEAD AND persist the corrected record back to
        //      localStorage so we don't keep doing this dance.
        const storedBranch = project.branch?.trim() ?? ""
        const knownBranches = new Set(info.branches)
        if (info.currentBranch) {
          if (!storedBranch) {
            setCurrentBranch(info.currentBranch)
          } else if (!knownBranches.has(storedBranch)) {
            // Stale record — heal it.
            setCurrentBranch(info.currentBranch)
            const healed: Project = {
              ...project,
              branch: info.currentBranch,
            }
            saveRecentProject(healed)
            setSelectedProject(healed)
            setRecentProjects(loadRecentProjects())
          }
        }
      } catch {
        setGitInfo({
          isRepo: false,
          branches: [],
          remoteOnly: [],
          currentBranch: null,
          expanded: false,
          stashesByBranch: {},
        })
      } finally {
        setGitLoading(false)
      }
    },
    []
  )

  /**
   * Whenever the user opens / switches a project, refresh the real branch
   * list from disk. The endpoint returns isRepo:false gracefully for
   * non-Git folders, so we don't need to special-case errors. If the
   * project carries an explicit `branch` (set by the GitHub clone flow),
   * keep it; otherwise align `currentBranch` with the repo's HEAD.
   */
  useEffect(() => {
    void refreshBranches(selectedProject)
  }, [selectedProject, refreshBranches])

  const riskScore = scanReport?.risk_score ?? 0
  const uiFindings = useMemo(
    () => (scanReport ? mapReportToUiFindings(scanReport) : []),
    [scanReport]
  )
  const topBarAgents = useMemo(
    () => buildTopBarAgentsFromReport(scanReport, riskScore),
    [scanReport, riskScore]
  )
  const overviewAgents = useMemo(
    () => buildOverviewAgentsFromReport(scanReport, riskScore),
    [scanReport, riskScore]
  )
  const toolsInventory = useMemo(
    () => buildToolsInventoryFromReport(scanReport),
    [scanReport]
  )
  const totalToolCount = useMemo(
    () => totalToolCountFromReport(scanReport),
    [scanReport]
  )
  const topFindings = useMemo(() => topFindingsFromReport(scanReport), [scanReport])
  const scanSummary = scanReport?.summary ?? null
  // Distinct scanner rule_ids that produced at least one finding in the
  // latest scan. The Overview "Tests" tile uses this to compute how many
  // built-in checks "passed" (no findings) vs "failed" each scan, so the
  // tile updates with every run instead of staying static.
  const failedRuleIds = useMemo<string[]>(() => {
    if (!scanReport) return []
    const ids = new Set<string>()
    for (const f of scanReport.findings) ids.add(f.rule_id)
    return Array.from(ids)
  }, [scanReport])
  const lastScanLabel = scanReport
    ? new Date(scanReport.generated_at).toLocaleString()
    : "No scan yet"

  const projectLabel = selectedProject?.name ?? "No project opened"
  const hasProject = selectedProject !== null
  const hasScan = scanReport !== null
  const findingsCount = scanReport?.summary.total ?? 0

  const persistProject = useCallback((project: Project) => {
    const next: Project = { ...project, lastOpenedAt: new Date().toISOString() }
    saveRecentProject(next)
    setRecentProjects(loadRecentProjects())
    return next
  }, [])

  // Holds the in-flight scan's AbortController so the Scan Center
  // "Stop" button can actually cancel the request. We keep it in a ref
  // (not state) because we don't want re-renders to fire when the
  // controller swaps out, and because async closures need to read the
  // *latest* controller, not whatever was current when they captured.
  const scanAbortRef = useRef<AbortController | null>(null)

  const executeScan = useCallback(
    async (
      selectedCheckIds: string[],
      projectOverride?: Project,
      /** When set, post-filter the scan report so the UI only sees findings
       * the active user-defined suite was generated from. Dimensions:
       *  - `findingIds` (preferred): exact-match on the finding `id`.
       *  - `ruleFileTuples`: (rule_id, file) pair match — tight for
       *    manually authored suites where each test is "rule X on file Y".
       *  - `ruleIds`: rule_id-only match (no file pin).
       *  - `files` (fallback): match on `file` for legacy suites. */
      narrow?: {
        findingIds?: string[]
        files?: string[]
        ruleIds?: string[]
        ruleFileTuples?: Array<{ ruleId: string; file: string }>
        /** Behavioral-tab signal from Scan Center: when true the user
         *  ran with all built-in categories unchecked, so we flip the
         *  per-project Behavioral `userOnly` flag for them. */
        hintUserOnlyBehavioral?: boolean
      }
    ): Promise<{ beforeCount: number; afterCount: number; narrowed: boolean }> => {
      const target = projectOverride ?? selectedProject
      // Apply the "only my behavioral tests" hint up-front. We do this
      // BEFORE the scan so that any Findings → Behavioral Tests panel
      // already mounted picks up the new userOnly flag on its next
      // re-run (the panel's reload effect watches activeSuiteId, but
      // the toggle itself flips through localStorage). Idempotent and
      // cheap — no-op when the value matches what's already stored.
      if (narrow?.hintUserOnlyBehavioral && target?.path) {
        setUserOnly(target.path, true)
        setProbeStoreVersion((v) => v + 1)
      }
      if (!target) {
        setScanError(
          "Open a local project or clone from GitHub before running a scan."
        )
        return { beforeCount: 0, afterCount: 0, narrowed: false }
      }
      // Cancel any prior in-flight scan first — clicking "Run Scan"
      // again while one is running should supersede, not pile on.
      if (scanAbortRef.current) {
        scanAbortRef.current.abort()
      }
      const controller = new AbortController()
      scanAbortRef.current = controller

      setScanning(true)
      setScanError(null)
      try {
        const checks = resolveChecksForApi(selectedCheckIds)
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectPath: target.path,
            checks: checks && checks.length > 0 ? checks : undefined,
            // Pass the *user-selected* branch through to the API so
            // selecting `gt` or `yeye` in the dropdown actually scans
            // those branches via a temp `git worktree`, instead of
            // silently re-scanning whatever's checked out on disk.
            // The API no-ops the worktree path when this matches the
            // current HEAD branch.
            branch: currentBranch || undefined,
            // Scan-time intelligence mode. The DETERMINISTIC scan is
            // identical in every mode; this only tells /api/scan how hard
            // to run the post-scan LLM verifier/gap-audit layer
            // (lib/scan-intelligence). Sent as the canonical scan mode
            // (lite/balanced/deep/exhaustive); the route also accepts the
            // legacy save/auto/pro/max ids. Provider/manual-model metadata
            // is still stamped onto scan history client-side below.
            intelligenceMode: normalizeScanMode(intelligenceMode),
          }),
          // Wiring the AbortSignal here is what makes the Stop button
          // actually do something: aborting the controller rejects the
          // fetch with an AbortError, which we catch below and surface
          // as "Scan cancelled" rather than "Scan failed".
          signal: controller.signal,
        })
        // If the server had to fall back to a different branch because
        // our stored `branch` was stale (e.g. `"main"` on a master-default
        // repo), it sets these headers so we can heal the project record.
        const correctionFrom = res.headers.get("X-Edge-Branch-Correction-From")
        const correctionTo = res.headers.get("X-Edge-Branch-Correction-To")
        if (correctionFrom && correctionTo && target) {
          setCurrentBranch(correctionTo)
          const healed: Project = {
            ...target,
            branch: correctionTo,
          }
          saveRecentProject(healed)
          setSelectedProject(healed)
          setRecentProjects(loadRecentProjects())
        }
        const raw = await res.json()
        if (!res.ok) {
          const msg = typeof raw.error === "string" ? raw.error : "Scan failed"
          throw new Error(msg)
        }
        let report = parseScanReport(raw)
        const beforeCount = report.findings.length
        if (narrow) {
          report = narrowReport(report, narrow)
        }
        const afterCount = report.findings.length
        // Console breadcrumb so the dev can confirm narrowing actually ran
        // without sprinkling logs in normal scan flow.
        if (narrow) {
          console.info(
            `[edge-agent-ai] Suite narrowing: ${beforeCount} → ${afterCount} findings`,
            {
              findingIds: narrow.findingIds?.length ?? 0,
              ruleFileTuples: narrow.ruleFileTuples?.length ?? 0,
              ruleIds: narrow.ruleIds?.length ?? 0,
              files: narrow.files?.length ?? 0,
              fileSample: narrow.files?.slice(0, 5),
            }
          )
        }
        setScanReport(report)
        setSelectedAgents(["all"])
        // Persist to history so the Scan Center "Recent Scans" list grows
        // beyond a single "Latest scan" entry.
        const branchAtScan =
          target.branch?.trim() || currentBranch || "main"
        const item = scanItemFromReport(report, target, branchAtScan, {
          intelligenceMode,
          modeLabel: MODE_LABELS[intelligenceMode],
          aiProviderMode,
          manualModelSelection:
            intelligenceMode === "manual" ? manualModelSelection : undefined,
        })
        const next = appendScanToHistory(item)
        setScanHistory(next)
        return {
          beforeCount,
          afterCount,
          narrowed: Boolean(narrow),
        }
      } catch (e) {
        // AbortError shouldn't read like a failure — the user asked for
        // it. We clear the error too so the red banner doesn't linger.
        if (
          (e instanceof DOMException && e.name === "AbortError") ||
          (e instanceof Error && e.name === "AbortError")
        ) {
          setScanError("Scan cancelled.")
        } else {
          setScanError(e instanceof Error ? e.message : "Scan failed")
        }
        return { beforeCount: 0, afterCount: 0, narrowed: false }
      } finally {
        // Only clear the ref if this run is still the active one — a
        // newer run may have already replaced it.
        if (scanAbortRef.current === controller) {
          scanAbortRef.current = null
        }
        setScanning(false)
      }
    },
    [selectedProject, currentBranch]
  )

  /** Public abort hook — exposed to ScanCenter so the red Stop button
   *  can cancel the in-flight scan. No-op when nothing is running. */
  const abortScan = useCallback(() => {
    scanAbortRef.current?.abort()
  }, [])

  /**
   * Re-evaluate `.edgeagent/policy.yaml` against the supplied report.
   * Called whenever a fresh scan lands or a historical scan is loaded.
   * The policy file is read on the server side; if it's missing the
   * server returns its safe defaults so the UI still gets a decision.
   */
  const runPolicyForReport = useCallback(
    async (
      report: ScanReport,
      project: Project | null,
      opts: { refreshBase?: boolean } = {}
    ) => {
      if (!project?.path) {
        setPolicyResponse(null)
        return
      }
      // Cancel any prior in-flight evaluation. We don't need its result.
      policyEvalAbortRef.current?.abort()
      const ctl = new AbortController()
      policyEvalAbortRef.current = ctl
      setPolicyLoading(true)
      try {
        const resp = await evaluatePolicyApi({
          projectPath: project.path,
          targetReport: report,
          // refreshBase=true is wired to the "Re-scan main" button on
          // the policy card; the server then bypasses the on-disk
          // base-scan cache and re-runs the scanner against the base
          // branch's HEAD so we recover from a stale baseline.
          refreshBase: opts.refreshBase,
          context: {
            branch: currentBranch || project.branch,
            // Working-tree status is fetched lazily by TopBar; the policy
            // evaluator only consults it when auto-merge is requested,
            // so omitting here is fine for the scan-time evaluation.
          },
        })
        if (ctl.signal.aborted) return
        setPolicyResponse(resp)
        // Persist the freshest real gate result so the Export Policy
        // Report button can light up across the app — including
        // Settings → Policy Rules and the Policy Status Card. Every
        // gate-running path in the app routes through here, so this
        // is the canonical persistence point. We pass `operation:
        // "test"` because the scan-time evaluation isn't tied to any
        // specific Git verb; commit/push/PR result modals can later
        // overwrite with a more specific operation if desired.
        if (resp.evaluation) {
          try {
            saveLatestPolicyResult({
              projectPath: project.path,
              projectName: project.name ?? null,
              operation: "test",
              generatedAt: new Date().toISOString(),
              baseBranch: resp.baseBranch ?? null,
              targetBranch: currentBranch || project.branch || null,
              baseSha: resp.baseSha ?? null,
              targetSha: null,
              baseIncludesStashes: false,
              targetIncludesStashes: !!(
                report as unknown as {
                  working_tree?: { stashes_included_count?: number }
                }
              )?.working_tree?.stashes_included_count,
              actionTaken: null,
              policy: resp,
              targetReport: {
                risk_score: report.risk_score,
                summary: report.summary,
                generated_at: report.generated_at,
                findings: report.findings,
              },
            })
          } catch {
            /* persistence is best-effort */
          }
        }
      } catch {
        if (!ctl.signal.aborted) setPolicyResponse(null)
      } finally {
        if (policyEvalAbortRef.current === ctl) {
          policyEvalAbortRef.current = null
        }
        if (!ctl.signal.aborted) setPolicyLoading(false)
      }
    },
    [currentBranch]
  )

  /** Public refresh hook for the "Re-scan <base>" button on the
   *  Overview's policy card. Re-evaluates the current scan against a
   *  fresh base-branch scan, ignoring any cached entry. No-op when
   *  there's no current scan or project. */
  const refreshPolicyBaseline = useCallback(() => {
    if (!scanReport || !selectedProject) return
    void runPolicyForReport(scanReport, selectedProject, { refreshBase: true })
  }, [scanReport, selectedProject, runPolicyForReport])

  // Re-evaluate policy whenever the *current* scan report changes
  // (executeScan, handleLoadScan, project switch). Keeps the Overview
  // and any consumer in sync without each one needing to re-call the
  // API itself.
  useEffect(() => {
    if (!scanReport || !selectedProject?.path) {
      setPolicyResponse(null)
      return
    }
    void runPolicyForReport(scanReport, selectedProject)
  }, [scanReport, selectedProject, runPolicyForReport])

  /** Load a historical scan back into the current view. If the scan belongs
   * to a different project than the currently-selected one, switch to that
   * project too so the rest of the UI lines up. */
  const handleLoadScan = useCallback((item: ScanHistoryItem) => {
    const projectFromItem: Project = {
      id: item.projectId,
      name: item.projectName,
      path: item.projectPath,
      source: "local",
      branch: item.branch,
      lastOpenedAt: new Date().toISOString(),
    }
    setSelectedProject(projectFromItem)
    setScanReport(item.report)
    setScanError(null)
    if (item.branch && item.branch.trim()) {
      setCurrentBranch(item.branch.trim())
    }
    setSelectedAgents(["all"])
  }, [])

  const handleOpenProject = useCallback(
    (project: Project) => {
      const persisted = persistProject(project)
      setSelectedProject(persisted)
      setScanReport(null)
      setScanError(null)
      setPolicyResponse(null)
      setCurrentView("overview")
      // A suite picked for project A should not stay active when the user
      // jumps to project B — its file/finding targets won't make sense.
      setActiveSuite(null)
      if (persisted.branch && persisted.branch.trim()) {
        setCurrentBranch(persisted.branch.trim())
      }
    },
    [persistProject]
  )

  const handleOpenAndScan = useCallback(
    (project: Project) => {
      const persisted = persistProject(project)
      setSelectedProject(persisted)
      setScanReport(null)
      setScanError(null)
      setPolicyResponse(null)
      setCurrentView("overview")
      setActiveSuite(null)
      if (persisted.branch && persisted.branch.trim()) {
        setCurrentBranch(persisted.branch.trim())
      }
      void executeScan([], persisted)
    },
    [persistProject, executeScan]
  )

  const handleSwitchProject = useCallback(
    (project: Project) => {
      handleOpenProject(project)
    },
    [handleOpenProject]
  )

  const handleNavigate = (view: string) => {
    setCurrentView(view as ViewType)
  }

  // Reset the Findings inner tab back to "code" whenever the user
  // leaves Findings. The deep-link path (Scan Center → behavioral)
  // sets the tab and the view in the same tick, so we never race it.
  // Without this reset, a user who once clicked "Run user-defined +
  // AI tests" would keep landing on the Behavioral tab on every
  // future Findings visit.
  useEffect(() => {
    if (currentView !== "findings" && findingsInitialTab !== "code") {
      setFindingsInitialTab("code")
    }
  }, [currentView, findingsInitialTab])

  const handleRunScan = () => {
    if (!selectedProject) {
      setScanError(
        "Open a local project or clone from GitHub before running a scan."
      )
      setCurrentView("scan-center")
      return
    }
    setCurrentView("scan-center")
    void executeScan([])
  }

  const renderView = () => {
    switch (currentView) {
      case "overview":
        return (
          <Overview
            onNavigate={handleNavigate}
            riskScore={riskScore}
            currentBranch={currentBranch}
            projectLabel={projectLabel}
            projectId={selectedProject?.id}
            scanSummary={scanSummary}
            topFindings={topFindings}
            detectedAgents={overviewAgents}
            lastScanLabel={lastScanLabel}
            hasProject={hasProject}
            hasScan={hasScan}
            activeSuite={activeSuite}
            failedRuleIds={failedRuleIds}
            policyResponse={policyResponse}
            policyLoading={policyLoading}
            onRefreshPolicyBaseline={refreshPolicyBaseline}
            projectPath={selectedProject?.path ?? null}
            project={selectedProject}
            // The "policy gate" runs as a side-effect of every scan, so
            // the scan report's own generated_at is the cleanest proxy
            // for "last gate run". When we add a dedicated PR gate
            // runner this will switch to its own timestamp.
            lastGateRunAt={scanReport?.generated_at ?? null}
            branches={gitInfo?.branches ?? []}
            remoteOnlyBranches={gitInfo?.remoteOnly ?? []}
          />
        )
      case "scan-center":
        return (
          <ScanCenter
            selectedAgents={selectedAgents}
            onRunScan={async (ids, narrow) =>
              executeScan(ids, undefined, narrow)
            }
            isScanning={scanning}
            onStopScan={abortScan}
            scanError={scanError}
            lastIssueCount={scanReport?.summary.total ?? null}
            lastScanTime={
              scanReport ? new Date(scanReport.generated_at).toLocaleString() : null
            }
            hasProject={hasProject}
            projectLabel={projectLabel}
            scanReport={scanReport}
            project={selectedProject}
            branch={currentBranch}
            policyResponse={policyResponse}
            scanHistory={scanHistoryForProject(scanHistory, selectedProject?.id)}
            onLoadScan={handleLoadScan}
            activeSuite={activeSuite}
            onActiveSuiteChange={setActiveSuite}
            onShowUserDefinedAndAiTests={() => {
              // "Run user-defined + AI tests" is the explicit "merge
              // both pools" gesture. Flip userOnly OFF so the
              // Behavioral panel runs built-in probes alongside any
              // suite-bridged / custom probes. Without this, a
              // previous "Run Suite Scan with everything unticked"
              // would leave userOnly stuck ON and the user would see
              // only their custom tests after explicitly asking for
              // built-ins back.
              if (selectedProject?.path) {
                setUserOnly(selectedProject.path, false)
                setProbeStoreVersion((v) => v + 1)
              }
              setFindingsInitialTab("behavioral")
              setCurrentView("findings")
            }}
            intelligenceMode={intelligenceMode}
            setIntelligenceMode={setIntelligenceMode}
            manualModelSelection={manualModelSelection}
            setManualModelSelection={setManualModelSelection}
            onNavigateToPlan={() => setCurrentView("plan-billing")}
          />
        )
      case "detected-agents":
        return (
          <DetectedAgents
            agents={overviewAgents}
            hasProject={hasProject}
            hasScan={hasScan}
            scanReport={scanReport}
            onOpenInFindings={(agentName) => {
              setSelectedAgents([agentName])
              setCurrentView("findings")
            }}
          />
        )
      case "understand-code-workflow":
        return (
          <UnderstandCodeWorkflow
            hasProject={hasProject}
            projectPath={selectedProject?.path ?? null}
            projectName={selectedProject?.name ?? null}
            onNavigateToSettings={() => setCurrentView("settings")}
          />
        )
      case "findings":
        return (
          <Findings
            findings={uiFindings}
            riskScore={riskScore}
            hasProject={hasProject}
            hasScan={hasScan}
            projectPath={selectedProject?.path ?? null}
            scanReport={scanReport}
            initialTab={findingsInitialTab}
            activeSuiteId={activeSuite?.id ?? null}
            activeSuite={activeSuite}
            probeStoreVersion={probeStoreVersion}
            projectId={selectedProject?.id ?? null}
            onActiveSuiteChange={setActiveSuite}
            onRerunScan={handleRunScan}
            intelligenceMode={intelligenceMode}
            setIntelligenceMode={setIntelligenceMode}
            aiProviderMode={aiProviderMode}
            manualModelSelection={manualModelSelection}
            setManualModelSelection={setManualModelSelection}
          />
        )
      case "run-traces":
        return (
          <RunTraces
            scanHistory={scanHistoryForProject(scanHistory, selectedProject?.id)}
            hasProject={hasProject}
            selectedAgents={selectedAgents}
          />
        )
      case "branch-compare":
        return (
          <BranchCompare
            currentBranch={currentBranch}
            branches={gitInfo?.branches ?? []}
            remoteOnlyBranches={gitInfo?.remoteOnly ?? []}
            stashesByBranch={gitInfo?.stashesByBranch ?? {}}
            projectPath={selectedProject?.path}
            project={selectedProject}
            isGitRepo={gitInfo?.isRepo ?? false}
            onRefreshBranches={(opts) =>
              refreshBranches(selectedProject, opts)
            }
            currentPolicyResponse={policyResponse}
            onEditPolicy={() => {
              if (typeof window !== "undefined") {
                window.location.hash = "policy-rules"
              }
              setCurrentView("settings")
            }}
          />
        )
      case "evaluations":
        return (
          <Evaluations
            projectPath={selectedProject?.path}
            isGitRepo={gitInfo?.isRepo ?? false}
            branches={gitInfo?.branches ?? []}
            remoteOnlyBranches={gitInfo?.remoteOnly ?? []}
            currentBranch={currentBranch}
            stashesByBranch={gitInfo?.stashesByBranch ?? {}}
          />
        )
      case "prompt-playground":
        return (
          <PromptPlayground
            scanReport={scanReport}
            projectId={selectedProject?.id ?? null}
          />
        )
      case "chat-assistant": {
        // Pass the latest scan id+timestamp so the right-rail "Scan
        // run" + "Scanned at" rows show real values instead of the
        // old hardcoded `scan-001`. We pull from the project's scan
        // history (newest first) so the id matches what shows up in
        // Recent Scans elsewhere.
        const projectScans = scanHistoryForProject(
          scanHistory,
          selectedProject?.id
        )
        return (
          <ChatAssistant
            currentBranch={currentBranch}
            scanReport={scanReport}
            selectedProject={selectedProject}
            latestScanId={projectScans[0]?.id ?? null}
            latestScanTimestamp={projectScans[0]?.timestamp ?? null}
          />
        )
      }
      case "plan-billing":
        return <PlanBilling />
      case "settings":
        return (
          <Settings
            projectPath={selectedProject?.path ?? null}
            project={selectedProject}
            scanReport={scanReport}
            currentBranch={currentBranch}
          />
        )
      default:
        return null
    }
  }

  // Hold rendering until we know whether to show the welcome gate, then
  // show onboarding or the app.
  if (showOnboarding === null) {
    return <div className="h-screen bg-background" />
  }
  if (showOnboarding) {
    return (
      <OnboardingWelcome
        onSkip={dismissOnboarding}
        onSignedIn={dismissOnboarding}
        onViewPlans={() => {
          setCurrentView("plan-billing")
          dismissOnboarding()
        }}
      />
    )
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      <TopBar
        projectName={projectLabel}
        currentBranch={currentBranch}
        onBranchChange={setCurrentBranch}
        selectedAgents={selectedAgents}
        onAgentChange={setSelectedAgents}
        riskScore={riskScore}
        onRunScan={handleRunScan}
        onNavigateToBranchCompare={() => setCurrentView("branch-compare")}
        agentOptions={topBarAgents}
        toolsInventory={toolsInventory}
        totalToolCount={totalToolCount}
        hasScan={hasScan}
        hasProject={hasProject}
        branches={gitInfo?.branches ?? []}
        remoteOnlyBranches={gitInfo?.remoteOnly ?? []}
        gitCurrentBranch={gitInfo?.currentBranch ?? null}
        isGitRepo={gitInfo?.isRepo ?? false}
        gitLoading={gitLoading}
        scanReport={scanReport}
        project={selectedProject}
        policyResponse={policyResponse}
        onGitOpComplete={() => {
          // Refresh the branch list (and HEAD detection) after every
          // successful pull/commit/push so the rest of the app sees
          // the new state.
          void refreshBranches(selectedProject)
        }}
      />
      <div className="flex flex-1 overflow-hidden">
        <AppSidebar 
          currentView={currentView} 
          onViewChange={setCurrentView}
          findingsCount={findingsCount}
          selectedProject={selectedProject}
          recentProjects={recentProjects}
          onSwitchProject={handleSwitchProject}
          onOpenLocalProject={() => setOpenLocalDialog(true)}
          onCloneFromGithub={() => setOpenCloneDialog(true)}
        />
        <main className="flex-1 overflow-auto">{renderView()}</main>
      </div>

      <OpenProjectDialog
        open={openLocalDialog}
        onOpenChange={setOpenLocalDialog}
        onOpenProject={handleOpenProject}
        onOpenAndScan={handleOpenAndScan}
      />
      <CloneGithubDialog
        open={openCloneDialog}
        onOpenChange={setOpenCloneDialog}
        onCloned={handleOpenProject}
        onClonedAndScan={handleOpenAndScan}
      />
    </div>
  )
}
