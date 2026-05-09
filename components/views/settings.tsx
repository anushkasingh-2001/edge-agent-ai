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

export function Settings() {
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

      {/* B. LLM Providers — required for Prompt Playground + Chat Assistant */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            LLM Providers
          </CardTitle>
          <CardDescription>
            Add at least one provider to use Prompt Playground and Chat
            Assistant. Keys are stored locally in your browser only — never
            sent to our servers — and only forwarded to the provider you
            configured.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
