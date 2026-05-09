"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Play,
  Plus,
  Trash2,
  Save,
  Wrench,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Clock,
  History,
  RefreshCw,
} from "lucide-react"
import {
  loadProviderConfigs,
  pickPrimaryProvider,
  getSlotConfig,
  LLM_SLOTS,
  SLOT_META,
  type LlmSlot,
  type ModelProviderConfig,
} from "@/lib/model-keys"
import { MODEL_CATALOG, isKnownModel } from "@/lib/model-catalog"
import type { ScanReport, ToolHit } from "@/lib/scan-report"

/**
 * Prompt Playground — compares two LLMs side-by-side on a fixed system
 * prompt + a list of test cases. Beyond text comparison, the user can
 * expose a subset of the project's detected tools to both models and
 * assert which tool each model picked per case. That's the bit the old
 * dummy implementation faked; now it's real:
 *
 *   - System prompt + test cases live in component state and persist in
 *     `localStorage` as named sessions.
 *   - Tools come from the latest scan report's `tools_detected`. The
 *     user picks a subset; both models always see the same set so the
 *     comparison is honest.
 *   - Per case: expected tool ("any" / "none" / specific tool) and an
 *     optional expected substring in the text. Pass/fail is computed
 *     from those assertions, never invented.
 *   - Runs against the user's configured providers via /api/playground/run.
 *     If no provider is configured we surface a clear empty state and
 *     disable the run button — no fake metrics.
 *
 * Anything we can't verify (cost, semantic accuracy, real tool execution)
 * is intentionally absent. We only show what we measured.
 */

interface PromptPlaygroundProps {
  /** Latest scan report; tools_detected drives the tool picker. */
  scanReport: ScanReport | null
  /** Selected project id, used to namespace saved sessions. */
  projectId?: string | null
}

/* -------------------------------------------------------------------------- */
/* Persisted shapes                                                           */
/* -------------------------------------------------------------------------- */

type ExpectedTool =
  // Pass when the model picked any tool from the exposed set.
  | { kind: "any" }
  // Pass when the model emitted no tool call.
  | { kind: "none" }
  // Pass only when the named tool is the (first) called tool.
  | { kind: "tool"; name: string }

interface TestCase {
  id: string
  input: string
  expectedTool: ExpectedTool
  expectedTextContains: string
  notes: string
  /**
   * Optional per-case override of the available tool set. When `null`
   * the case inherits the global selection (most common). When set
   * (even to an empty array), only those tools are exposed for this
   * specific case — useful when one case should test "what does the
   * model do when only refund_tool is available?" while other cases
   * keep the broader set.
   */
  toolOverride: string[] | null
}

interface PromptSession {
  id: string
  name: string
  projectId: string | null
  prompt: string
  modelASlot: LlmSlot
  modelBSlot: LlmSlot
  selectedToolNames: string[]
  cases: TestCase[]
  savedAt: string
  updatedAt: string
}

const SESSIONS_KEY = "edge-agent-ai.promptSessions"
const SESSIONS_CAP = 25

function isBrowser(): boolean {
  return typeof window !== "undefined"
}

function loadSessions(): PromptSession[] {
  if (!isBrowser()) return []
  try {
    const raw = window.localStorage.getItem(SESSIONS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSession).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )
  } catch {
    return []
  }
}

function isSession(v: unknown): v is PromptSession {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.prompt === "string" &&
    Array.isArray(o.cases)
  )
}

function saveSession(s: PromptSession): PromptSession[] {
  if (!isBrowser()) return [s]
  const all = loadSessions().filter((x) => x.id !== s.id)
  const next = [s, ...all].slice(0, SESSIONS_CAP)
  try {
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(next))
  } catch {
    /* ignore quota */
  }
  return next
}

function deleteSession(id: string): PromptSession[] {
  if (!isBrowser()) return []
  const next = loadSessions().filter((x) => x.id !== id)
  try {
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

/* -------------------------------------------------------------------------- */
/* Per-run result shapes                                                      */
/* -------------------------------------------------------------------------- */

interface RunOutcome {
  text: string
  toolCalls: { name: string; argumentsJson: string }[]
  latencyMs: number
  /** Set when the call failed (network, 4xx/5xx, no provider, etc). */
  error?: string
  /** True when the slot has no provider configured. */
  notConfigured?: boolean
}

interface CaseRun {
  caseId: string
  modelA?: RunOutcome
  modelB?: RunOutcome
  loading: boolean
}

/* -------------------------------------------------------------------------- */
/* Tool helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Group repo-detected tools by name (keep first source location for the
 * tooltip + agent attribution). We dedupe because the scanner emits one
 * ToolHit per decorator/class/file occurrence — ten `def search_docs`
 * decorators shouldn't show as ten tools in the picker.
 *
 * For agent-grouping we use the tool's `agent` field when set; tools
 * without an attribution land in an "Unattributed" bucket so they're
 * still selectable.
 */
const UNATTRIBUTED_GROUP = "Unattributed"

interface CatalogTool {
  name: string
  agent: string
  source: ToolHit
}

interface CatalogGroup {
  agent: string
  tools: CatalogTool[]
}

function uniqueTools(report: ScanReport | null): CatalogTool[] {
  if (!report?.tools_detected) return []
  const seen = new Map<string, CatalogTool>()
  for (const t of report.tools_detected) {
    const key = t.name
    if (!key) continue
    if (seen.has(key)) continue
    const agent = (t.agent && t.agent.trim()) || UNATTRIBUTED_GROUP
    seen.set(key, { name: key, agent, source: t })
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
}

/** Bucket the flat tool catalog by agent, with a stable agent order. */
function groupByAgent(catalog: CatalogTool[]): CatalogGroup[] {
  const buckets = new Map<string, CatalogTool[]>()
  for (const t of catalog) {
    const arr = buckets.get(t.agent) ?? []
    arr.push(t)
    buckets.set(t.agent, arr)
  }
  // Real agents (alphabetical) first, Unattributed always last so the
  // user sees their named agents up top.
  return Array.from(buckets.entries())
    .map(([agent, tools]) => ({ agent, tools }))
    .sort((a, b) => {
      if (a.agent === UNATTRIBUTED_GROUP) return 1
      if (b.agent === UNATTRIBUTED_GROUP) return -1
      return a.agent.localeCompare(b.agent)
    })
}

/**
 * Build the OpenAI-style tool definition payload from selected tool
 * names. We have no real signature info from the scanner, so each tool
 * gets a permissive empty-object schema and a description noting where
 * we found it. The model will still pick by name, which is what the
 * test asserts.
 */
function toolsForApi(
  selected: string[],
  catalog: CatalogTool[]
): { name: string; description: string; parameters: Record<string, unknown> }[] {
  const byName = new Map(catalog.map((t) => [t.name, t]))
  return selected.map((name) => {
    const t = byName.get(name)
    const where = t ? `${t.source.file}:${t.source.line}` : "unknown"
    const agentHint =
      t && t.agent !== UNATTRIBUTED_GROUP ? ` (agent: ${t.agent})` : ""
    return {
      name,
      description: `Detected in repo at ${where}${agentHint}. Pick this tool when the user request needs ${name}.`,
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Free-form input for the tool",
          },
        },
        required: [],
      },
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Pass/fail evaluation                                                       */
/* -------------------------------------------------------------------------- */

function evalToolMatch(
  expected: ExpectedTool,
  outcome: RunOutcome
): "pass" | "fail" {
  const calledName = outcome.toolCalls[0]?.name
  if (expected.kind === "none") {
    return outcome.toolCalls.length === 0 ? "pass" : "fail"
  }
  if (expected.kind === "any") {
    return outcome.toolCalls.length > 0 ? "pass" : "fail"
  }
  return calledName === expected.name ? "pass" : "fail"
}

function evalTextMatch(
  expectedSubstring: string,
  outcome: RunOutcome
): "pass" | "fail" | "skip" {
  const needle = expectedSubstring.trim()
  if (!needle) return "skip"
  return outcome.text.toLowerCase().includes(needle.toLowerCase())
    ? "pass"
    : "fail"
}

/* -------------------------------------------------------------------------- */

const DEFAULT_PROMPT = `You are a helpful assistant for this project. When the user's request matches one of the available tools, call the most appropriate tool with a concise input. Otherwise reply directly.`

function emptyCase(): TestCase {
  return {
    id: newId("case"),
    input: "",
    expectedTool: { kind: "any" },
    expectedTextContains: "",
    notes: "",
    toolOverride: null,
  }
}

/** Resolve the actual tools exposed for a case. Override wins; otherwise
 *  fall back to the global selection. */
function resolveCaseTools(c: TestCase, globalSelected: string[]): string[] {
  return c.toolOverride ?? globalSelected
}

export function PromptPlayground({
  scanReport,
  projectId,
}: PromptPlaygroundProps) {
  // Provider configs come from Settings (localStorage). We re-load on
  // mount and expose a refresh button so users who just added a key
  // don't have to navigate away and back.
  const [providers, setProviders] = useState<ModelProviderConfig[]>([])
  useEffect(() => {
    setProviders(loadProviderConfigs())
  }, [])

  const refreshProviders = () => setProviders(loadProviderConfigs())

  const primary = pickPrimaryProvider(providers)
  // Default the two slots to whatever the user has configured. If only
  // one provider exists, both slots point at it; the user can change.
  const defaultSlot: LlmSlot = (() => {
    for (const slot of LLM_SLOTS) {
      const cfg = getSlotConfig(slot, providers)
      if (cfg && SLOT_META[slot].runnerImplemented) return slot
    }
    return "openai"
  })()

  const [modelASlot, setModelASlot] = useState<LlmSlot>(defaultSlot)
  const [modelBSlot, setModelBSlot] = useState<LlmSlot>(defaultSlot)
  // Per-slot model override for this session. `null` means "use whatever
  // is saved in Settings for that slot" (the common default). When set,
  // the user picked a different model from the catalog just for this
  // playground session — the underlying Settings entry is untouched, so
  // they can A/B different models without rewriting their saved config.
  const [modelAOverride, setModelAOverride] = useState<string | null>(null)
  const [modelBOverride, setModelBOverride] = useState<string | null>(null)
  // Re-derive when providers load for the first time so the slots
  // default to a valid configured slot rather than blank dropdowns.
  useEffect(() => {
    if (!primary) return
    setModelASlot((s) => (getSlotConfig(s, providers) ? s : defaultSlot))
    setModelBSlot((s) => (getSlotConfig(s, providers) ? s : defaultSlot))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length])

  const toolCatalog = useMemo(() => uniqueTools(scanReport), [scanReport])
  const toolGroups = useMemo(() => groupByAgent(toolCatalog), [toolCatalog])

  const [prompt, setPrompt] = useState<string>(DEFAULT_PROMPT)
  const [selectedToolNames, setSelectedToolNames] = useState<string[]>([])
  const [toolSearch, setToolSearch] = useState<string>("")
  const [cases, setCases] = useState<TestCase[]>([emptyCase()])
  const [runs, setRuns] = useState<Record<string, CaseRun>>({})
  const [running, setRunning] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<PromptSession[]>([])
  useEffect(() => setSessions(loadSessions()), [])

  // Save Session dialog
  const [saveOpen, setSaveOpen] = useState(false)
  const [sessionName, setSessionName] = useState<string>("")

  // When the project switches, the tool list will change underneath us.
  // Drop selections that no longer exist so we don't ship dangling tool
  // names to the model.
  useEffect(() => {
    setSelectedToolNames((prev) =>
      prev.filter((n) => toolCatalog.some((t) => t.name === n))
    )
  }, [toolCatalog])

  function toggleTool(name: string) {
    setSelectedToolNames((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    )
  }

  function addCase() {
    setCases((cs) => [...cs, emptyCase()])
  }

  function updateCase(id: string, patch: Partial<TestCase>) {
    setCases((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  function removeCase(id: string) {
    setCases((cs) => cs.filter((c) => c.id !== id))
    setRuns((r) => {
      const { [id]: _drop, ...rest } = r
      return rest
    })
  }

  function setCaseToolOverride(id: string, override: string[] | null) {
    setCases((cs) =>
      cs.map((c) => (c.id === id ? { ...c, toolOverride: override } : c))
    )
  }

  /**
   * Hit /api/playground/run for one (case, model) combination. Returns
   * a normalised RunOutcome whether the request succeeded, failed, or
   * the slot has no key configured. `modelOverride` lets the playground
   * pick a different model id than what's saved in Settings — without
   * mutating the saved config.
   */
  async function runCaseAgainst(
    cfg: ModelProviderConfig | undefined,
    c: TestCase,
    toolsApi: ReturnType<typeof toolsForApi>,
    modelOverride: string | null
  ): Promise<RunOutcome> {
    if (!cfg) {
      return {
        text: "",
        toolCalls: [],
        latencyMs: 0,
        notConfigured: true,
        error: "No provider configured for this slot.",
      }
    }
    const startedAt = Date.now()
    try {
      const res = await fetch("/api/playground/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: cfg.type,
          apiKey: cfg.apiKey,
          model: (modelOverride && modelOverride.trim()) || cfg.model,
          baseUrl: cfg.baseUrl,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: c.input },
          ],
          tools: toolsApi.length > 0 ? toolsApi : undefined,
          toolChoice: toolsApi.length > 0 ? "auto" : undefined,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        text?: string
        toolCalls?: { name: string; argumentsJson: string }[]
        latencyMs?: number
        error?: string
        notImplemented?: boolean
      }
      if (!res.ok || !body.ok) {
        return {
          text: "",
          toolCalls: [],
          latencyMs: body.latencyMs ?? Date.now() - startedAt,
          error:
            body.error ||
            `Request failed with status ${res.status}` ||
            "Unknown error",
        }
      }
      return {
        text: body.text ?? "",
        toolCalls: body.toolCalls ?? [],
        latencyMs: body.latencyMs ?? Date.now() - startedAt,
      }
    } catch (e) {
      return {
        text: "",
        toolCalls: [],
        latencyMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : "Network error",
      }
    }
  }

  /** Build the OpenAI-style tool payload for a single case, using its
   *  override if present, otherwise the global selection. */
  function toolsApiFor(c: TestCase) {
    return toolsForApi(resolveCaseTools(c, selectedToolNames), toolCatalog)
  }

  async function runAll() {
    if (running) return
    if (cases.length === 0) return
    setRunning(true)
    const cfgA = getSlotConfig(modelASlot, providers)
    const cfgB = getSlotConfig(modelBSlot, providers)

    // Mark each case as loading first so the UI flips immediately,
    // then fan out per-case with both models in parallel.
    setRuns(() => {
      const next: Record<string, CaseRun> = {}
      for (const c of cases) next[c.id] = { caseId: c.id, loading: true }
      return next
    })

    // Per-case in parallel; cases run sequentially to avoid hammering
    // both providers with N×2 concurrent requests for a long suite.
    for (const c of cases) {
      const tools = toolsApiFor(c)
      const [a, b] = await Promise.all([
        runCaseAgainst(cfgA, c, tools, modelAOverride),
        runCaseAgainst(cfgB, c, tools, modelBOverride),
      ])
      setRuns((prev) => ({
        ...prev,
        [c.id]: { caseId: c.id, modelA: a, modelB: b, loading: false },
      }))
    }
    setRunning(false)
  }

  async function runOne(c: TestCase) {
    if (running) return
    setRunning(true)
    const cfgA = getSlotConfig(modelASlot, providers)
    const cfgB = getSlotConfig(modelBSlot, providers)
    const tools = toolsApiFor(c)
    setRuns((prev) => ({
      ...prev,
      [c.id]: { caseId: c.id, loading: true },
    }))
    const [a, b] = await Promise.all([
      runCaseAgainst(cfgA, c, tools, modelAOverride),
      runCaseAgainst(cfgB, c, tools, modelBOverride),
    ])
    setRuns((prev) => ({
      ...prev,
      [c.id]: { caseId: c.id, modelA: a, modelB: b, loading: false },
    }))
    setRunning(false)
  }

  function openSaveDialog() {
    if (!sessionName) {
      setSessionName(
        activeSessionId
          ? sessions.find((s) => s.id === activeSessionId)?.name ?? ""
          : "Untitled session"
      )
    }
    setSaveOpen(true)
  }

  function commitSave() {
    const id = activeSessionId ?? newId("sess")
    const now = new Date().toISOString()
    const session: PromptSession = {
      id,
      name: sessionName.trim() || "Untitled session",
      projectId: projectId ?? null,
      prompt,
      modelASlot,
      modelBSlot,
      selectedToolNames,
      cases,
      savedAt: now,
      updatedAt: now,
    }
    const next = saveSession(session)
    setSessions(next)
    setActiveSessionId(id)
    setSaveOpen(false)
  }

  function loadSession(s: PromptSession) {
    setActiveSessionId(s.id)
    setSessionName(s.name)
    setPrompt(s.prompt)
    setModelASlot(s.modelASlot)
    setModelBSlot(s.modelBSlot)
    setSelectedToolNames(s.selectedToolNames)
    setCases(s.cases.length ? s.cases : [emptyCase()])
    setRuns({})
  }

  function discardSession(id: string) {
    const next = deleteSession(id)
    setSessions(next)
    if (activeSessionId === id) setActiveSessionId(null)
  }

  // Aggregate counts for the metrics tile — derived purely from runs.
  const aggregate = useMemo(() => {
    let attempted = 0
    let aPassTool = 0
    let bPassTool = 0
    let aPassText = 0
    let bPassText = 0
    let aErrors = 0
    let bErrors = 0
    let totalLatencyA = 0
    let totalLatencyB = 0
    let countLatencyA = 0
    let countLatencyB = 0
    for (const c of cases) {
      const r = runs[c.id]
      if (!r || r.loading) continue
      attempted += 1
      if (r.modelA) {
        if (r.modelA.error) aErrors += 1
        else {
          if (evalToolMatch(c.expectedTool, r.modelA) === "pass") aPassTool += 1
          if (evalTextMatch(c.expectedTextContains, r.modelA) === "pass")
            aPassText += 1
          totalLatencyA += r.modelA.latencyMs
          countLatencyA += 1
        }
      }
      if (r.modelB) {
        if (r.modelB.error) bErrors += 1
        else {
          if (evalToolMatch(c.expectedTool, r.modelB) === "pass") bPassTool += 1
          if (evalTextMatch(c.expectedTextContains, r.modelB) === "pass")
            bPassText += 1
          totalLatencyB += r.modelB.latencyMs
          countLatencyB += 1
        }
      }
    }
    return {
      attempted,
      aPassTool,
      bPassTool,
      aPassText,
      bPassText,
      aErrors,
      bErrors,
      avgLatencyA: countLatencyA ? Math.round(totalLatencyA / countLatencyA) : 0,
      avgLatencyB: countLatencyB ? Math.round(totalLatencyB / countLatencyB) : 0,
    }
  }, [cases, runs])

  const noProvider = !primary
  const cfgA = getSlotConfig(modelASlot, providers)
  const cfgB = getSlotConfig(modelBSlot, providers)
  const canRun =
    !running && !noProvider && cases.some((c) => c.input.trim().length > 0)

  /* ---------------------------------------------------------------------- */
  /* Render                                                                 */
  /* ---------------------------------------------------------------------- */

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Prompt Playground</h1>
          <p className="text-muted-foreground">
            Compare two models on the same prompt, tools, and test cases —
            assert which tool each picks per case.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={openSaveDialog}>
            <Save className="h-4 w-4 mr-2" />
            Save Session
          </Button>
          <Button onClick={runAll} disabled={!canRun} title={runDisabledTitle(noProvider, running, cases)}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Run All
              </>
            )}
          </Button>
        </div>
      </div>

      {noProvider && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-300">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            No model provider configured. Add one in{" "}
            <span className="font-medium">Settings → LLM Providers</span>{" "}
            (OpenAI, custom OpenAI-compatible endpoint) and click{" "}
            <button
              type="button"
              onClick={refreshProviders}
              className="underline underline-offset-2 hover:text-yellow-200"
            >
              Refresh
            </button>{" "}
            here.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT — prompt + cases */}
        <div className="lg:col-span-2 space-y-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">System Prompt</CardTitle>
                <Badge variant="outline" className="text-xs">
                  {prompt.length} chars
                </Badge>
              </div>
              <CardDescription>
                Same prompt is sent to both models on every case.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="min-h-[160px] font-mono text-sm bg-secondary/30 resize-y"
                placeholder="Enter your system prompt…"
              />
            </CardContent>
          </Card>

          {/* Tool picker — grouped by agent, with search + per-group
           *  select-all so a multi-agent repo with dozens of tools is
           *  still navigable. The selected set is the global default
           *  for all cases; individual cases can override it below. */}
          <ToolPicker
            toolGroups={toolGroups}
            toolCatalog={toolCatalog}
            selected={selectedToolNames}
            onSelect={setSelectedToolNames}
            onToggle={toggleTool}
            search={toolSearch}
            onSearchChange={setToolSearch}
          />

          {/* Test Cases */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Test Cases</CardTitle>
                <Button variant="outline" size="sm" onClick={addCase}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Case
                </Button>
              </div>
              <CardDescription>
                Per case: input, what tool you expect, optional substring you
                expect in the response.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {cases.map((c, i) => (
                <CaseEditor
                  key={c.id}
                  index={i}
                  c={c}
                  globalSelected={selectedToolNames}
                  catalog={toolCatalog}
                  toolGroups={toolGroups}
                  run={runs[c.id]}
                  onChange={(patch) => updateCase(c.id, patch)}
                  onDelete={() => removeCase(c.id)}
                  onRunOne={() => runOne(c)}
                  onSetOverride={(o) => setCaseToolOverride(c.id, o)}
                  canRun={!running && !noProvider}
                />
              ))}
              {cases.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No cases yet — click <span className="font-medium">Add Case</span>.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* RIGHT — model slots, metrics, sessions */}
        <div className="space-y-4">
          <ModelSlotCard
            label="Model A"
            slot={modelASlot}
            onSlotChange={(s) => {
              setModelASlot(s)
              setModelAOverride(null)
            }}
            modelOverride={modelAOverride}
            onModelOverrideChange={setModelAOverride}
            cfg={cfgA}
            providers={providers}
            tone="emerald"
          />
          <ModelSlotCard
            label="Model B"
            slot={modelBSlot}
            onSlotChange={(s) => {
              setModelBSlot(s)
              setModelBOverride(null)
            }}
            modelOverride={modelBOverride}
            onModelOverrideChange={setModelBOverride}
            cfg={cfgB}
            providers={providers}
            tone="blue"
          />

          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Results Summary</CardTitle>
              <CardDescription>
                Aggregated from runs you've executed in this session.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {aggregate.attempted === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No runs yet. Click <span className="font-medium">Run All</span>{" "}
                  to populate.
                </p>
              ) : (
                <>
                  <MetricRow
                    label="Tool match"
                    a={`${aggregate.aPassTool}/${aggregate.attempted}`}
                    b={`${aggregate.bPassTool}/${aggregate.attempted}`}
                  />
                  <MetricRow
                    label="Text match"
                    a={`${aggregate.aPassText}/${aggregate.attempted}`}
                    b={`${aggregate.bPassText}/${aggregate.attempted}`}
                    note="Counts cases where the expected substring is empty as skipped."
                  />
                  <MetricRow
                    label="Avg latency"
                    a={`${aggregate.avgLatencyA} ms`}
                    b={`${aggregate.avgLatencyB} ms`}
                  />
                  {(aggregate.aErrors > 0 || aggregate.bErrors > 0) && (
                    <MetricRow
                      label="Errors"
                      a={`${aggregate.aErrors}`}
                      b={`${aggregate.bErrors}`}
                      tone="error"
                    />
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  Saved Sessions
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => setSessions(loadSessions())}
                  title="Reload from local storage"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {sessions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No saved sessions yet — use Save Session to keep prompts /
                  cases for later.
                </p>
              ) : (
                <ScrollArea className="max-h-[320px]">
                  <ul className="space-y-1 pr-2">
                    {sessions.map((s) => (
                      <li
                        key={s.id}
                        className={`group flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${
                          activeSessionId === s.id
                            ? "border-blue-500/40 bg-blue-500/10"
                            : "border-border/60"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => loadSession(s)}
                          className="flex-1 min-w-0 text-left"
                          title="Load session"
                        >
                          <div className="font-medium truncate">{s.name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {s.cases.length} case{s.cases.length === 1 ? "" : "s"} ·{" "}
                            {new Date(s.updatedAt).toLocaleString()}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => discardSession(s.id)}
                          className="text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Delete session"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Save Session dialog */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Save session</DialogTitle>
            <DialogDescription>
              Stored locally in your browser. Includes the system prompt,
              selected tools, model slots, and test cases (not run results).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Session name</label>
            <Input
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="e.g. Refund agent — tool routing v2"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={commitSave}>
              <Save className="h-4 w-4 mr-2" />
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Sub-components                                                             */
/* -------------------------------------------------------------------------- */

function CaseEditor({
  index,
  c,
  globalSelected,
  catalog,
  toolGroups,
  run,
  onChange,
  onDelete,
  onRunOne,
  onSetOverride,
  canRun,
}: {
  index: number
  c: TestCase
  globalSelected: string[]
  catalog: CatalogTool[]
  toolGroups: CatalogGroup[]
  run: CaseRun | undefined
  onChange: (patch: Partial<TestCase>) => void
  onDelete: () => void
  onRunOne: () => void
  onSetOverride: (override: string[] | null) => void
  canRun: boolean
}) {
  const expectedValue =
    c.expectedTool.kind === "tool"
      ? `tool:${c.expectedTool.name}`
      : c.expectedTool.kind

  function setExpected(v: string) {
    if (v === "any") onChange({ expectedTool: { kind: "any" } })
    else if (v === "none") onChange({ expectedTool: { kind: "none" } })
    else if (v.startsWith("tool:"))
      onChange({ expectedTool: { kind: "tool", name: v.slice(5) } })
  }

  // Tools actually exposed for this case — used both to populate the
  // "Expected tool" specific list (so the user can't pick a tool the
  // model can't call) and to feed the runner.
  const effectiveTools = resolveCaseTools(c, globalSelected)
  const usingOverride = c.toolOverride !== null

  return (
    <div className="rounded-lg border border-border/60 bg-secondary/10 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            #{index + 1}
          </Badge>
          {run?.loading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={onRunOne}
            disabled={!canRun || c.input.trim().length === 0}
            title={
              c.input.trim().length === 0
                ? "Enter an input first"
                : "Run only this case"
            }
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            User input
          </label>
          <Textarea
            value={c.input}
            onChange={(e) => onChange({ input: e.target.value })}
            placeholder="What the user says…"
            className="bg-secondary/30 text-sm min-h-[60px]"
          />
        </div>
        <div className="space-y-2">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Expected tool
            </label>
            <Select value={expectedValue} onValueChange={setExpected}>
              <SelectTrigger className="bg-secondary/30 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any tool from selected set</SelectItem>
                <SelectItem value="none">No tool (text only)</SelectItem>
                {effectiveTools.length > 0 && (
                  <>
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Specific tool {usingOverride ? "(case override)" : ""}
                    </div>
                    {effectiveTools.map((n) => (
                      <SelectItem key={n} value={`tool:${n}`}>
                        {n}
                      </SelectItem>
                    ))}
                  </>
                )}
              </SelectContent>
            </Select>
            {c.expectedTool.kind === "tool" &&
              !effectiveTools.includes(c.expectedTool.name) && (
                <p className="text-[10px] text-yellow-400 mt-1">
                  This tool isn't in the available set for this case — both
                  models won't be able to call it.
                </p>
              )}
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Expected text contains (optional)
            </label>
            <Input
              value={c.expectedTextContains}
              onChange={(e) =>
                onChange({ expectedTextContains: e.target.value })
              }
              placeholder="e.g. 30-day"
              className="bg-secondary/30 h-9 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Per-case tool override — collapsed by default. Lets one case
       *  test "what does the model do when only refund_tool is on the
       *  table?" while other cases keep the broader set. */}
      <CaseToolOverride
        c={c}
        catalog={catalog}
        toolGroups={toolGroups}
        globalSelected={globalSelected}
        onSetOverride={onSetOverride}
      />

      {/* Side-by-side outcomes */}
      {(run?.modelA || run?.modelB) && !run.loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-2 border-t border-border/30">
          <RunOutcomeCard
            label="A"
            tone="emerald"
            outcome={run.modelA}
            expected={c.expectedTool}
            expectedText={c.expectedTextContains}
          />
          <RunOutcomeCard
            label="B"
            tone="blue"
            outcome={run.modelB}
            expected={c.expectedTool}
            expectedText={c.expectedTextContains}
          />
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Tool picker (grouped by agent, with search)                               */
/* -------------------------------------------------------------------------- */

function ToolPicker({
  toolGroups,
  toolCatalog,
  selected,
  onSelect,
  onToggle,
  search,
  onSearchChange,
}: {
  toolGroups: CatalogGroup[]
  toolCatalog: CatalogTool[]
  selected: string[]
  onSelect: (next: string[]) => void
  onToggle: (name: string) => void
  search: string
  onSearchChange: (v: string) => void
}) {
  const q = search.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!q) return toolGroups
    return toolGroups
      .map((g) => ({
        agent: g.agent,
        tools: g.tools.filter((t) =>
          t.name.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.tools.length > 0)
  }, [q, toolGroups])

  function selectAllVisible() {
    const merged = new Set(selected)
    for (const g of filteredGroups) for (const t of g.tools) merged.add(t.name)
    onSelect(Array.from(merged))
  }
  function clearAll() {
    onSelect([])
  }
  function toggleGroup(agent: string) {
    const groupNames = filteredGroups
      .find((g) => g.agent === agent)
      ?.tools.map((t) => t.name) ?? []
    const allOn = groupNames.every((n) => selected.includes(n))
    if (allOn) {
      onSelect(selected.filter((n) => !groupNames.includes(n)))
    } else {
      const merged = new Set(selected)
      for (const n of groupNames) merged.add(n)
      onSelect(Array.from(merged))
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Wrench className="h-4 w-4 text-blue-400" />
            Tools Exposed to Both Models
          </CardTitle>
          <div className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground/90">
              {selected.length}
            </span>{" "}
            of {toolCatalog.length} selected
          </div>
        </div>
        <CardDescription>
          Detected from the latest scan, grouped by agent. Click chips to
          multi-select. The selected set is the default for every case;
          individual cases can override it below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {toolCatalog.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tools detected in the open project. Run a scan to populate
            this list.
          </p>
        ) : (
          <>
            {/* Search + global actions */}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={`Search ${toolCatalog.length} tools…`}
                className="bg-secondary/30 h-8 text-sm flex-1 min-w-[160px]"
              />
              <button
                type="button"
                onClick={selectAllVisible}
                className="text-[11px] rounded border border-border/60 px-2 py-1 text-muted-foreground hover:bg-secondary/30"
                title={q ? "Select every tool currently shown" : "Select every tool"}
              >
                Select {q ? "shown" : "all"}
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="text-[11px] rounded border border-border/60 px-2 py-1 text-muted-foreground hover:bg-secondary/30"
                disabled={selected.length === 0}
              >
                Clear ({selected.length})
              </button>
            </div>

            {/* Selection summary chip strip — gives a quick read of what's
             *  picked without scrolling the whole catalog. Capped to 12
             *  with a "+N more" so it stays one-line-ish. */}
            {selected.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                <span className="uppercase tracking-wide">Selected:</span>
                {selected.slice(0, 12).map((n) => (
                  <span
                    key={n}
                    className="font-mono rounded bg-blue-500/10 text-blue-300 border border-blue-500/30 px-1.5"
                  >
                    {n}
                  </span>
                ))}
                {selected.length > 12 && <span>+{selected.length - 12} more</span>}
              </div>
            )}

            {/* Groups */}
            {filteredGroups.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No tools match <span className="font-mono">"{search}"</span>.
              </p>
            ) : (
              <div className="space-y-3">
                {filteredGroups.map((g) => {
                  const allOn = g.tools.every((t) => selected.includes(t.name))
                  const someOn = g.tools.some((t) => selected.includes(t.name))
                  return (
                    <div key={g.agent} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium text-foreground/90">
                            {g.agent === UNATTRIBUTED_GROUP
                              ? "Unattributed tools"
                              : g.agent}
                          </span>
                          <span className="text-muted-foreground">
                            ({g.tools.filter((t) => selected.includes(t.name)).length}/
                            {g.tools.length})
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleGroup(g.agent)}
                          className="text-[10px] rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground hover:bg-secondary/30"
                        >
                          {allOn ? "Clear group" : someOn ? "Select rest" : "Select group"}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {g.tools.map((t) => {
                          const on = selected.includes(t.name)
                          return (
                            <button
                              key={t.name}
                              type="button"
                              onClick={() => onToggle(t.name)}
                              title={`${t.source.file}:${t.source.line} (${t.source.kind})`}
                              className={`inline-flex items-center gap-1.5 text-xs rounded border px-2 py-1 transition-colors ${
                                on
                                  ? "bg-blue-500/15 border-blue-500/40 text-blue-300"
                                  : "border-border/60 text-muted-foreground hover:bg-secondary/30"
                              }`}
                            >
                              {/* Tiny checkbox glyph so it's obvious this
                               *  is multi-select rather than a single-pick
                               *  list. */}
                              <span
                                className={`inline-flex h-3 w-3 items-center justify-center rounded-sm border ${
                                  on
                                    ? "bg-blue-500 border-blue-400 text-white"
                                    : "border-border/80"
                                }`}
                              >
                                {on && <CheckCircle2 className="h-2.5 w-2.5" />}
                              </span>
                              {t.name}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Per-case override. Collapsed by default. When toggled on, the case
 * uses its own subset of tools from the catalog rather than inheriting
 * the global selection. We render the same grouped/checkbox UI used by
 * the global picker, but scoped to this case's list — so the user
 * doesn't have to learn a different multi-select pattern.
 */
function CaseToolOverride({
  c,
  catalog,
  toolGroups,
  globalSelected,
  onSetOverride,
}: {
  c: TestCase
  catalog: CatalogTool[]
  toolGroups: CatalogGroup[]
  globalSelected: string[]
  onSetOverride: (override: string[] | null) => void
}) {
  const [expanded, setExpanded] = useState<boolean>(c.toolOverride !== null)
  const usingOverride = c.toolOverride !== null
  const effective = resolveCaseTools(c, globalSelected)

  if (catalog.length === 0) return null

  function enable() {
    onSetOverride([...globalSelected])
    setExpanded(true)
  }
  function disable() {
    onSetOverride(null)
  }
  function toggleName(name: string) {
    const cur = c.toolOverride ?? []
    onSetOverride(
      cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]
    )
  }
  function toggleGroup(agent: string) {
    const cur = c.toolOverride ?? []
    const names = toolGroups.find((g) => g.agent === agent)?.tools.map((t) => t.name) ?? []
    const allOn = names.every((n) => cur.includes(n))
    if (allOn) onSetOverride(cur.filter((n) => !names.includes(n)))
    else {
      const merged = new Set(cur)
      for (const n of names) merged.add(n)
      onSetOverride(Array.from(merged))
    }
  }

  return (
    <div className="rounded border border-border/40 bg-secondary/5 px-2 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <Wrench className="h-3 w-3" />
          {usingOverride ? (
            <>
              Tools for this case:{" "}
              <span className="font-medium text-blue-300">
                custom ({effective.length})
              </span>
            </>
          ) : (
            <>
              Tools for this case:{" "}
              <span className="text-foreground/80">
                inherits global ({effective.length})
              </span>
            </>
          )}
        </button>
        {usingOverride ? (
          <button
            type="button"
            onClick={disable}
            className="text-[10px] rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground hover:bg-secondary/30"
          >
            Use global
          </button>
        ) : (
          <button
            type="button"
            onClick={enable}
            className="text-[10px] rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground hover:bg-secondary/30"
          >
            Override for this case
          </button>
        )}
      </div>
      {expanded && usingOverride && (
        <div className="mt-2 space-y-2">
          {toolGroups.map((g) => {
            const names = g.tools.map((t) => t.name)
            const cur = c.toolOverride ?? []
            const allOn = names.every((n) => cur.includes(n))
            const someOn = names.some((n) => cur.includes(n))
            return (
              <div key={g.agent}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px]">
                    <span className="font-medium">
                      {g.agent === UNATTRIBUTED_GROUP
                        ? "Unattributed"
                        : g.agent}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      ({names.filter((n) => cur.includes(n)).length}/{names.length})
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.agent)}
                    className="text-[10px] rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground hover:bg-secondary/30"
                  >
                    {allOn ? "Clear" : someOn ? "Add rest" : "Add group"}
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {g.tools.map((t) => {
                    const on = (c.toolOverride ?? []).includes(t.name)
                    return (
                      <button
                        key={t.name}
                        type="button"
                        onClick={() => toggleName(t.name)}
                        title={`${t.source.file}:${t.source.line}`}
                        className={`inline-flex items-center gap-1 text-[11px] rounded border px-1.5 py-0.5 transition-colors ${
                          on
                            ? "bg-blue-500/15 border-blue-500/40 text-blue-300"
                            : "border-border/60 text-muted-foreground hover:bg-secondary/30"
                        }`}
                      >
                        <span
                          className={`inline-flex h-2.5 w-2.5 items-center justify-center rounded-sm border ${
                            on
                              ? "bg-blue-500 border-blue-400"
                              : "border-border/80"
                          }`}
                        />
                        {t.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RunOutcomeCard({
  label,
  tone,
  outcome,
  expected,
  expectedText,
}: {
  label: string
  tone: "emerald" | "blue"
  outcome: RunOutcome | undefined
  expected: ExpectedTool
  expectedText: string
}) {
  const labelColor =
    tone === "emerald" ? "text-emerald-400" : "text-blue-400"

  if (!outcome) {
    return (
      <div className="rounded border border-border/40 bg-secondary/20 p-2 text-xs text-muted-foreground">
        Model {label}: no result.
      </div>
    )
  }

  if (outcome.error) {
    return (
      <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs">
        <div className={`font-medium ${labelColor}`}>Model {label}</div>
        <div className="text-red-300 mt-1 break-words">{outcome.error}</div>
        {outcome.notConfigured && (
          <div className="text-[10px] text-muted-foreground mt-1">
            Configure this slot in Settings.
          </div>
        )}
      </div>
    )
  }

  const toolStatus = evalToolMatch(expected, outcome)
  const textStatus = evalTextMatch(expectedText, outcome)
  const calledName = outcome.toolCalls[0]?.name

  return (
    <div className="rounded border border-border/40 bg-secondary/20 p-2 space-y-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className={`font-medium ${labelColor}`}>Model {label}</span>
        <span className="text-muted-foreground inline-flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {outcome.latencyMs} ms
        </span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <PassPill kind="Tool" status={toolStatus} />
        <span className="text-muted-foreground">
          {calledName ? (
            <>
              picked <span className="font-mono">{calledName}</span>
            </>
          ) : (
            <>no tool called</>
          )}
          {outcome.toolCalls.length > 1 && (
            <> (+{outcome.toolCalls.length - 1} more)</>
          )}
        </span>
      </div>
      {expectedText.trim().length > 0 && (
        <div className="flex items-center gap-2">
          <PassPill kind="Text" status={textStatus} />
        </div>
      )}
      {outcome.text && (
        <div className="rounded bg-secondary/40 p-2 text-foreground/90 whitespace-pre-wrap break-words">
          {outcome.text}
        </div>
      )}
    </div>
  )
}

function PassPill({
  kind,
  status,
}: {
  kind: string
  status: "pass" | "fail" | "skip"
}) {
  if (status === "skip") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground text-[10px]">
        — {kind} skipped
      </span>
    )
  }
  return status === "pass" ? (
    <span className="inline-flex items-center gap-1 text-green-400 text-[10px]">
      <CheckCircle2 className="h-3 w-3" />
      {kind} pass
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-red-400 text-[10px]">
      <XCircle className="h-3 w-3" />
      {kind} fail
    </span>
  )
}

/**
 * Provider slot card — picks the named provider (OpenAI / Anthropic /
 * Gemini / Custom) AND a specific model from that provider's catalog.
 *
 * The model selection here is a **session override**: changing it in
 * the playground does NOT mutate the saved Settings entry. Setting it
 * back to "Default (saved)" or switching slots clears the override.
 */
function ModelSlotCard({
  label,
  slot,
  onSlotChange,
  modelOverride,
  onModelOverrideChange,
  cfg,
  providers,
  tone,
}: {
  label: string
  slot: LlmSlot
  onSlotChange: (s: LlmSlot) => void
  modelOverride: string | null
  onModelOverrideChange: (next: string | null) => void
  cfg: ModelProviderConfig | undefined
  providers: ModelProviderConfig[]
  tone: "emerald" | "blue"
}) {
  const labelColor = tone === "emerald" ? "text-emerald-400" : "text-blue-400"
  const slotMeta = SLOT_META[slot]
  const effectiveModel = (modelOverride && modelOverride.trim()) || cfg?.model || slotMeta.defaultModel
  const catalog = MODEL_CATALOG[slot]
  const overrideIsCustom =
    modelOverride !== null && !isKnownModel(slot, modelOverride)

  // Sentinels for the picker:
  //   __default__ — no override, use saved Settings model
  //   __custom__  — flip to a free-form input for one-off model ids
  const DEFAULT = "__default__"
  const CUSTOM = "__custom__"
  const pickerValue = (() => {
    if (modelOverride === null) return DEFAULT
    if (overrideIsCustom) return CUSTOM
    return modelOverride
  })()

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className={`text-base ${labelColor}`}>{label}</CardTitle>
        <CardDescription>
          {cfg ? (
            <>
              {slotMeta.label} ·{" "}
              <span className="font-mono">{effectiveModel}</span>
              {modelOverride !== null && (
                <span className="text-[10px] ml-1 text-yellow-400">
                  (session override)
                </span>
              )}
            </>
          ) : (
            "No provider configured for this slot."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Provider slot picker */}
        <Select value={slot} onValueChange={(v) => onSlotChange(v as LlmSlot)}>
          <SelectTrigger className="bg-secondary/50 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LLM_SLOTS.map((s) => {
              const c = getSlotConfig(s, providers)
              const meta = SLOT_META[s]
              return (
                <SelectItem key={s} value={s}>
                  <span className="flex items-center gap-2">
                    <span>{meta.label}</span>
                    {c ? (
                      <span className="text-[10px] text-muted-foreground">
                        ({c.model})
                      </span>
                    ) : (
                      <span className="text-[10px] text-yellow-400">
                        (not configured)
                      </span>
                    )}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>

        {/* Model picker — only meaningful when there's a key configured */}
        {cfg && !overrideIsCustom && (
          <Select
            value={pickerValue}
            onValueChange={(v) => {
              if (v === DEFAULT) onModelOverrideChange(null)
              else if (v === CUSTOM) onModelOverrideChange("")
              else onModelOverrideChange(v)
            }}
          >
            <SelectTrigger className="bg-secondary/40 h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>
                <span className="flex items-center gap-2">
                  Default (saved)
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {cfg.model}
                  </span>
                </span>
              </SelectItem>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {slotMeta.label} models
              </div>
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
              <SelectItem value={CUSTOM}>Custom model name…</SelectItem>
            </SelectContent>
          </Select>
        )}

        {/* Free-form input for one-off model ids (private fine-tunes,
         *  preview SKUs not in the catalog yet, OpenAI-compatible
         *  endpoints with arbitrary model namespaces). */}
        {cfg && overrideIsCustom && (
          <div className="flex items-center gap-2">
            <Input
              value={modelOverride ?? ""}
              onChange={(e) => onModelOverrideChange(e.target.value)}
              placeholder={cfg.model}
              autoFocus
              className="bg-secondary/40 h-9 text-sm font-mono"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onModelOverrideChange(null)}
              className="h-9 text-xs text-muted-foreground"
              title="Use the model saved in Settings"
            >
              Use default
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MetricRow({
  label,
  a,
  b,
  note,
  tone,
}: {
  label: string
  a: string
  b: string
  note?: string
  tone?: "error"
}) {
  const cellTone = tone === "error" ? "text-red-400" : ""
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <div className="flex gap-2">
          <Badge
            variant="outline"
            className={`bg-emerald-500/10 text-emerald-400 border-emerald-500/20 ${cellTone}`}
          >
            A: {a}
          </Badge>
          <Badge
            variant="outline"
            className={`bg-blue-500/10 text-blue-400 border-blue-500/20 ${cellTone}`}
          >
            B: {b}
          </Badge>
        </div>
      </div>
      {note && <div className="text-[10px] text-muted-foreground">{note}</div>}
    </div>
  )
}

function runDisabledTitle(
  noProvider: boolean,
  running: boolean,
  cases: TestCase[]
): string {
  if (running) return "A run is already in progress."
  if (noProvider) return "Add a provider in Settings → LLM Providers first."
  if (!cases.some((c) => c.input.trim().length > 0))
    return "Add at least one test case with input."
  return ""
}
