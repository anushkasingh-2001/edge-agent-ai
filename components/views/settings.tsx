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
  KeyRound,
  Eye,
  EyeOff,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Github,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react"
import {
  loadProviderConfigs,
  saveProviderConfig,
  deleteProviderConfig,
  slotConfigId,
  getSlotConfig,
  maskKey,
  LLM_SLOTS,
  SLOT_META,
  type LlmSlot,
  type ModelProviderConfig,
} from "@/lib/model-keys"
import { MODEL_CATALOG, isKnownModel } from "@/lib/model-catalog"
import {
  fetchGitHubRepoPermission,
  fetchGitHubStatus,
  type GitHubRepoPermissionResponse,
  type GitHubStatusResponse,
} from "@/lib/github-client"
import { GithubLoginDialog } from "@/components/github-login-dialog"
import { PolicyRulesCard } from "@/components/views/policy-rules-card"
import { SystemHealthGate } from "@/components/system-health-gate"
import type { Project } from "@/lib/projects"
import type { ScanReport } from "@/lib/scan-report"

export interface SettingsProps {
  /** Currently opened project's filesystem path. Required for the
   *  "Selected project remote" + permission lookup in the GitHub
   *  Account card. Null when no project is open. */
  projectPath?: string | null
  /** Full Project record — needed by the Policy Rules card so it can
   *  load / save .edgeagent/policy.yaml and persist the latest
   *  policy result to localStorage. Falling back to null when no
   *  project is open. */
  project?: Project | null
  /** Latest scan report — used by "Test policy on latest scan". */
  scanReport?: ScanReport | null
  /** Current branch — passed into the policy test so the right
   *  baseline is loaded. */
  currentBranch?: string | null
}

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

  // LLM provider slots — read once on mount, updated locally on every save/delete
  // so we don't need to round-trip through React Context.
  const [providers, setProviders] = useState<ModelProviderConfig[]>([])
  useEffect(() => {
    setProviders(loadProviderConfigs())
  }, [])

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Configure Edge Agent AI preferences</p>
      </div>

      {/* A0. System Health — desktop-readiness probe for git / gh /
          scanner. Surfaces here (and not just on first launch) because
          users typically come to Settings when something feels off,
          and "is my scanner even installed?" is the cheapest
          first-question to answer. Soft-blocks via warnings only;
          actual feature gating lives in the consumers (Run Scan,
          Create PR, etc.). */}
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

      {/* B. LLM Providers — required for ALL AI features in this MVP */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            LLM Providers
          </CardTitle>
          <CardDescription>
            Bring your own API key. Edge Agent AI never provides or stores
            hosted credits in this MVP. Your provider bills you directly.
            Keys are stored locally in your browser only — never sent to
            our servers — and are forwarded to the configured provider
            only for the duration of the request that needs them. They
            are never written to the explanation cache, logged, or
            included in error messages.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent-foreground">
            <KeyRound className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>BYOK only.</strong> AI explanations, fixes,
              Pro/Max/Manual modes all require a key configured here.
              The scanner itself is deterministic and runs without
              any key. Use <em>Test key</em> below to validate a
              provider before relying on it.
            </span>
          </div>
          <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Local-storage keys are fine for personal dev use. Don't use
              production / shared API keys here.
            </span>
          </div>
          <div className="space-y-3">
            {LLM_SLOTS.map((slot) => (
              <ProviderSlotEditor
                key={slot}
                slot={slot}
                config={getSlotConfig(slot, providers)}
                onSaved={(next) => setProviders(next)}
                onDeleted={(next) => setProviders(next)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* B2. GitHub Account — checks gh CLI install/auth and per-repo
          push permission so the user knows which account git push will
          actually use before they run it. Settings is the canonical
          place to fix "wrong account cached" type errors. */}
      <GitHubAccountCard projectPath={projectPath} />

      {/* B3. Policy Rules — authoritative editor for
          .edgeagent/policy.yaml. Lives in Settings so users can
          discover and edit gates from one place. Exports to backend
          on save; backend enforcement is unchanged. */}
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
/* Provider slot editor                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One row of the LLM Providers card. A "slot" is a fixed named provider
 * (OpenAI, Anthropic, Gemini, Custom OpenAI-compatible) — we use named
 * slots rather than a freeform "add provider" form so users see the
 * familiar brands and the Playground / Chat Assistant can ask for a
 * specific slot by name.
 *
 * Local edit state is kept inside this component; only Save / Delete
 * propagate back via the parent's setProviders so the page-level list
 * stays the source of truth for everything else (Playground, Chat).
 */
function ProviderSlotEditor({
  slot,
  config,
  onSaved,
  onDeleted,
}: {
  slot: LlmSlot
  config: ModelProviderConfig | undefined
  onSaved: (next: ModelProviderConfig[]) => void
  onDeleted: (next: ModelProviderConfig[]) => void
}) {
  const meta = SLOT_META[slot]
  const isOpenAiCompat = meta.type === "openai_compatible"

  // Form state
  const [model, setModel] = useState<string>(config?.model ?? meta.defaultModel)
  const [apiKey, setApiKey] = useState<string>(config?.apiKey ?? "")
  const [baseUrl, setBaseUrl] = useState<string>(
    config?.baseUrl ?? meta.defaultBaseUrl ?? ""
  )
  const [showKey, setShowKey] = useState<boolean>(false)
  // True while the user is rotating the key for an already-configured slot.
  // Lets the input sit empty with "Replace key…" placeholder rather than
  // round-tripping the stored key through the mask string (which would
  // corrupt the saved value if the user typed into the masked text).
  const [editingKey, setEditingKey] = useState<boolean>(false)
  const [justSaved, setJustSaved] = useState<boolean>(false)
  // "Test key" result: ``null`` when never run, otherwise the parsed
  // /api/byok/test response. The ``warning`` field on a success means
  // the key authenticated but the account needs attention before AI
  // calls will run end-to-end (e.g. Anthropic billing/credits).
  const [testing, setTesting] = useState<boolean>(false)
  const [testResult, setTestResult] = useState<
    | { ok: true; model: string; warning?: string }
    | { ok: false; message: string; code?: string }
    | null
  >(null)

  // When the underlying config changes (e.g. user removed and re-saved
  // from another tab), reset the editor to the new value.
  useEffect(() => {
    setModel(config?.model ?? meta.defaultModel)
    setApiKey("")
    setEditingKey(false)
    setBaseUrl(config?.baseUrl ?? meta.defaultBaseUrl ?? "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.id, config?.updatedAt])

  const modelChanged = (model || "") !== (config?.model ?? meta.defaultModel)
  const baseChanged =
    isOpenAiCompat &&
    (baseUrl || "") !== (config?.baseUrl ?? meta.defaultBaseUrl ?? "")
  // Dirty when:
  //  - any free-form field changed
  //  - OR the user is rotating an existing key (editingKey + non-empty)
  //  - OR there's no saved key yet and they typed one in
  const dirty =
    modelChanged ||
    baseChanged ||
    (!config && apiKey.trim().length > 0) ||
    (!!config && editingKey && apiKey.trim().length > 0)

  function save() {
    // Effective key: brand-new entry or user typed a new one to rotate;
    // otherwise keep the existing saved key untouched (user only edited
    // model / base URL).
    const keyToUse = (() => {
      if (apiKey.trim().length > 0) return apiKey.trim()
      if (config?.apiKey) return config.apiKey
      return ""
    })()
    if (!keyToUse) return
    const now = new Date().toISOString()
    const next: ModelProviderConfig = {
      id: slotConfigId(slot),
      type: meta.type,
      label: meta.label,
      model: (model || meta.defaultModel).trim(),
      apiKey: keyToUse,
      baseUrl: isOpenAiCompat
        ? (baseUrl || meta.defaultBaseUrl || "").trim() || undefined
        : undefined,
      createdAt: config?.createdAt ?? now,
      updatedAt: now,
    }
    onSaved(saveProviderConfig(next))
    setApiKey("")
    setEditingKey(false)
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 2200)
  }

  function remove() {
    if (!config) return
    onDeleted(deleteProviderConfig(config.id))
    setApiKey("")
    setEditingKey(false)
    setJustSaved(false)
  }

  const configured = !!config?.apiKey
  return (
    <div className="rounded-lg border border-border/60 bg-secondary/10 p-3 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{meta.label}</span>
          {configured ? (
            <Badge
              variant="outline"
              className="bg-green-500/10 text-green-400 border-green-500/20 text-[10px]"
            >
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Configured
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">
              Not configured
            </Badge>
          )}
          {!meta.runnerImplemented && (
            <Badge
              variant="outline"
              className="bg-yellow-500/10 text-yellow-400 border-yellow-500/20 text-[10px]"
              title="Key stores locally but the runtime call isn't wired yet — the playground will surface a clear error instead of pretending."
            >
              Runner pending
            </Badge>
          )}
        </div>
        {justSaved && (
          <span className="text-[11px] text-green-400 inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" /> Saved
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Model</Label>
          {/* Curated dropdown of known model ids for this provider, plus
           *  a "Custom…" option that flips back to a free-form input.
           *  Saving a model id outside the catalog (eg. a private fine-
           *  tune) automatically renders as Custom on next mount. */}
          <ModelPicker
            slot={slot}
            value={model}
            onChange={setModel}
            placeholder={meta.defaultModel}
          />
        </div>
        {isOpenAiCompat && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Base URL{" "}
              <span className="text-[10px]">
                (optional — defaults to {meta.defaultBaseUrl ?? "OpenAI"})
              </span>
            </Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={meta.defaultBaseUrl ?? "https://api.openai.com/v1"}
              className="bg-secondary/40 h-9 text-sm font-mono"
            />
          </div>
        )}
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">API key</Label>
        {/* When a key is already saved we render two states:
         *   - Default: read-only masked preview + "Replace" button. Users
         *     can confirm a key is stored without us round-tripping the
         *     real value through the input.
         *   - Editing: blank input with placeholder "Enter new key…".
         * For unconfigured slots the input is always editable. */}
        {configured && !editingKey ? (
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={
                showKey
                  ? config?.apiKey ?? ""
                  : maskKey(config?.apiKey ?? "")
              }
              readOnly
              className="bg-secondary/40 h-9 text-sm font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowKey((s) => !s)}
              className="h-9"
              title={showKey ? "Hide key" : "Show key"}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setEditingKey(true)
                setApiKey("")
                setShowKey(true)
              }}
              className="h-9"
            >
              Replace
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                editingKey
                  ? "Enter new key to replace…"
                  : meta.type === "openai_compatible"
                  ? "sk-…"
                  : meta.type === "anthropic"
                  ? "sk-ant-…"
                  : "AIza…"
              }
              className="bg-secondary/40 h-9 text-sm font-mono"
              autoComplete="off"
              autoFocus={editingKey}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowKey((s) => !s)}
              className="h-9"
              title={showKey ? "Hide key" : "Show key"}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            {editingKey && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingKey(false)
                  setApiKey("")
                }}
                className="h-9 text-muted-foreground"
              >
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>

      {testResult ? (
        (() => {
          // Three visual states:
          //   * ok + no warning   → solid green "key works"
          //   * ok + warning      → amber "works but ..." (e.g.
          //                        Anthropic billing not enabled)
          //   * !ok               → red error with upstream message
          const tone = testResult.ok
            ? testResult.warning
              ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-300"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            : "border-destructive/40 bg-destructive/10 text-destructive"
          return (
            <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${tone}`}>
              {testResult.ok ? (
                testResult.warning ? (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      Key authenticated with{" "}
                      <span className="font-mono">{testResult.model}</span>.{" "}
                      {testResult.warning}
                    </span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      Key works. Tested with{" "}
                      <span className="font-mono">{testResult.model}</span>.
                    </span>
                  </>
                )
              ) : (
                <>
                  <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span className="whitespace-pre-wrap break-words">{testResult.message}</span>
                </>
              )}
            </div>
          )
        })()
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {configured && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={remove}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            Remove
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            // Use the typed key if present (the user is rotating or
            // entering for the first time); otherwise fall back to the
            // stored one so "Test key" works without forcing the user
            // to re-paste a previously-saved key.
            const keyForTest = apiKey.trim() || config?.apiKey || ""
            if (!keyForTest) {
              setTestResult({
                ok: false,
                message:
                  "API key not provided. Add your provider key in Settings to use AI explanations and fixes.",
              })
              return
            }
            setTesting(true)
            setTestResult(null)
            try {
              const res = await fetch("/api/byok/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  provider: meta.type === "openai_compatible" && slot === "custom"
                    ? "custom"
                    : meta.type,
                  apiKey: keyForTest,
                  baseUrl: isOpenAiCompat
                    ? (baseUrl || meta.defaultBaseUrl || "").trim() || undefined
                    : undefined,
                  model: (model || meta.defaultModel).trim(),
                }),
              })
              const j = (await res.json()) as
                | { ok: true; provider: string; model: string; warning?: string }
                | { ok: false; code: string; message: string; upstream?: string }
              if ("ok" in j && j.ok) {
                setTestResult({
                  ok: true,
                  model: j.model,
                  warning: j.warning,
                })
              } else {
                // Surface the upstream provider body verbatim when
                // available so the user sees the actual reason
                // (e.g. Anthropic's "credit balance is too low")
                // instead of a generic line.
                setTestResult({
                  ok: false,
                  code: (j as { code?: string }).code,
                  message: (j as { message: string }).message ?? "Test failed.",
                })
              }
            } catch (e) {
              setTestResult({
                ok: false,
                message: `Network error: ${(e as Error).message}`,
              })
            } finally {
              setTesting(false)
            }
          }}
          disabled={testing || (!apiKey.trim() && !config?.apiKey)}
          title={
            !apiKey.trim() && !config?.apiKey
              ? "Enter a key first"
              : "Validate this key + model with a single low-cost upstream call"
          }
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
          )}
          {testing ? "Testing…" : "Test key"}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={
            // Save is allowed when there's _something_ that needs writing
            // and we have a key on file (either typed now or already
            // stored). The dirty check already excludes "nothing changed".
            !dirty || (!config?.apiKey && !apiKey.trim())
          }
          title={
            !config?.apiKey && !apiKey.trim()
              ? "Enter an API key first"
              : !dirty
              ? "Nothing changed"
              : "Save this provider"
          }
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {configured ? "Update" : "Save"}
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Model picker (Settings)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Curated dropdown of known models for a provider slot, with a
 * "Custom model name…" escape hatch that swaps the picker for a
 * free-form input. Used inside the slot editor.
 *
 * The component is uncontrolled w.r.t. "is the user picking custom?" —
 * we derive that from whether the value is in the catalog, which means
 * loading a saved custom model id always defaults to the input, no
 * extra state needed.
 */
const CUSTOM_SENTINEL = "__custom__"

function ModelPicker({
  slot,
  value,
  onChange,
  placeholder,
}: {
  slot: LlmSlot
  value: string
  onChange: (next: string) => void
  placeholder?: string
}) {
  const catalog = MODEL_CATALOG[slot]
  const known = isKnownModel(slot, value)
  // Track "user explicitly picked Custom" so an empty string doesn't
  // collapse the picker back to a known item.
  const [customMode, setCustomMode] = useState<boolean>(!known && value !== "")

  function handleSelect(v: string) {
    if (v === CUSTOM_SENTINEL) {
      setCustomMode(true)
      // Don't blow away the existing value when entering custom mode.
      if (isKnownModel(slot, value)) onChange("")
      return
    }
    setCustomMode(false)
    onChange(v)
  }

  if (customMode || (!known && value !== "")) {
    return (
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "model-id"}
          className="bg-secondary/40 h-9 text-sm font-mono"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setCustomMode(false)
            onChange(catalog[0]?.id ?? "")
          }}
          className="h-9 text-xs text-muted-foreground"
          title="Switch back to the curated list"
        >
          Use list
        </Button>
      </div>
    )
  }

  return (
    <Select
      value={known && value ? value : catalog[0]?.id ?? ""}
      onValueChange={handleSelect}
    >
      <SelectTrigger className="bg-secondary/40 h-9 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {catalog.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            <span className="flex items-center gap-2">
              <span className="font-mono">{m.id}</span>
              {m.hint && (
                <span className="text-[10px] text-muted-foreground">
                  {m.hint}
                </span>
              )}
            </span>
          </SelectItem>
        ))}
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Other
        </div>
        <SelectItem value={CUSTOM_SENTINEL}>Custom model name…</SelectItem>
      </SelectContent>
    </Select>
  )
}

/* -------------------------------------------------------------------------- */
/* GitHub Account card                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Self-contained "GitHub Account" settings card. It hits two read-only
 * endpoints (`/api/github/status`, `/api/github/repo-permission`) on
 * mount and again whenever the user clicks one of the refresh buttons.
 *
 * We deliberately do *not* attempt to launch `gh auth login` from the
 * server: that command opens a browser and prints a one-time code on
 * stdin, which is hostile from inside a Next.js dev server. Instead
 * we render the exact command and let the user run it in their own
 * terminal — then click "Refresh".
 *
 * No tokens, passwords, or PATs are persisted by this component.
 * Authentication state lives entirely in the user's `gh` CLI / system
 * credential manager.
 */
function GitHubAccountCard({ projectPath }: { projectPath: string | null }) {
  const [status, setStatus] = useState<GitHubStatusResponse | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [perm, setPerm] = useState<GitHubRepoPermissionResponse | null>(null)
  const [permLoading, setPermLoading] = useState(false)
  // The CLI-only instructions panel is kept as a fallback for users
  // who'd rather use `gh` than paste a token. Hidden by default now
  // that the in-app sign-in dialog is the recommended path.
  const [showConnectInstructions, setShowConnectInstructions] =
    useState(false)
  const [showDisconnectInstructions, setShowDisconnectInstructions] =
    useState(false)
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

  // Initial load + re-load whenever the selected project path changes
  // so the "Selected project remote" line stays in sync.
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
        {/* Status grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <StatRow
            label="GitHub CLI installed"
            value={
              statusLoading
                ? "Checking…"
                : ghInstalled
                  ? "yes"
                  : "no"
            }
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

        {/* Status message banner */}
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

        {/* Cached-credentials warning for HTTPS remotes */}
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

        {/* Action buttons */}
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
          <Button
            type="button"
            size="sm"
            onClick={() => setSignInOpen(true)}
          >
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

        {/* Connect instructions panel */}
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
      {/* In-app sign-in modal. Refreshes both status + permission
          after a successful login so the badges reflect the new
          identity immediately. */}
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

/** Tiny labelled value row used by the GitHub Account stat grid. */
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
