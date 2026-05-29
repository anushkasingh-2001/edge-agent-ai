"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Save,
  Palette,
  ScanSearch,
  GitBranch,
  ChevronDown,
  Webhook,
  Sparkles,
  AlertTriangle,
  Github,
  Loader2,
  RefreshCw,
  XCircle,
  Zap,
  CheckCircle2,
} from "lucide-react"
import {
  consumeMigrationNotices,
  purgeLegacyProviderKeys,
  type MigrationNotice,
} from "@/lib/model-keys"
import {
  fetchGitHubRepoPermission,
  fetchGitHubStatus,
  type GitHubRepoPermissionResponse,
  type GitHubStatusResponse,
} from "@/lib/github-client"
import { GithubLoginDialog } from "@/components/github-login-dialog"
import { PolicyRulesCard } from "@/components/views/policy-rules-card"
import { SystemHealthGate } from "@/components/system-health-gate"
import {
  usePlanSummary,
  startCheckout,
  openBillingPortal,
  devLogin,
  devLogout,
  isBillingMockClient,
  DEMO_BILLING_LABEL,
} from "@/lib/plan-client"
import type { Project } from "@/lib/projects"
import type { ScanReport } from "@/lib/scan-report"
import { apiFetch } from "@/lib/api-fetch"

export interface SettingsProps {
  /** Currently opened project's filesystem path. Required for the
   *  "Selected project remote" + permission lookup in the GitHub
   *  Account card. Null when no project is open. */
  projectPath?: string | null
  /** Full Project record — needed by the Policy Rules card. */
  project?: Project | null
  /** Latest scan report — used by "Test policy on latest scan". */
  scanReport?: ScanReport | null
  /** Current branch — passed into the policy test so the right
   *  baseline is loaded. */
  currentBranch?: string | null
}

/**
 * Settings.
 *
 * Hosted-only product. The Settings page no longer carries any provider
 * key UI: AI is included in the user's plan and the server reads keys
 * from server env / secret manager. The primary AI-related card is now
 * "Plan & AI" — current tier, credits remaining, included features,
 * upgrade CTA.
 *
 * Legacy localStorage cleanup runs ONCE on mount via
 * `purgeLegacyProviderKeys()`. Any stale provider credentials from earlier
 * pre-hosted builds get wiped; stale Anthropic model ids get migrated
 * (notice surfaced in the amber banner just below).
 */
export function Settings({
  projectPath = null,
  project = null,
  scanReport = null,
  currentBranch = null,
}: SettingsProps = {}) {
  const { theme, setTheme } = useTheme()
  const [webhookEnabled, setWebhookEnabled] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [alertDestination, setAlertDestination] = useState("slack")

  // Legacy-key purge on mount. We surface a one-shot banner when
  // either (a) the purge removed stale provider credentials from a
  // previous pre-hosted build, or (b) a saved Anthropic model id was
  // rewritten to
  // the current catalog.
  const [migrationNotices, setMigrationNotices] = useState<MigrationNotice[]>([])
  const [legacyKeysWiped, setLegacyKeysWiped] = useState(false)
  useEffect(() => {
    const result = purgeLegacyProviderKeys()
    if (result.purged && result.noticesAdded === 0) {
      setLegacyKeysWiped(true)
    }
    const notices = consumeMigrationNotices()
    if (notices.length > 0) setMigrationNotices(notices)
  }, [])

  const { plan, loading: planLoading } = usePlanSummary()

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Configure Edge Agent AI preferences</p>
      </div>

      {/* A0. System Health */}
      <SystemHealthGate />

      {/* A. Appearance */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Appearance
          </CardTitle>
          <CardDescription>Customize the look and feel</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Theme</Label>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger className="w-48 bg-secondary/50">
                <SelectValue placeholder="Select theme" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Choose how Edge Agent AI appears on this device.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* One-shot legacy-key wipe banner. Hosted contract: the app no
          longer stores provider credentials client-side; the purge runs once
          on mount. */}
      {legacyKeysWiped && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="flex-1">
            Edge Agent AI is now Hosted-only. Any provider credentials
            you previously stored in this browser have been removed —
            AI is included in your plan and runs through Edge Agent
            AI&apos;s shared infrastructure.
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setLegacyKeysWiped(false)}
            className="h-6 px-2 text-emerald-300 hover:bg-emerald-500/20"
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* One-shot Anthropic migration banner. */}
      {migrationNotices.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="flex-1 space-y-1">
            {migrationNotices.map((n, i) => (
              <div key={`${n.slot}-${i}`}>
                Your saved <span className="capitalize">{n.slot}</span> model
                <code className="mx-1 rounded bg-yellow-500/10 px-1 font-mono">
                  {n.oldModel}
                </code>
                was outdated and was updated to
                <code className="mx-1 rounded bg-yellow-500/10 px-1 font-mono">
                  {n.newModel}
                </code>
                .
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setMigrationNotices([])}
            className="h-6 px-2 text-yellow-300 hover:bg-yellow-500/20"
            aria-label="Dismiss"
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* A2. Demo account (mock billing only) — lets the user establish
          an email-based session without a real identity provider, so the
          selected plan is saved against their email. */}
      {process.env.NEXT_PUBLIC_BILLING_MOCK === "1" && <DemoAccountCard />}

      {/* B. Plan & AI — replaces the old "LLM Providers" editor.
          Hosted AI is included in the user's plan; no key fields,
          no base URL fields, no provider-key toggle. The user sees
          current tier, credits left, included features, and the
          upgrade button. */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Plan &amp; AI
          </CardTitle>
          <CardDescription>
            AI explanations, fixes, and Pro/Max modes are included in
            your plan. Edge Agent AI manages provider credentials
            centrally — you never need an OpenAI / Anthropic / Gemini
            key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {process.env.NEXT_PUBLIC_BILLING_MOCK === "1" && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.08] p-3 text-xs flex items-center gap-2 text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{DEMO_BILLING_LABEL}</span>
            </div>
          )}
          <div className="rounded-md border border-accent/40 bg-accent/[0.06] p-3 text-xs flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            <span>
              <strong>AI included in your plan.</strong> No API key required.
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile
              label="Current plan"
              value={planLoading ? "…" : plan?.tier ?? "—"}
              accent="text-foreground"
            />
            <StatTile
              label="AI credits remaining"
              value={
                planLoading
                  ? "…"
                  : plan
                    ? `${plan.creditsRemaining} / ${plan.creditsTotal}`
                    : "—"
              }
              accent={
                plan && plan.creditsRemaining > 0
                  ? "text-emerald-300"
                  : "text-yellow-300"
              }
            />
            <StatTile
              label="Manual model picks"
              value={
                planLoading
                  ? "…"
                  : plan?.allowManualModelSelection
                    ? "Enabled"
                    : "Pro plan only"
              }
              accent={
                plan?.allowManualModelSelection
                  ? "text-emerald-300"
                  : "text-muted-foreground"
              }
            />
          </div>

          <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Included AI features
            </div>
            <ul className="space-y-1 text-muted-foreground">
              {(plan?.allowedModes ?? []).map((m) => (
                <li key={m} className="flex items-center gap-2">
                  <Zap className="h-3 w-3 text-accent" />
                  <span className="uppercase">{m}</span>
                  <span className="opacity-70">
                    {modeBlurb(m)}
                  </span>
                </li>
              ))}
              {(!plan?.allowedModes || plan.allowedModes.length === 0) && (
                <li className="text-muted-foreground">
                  No AI modes are enabled on this plan.
                </li>
              )}
            </ul>
          </div>

          <PlanActions plan={plan} />
          <p className="text-[11px] text-muted-foreground">
            Provider credentials are managed centrally by Edge Agent
            AI — no API key is ever stored in this browser.
          </p>
        </CardContent>
      </Card>

      {/* B2. GitHub Account */}
      <GitHubAccountCard projectPath={projectPath} />

      {/* B3. Policy Rules */}
      <PolicyRulesCard
        project={project}
        scanReport={scanReport}
        currentBranch={currentBranch}
      />

      {/* C. Scan Preferences */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ScanSearch className="h-4 w-4" />
            Scan Preferences
          </CardTitle>
          <CardDescription>Configure scanning behavior</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-scan local file changes</Label>
              <p className="text-sm text-muted-foreground">
                Rerun selected checks when files are modified inside the opened local project folder. For GitHub repos, remote changes are scanned after you pull/sync locally.
              </p>
            </div>
            <Switch defaultChecked />
          </div>
          <Separator className="bg-border" />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Desktop notifications</Label>
              <p className="text-sm text-muted-foreground">
                Show a system notification when critical or high-risk findings are detected.
              </p>
            </div>
            <Switch defaultChecked />
          </div>
        </CardContent>
      </Card>

      {/* C. Git Workflow */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Git Workflow
          </CardTitle>
          <CardDescription>Configure version control integration</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Run scan before commit</Label>
            </div>
            <Switch defaultChecked />
          </div>
          <Separator className="bg-border" />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Run scan before push</Label>
            </div>
            <Switch defaultChecked />
          </div>
          <Separator className="bg-border" />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Warn on critical findings</Label>
            </div>
            <Switch defaultChecked />
          </div>
          <p className="text-sm text-muted-foreground">
            Use these settings to check the selected branch before committing or pushing changes.
          </p>
        </CardContent>
      </Card>

      {/* D. Advanced Integrations */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <Card className="bg-card border-border">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-secondary/30 transition-colors rounded-t-lg">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Webhook className="h-4 w-4" />
                  Advanced Integrations
                </CardTitle>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              </div>
              <CardDescription>Configure external service integrations</CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-6 pt-0">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Send scan alerts to external tool</Label>
                </div>
                <Switch checked={webhookEnabled} onCheckedChange={setWebhookEnabled} />
              </div>
              {webhookEnabled && (
                <>
                  <Separator className="bg-border" />
                  <div className="space-y-2">
                    <Label>Alert destination</Label>
                    <Select value={alertDestination} onValueChange={setAlertDestination}>
                      <SelectTrigger className="w-48 bg-secondary/50">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="slack">Slack</SelectItem>
                        <SelectItem value="discord">Discord</SelectItem>
                        <SelectItem value="jira">Jira</SelectItem>
                        <SelectItem value="linear">Linear</SelectItem>
                        <SelectItem value="custom">Custom webhook</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="webhook">Webhook URL</Label>
                    <Input
                      id="webhook"
                      placeholder="https://hooks.slack.com/..."
                      className="bg-secondary/50"
                    />
                    <p className="text-sm text-muted-foreground">
                      Paste the webhook URL from Slack, Discord, Jira, Linear, or your internal system. Edge Agent AI will send scan summaries after scans.
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button>
          <Save className="h-4 w-4 mr-2" />
          Save Settings
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Plan & AI helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Demo-only email sign-in (mock billing). Establishes a session cookie
 *  via `/api/auth/dev-login` so the selected plan is persisted against
 *  the user's email. Shows the current signed-in email (read from
 *  `/api/plan`) and a sign-out action. */
function DemoAccountCard() {
  const [email, setEmail] = useState("")
  const [currentEmail, setCurrentEmail] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const res = await apiFetch("/api/plan")
      if (!res.ok) return
      const json = (await res.json()) as { authenticated?: boolean; email?: string | null }
      setAuthenticated(Boolean(json.authenticated))
      setCurrentEmail(json.email ?? null)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const signIn = async () => {
    setBusy(true)
    setError(null)
    const r = await devLogin(email.trim())
    if (!r.ok) {
      setError(r.error)
      setBusy(false)
      return
    }
    if (typeof window !== "undefined") window.location.reload()
  }

  const signOut = async () => {
    setBusy(true)
    setError(null)
    await devLogout()
    if (typeof window !== "undefined") window.location.reload()
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Demo account
        </CardTitle>
        <CardDescription>
          Demo mode — sign in with an email to create a session. Your
          email and selected plan are saved server-side (file store in
          dev, Postgres when DATABASE_URL is set). No password, no real
          payment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {authenticated && currentEmail ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs">
              Signed in as <strong className="text-foreground">{currentEmail}</strong>
            </div>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={signOut}>
              {busy ? "…" : "Sign out"}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="demo-email" className="text-xs">
              Email
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="demo-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="max-w-xs"
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || email.trim().length === 0}
                onClick={signIn}
              >
                {busy ? "…" : "Sign in"}
              </Button>
            </div>
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 text-xs text-red-400">
            <XCircle className="h-3.5 w-3.5" />
            <span>{error}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Upgrade + manage-billing CTAs. Hits `/api/billing/checkout` to
 *  start a Stripe Checkout session, or `/api/billing/portal` to open
 *  the Stripe Customer Portal for paid users. Surfaces server
 *  configuration errors instead of opening a broken URL. */
function PlanActions({
  plan,
}: {
  plan: Pick<NonNullable<ReturnType<typeof usePlanSummary>["plan"]>, "tier" | "subscriptionStatus"> | null
}) {
  const [busy, setBusy] = useState<"starter" | "pro" | "team" | "portal" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasSub =
    plan?.tier !== "free" && plan?.tier !== undefined && plan?.subscriptionStatus !== "none"

  const useMock = isBillingMockClient()

  const start = async (tier: "starter" | "pro" | "team") => {
    setBusy(tier)
    setError(null)
    const r = await startCheckout(tier)
    if (!r.ok) {
      setError(r.error)
      setBusy(null)
      return
    }
    if (useMock) {
      if (typeof window !== "undefined") window.location.reload()
      return
    }
    setBusy(null)
  }

  const portal = async () => {
    setBusy("portal")
    setError(null)
    const r = await openBillingPortal()
    if (!r.ok) setError(r.error)
    setBusy(null)
  }

  return (
    <div className="space-y-2">
      {useMock && (
        <p className="text-[11px] text-amber-200/90">{DEMO_BILLING_LABEL}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {plan?.tier !== "starter" && (
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => start("starter")}>
            {busy === "starter" ? "…" : "Upgrade to Starter"}
          </Button>
        )}
        {plan?.tier !== "pro" && plan?.tier !== "team" && plan?.tier !== "enterprise" && (
          <Button type="button" variant="default" size="sm" disabled={busy !== null} onClick={() => start("pro")}>
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            {busy === "pro" ? "…" : "Upgrade to Pro"}
          </Button>
        )}
        {plan?.tier !== "team" && plan?.tier !== "enterprise" && (
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => start("team")}>
            {busy === "team" ? "…" : "Upgrade to Team"}
          </Button>
        )}
        {hasSub && !useMock && (
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={portal}>
            {busy === "portal" ? "…" : "Manage billing"}
          </Button>
        )}
      </div>
      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-red-300">
          <AlertTriangle className="h-3 w-3 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}

function modeBlurb(mode: string): string {
  switch (mode) {
    case "save":
      return "— deterministic scanner + AI explanations"
    case "auto":
      return "— smart model routing (cheap → strong)"
    case "pro":
      return "— stronger model, larger context"
    case "max":
      return "— plan → patch → validate (deep review)"
    case "manual":
      return "— pick a specific model per task"
    default:
      return ""
  }
}

function StatTile({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent: string
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`text-sm font-semibold mt-1 ${accent}`}>{value}</div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* GitHub Account card                                                        */
/* -------------------------------------------------------------------------- */

function GitHubAccountCard({ projectPath }: { projectPath: string | null }) {
  const [status, setStatus] = useState<GitHubStatusResponse | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [perm, setPerm] = useState<GitHubRepoPermissionResponse | null>(null)
  const [permLoading, setPermLoading] = useState(false)
  const [showConnectInstructions, setShowConnectInstructions] = useState(false)
  const [showDisconnectInstructions, setShowDisconnectInstructions] = useState(false)
  const [signInOpen, setSignInOpen] = useState(false)

  const refreshStatus = async () => {
    setStatusLoading(true)
    try {
      const s = await fetchGitHubStatus()
      setStatus(s)
    } catch {
      setStatus({
        ghInstalled: false,
        authenticated: false,
        login: null,
        message: "Failed to reach /api/github/status.",
      })
    } finally {
      setStatusLoading(false)
    }
  }

  const refreshPermissions = async () => {
    if (!projectPath) {
      setPerm(null)
      return
    }
    setPermLoading(true)
    try {
      const p = await fetchGitHubRepoPermission(projectPath)
      setPerm(p)
    } catch {
      setPerm({
        message: "Failed to reach /api/github/repo-permission.",
      })
    } finally {
      setPermLoading(false)
    }
  }

  useEffect(() => {
    void refreshStatus()
  }, [])
  useEffect(() => {
    void refreshPermissions()
  }, [projectPath])

  const ghInstalled = !!status?.ghInstalled
  const authed = !!status?.authenticated
  const login = status?.login ?? null

  let permLabel = "unknown"
  let permClass = "bg-secondary text-muted-foreground"
  if (perm?.resolved && perm.permissions) {
    if (perm.permissions.admin) {
      permLabel = "admin"
      permClass = "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    } else if (perm.permissions.maintain || perm.permissions.push) {
      permLabel = "write"
      permClass = "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    } else if (perm.permissions.triage || perm.permissions.pull) {
      permLabel = "read"
      permClass = "bg-yellow-500/15 text-yellow-300 border-yellow-500/40"
    } else {
      permLabel = "none"
      permClass = "bg-red-500/15 text-red-300 border-red-500/40"
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Github className="h-4 w-4" />
          GitHub Account
        </CardTitle>
        <CardDescription>
          Detect which GitHub account git/gh is using and whether it can
          push to the currently opened repo. We never ask for your
          password or store a personal access token — authentication
          lives in <code>gh</code> / your system credential manager.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <StatRow
            label="GitHub CLI installed"
            value={statusLoading ? "Checking…" : ghInstalled ? "yes" : "no"}
            ok={ghInstalled}
            warn={!statusLoading && !ghInstalled}
          />
          <StatRow
            label="Authenticated user"
            value={
              statusLoading
                ? "Checking…"
                : authed
                  ? login ?? "unknown"
                  : "Not connected"
            }
            ok={authed}
            warn={!statusLoading && ghInstalled && !authed}
          />
          <StatRow
            label="Selected project remote"
            value={
              !projectPath
                ? "No project open"
                : permLoading
                  ? "Checking…"
                  : perm?.notGitHub
                    ? "Not a GitHub remote"
                    : perm?.owner && perm?.repo
                      ? `${perm.owner}/${perm.repo}`
                      : "—"
            }
            ok={!!perm?.owner && !!perm?.repo}
            warn={!!projectPath && !!perm && !perm.owner && !permLoading}
          />
          <StatRow
            label="Permission"
            value={permLoading ? "Checking…" : permLabel}
            ok={
              perm?.resolved === true &&
              !!perm.permissions &&
              (perm.permissions.admin ||
                perm.permissions.maintain ||
                perm.permissions.push)
            }
            warn={
              perm?.resolved === true &&
              !!perm.permissions &&
              !perm.permissions.admin &&
              !perm.permissions.maintain &&
              !perm.permissions.push
            }
            badgeClass={permClass}
          />
        </div>

        {(status?.message || perm?.message) && (
          <div className="rounded-md border border-border bg-secondary/20 p-2 text-xs text-muted-foreground space-y-1">
            {status?.message && (
              <div>
                <span className="font-medium text-foreground">CLI:</span>{" "}
                {status.message}
              </div>
            )}
            {perm?.message && (
              <div>
                <span className="font-medium text-foreground">Repo:</span>{" "}
                {perm.message}
              </div>
            )}
          </div>
        )}

        {ghInstalled &&
          authed &&
          perm?.protocol === "https" &&
          perm.resolved === false && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-300">
              Heads up: this remote uses HTTPS. Your browser/CLI login may
              be correct, but <code>git push</code> uses stored Git
              credentials. If push fails with 403, re-authenticate Git
              with <code>gh auth login</code> or switch the remote to
              SSH.
            </div>
          )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={refreshStatus}
            disabled={statusLoading}
          >
            {statusLoading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            Check GitHub Status
          </Button>
          <Button type="button" size="sm" onClick={() => setSignInOpen(true)}>
            <Github className="h-3.5 w-3.5 mr-1.5" />
            {status?.authenticated ? "Manage GitHub account" : "Sign in with GitHub"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowConnectInstructions((v) => !v)}
            className="text-xs text-muted-foreground"
          >
            Use gh CLI instead
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={refreshPermissions}
            disabled={permLoading || !projectPath}
          >
            {permLoading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            Refresh Permissions
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowDisconnectInstructions((v) => !v)}
          >
            <XCircle className="h-3.5 w-3.5 mr-1.5" />
            Disconnect…
          </Button>
        </div>

        {showConnectInstructions && (
          <InstructionsPanel
            title="Sign in to GitHub from your terminal"
            steps={[
              "Open a terminal in this project folder.",
              "Run: gh auth login",
              "Choose GitHub.com, HTTPS, then 'Login with a web browser'.",
              "Paste the one-time code into the browser window gh opens.",
              "Come back here and click 'Check GitHub Status'.",
            ]}
            footer={
              ghInstalled
                ? undefined
                : "First install the GitHub CLI from https://cli.github.com/."
            }
          />
        )}
        {showDisconnectInstructions && (
          <InstructionsPanel
            title="Disconnect GitHub account"
            steps={[
              "If you signed in inside Edge Agent AI, click 'Manage GitHub account' above and use 'Sign out' — that deletes the local token.",
              "If you used the gh CLI: gh auth logout",
              "If git push still uses an old account, also clear the cached HTTPS credential:",
              "  macOS: printf 'host=github.com\\nprotocol=https\\n' | git credential-osxkeychain erase",
              "  Linux (libsecret): git credential-cache exit",
              "  Windows: open 'Credential Manager' and remove github.com entries",
              "Click 'Check GitHub Status' to confirm.",
            ]}
          />
        )}
      </CardContent>
      <GithubLoginDialog
        open={signInOpen}
        onOpenChange={setSignInOpen}
        onAuthChanged={() => {
          void refreshStatus()
          void refreshPermissions()
        }}
      />
    </Card>
  )
}

function StatRow({
  label,
  value,
  ok,
  warn,
  badgeClass,
}: {
  label: string
  value: string
  ok?: boolean
  warn?: boolean
  badgeClass?: string
}) {
  const cls =
    badgeClass ??
    (ok
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
      : warn
        ? "bg-yellow-500/15 text-yellow-300 border-yellow-500/40"
        : "bg-secondary text-muted-foreground")
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-secondary/10 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Badge variant="outline" className={cls}>
        {value}
      </Badge>
    </div>
  )
}

function InstructionsPanel({
  title,
  steps,
  footer,
}: {
  title: string
  steps: string[]
  footer?: string
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs space-y-2">
      <div className="font-medium text-sm">{title}</div>
      <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
        {steps.map((s, i) => (
          <li key={i} className="font-mono whitespace-pre-wrap">
            {s}
          </li>
        ))}
      </ol>
      {footer && (
        <div className="text-[11px] text-muted-foreground">{footer}</div>
      )}
    </div>
  )
}
