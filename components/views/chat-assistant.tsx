"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Send,
  Bot,
  User,
  Sparkles,
  FileCode,
  GitBranch,
  AlertTriangle,
  TestTube,
  ChevronRight,
  Info,
  Loader2,
  AlertCircle,
  Settings as SettingsIcon,
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
import type { ScanReport, ScannerFinding } from "@/lib/scan-report"
import type { Project } from "@/lib/projects"

/**
 * Chat Assistant — answers questions grounded in the user's local
 * scan results, NOT canned strings. Talks to the same provider the
 * Prompt Playground uses (configured in Settings → LLM Providers) via
 * `/api/playground/run`.
 *
 * Context sent on every turn (intentionally minimal — never the whole
 * repo):
 *   - Project name + branch + scan timestamp + risk score
 *   - Detected frameworks / agents
 *   - Top findings (capped, truncated evidence) optionally filtered by
 *     the agent the user picked in the right rail
 *
 * If no LLM provider is configured, the chat surfaces a clear empty
 * state pointing to Settings instead of pretending to answer.
 */

interface ChatAssistantProps {
  currentBranch: string
  scanReport: ScanReport | null
  selectedProject: Project | null
  /**
   * Last few completed scans for this project, newest first. Used so
   * "Current scan run" shows the real id and timestamp instead of a
   * fake `scan-001`.
   */
  latestScanId?: string | null
  latestScanTimestamp?: string | null
}

interface ChatMessage {
  id: number
  role: "user" | "assistant"
  content: string
  timestamp: string
  /** Files referenced in the answer, surfaced as chips below the bubble. */
  references?: { file: string; line?: number }[]
  /** Set when the upstream LLM call failed; rendered in red. */
  errored?: boolean
}

const ALL_AGENTS = "__all__"
const NO_FINDING = "__none__"
const NO_FILE = "__none__"

/** Persisted user choice of which provider + model to chat with.
 *  Lives in localStorage so it survives reloads. Two separate keys
 *  rather than a structured object because the playground also uses
 *  flat keys and we want the chat picker to feel identical. */
const CHAT_SLOT_KEY = "edge-agent-ai.chat.slot"
const CHAT_MODEL_KEY = "edge-agent-ai.chat.model"

function readStoredSlot(): LlmSlot | null {
  if (typeof window === "undefined") return null
  const v = window.localStorage.getItem(CHAT_SLOT_KEY)
  return v && (LLM_SLOTS as readonly string[]).includes(v) ? (v as LlmSlot) : null
}
function readStoredModel(): string | null {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(CHAT_MODEL_KEY)
}
function writeStoredSlot(s: LlmSlot | null) {
  if (typeof window === "undefined") return
  if (s) window.localStorage.setItem(CHAT_SLOT_KEY, s)
  else window.localStorage.removeItem(CHAT_SLOT_KEY)
}
function writeStoredModel(m: string | null) {
  if (typeof window === "undefined") return
  if (m) window.localStorage.setItem(CHAT_MODEL_KEY, m)
  else window.localStorage.removeItem(CHAT_MODEL_KEY)
}

const INITIAL_GREETING: ChatMessage = {
  id: 1,
  role: "assistant",
  content:
    "Hi — I can answer questions grounded in your latest scan: findings, agents, tools, prompts, and likely fixes. Pick an agent on the right to narrow my context, or just ask away.",
  timestamp: new Date().toISOString(),
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function ChatAssistant({
  currentBranch,
  scanReport,
  selectedProject,
  latestScanId,
  latestScanTimestamp,
}: ChatAssistantProps) {
  // Provider configs come from Settings (localStorage). Refresh on
  // mount; the user might have just added a key in another tab.
  const [providers, setProviders] = useState<ModelProviderConfig[]>([])
  useEffect(() => {
    setProviders(loadProviderConfigs())
  }, [])
  const refreshProviders = () => setProviders(loadProviderConfigs())

  // Which provider slot + model the user wants to chat with. Defaults
  // to whatever they last picked (localStorage), falling back to the
  // primary configured provider on first run. The model is a chat
  // override on top of whatever model is saved in Settings for that
  // slot — same pattern as the Prompt Playground's per-slot override.
  const [chatSlot, setChatSlot] = useState<LlmSlot | null>(null)
  const [chatModel, setChatModel] = useState<string | null>(null)
  useEffect(() => {
    setChatSlot(readStoredSlot())
    setChatModel(readStoredModel())
  }, [])
  // Once providers load, pick a sensible default slot if none stored.
  useEffect(() => {
    if (chatSlot !== null) return
    const primary = pickPrimaryProvider(providers)
    if (!primary) return
    // Reverse-look-up: which named slot owns this primary config?
    for (const s of LLM_SLOTS) {
      const c = getSlotConfig(s, providers)
      if (c?.id === primary.id) {
        setChatSlot(s)
        return
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length])

  function updateChatSlot(s: LlmSlot) {
    setChatSlot(s)
    writeStoredSlot(s)
    // Reset the model override when switching slots — the catalog is
    // per-slot, so a stored "gpt-4o-mini" choice makes no sense after
    // flipping to Anthropic.
    setChatModel(null)
    writeStoredModel(null)
  }
  function updateChatModel(m: string | null) {
    setChatModel(m)
    writeStoredModel(m)
  }

  // Resolve the active config + effective model. `provider` may still
  // be undefined if the user picked a slot they haven't configured —
  // we surface that case with a clear "not configured" banner rather
  // than silently swap to another slot.
  const activeSlot: LlmSlot = chatSlot ?? "openai"
  const provider = chatSlot ? getSlotConfig(chatSlot, providers) : undefined
  const effectiveModel =
    (chatModel && chatModel.trim()) ||
    provider?.model ||
    SLOT_META[activeSlot].defaultModel

  // Detected agents come from the live scan, not a hardcoded list.
  // Falls back to a single "All" entry when nothing was detected so
  // the dropdown is never empty.
  const detectedAgents = useMemo(() => {
    const set = new Set<string>()
    for (const a of scanReport?.agents_detected ?? []) {
      if (a.name) set.add(a.name)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [scanReport])

  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_GREETING])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<string>(ALL_AGENTS)
  const [selectedFindingId, setSelectedFindingId] =
    useState<string>(NO_FINDING)
  const [selectedFile, setSelectedFile] = useState<string>(NO_FILE)

  // Reset narrowing whenever the scan changes — old finding ids would
  // dangle and the file list would be stale.
  useEffect(() => {
    setSelectedFindingId(NO_FINDING)
    setSelectedFile(NO_FILE)
    setSelectedAgent(ALL_AGENTS)
  }, [scanReport?.generated_at])

  // List of findings the user can pin as the focus of the conversation.
  // Capped at 50 so a 10k-finding repo doesn't render an unusable
  // dropdown — we sort by severity weight first, then by file.
  const findingChoices = useMemo(() => {
    const all = scanReport?.findings ?? []
    const ranked = [...all].sort(
      (a, b) =>
        SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
        a.file.localeCompare(b.file)
    )
    return ranked.slice(0, 50)
  }, [scanReport])

  // Available files = unique files referenced by findings. Same cap rationale.
  const fileChoices = useMemo(() => {
    const set = new Set<string>()
    for (const f of scanReport?.findings ?? []) set.add(f.file)
    return Array.from(set).sort().slice(0, 100)
  }, [scanReport])

  const selectedFinding = useMemo(
    () =>
      selectedFindingId === NO_FINDING
        ? null
        : scanReport?.findings.find((f) => f.id === selectedFindingId) ?? null,
    [scanReport, selectedFindingId]
  )

  const suggestedQuestions = useMemo(
    () => buildSuggestedQuestions(scanReport, selectedAgent, selectedFinding),
    [scanReport, selectedAgent, selectedFinding]
  )

  // Auto-scroll the chat to the latest message.
  const scrollEndRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages.length, busy])

  /* -------------------------------------------------------------------- */
  /* Send a turn                                                          */
  /* -------------------------------------------------------------------- */

  async function send() {
    const text = input.trim()
    if (!text || busy) return

    const userMsg: ChatMessage = {
      id: messages.length + 1,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, userMsg])
    setInput("")

    if (!provider) {
      // Clear, honest empty-state instead of pretending to answer.
      setMessages((prev) => [
        ...prev,
        {
          id: prev.length + 1,
          role: "assistant",
          content:
            "I can't answer yet — there's no LLM provider configured. Add one in Settings → LLM Providers, then try again.",
          timestamp: new Date().toISOString(),
          errored: true,
        },
      ])
      return
    }

    setBusy(true)
    const systemPrompt = buildSystemPrompt({
      scanReport,
      selectedProject,
      currentBranch,
      selectedAgent,
      selectedFinding,
      selectedFile: selectedFile === NO_FILE ? null : selectedFile,
      latestScanId: latestScanId ?? null,
      latestScanTimestamp: latestScanTimestamp ?? null,
    })

    // Send the most recent ~10 turns of conversation so the model has
    // some history without us shipping the whole transcript on every
    // call. The system prompt already carries scan context.
    const history = messages
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }))

    try {
      const res = await fetch("/api/playground/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: provider.type,
          apiKey: provider.apiKey,
          // Use the user's chat-side override if they picked one,
          // otherwise fall back to the model saved in Settings.
          model: effectiveModel,
          baseUrl: provider.baseUrl,
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: text },
          ],
          temperature: 0.2,
          maxTokens: 1024,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        text?: string
        error?: string
      }
      if (!res.ok || !body.ok) {
        setMessages((prev) => [
          ...prev,
          {
            id: prev.length + 1,
            role: "assistant",
            content: body.error || `Request failed (${res.status}).`,
            timestamp: new Date().toISOString(),
            errored: true,
          },
        ])
      } else {
        const refs = extractFileReferences(body.text ?? "")
        setMessages((prev) => [
          ...prev,
          {
            id: prev.length + 1,
            role: "assistant",
            content: body.text ?? "(empty response)",
            timestamp: new Date().toISOString(),
            references: refs.length > 0 ? refs : undefined,
          },
        ])
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: prev.length + 1,
          role: "assistant",
          content: e instanceof Error ? e.message : "Network error.",
          timestamp: new Date().toISOString(),
          errored: true,
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  function clearConversation() {
    setMessages([INITIAL_GREETING])
  }

  /* -------------------------------------------------------------------- */
  /* Render                                                               */
  /* -------------------------------------------------------------------- */

  return (
    <div className="p-6 h-[calc(100vh-5.5rem)] flex flex-col">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Chat Assistant</h1>
          <p className="text-muted-foreground text-sm">
            Grounded in your latest scan. Configure the model in{" "}
            <span className="font-medium">Settings → LLM Providers</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {provider && (
            <Badge variant="outline" className="text-xs">
              <Bot className="h-3 w-3 mr-1" />
              {SLOT_META[activeSlot].label} ·{" "}
              <span className="font-mono ml-1">{effectiveModel}</span>
            </Badge>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearConversation}
            disabled={messages.length <= 1}
          >
            Clear chat
          </Button>
        </div>
      </div>

      {!provider && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-300">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            {providers.length === 0 ? (
              <>
                No LLM provider configured. Add one in{" "}
                <span className="font-medium">Settings → LLM Providers</span>{" "}
                (OpenAI, Anthropic, Gemini, or any OpenAI-compatible
                endpoint), then{" "}
                <button
                  type="button"
                  onClick={refreshProviders}
                  className="underline underline-offset-2 hover:text-yellow-200"
                >
                  refresh
                </button>
                .
              </>
            ) : (
              <>
                The selected provider ({SLOT_META[activeSlot].label}) isn't
                configured yet. Pick a different one on the right or add an
                API key in{" "}
                <span className="font-medium">Settings → LLM Providers</span>.
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 flex gap-6 min-h-0">
        {/* Chat Panel */}
        <Card className="flex-1 bg-card border-border flex flex-col">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {busy && (
                <div className="flex gap-3">
                  <div className="p-2 bg-accent/10 rounded-lg border border-accent/20 h-fit">
                    <Bot className="h-4 w-4 text-accent" />
                  </div>
                  <div className="bg-secondary/30 rounded-2xl rounded-tl-md p-4">
                    <div className="flex gap-1">
                      <span
                        className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
                        style={{ animationDelay: "0ms" }}
                      />
                      <span
                        className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
                        style={{ animationDelay: "150ms" }}
                      />
                      <span
                        className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
                        style={{ animationDelay: "300ms" }}
                      />
                    </div>
                  </div>
                </div>
              )}
              <div ref={scrollEndRef} />
            </div>
          </ScrollArea>

          {/* Input */}
          <CardContent className="border-t border-border p-4">
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder={
                  scanReport
                    ? "Ask about a finding, an agent, or how to fix something…"
                    : "Open a project and run a scan first to ground the assistant."
                }
                className="bg-secondary/50"
                disabled={busy}
              />
              <Button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim() || busy}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Sidebar */}
        <div className="w-80 space-y-4 overflow-y-auto pr-1">
          {/* Model picker — pick provider + specific model for the chat.
           *  Persisted in localStorage so the choice survives reloads.
           *  The model dropdown is the same per-slot catalog the
           *  Prompt Playground uses (gpt-4o, claude-3-5-sonnet, …),
           *  with a "Default (saved)" entry that defers to whatever is
           *  saved in Settings for that slot. */}
          <ChatModelPicker
            slot={activeSlot}
            providers={providers}
            chatModel={chatModel}
            onSlotChange={updateChatSlot}
            onModelChange={updateChatModel}
          />

          {/* Agent narrowing */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-accent" />
                  <Label className="text-sm font-medium">
                    Narrow by agent
                  </Label>
                </div>
                <Select
                  value={selectedAgent}
                  onValueChange={setSelectedAgent}
                >
                  <SelectTrigger className="bg-secondary/50">
                    <SelectValue placeholder="All agents" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_AGENTS}>All agents</SelectItem>
                    {detectedAgents.length === 0 ? (
                      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        No agents detected in this scan.
                      </div>
                    ) : (
                      detectedAgents.map((a) => (
                        <SelectItem key={a} value={a}>
                          {a}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Info className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>
                    Filters which findings I include in my context. Defaults
                    to all detected agents.
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Finding pin */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-orange-400" />
                  <Label className="text-sm font-medium">
                    Pin a finding (optional)
                  </Label>
                </div>
                <Select
                  value={selectedFindingId}
                  onValueChange={setSelectedFindingId}
                >
                  <SelectTrigger className="bg-secondary/50">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_FINDING}>None</SelectItem>
                    {findingChoices.length === 0 ? (
                      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        No findings to pin.
                      </div>
                    ) : (
                      findingChoices.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          <span className="flex items-center gap-2">
                            <SeverityDot severity={f.severity} />
                            <span className="truncate max-w-[180px]">
                              {f.title}
                            </span>
                            <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[80px]">
                              {basename(f.file)}
                            </span>
                          </span>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Current Context — every value is real */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="text-sm font-medium mb-3">Current Context</div>
              <div className="space-y-3 text-sm">
                <ContextRow
                  label="Project"
                  value={selectedProject?.name || "None"}
                />
                <ContextRow label="Branch" value={currentBranch || "None"} />
                <ContextRow
                  label="Agent context"
                  value={
                    selectedAgent === ALL_AGENTS
                      ? "All"
                      : selectedAgent
                  }
                />
                <ContextRow
                  label="Pinned finding"
                  value={
                    selectedFinding
                      ? `${selectedFinding.severity} · ${truncate(
                          selectedFinding.title,
                          28
                        )}`
                      : "None"
                  }
                />
                <ContextRow
                  label="Selected file"
                  value={
                    selectedFile === NO_FILE
                      ? selectedFinding?.file ?? "None"
                      : selectedFile
                  }
                  mono
                  truncate
                />
                <ContextRow
                  label="Scan run"
                  value={
                    latestScanId
                      ? `${latestScanId.slice(0, 12)}…`
                      : scanReport
                      ? "(unsaved)"
                      : "None"
                  }
                  mono
                />
                <ContextRow
                  label="Scanned at"
                  value={
                    latestScanTimestamp
                      ? new Date(latestScanTimestamp).toLocaleString()
                      : scanReport
                      ? new Date(scanReport.generated_at).toLocaleString()
                      : "Never"
                  }
                />
              </div>
            </CardContent>
          </Card>

          {/* Suggested Questions — generated from the actual scan */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="h-4 w-4 text-accent" />
                <span className="text-sm font-medium">Try asking</span>
              </div>
              <div className="space-y-2">
                {suggestedQuestions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Run a scan to get tailored question ideas.
                  </p>
                ) : (
                  suggestedQuestions.map((q, i) => (
                    <button
                      type="button"
                      key={i}
                      onClick={() => setInput(q.text)}
                      className="w-full flex items-center gap-3 p-3 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors text-left group"
                    >
                      <q.icon className={`h-4 w-4 ${q.color}`} />
                      <span className="text-sm flex-1">{q.text}</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {!provider && (
            <Card className="bg-card border-border">
              <CardContent className="pt-4 text-xs text-muted-foreground space-y-2">
                <div className="flex items-center gap-2 text-foreground/90 text-sm">
                  <SettingsIcon className="h-4 w-4" />
                  Why no answer?
                </div>
                <p>
                  We never ship your repo or your key to a third party
                  automatically. Add your own provider in Settings, then come
                  back here.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Sub-components                                                             */
/* -------------------------------------------------------------------------- */

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user"
  return (
    <div className={`flex gap-3 ${isUser ? "justify-end" : ""}`}>
      {!isUser && (
        <div className="p-2 bg-accent/10 rounded-lg border border-accent/20 h-fit">
          <Bot className="h-4 w-4 text-accent" />
        </div>
      )}
      <div
        className={`max-w-[80%] ${
          isUser
            ? "bg-primary text-primary-foreground rounded-2xl rounded-tr-md px-4 py-2"
            : "space-y-3"
        }`}
      >
        {!isUser ? (
          <>
            <div
              className={`rounded-2xl rounded-tl-md p-4 whitespace-pre-wrap text-sm leading-relaxed ${
                message.errored
                  ? "bg-red-500/10 border border-red-500/30 text-red-300"
                  : "bg-secondary/30"
              }`}
            >
              {message.content}
            </div>
            {message.references && message.references.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {message.references.map((ref, i) => (
                  <Badge
                    key={i}
                    variant="outline"
                    className="text-xs bg-secondary/30"
                  >
                    <FileCode className="h-3 w-3 mr-1" />
                    {ref.file}
                    {typeof ref.line === "number" ? `:${ref.line}` : ""}
                  </Badge>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm">{message.content}</p>
        )}
      </div>
      {isUser && (
        <div className="p-2 bg-secondary rounded-lg h-fit">
          <User className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
    </div>
  )
}

/**
 * Provider slot + model picker for the chat. The slot select shows
 * which providers the user has configured (highlighting unconfigured
 * ones in yellow); the model select is the curated catalog for the
 * chosen slot, with sentinel entries for "Default (saved)" and
 * "Custom model name…".
 */
function ChatModelPicker({
  slot,
  providers,
  chatModel,
  onSlotChange,
  onModelChange,
}: {
  slot: LlmSlot
  providers: ModelProviderConfig[]
  chatModel: string | null
  onSlotChange: (s: LlmSlot) => void
  onModelChange: (m: string | null) => void
}) {
  const cfg = getSlotConfig(slot, providers)
  const meta = SLOT_META[slot]
  const catalog = MODEL_CATALOG[slot]
  const overrideIsCustom =
    chatModel !== null && !isKnownModel(slot, chatModel)

  const DEFAULT = "__default__"
  const CUSTOM = "__custom__"
  const pickerValue = (() => {
    if (chatModel === null) return DEFAULT
    if (overrideIsCustom) return CUSTOM
    return chatModel
  })()

  return (
    <Card className="bg-card border-border">
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-accent" />
          <Label className="text-sm font-medium">Chat with</Label>
        </div>

        {/* Provider slot — same set as Settings / Playground. */}
        <Select value={slot} onValueChange={(v) => onSlotChange(v as LlmSlot)}>
          <SelectTrigger className="bg-secondary/50 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LLM_SLOTS.map((s) => {
              const c = getSlotConfig(s, providers)
              const m = SLOT_META[s]
              return (
                <SelectItem key={s} value={s}>
                  <span className="flex items-center gap-2">
                    <span>{m.label}</span>
                    {!c && (
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

        {/* Model picker for the chosen slot. Only shown when the slot
         *  has a configured key — otherwise the Settings card already
         *  surfaces what to do next, and a model picker without a key
         *  would be misleading. */}
        {cfg && !overrideIsCustom && (
          <Select
            value={pickerValue}
            onValueChange={(v) => {
              if (v === DEFAULT) onModelChange(null)
              else if (v === CUSTOM) onModelChange("")
              else onModelChange(v)
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
                {meta.label} models
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

        {/* Free-form input for one-off model ids — same UX as the
         *  Prompt Playground per-slot override. */}
        {cfg && overrideIsCustom && (
          <div className="flex items-center gap-2">
            <Input
              value={chatModel ?? ""}
              onChange={(e) => onModelChange(e.target.value)}
              placeholder={cfg.model}
              autoFocus
              className="bg-secondary/40 h-9 text-sm font-mono"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onModelChange(null)}
              className="h-9 text-xs text-muted-foreground"
              title="Use the model saved in Settings"
            >
              Use default
            </Button>
          </div>
        )}

        {!cfg && (
          <p className="text-[11px] text-yellow-400">
            Add an API key for {meta.label} in Settings to enable this slot.
          </p>
        )}

        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            Saved per-browser. Switching slots resets the model
            override.
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function ContextRow({
  label,
  value,
  mono,
  truncate: shouldTruncate,
}: {
  label: string
  value: string
  mono?: boolean
  truncate?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`text-xs bg-secondary/50 px-2 py-0.5 rounded ${
          mono ? "font-mono" : ""
        } ${shouldTruncate ? "truncate max-w-[150px]" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function SeverityDot({ severity }: { severity: string }) {
  const color =
    severity === "critical"
      ? "bg-red-500"
      : severity === "high"
      ? "bg-orange-500"
      : severity === "medium"
      ? "bg-yellow-500"
      : severity === "low"
      ? "bg-blue-500"
      : "bg-muted-foreground"
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
}

/* -------------------------------------------------------------------------- */
/* System prompt + suggestions + helpers                                      */
/* -------------------------------------------------------------------------- */

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
}

/** Files mentioned in the model's reply, lifted to chips below it. */
function extractFileReferences(text: string): { file: string; line?: number }[] {
  // Match "path/like/this.py" optionally followed by ":123". We allow
  // alphanumerics, slashes, dashes, dots, underscores in path segments.
  // Capped at 8 unique refs to avoid chip spam from a chatty model.
  const re = /\b([\w\-./]+\.(?:py|ts|tsx|js|jsx|md|yaml|yml|json|toml|txt))(?::(\d+))?/g
  const seen = new Map<string, { file: string; line?: number }>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const file = m[1]
    const line = m[2] ? Number(m[2]) : undefined
    const key = `${file}:${line ?? ""}`
    if (!seen.has(key)) seen.set(key, { file, line })
    if (seen.size >= 8) break
  }
  return Array.from(seen.values())
}

interface SystemContext {
  scanReport: ScanReport | null
  selectedProject: Project | null
  currentBranch: string
  selectedAgent: string
  selectedFinding: ScannerFinding | null
  selectedFile: string | null
  latestScanId: string | null
  latestScanTimestamp: string | null
}

/**
 * Build the system prompt. Deliberately compact: the model is meant
 * to be useful for this user's project, not given the entire repo.
 *
 * - Top 20 findings by severity (skipping persistent dupes).
 * - Truncates each finding's evidence to 240 chars to keep the prompt
 *   small enough to comfortably fit alongside several conversation turns.
 * - Filters by selectedAgent when set, so a user pinning "RefundAgent"
 *   doesn't get answers about unrelated agents.
 */
function buildSystemPrompt(ctx: SystemContext): string {
  const lines: string[] = []
  lines.push(
    "You are Edge Agent AI's chat assistant. You help the user understand and fix issues in their AI-agent codebase based on a recent local security scan."
  )
  lines.push(
    "Be concise. Cite files and line numbers when referencing the scan. Never invent file paths, finding ids, or line numbers — if it's not in the context below, say you don't have that information."
  )

  lines.push("")
  lines.push("## Project")
  lines.push(`- Name: ${ctx.selectedProject?.name ?? "(none open)"}`)
  if (ctx.selectedProject?.path) {
    lines.push(`- Path: ${ctx.selectedProject.path}`)
  }
  lines.push(`- Branch: ${ctx.currentBranch || "(unknown)"}`)
  if (ctx.latestScanId) lines.push(`- Scan id: ${ctx.latestScanId}`)
  if (ctx.latestScanTimestamp) {
    lines.push(`- Scanned at: ${ctx.latestScanTimestamp}`)
  }

  if (!ctx.scanReport) {
    lines.push("")
    lines.push(
      "## Scan: NONE — no scan has been run yet. Ask the user to run a scan from the Scan Center."
    )
    return lines.join("\n")
  }

  const r = ctx.scanReport
  lines.push("")
  lines.push("## Scan summary")
  lines.push(`- Risk score: ${r.risk_score}/100`)
  lines.push(
    `- Counts: critical=${r.summary.critical}, high=${r.summary.high}, medium=${r.summary.medium}, low=${r.summary.low}, total=${r.summary.total}`
  )
  if (r.frameworks_detected && r.frameworks_detected.length > 0) {
    lines.push(`- Frameworks: ${r.frameworks_detected.join(", ")}`)
  }

  if (r.agents_detected && r.agents_detected.length > 0) {
    lines.push("")
    lines.push("## Agents detected")
    for (const a of r.agents_detected.slice(0, 20)) {
      lines.push(
        `- ${a.name}${a.framework ? ` (${a.framework})` : ""} @ ${
          a.file
        }:${a.line}`
      )
    }
  }

  if (r.tools_detected && r.tools_detected.length > 0) {
    lines.push("")
    lines.push("## Tools detected")
    for (const t of r.tools_detected.slice(0, 30)) {
      lines.push(
        `- ${t.name}${t.agent ? ` (agent: ${t.agent})` : ""} @ ${t.file}:${
          t.line
        }`
      )
    }
  }

  // Findings — narrowed by selectedAgent if pinned, then ranked.
  let pool: ScannerFinding[] = r.findings
  if (ctx.selectedAgent !== ALL_AGENTS) {
    const filtered = pool.filter((f) => f.agent === ctx.selectedAgent)
    if (filtered.length > 0) pool = filtered
  }
  if (ctx.selectedFile) {
    const filtered = pool.filter((f) => f.file === ctx.selectedFile)
    if (filtered.length > 0) pool = filtered
  }
  const topFindings = [...pool]
    .sort(
      (a, b) =>
        SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
        a.file.localeCompare(b.file)
    )
    .slice(0, 20)

  if (topFindings.length > 0) {
    lines.push("")
    lines.push(
      `## Top ${topFindings.length} findings${
        ctx.selectedAgent !== ALL_AGENTS
          ? ` (filtered to agent ${ctx.selectedAgent})`
          : ""
      }`
    )
    for (const f of topFindings) {
      const evidence = truncate(
        (f.evidence ?? "").replace(/\s+/g, " "),
        240
      )
      lines.push(
        `- [${f.severity}] ${f.title} — ${f.file}:${f.line} (rule ${f.rule_id})`
      )
      if (evidence) lines.push(`    evidence: ${evidence}`)
      if (f.suggestedFix) {
        lines.push(`    suggested_fix: ${truncate(f.suggestedFix, 200)}`)
      }
    }
  }

  if (ctx.selectedFinding) {
    lines.push("")
    lines.push("## Pinned finding (treat as primary subject)")
    lines.push(
      `- id: ${ctx.selectedFinding.id} | severity: ${ctx.selectedFinding.severity} | rule: ${ctx.selectedFinding.rule_id}`
    )
    lines.push(`- title: ${ctx.selectedFinding.title}`)
    lines.push(
      `- location: ${ctx.selectedFinding.file}:${ctx.selectedFinding.line}`
    )
    if (ctx.selectedFinding.evidence) {
      lines.push(
        `- evidence: ${truncate(
          ctx.selectedFinding.evidence.replace(/\s+/g, " "),
          400
        )}`
      )
    }
    if (ctx.selectedFinding.suggestedFix) {
      lines.push(
        `- suggested_fix: ${truncate(ctx.selectedFinding.suggestedFix, 400)}`
      )
    }
  }

  return lines.join("\n")
}

interface SuggestedQuestion {
  text: string
  icon: typeof AlertTriangle
  color: string
}

/**
 * Build suggested questions from the actual scan. We deliberately
 * avoid generic prompts ("Why did accuracy drop?") because we have no
 * accuracy signal — those would imply functionality we don't have.
 */
function buildSuggestedQuestions(
  report: ScanReport | null,
  agent: string,
  finding: ScannerFinding | null
): SuggestedQuestion[] {
  const out: SuggestedQuestion[] = []

  if (finding) {
    out.push({
      text: `How do I fix the ${finding.rule_id} issue in ${basename(
        finding.file
      )}:${finding.line}?`,
      icon: AlertTriangle,
      color: "text-red-400",
    })
    out.push({
      text: `Why is "${truncate(finding.title, 60)}" rated ${
        finding.severity
      }?`,
      icon: Info,
      color: "text-orange-400",
    })
    out.push({
      text: `Generate a test case that would catch the ${finding.rule_id} issue.`,
      icon: TestTube,
      color: "text-green-400",
    })
  }

  if (report) {
    if ((report.summary.critical ?? 0) > 0) {
      out.push({
        text: `Walk me through the ${report.summary.critical} critical findings.`,
        icon: AlertTriangle,
        color: "text-red-400",
      })
    }
    if ((report.summary.high ?? 0) > 0) {
      out.push({
        text: `Which high-severity findings should I fix first and why?`,
        icon: AlertTriangle,
        color: "text-orange-400",
      })
    }
    if (report.agents_detected && report.agents_detected.length > 0) {
      const a =
        agent !== ALL_AGENTS
          ? agent
          : report.agents_detected[0]?.name
      if (a) {
        out.push({
          text: `What does the ${a} agent do, and what risks did the scan flag for it?`,
          icon: Bot,
          color: "text-blue-400",
        })
      }
    }
    if (report.tools_detected && report.tools_detected.length > 0) {
      out.push({
        text: `Which tools should require human approval before being called?`,
        icon: GitBranch,
        color: "text-purple-400",
      })
    }
    out.push({
      text: `Which files have the most findings and why?`,
      icon: FileCode,
      color: "text-blue-400",
    })
    out.push({
      text: `Generate test cases for the highest-severity finding.`,
      icon: TestTube,
      color: "text-green-400",
    })
  } else {
    out.push({
      text: "I haven't run a scan yet — what does Edge Agent AI check for?",
      icon: Info,
      color: "text-muted-foreground",
    })
  }

  // Cap to keep the side rail tidy.
  return out.slice(0, 6)
}

function truncate(s: string, n: number): string {
  if (!s) return ""
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  return i >= 0 ? p.slice(i + 1) : p
}
