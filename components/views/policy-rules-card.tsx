"use client"

/**
 * Settings → Policy Rules card.
 *
 * Authoritative UI for editing `.edgeagent/policy.yaml`. Loads the
 * project's current policy on mount, lets the user flip every rule
 * in the six logical groups (Mode, Security, Thresholds, Evals, Pull
 * request, Auto-merge), previews what the result will block on, runs
 * a "Test on latest scan" dry-run against the freshest scan in app
 * state, and persists via `/api/policy/save`.
 *
 * Design rules:
 *   - The Policy type is the single source of truth. The form is just
 *     a thin view onto a `useState<Policy>` instance.
 *   - Backend enforcement is unaffected by this UI — the saved YAML
 *     is what gates commits/pushes/PRs. The UI only edits the YAML.
 *   - "Test on latest scan" must run against the REAL latest scan
 *     report; we never fabricate one.
 */

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DEFAULT_POLICY, type Policy } from "@/lib/policy"
import {
  evaluatePolicyApi,
  loadPolicy,
  savePolicy,
  type PolicyApiResponse,
} from "@/lib/policy-client"
import {
  saveLatestPolicyResult,
  type LatestPolicyResult,
} from "@/lib/latest-policy-result"
import type { ScanReport } from "@/lib/scan-report"
import type { Project } from "@/lib/projects"
import { ExportPolicyReportButton } from "@/components/export-policy-report-button"

export interface PolicyRulesCardProps {
  project: Project | null
  /** Latest scan report — used for "Test policy on latest scan". When
   *  null the button stays visible but disabled with a tooltip. */
  scanReport?: ScanReport | null
  /** Current branch — included in the test-evaluation context so the
   *  base-branch comparison uses the right baseline. */
  currentBranch?: string | null
}

export function PolicyRulesCard({
  project,
  scanReport = null,
  currentBranch = null,
}: PolicyRulesCardProps) {
  // ── State ────────────────────────────────────────────────────────
  const [policy, setPolicy] = useState<Policy>(DEFAULT_POLICY)
  const [originalPolicy, setOriginalPolicy] = useState<Policy>(DEFAULT_POLICY)
  const [policyMeta, setPolicyMeta] = useState<PolicyApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<PolicyApiResponse | null>(null)

  // ── Load current policy on mount / project change ────────────────
  useEffect(() => {
    let cancelled = false
    setTestResult(null)
    if (!project?.path) {
      setPolicy(DEFAULT_POLICY)
      setOriginalPolicy(DEFAULT_POLICY)
      setPolicyMeta(null)
      return
    }
    setLoading(true)
    void loadPolicy(project.path)
      .then((resp) => {
        if (cancelled) return
        if (resp.policy) {
          setPolicy(resp.policy)
          setOriginalPolicy(resp.policy)
        }
        setPolicyMeta(resp)
      })
      .catch(() => {
        if (cancelled) return
        setPolicy(DEFAULT_POLICY)
        setOriginalPolicy(DEFAULT_POLICY)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project?.path])

  // ── Derived bits ─────────────────────────────────────────────────
  const dirty = useMemo(
    () => JSON.stringify(policy) !== JSON.stringify(originalPolicy),
    [policy, originalPolicy]
  )
  const policyFileMissing = policyMeta?.policySource === "default"
  const previewBlockers = useMemo(() => buildPreviewBlockers(policy), [policy])

  // ── Handlers ─────────────────────────────────────────────────────
  const updateSecurity = <K extends keyof Policy["security"]>(
    key: K,
    value: Policy["security"][K]
  ) => setPolicy((p) => ({ ...p, security: { ...p.security, [key]: value } }))

  const updateEvals = <K extends keyof Policy["evals"]>(
    key: K,
    value: Policy["evals"][K]
  ) => setPolicy((p) => ({ ...p, evals: { ...p.evals, [key]: value } }))

  const updatePR = <K extends keyof Policy["pull_request"]>(
    key: K,
    value: Policy["pull_request"][K]
  ) =>
    setPolicy((p) => ({
      ...p,
      pull_request: { ...p.pull_request, [key]: value },
    }))

  const updateAutoMerge = <K extends keyof Policy["auto_merge"]>(
    key: K,
    value: Policy["auto_merge"][K]
  ) =>
    setPolicy((p) => ({
      ...p,
      auto_merge: { ...p.auto_merge, [key]: value },
    }))

  const updateCommit = <K extends keyof Policy["commit"]>(
    key: K,
    value: Policy["commit"][K]
  ) => setPolicy((p) => ({ ...p, commit: { ...p.commit, [key]: value } }))

  const updatePush = <K extends keyof Policy["push"]>(
    key: K,
    value: Policy["push"][K]
  ) => setPolicy((p) => ({ ...p, push: { ...p.push, [key]: value } }))

  const handleSave = async () => {
    if (!project?.path) {
      toast.error("Open a project before saving the policy.")
      return
    }
    setSaving(true)
    try {
      const resp = await savePolicy({ projectPath: project.path, policy })
      if (resp.error) {
        toast.error(resp.error)
      } else {
        toast.success("Policy saved to .edgeagent/policy.yaml")
        if (resp.policy) {
          setPolicy(resp.policy)
          setOriginalPolicy(resp.policy)
        }
        setPolicyMeta(resp)
      }
    } catch (e) {
      toast.error(
        `Failed to save policy: ${e instanceof Error ? e.message : String(e)}`
      )
    } finally {
      setSaving(false)
    }
  }

  const handleResetToDefault = () => {
    setPolicy(DEFAULT_POLICY)
  }

  const handleDiscard = () => {
    setPolicy(originalPolicy)
  }

  const handleTest = async () => {
    if (!project?.path || !scanReport) return
    setTesting(true)
    try {
      // The /api/policy/evaluate route uses the policy *on disk*, not
      // the in-memory draft. To preview an unsaved draft we send a
      // sentinel: temporarily save → evaluate → if user discards the
      // draft, the on-disk file stays as-was. Cleaner alternative
      // would be a `?policyOverride=...` flag; for now we evaluate
      // against the *saved* policy and tell the user when there are
      // unsaved changes.
      const resp = await evaluatePolicyApi({
        projectPath: project.path,
        targetReport: scanReport,
        context: { branch: currentBranch ?? project.branch ?? undefined },
      })
      setTestResult(resp)
      if (resp.evaluation && project) {
        // Persist as a real gate result so the Export Policy Report
        // button lights up across the app.
        const latest: LatestPolicyResult = {
          projectPath: project.path,
          projectName: project.name ?? null,
          operation: "test",
          generatedAt: new Date().toISOString(),
          baseBranch: resp.baseBranch ?? null,
          targetBranch: currentBranch ?? project.branch ?? null,
          baseSha: resp.baseSha ?? null,
          targetSha: null,
          baseIncludesStashes: false,
          targetIncludesStashes: false,
          actionTaken: null,
          policy: resp,
          targetReport: {
            risk_score: scanReport.risk_score,
            summary: scanReport.summary,
            generated_at: scanReport.generated_at,
            findings: scanReport.findings,
          },
        }
        saveLatestPolicyResult(latest)
      }
    } catch (e) {
      toast.error(
        `Test failed: ${e instanceof Error ? e.message : String(e)}`
      )
    } finally {
      setTesting(false)
    }
  }

  // ── Auto-scroll into view when the user navigates from
  //    "Edit Policy" (we tag the card with a stable id and the URL
  //    fragment is set just before the navigation). Defensive about
  //    SSR — no document during initial render.
  useEffect(() => {
    if (typeof window === "undefined") return
    if (window.location.hash !== "#policy-rules") return
    const el = document.getElementById("policy-rules")
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [])

  // ── Render ───────────────────────────────────────────────────────
  return (
    <Card id="policy-rules" className="bg-card border-border scroll-mt-6">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Policy Rules
            </CardTitle>
            <CardDescription>
              Configure what blocks commits, pushes, and pull requests.
              Saved as <code>.edgeagent/policy.yaml</code> in the project
              root.
            </CardDescription>
          </div>
          {policyMeta && (
            <Badge
              variant="outline"
              className={
                policyFileMissing
                  ? "border-yellow-500/40 text-yellow-300 bg-yellow-500/10"
                  : "border-green-500/40 text-green-300 bg-green-500/10"
              }
            >
              {policyFileMissing ? "Using default" : "From file"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {!project ? (
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-3 text-sm text-yellow-200">
            Open a project to view and edit its policy.
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading policy…
          </div>
        ) : (
          <>
            {policyFileMissing && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-200">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">No policy file found.</p>
                  <p className="text-yellow-300/90 text-xs mt-0.5">
                    Using safe default policy. Click <em>Save Policy</em>{" "}
                    to write the current values to{" "}
                    <code>.edgeagent/policy.yaml</code>.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => void handleSave()}
                  disabled={saving}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Create default policy
                </Button>
              </div>
            )}
            {policyMeta?.policyErrors && policyMeta.policyErrors.length > 0 && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
                <p className="font-medium text-red-300">
                  Policy file warnings:
                </p>
                <ul className="text-red-300/90 list-disc list-inside text-xs mt-1 space-y-0.5">
                  {policyMeta.policyErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 1. Policy mode */}
            <Section
              title="Policy mode"
              hint="Block prevents commits/pushes/PRs when blocking rules fail. Warn surfaces them but lets the action through."
            >
              <div className="flex items-center gap-3">
                <Select
                  value={policy.mode}
                  onValueChange={(v) =>
                    setPolicy((p) => ({ ...p, mode: v as Policy["mode"] }))
                  }
                >
                  <SelectTrigger className="w-48 bg-secondary/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="warn">warn — observation only</SelectItem>
                    <SelectItem value="block">block — enforce</SelectItem>
                    <SelectItem value="auto_merge">
                      auto_merge — enforce + auto-merge
                    </SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                  {policy.mode === "block"
                    ? "All blocking rules below will hard-stop the gate."
                    : policy.mode === "auto_merge"
                      ? "Pass + auto-merge gates → GitHub auto-merge."
                      : "Rules surface as warnings only."}
                </span>
              </div>
            </Section>

            <Separator />

            {/* 2. Security blocking rules */}
            <Section
              title="Security blocking rules"
              hint="Each toggle flips the gate from PASS to BLOCK (or WARN, depending on mode) when the condition is met."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Toggle
                  label="Block if critical findings exist"
                  checked={!!policy.security.block_if_critical}
                  onChange={(v) => updateSecurity("block_if_critical", v)}
                />
                <Toggle
                  label="Block if high findings increased"
                  checked={!!policy.security.block_if_high_increased}
                  onChange={(v) => updateSecurity("block_if_high_increased", v)}
                />
                <Toggle
                  label="Block if medium findings increased"
                  checked={!!policy.security.block_if_medium_increased}
                  onChange={(v) =>
                    updateSecurity("block_if_medium_increased", v)
                  }
                />
                <Toggle
                  label="Block if risk score increased"
                  checked={!!policy.security.require_risk_score_not_increase}
                  onChange={(v) =>
                    updateSecurity("require_risk_score_not_increase", v)
                  }
                />
                <Toggle
                  label="Block if secrets are found"
                  checked={!!policy.security.block_if_secrets_found}
                  onChange={(v) => updateSecurity("block_if_secrets_found", v)}
                />
                <Toggle
                  label="Block if dangerous tool has no approval gate"
                  checked={
                    !!policy.security.block_if_dangerous_tool_without_approval
                  }
                  onChange={(v) =>
                    updateSecurity(
                      "block_if_dangerous_tool_without_approval",
                      v
                    )
                  }
                />
                <Toggle
                  label="Block if user input reaches dangerous code"
                  checked={
                    !!policy.security.block_if_user_input_to_dangerous_code
                  }
                  onChange={(v) =>
                    updateSecurity("block_if_user_input_to_dangerous_code", v)
                  }
                />
                <Toggle
                  label="Block if unsafe MCP config is found"
                  checked={!!policy.security.block_if_unsafe_mcp}
                  onChange={(v) => updateSecurity("block_if_unsafe_mcp", v)}
                />
                <Toggle
                  label="Block if OpenAPI/auth/schema quality fails"
                  checked={!!policy.security.block_if_schema_auth_gap}
                  onChange={(v) =>
                    updateSecurity("block_if_schema_auth_gap", v)
                  }
                />
              </div>
            </Section>

            <Separator />

            {/* 3. Numeric thresholds */}
            <Section
              title="Numeric thresholds"
              hint="Use the switch on each card to enable or disable a threshold. Disabled thresholds aren't enforced."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <NumberField
                  label="Max allowed risk score"
                  value={policy.security.max_risk_score}
                  placeholder="70"
                  min={0}
                  max={100}
                  onChange={(n) => updateSecurity("max_risk_score", n)}
                />
                <NumberField
                  label="Max risk score increase"
                  value={policy.security.max_risk_score_increase}
                  placeholder="0"
                  min={0}
                  onChange={(n) =>
                    updateSecurity("max_risk_score_increase", n)
                  }
                />
                <NumberField
                  label="Max allowed critical findings"
                  value={policy.security.max_critical_findings}
                  placeholder="0"
                  min={0}
                  onChange={(n) => updateSecurity("max_critical_findings", n)}
                />
                <NumberField
                  label="Max allowed high findings"
                  value={policy.security.max_high_findings}
                  placeholder="0"
                  min={0}
                  onChange={(n) => updateSecurity("max_high_findings", n)}
                />
              </div>
            </Section>

            <Separator />

            {/* 4. Evaluation / metrics rules */}
            <Section
              title="Evaluation / metrics rules"
              hint="Applied to every agent that has eval metrics. Per-agent overrides live in YAML under agents.<name>.*."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Toggle
                  label="Block if accuracy drops"
                  checked={!!policy.evals.block_if_accuracy_drops}
                  onChange={(v) => updateEvals("block_if_accuracy_drops", v)}
                />
                <NumberField
                  label="Minimum accuracy (0–1)"
                  value={policy.evals.min_accuracy}
                  placeholder="0.85"
                  step={0.01}
                  min={0}
                  max={1}
                  onChange={(n) => updateEvals("min_accuracy", n)}
                />
                <Toggle
                  label="Block if runtime increases"
                  checked={!!policy.evals.block_if_runtime_increases}
                  onChange={(v) =>
                    updateEvals("block_if_runtime_increases", v)
                  }
                />
                <NumberField
                  label="Maximum runtime p95 (ms)"
                  value={policy.evals.max_runtime_p95_ms}
                  placeholder="2000"
                  min={0}
                  onChange={(n) => updateEvals("max_runtime_p95_ms", n)}
                />
                <Toggle
                  label="Block if tool-selection pass rate drops"
                  checked={!!policy.evals.block_if_tool_selection_drops}
                  onChange={(v) =>
                    updateEvals("block_if_tool_selection_drops", v)
                  }
                />
                <NumberField
                  label="Minimum tool-selection pass rate (0–1)"
                  value={policy.evals.min_tool_selection_pass_rate}
                  placeholder="0.90"
                  step={0.01}
                  min={0}
                  max={1}
                  onChange={(n) =>
                    updateEvals("min_tool_selection_pass_rate", n)
                  }
                />
                <Toggle
                  label="Block if required evals are missing"
                  checked={!!policy.evals.block_if_required_evals_missing}
                  onChange={(v) =>
                    updateEvals("block_if_required_evals_missing", v)
                  }
                />
                <Toggle
                  label="Block if tests fail"
                  checked={!!policy.evals.block_if_tests_fail}
                  onChange={(v) => updateEvals("block_if_tests_fail", v)}
                />
              </div>
            </Section>

            <Separator />

            {/* 5. Pull request rules */}
            <Section title="Pull request rules">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Toggle
                  label="Run policy gate before PR"
                  checked={
                    policy.pull_request.run_policy_gate_before_pr !== false
                  }
                  onChange={(v) => updatePR("run_policy_gate_before_pr", v)}
                />
                <Toggle
                  label="Block PR if policy blocks"
                  checked={
                    policy.pull_request.block_if_policy_blocks !== false
                  }
                  onChange={(v) => updatePR("block_if_policy_blocks", v)}
                />
                <Toggle
                  label="Create draft PR on warn"
                  checked={
                    policy.pull_request.create_draft_if_warn !== false
                  }
                  onChange={(v) => updatePR("create_draft_if_warn", v)}
                />
                <Toggle
                  label="Require clean working tree before PR"
                  checked={!!policy.pull_request.require_clean_worktree}
                  onChange={(v) => updatePR("require_clean_worktree", v)}
                />
                <Toggle
                  label="Block PR from main/master"
                  checked={!!policy.pull_request.block_pr_from_main_or_master}
                  onChange={(v) =>
                    updatePR("block_pr_from_main_or_master", v)
                  }
                />
                <div className="space-y-1.5">
                  <Label className="text-xs">Default base branch</Label>
                  <Input
                    placeholder="main"
                    value={policy.pull_request.base_branch ?? ""}
                    onChange={(e) =>
                      updatePR(
                        "base_branch",
                        e.target.value.trim() || undefined
                      )
                    }
                    className="bg-secondary/50"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                <Toggle
                  label="Run scan before commit"
                  checked={policy.commit.run_scan_before_commit !== false}
                  onChange={(v) => updateCommit("run_scan_before_commit", v)}
                />
                <Toggle
                  label="Block commit if policy blocks"
                  checked={policy.commit.block_if_policy_blocks !== false}
                  onChange={(v) => updateCommit("block_if_policy_blocks", v)}
                />
                <Toggle
                  label="Run scan before push"
                  checked={policy.push.run_scan_before_push !== false}
                  onChange={(v) => updatePush("run_scan_before_push", v)}
                />
                <Toggle
                  label="Block push if policy blocks"
                  checked={policy.push.block_if_policy_blocks !== false}
                  onChange={(v) => updatePush("block_if_policy_blocks", v)}
                />
              </div>
            </Section>

            <Separator />

            {/* 6. Auto-merge rules */}
            <Section
              title="Auto-merge rules"
              hint="Default OFF. Only fires when policy mode is auto_merge AND every gate below is satisfied."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Toggle
                  label="Enable auto-merge only if policy passes"
                  checked={!!policy.auto_merge.enabled}
                  onChange={(v) => updateAutoMerge("enabled", v)}
                />
                <Toggle
                  label="Require no critical/high findings"
                  checked={!!policy.auto_merge.require_no_critical_or_high}
                  onChange={(v) =>
                    updateAutoMerge("require_no_critical_or_high", v)
                  }
                />
                <Toggle
                  label="Require accuracy not drop"
                  checked={!!policy.auto_merge.require_accuracy_not_drop}
                  onChange={(v) =>
                    updateAutoMerge("require_accuracy_not_drop", v)
                  }
                />
                <Toggle
                  label="Require runtime not increase"
                  checked={!!policy.auto_merge.require_runtime_not_increase}
                  onChange={(v) =>
                    updateAutoMerge("require_runtime_not_increase", v)
                  }
                />
                <Toggle
                  label="Require clean working tree"
                  checked={!!policy.auto_merge.require_clean_worktree}
                  onChange={(v) =>
                    updateAutoMerge("require_clean_worktree", v)
                  }
                />
                <Toggle
                  label="Trusted branches only"
                  checked={!!policy.auto_merge.trusted_branches_only}
                  onChange={(v) =>
                    updateAutoMerge("trusted_branches_only", v)
                  }
                />
              </div>
            </Section>

            <Separator />

            {/* Policy preview */}
            <Section title="Policy preview">
              <div className="rounded-md border border-border bg-secondary/30 p-3 text-sm space-y-2">
                <div>
                  <span className="text-muted-foreground">Current mode: </span>
                  <code className="text-foreground">{policy.mode}</code>
                </div>
                <div>
                  <div className="text-muted-foreground mb-1">
                    This policy will block when:
                  </div>
                  {previewBlockers.length === 0 ? (
                    <p className="text-muted-foreground italic">
                      No blocking rules enabled — nothing will be gated.
                    </p>
                  ) : (
                    <ul className="list-disc list-inside text-foreground space-y-0.5">
                      {previewBlockers.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Section>

            <Separator />

            {/* Test on latest scan */}
            <Section
              title="Test policy on latest scan"
              hint="Runs the SAVED policy against the freshest scan report in app state. Persists the result so Export Policy Report lights up."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={!project?.path || !scanReport || testing}
                  onClick={() => void handleTest()}
                >
                  {testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  Test on latest scan
                </Button>
                {!scanReport && (
                  <span className="text-xs text-muted-foreground">
                    Run a scan first to enable.
                  </span>
                )}
                {dirty && (
                  <span className="text-xs text-yellow-300">
                    You have unsaved changes — the test uses the saved
                    policy. Save first to test the draft.
                  </span>
                )}
                <ExportPolicyReportButton project={project} />
              </div>
              {testResult?.evaluation && (
                <TestResultBanner result={testResult} />
              )}
            </Section>

            {/* Footer actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                {policyMeta?.policyPath ?? ".edgeagent/policy.yaml"}
                {dirty && (
                  <Badge variant="outline" className="ml-2">
                    unsaved
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2"
                  onClick={handleResetToDefault}
                  disabled={saving}
                >
                  Reset to safe default
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2"
                  onClick={handleDiscard}
                  disabled={!dirty || saving}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="gap-2"
                  onClick={() => void handleSave()}
                  disabled={saving || !project?.path}
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save Policy
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Small subcomponents                                                        */
/* -------------------------------------------------------------------------- */

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && (
          <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
        )}
      </div>
      {children}
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3 rounded-md border border-border/60 bg-secondary/30 px-3 py-2 cursor-pointer hover:bg-secondary/50 transition-colors">
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        className="mt-0.5"
      />
      <span className="text-sm leading-snug">{label}</span>
    </label>
  )
}

function NumberField({
  label,
  value,
  placeholder,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number | undefined
  placeholder?: string
  min?: number
  max?: number
  step?: number
  onChange: (next: number | undefined) => void
}) {
  // A threshold is "enabled" when the policy has a numeric value for it;
  // `undefined` (or `null`) means the rule is off entirely. The Switch
  // below is the explicit on/off control — flipping it off clears the
  // value, flipping it back on restores the last value the user typed
  // (or falls back to the placeholder default so the field is never
  // enabled-but-empty).
  const enabled = value != null
  const [text, setText] = useState<string>(value == null ? "" : String(value))
  // Remember the last non-empty value so toggling off → on restores it
  // instead of forcing the user to re-type a number.
  const [lastValue, setLastValue] = useState<string>(
    value == null ? "" : String(value)
  )
  useEffect(() => {
    setText(value == null ? "" : String(value))
    if (value != null) setLastValue(String(value))
  }, [value])

  const handleToggle = (next: boolean) => {
    if (!next) {
      onChange(undefined)
      return
    }
    // Restore last-typed value, else fall back to placeholder, else 0.
    const restore = lastValue || placeholder || "0"
    setText(restore)
    const n = Number(restore)
    onChange(Number.isFinite(n) ? n : undefined)
  }

  return (
    <div
      className={`space-y-1.5 rounded-md border px-3 py-2 transition-colors ${
        enabled
          ? "border-border/60 bg-secondary/30"
          : "border-border/40 bg-secondary/10"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <Label
          className={`text-xs ${enabled ? "" : "text-muted-foreground"}`}
        >
          {label}
        </Label>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {enabled ? "on" : "off"}
          </span>
          <Switch checked={enabled} onCheckedChange={handleToggle} />
        </div>
      </div>
      <Input
        type="number"
        inputMode="decimal"
        value={enabled ? text : ""}
        placeholder={enabled ? placeholder : "Disabled"}
        min={min}
        max={max}
        step={step}
        disabled={!enabled}
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          if (raw.trim() === "") {
            // Empty while enabled = transient typing state. Don't flip
            // the rule off; just don't push a value upstream until they
            // type a finite number. To turn the rule off, use the
            // switch.
            onChange(undefined)
            return
          }
          setLastValue(raw)
          const n = Number(raw)
          if (Number.isFinite(n)) onChange(n)
        }}
        className="bg-secondary/50 disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  )
}

function TestResultBanner({ result }: { result: PolicyApiResponse }) {
  const ev = result.evaluation
  if (!ev) return null
  const tone =
    ev.decision === "block"
      ? "border-red-500/40 bg-red-500/10 text-red-200"
      : ev.decision === "warn"
        ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-200"
        : "border-green-500/40 bg-green-500/10 text-green-200"
  return (
    <div className={`mt-2 rounded-md border px-3 py-2 text-sm ${tone}`}>
      <p className="font-medium uppercase tracking-wide text-xs">
        Result: {ev.decision}
      </p>
      {ev.reasons.length > 0 && (
        <ul className="mt-1 list-disc list-inside text-xs space-y-0.5">
          {ev.reasons.slice(0, 5).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
          {ev.reasons.length > 5 && (
            <li className="opacity-70">
              +{ev.reasons.length - 5} more — see Export Policy Report for
              full details
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * Walks the policy and returns the human-readable list of conditions
 * that, if hit, would put the gate into block (or warn, depending on
 * `policy.mode`). Used by the live preview pane.
 */
function buildPreviewBlockers(policy: Policy): string[] {
  const out: string[] = []
  const s = policy.security
  if (s.block_if_critical) out.push("Critical findings exist")
  if (s.block_if_high_increased) out.push("High findings increased vs base")
  if (s.block_if_medium_increased)
    out.push("Medium findings increased vs base")
  if (s.require_risk_score_not_increase)
    out.push("Risk score increased vs base")
  if (typeof s.max_risk_score === "number")
    out.push(`Risk score exceeds ${s.max_risk_score}`)
  if (typeof s.max_risk_score_increase === "number")
    out.push(`Risk score grew by more than ${s.max_risk_score_increase}`)
  if (typeof s.max_critical_findings === "number")
    out.push(`More than ${s.max_critical_findings} critical findings`)
  if (typeof s.max_high_findings === "number")
    out.push(`More than ${s.max_high_findings} high findings`)
  if (s.block_if_secrets_found) out.push("Secrets are found in source")
  if (s.block_if_dangerous_tool_without_approval)
    out.push("Dangerous tools lack a human-approval gate")
  if (s.block_if_user_input_to_dangerous_code)
    out.push("User input reaches dangerous code paths")
  if (s.block_if_unsafe_mcp) out.push("Unsafe MCP configuration is found")
  if (s.block_if_schema_auth_gap)
    out.push("OpenAPI / auth / schema quality fails")

  const e = policy.evals
  if (e.block_if_accuracy_drops) out.push("Eval accuracy drops vs base")
  if (typeof e.min_accuracy === "number")
    out.push(`Eval accuracy below ${(e.min_accuracy * 100).toFixed(0)}%`)
  if (e.block_if_runtime_increases) out.push("Eval runtime increases vs base")
  if (typeof e.max_runtime_p95_ms === "number")
    out.push(`Eval runtime p95 above ${e.max_runtime_p95_ms}ms`)
  if (e.block_if_tool_selection_drops)
    out.push("Tool-selection pass rate drops vs base")
  if (typeof e.min_tool_selection_pass_rate === "number")
    out.push(
      `Tool-selection pass rate below ${(
        e.min_tool_selection_pass_rate * 100
      ).toFixed(0)}%`
    )
  if (e.block_if_required_evals_missing)
    out.push("Required eval metrics are missing")
  if (e.block_if_tests_fail) out.push("Tests fail in eval runs")
  return out
}
