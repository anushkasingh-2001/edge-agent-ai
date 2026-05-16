"use client"

/**
 * Understand Code Workflow — view.
 *
 * Sidebar tab that asks the user's currently selected project to be statically
 * analyzed (POST /api/workflow/analyze), then renders the result as:
 *
 *   - summary text + stats
 *   - Mermaid flowchart of components and inferred edges
 *   - component cards (entry points, agents, routes, prompts, tools, etc.)
 *   - prompt inventory with variables + previews
 *   - tool inventory with risk tags
 *   - model call inventory with provider + model
 *   - MCP / OpenAPI surfaces
 *   - "Ask about this repo" mini-chat (deterministic answers off the graph)
 *
 * No user code is ever executed; everything below is just a presentation
 * layer on top of the WorkflowAnalysis JSON.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronRight,
  Code2,
  Database,
  Download,
  ExternalLink,
  FileCode,
  FileText,
  Globe,
  Info,
  KeyRound,
  Layers,
  Loader2,
  MessageSquare,
  Network,
  Play,
  Search,
  ShieldAlert,
  Sparkles,
  Wrench,
  Workflow,
  Wand2,
} from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import type {
  WorkflowAnalysis,
  WorkflowComponent,
  WorkflowComponentType,
} from "@/lib/workflow-types"
import {
  getSlotConfig,
  loadProviderConfigs,
  type LlmSlot,
  type ModelProviderConfig,
} from "@/lib/model-keys"

/* -------------------------------------------------------------------------- */
/* Chat — provider catalogue (mirrors lib/workflow-chat.ts)                   */
/* -------------------------------------------------------------------------- */

/**
 * UI-only "deterministic" pseudo-provider — answered fully on the client
 * from the workflow graph, no API key needed. All other providers POST to
 * `/api/workflow/chat`.
 */
type ChatProviderChoice = "deterministic" | "openai" | "anthropic" | "gemini"

type ChatModelOption = { id: string; label: string; hint?: string }
type ChatProviderInfo = {
  id: ChatProviderChoice
  label: string
  envKey?: string
  docsUrl?: string
  defaultModel?: string
  models?: ChatModelOption[]
}

// Keep in lock-step with `PROVIDER_CATALOGUE` in lib/workflow-chat.ts. We
// duplicate (rather than fetching from the server) so the picker has zero
// network round-trips and can stay responsive even before analyze runs.
const CHAT_PROVIDERS: ChatProviderInfo[] = [
  {
    id: "deterministic",
    label: "Deterministic (no API key needed)",
  },
  {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    envKey: "OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.4-mini",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", hint: "Most capable (slow, expensive)" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", hint: "Balanced — recommended" },
      { id: "gpt-5.4-nano", label: "GPT-5.4 nano", hint: "Fastest, cheapest" },
      { id: "gpt-4o", label: "GPT-4o", hint: "Older but proven" },
      { id: "gpt-4o-mini", label: "GPT-4o mini", hint: "Older fallback" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    envKey: "ANTHROPIC_API_KEY",
    docsUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-4-6",
    models: [
      { id: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "Most capable" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Balanced — recommended" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest, cheapest" },
    ],
  },
  {
    id: "gemini",
    label: "Google (Gemini)",
    envKey: "GEMINI_API_KEY",
    docsUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-3-flash",
    models: [
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", hint: "Most capable" },
      { id: "gemini-3-flash", label: "Gemini 3 Flash", hint: "Balanced — recommended" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", hint: "Cheapest, lowest latency" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Older fallback" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Older fallback" },
    ],
  },
]

const CHAT_PROVIDER_BY_ID: Record<ChatProviderChoice, ChatProviderInfo> =
  Object.fromEntries(CHAT_PROVIDERS.map((p) => [p.id, p])) as Record<
    ChatProviderChoice,
    ChatProviderInfo
  >

/** localStorage keys for the user's last picked provider + model. */
const CHAT_LS_PROVIDER = "eaa.workflow.chat.provider"
const CHAT_LS_MODEL = "eaa.workflow.chat.model"

/**
 * Map our chat provider id (which is just nicer-looking UX strings) onto
 * the existing Settings page slot id, so we can fish out the API key the
 * user already configured. The slot ids are defined in `lib/model-keys.ts`.
 */
const CHAT_PROVIDER_TO_SLOT: Record<
  Exclude<ChatProviderChoice, "deterministic">,
  LlmSlot
> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
}

/* -------------------------------------------------------------------------- */
/* Mermaid renderer (lazy-loaded)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Renders Mermaid source as inline SVG. We dynamic-import the heavy
 * `mermaid` runtime so this dep only loads when this view actually mounts.
 *
 * Sizing strategy: we set `useMaxWidth: false` so mermaid produces an SVG
 * at its *natural* size instead of squishing it down to fit the card. The
 * surrounding wrapper then scrolls horizontally (and we apply a user-
 * controlled CSS zoom transform via the +/- buttons). On a 33-node graph
 * the difference is the diagram being unreadable vs. comfortable to scan.
 */
function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Start at 1.25× so the first render lands comfortably readable on a
  // 14"-15" laptop. The previous default of 1.0 felt cramped for users.
  const [zoom, setZoom] = useState(1.25)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const svgWrapperRef = useRef<HTMLDivElement | null>(null)
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 10)}`)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    ;(async () => {
      try {
        const mod = await import("mermaid")
        const mermaid = mod.default
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
          // Bigger default font + native-size SVG: combined these are the
          // single biggest readability fix for dense diagrams. Without
          // `useMaxWidth: false`, mermaid emits `style="max-width:..."` on
          // the <svg> which forces shrink-to-fit.
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          themeVariables: {
            fontSize: "15px",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          },
          flowchart: {
            curve: "basis",
            htmlLabels: false,
            useMaxWidth: false,
            nodeSpacing: 55,
            rankSpacing: 90,
            padding: 12,
          },
        })
        const { svg: rendered } = await mermaid.render(
          idRef.current,
          source
        )
        if (!cancelled) setSvg(rendered)
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to render diagram")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source])

  if (error) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <div className="font-medium text-destructive mb-1">
          Couldn&apos;t render the workflow diagram
        </div>
        <div className="text-muted-foreground">{error}</div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Raw Mermaid source
          </summary>
          <pre className="mt-2 overflow-auto text-xs">{source}</pre>
        </details>
      </div>
    )
  }
  if (!svg) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Rendering diagram…
      </div>
    )
  }
  // Auto-fit: measure native SVG width vs container width and pick a zoom
  // factor that makes the diagram fill the available horizontal space.
  const fitToWidth = (): void => {
    const container = containerRef.current
    const wrapper = svgWrapperRef.current
    if (!container || !wrapper) return
    const svgEl = wrapper.querySelector("svg")
    if (!svgEl) return
    // Read the SVG's "natural" width — try viewBox first (more reliable than
    // measured width which would already include the current scale).
    const viewBox = svgEl.getAttribute("viewBox")
    let nativeWidth = svgEl.getBoundingClientRect().width / zoom
    if (viewBox) {
      const parts = viewBox.split(/\s+/)
      const w = Number.parseFloat(parts[2])
      if (Number.isFinite(w) && w > 0) nativeWidth = w
    }
    const containerWidth = container.clientWidth - 32 // account for p-4
    if (nativeWidth <= 0 || containerWidth <= 0) return
    const target = Math.max(0.5, Math.min(2.5, +(containerWidth / nativeWidth).toFixed(2)))
    setZoom(target)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="hidden sm:block">
          Tip: scroll inside the diagram to pan; use the controls to zoom.
        </div>
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1">Zoom</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}
            aria-label="Zoom out"
          >
            −
          </Button>
          <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))}
            aria-label="Zoom in"
          >
            +
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={fitToWidth}
            title="Scale the diagram to fill the available width"
          >
            Fit width
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => setZoom(1.25)}
          >
            Reset
          </Button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="workflow-mermaid overflow-auto rounded-md border bg-muted/20 p-4 min-h-[560px] max-h-[820px]"
      >
        <div
          ref={svgWrapperRef}
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
            // Compensate for transform so scrollable area still works.
            width: `${100 / zoom}%`,
          }}
          // mermaid output is server-rendered SVG from our own analyzer data;
          // securityLevel:"strict" further blocks anything dynamic.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const TYPE_META: Record<
  WorkflowComponentType,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: string }
> = {
  entrypoint: { label: "Entry point", icon: Play, tone: "text-emerald-400" },
  api_route: { label: "API route", icon: Globe, tone: "text-sky-400" },
  agent: { label: "Agent", icon: Bot, tone: "text-violet-400" },
  graph_node: { label: "Graph node", icon: Network, tone: "text-cyan-400" },
  prompt: { label: "Prompt", icon: FileText, tone: "text-amber-400" },
  tool: { label: "Tool", icon: Wrench, tone: "text-orange-400" },
  model_call: { label: "Model call", icon: Sparkles, tone: "text-fuchsia-400" },
  mcp_server: { label: "MCP server", icon: Layers, tone: "text-teal-400" },
  openapi_tool: { label: "OpenAPI tool", icon: Code2, tone: "text-blue-400" },
  database: { label: "Database", icon: Database, tone: "text-indigo-400" },
  file_io: { label: "File I/O", icon: FileCode, tone: "text-slate-400" },
  unknown: { label: "Unknown", icon: Info, tone: "text-muted-foreground" },
}

function ComponentIcon({
  type,
  className,
}: {
  type: WorkflowComponentType
  className?: string
}) {
  const Icon = (TYPE_META[type] ?? TYPE_META.unknown).icon
  return <Icon className={className} />
}

/**
 * Tiny markdown-lite renderer for the summary text. The analyzer produces
 * plain text with these formatting features:
 *
 *   - `**bold**` → <strong>
 *   - `` `code` `` → <code>
 *   - `## Heading` (line-start) → <h3>
 *   - `1. text` / `N. text` (line-start) → <ol><li>
 *   - `• text` (line-start) → <ul><li>
 *   - `\n\n` → paragraph break
 *
 * Full markdown is overkill for one paragraph of narrative — and pulling in
 * react-markdown would add 60+ KB just to render a handful of marks.
 */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  let tokenIdx = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx)
      tokens.push(
        <span key={`${keyBase}-t-${tokenIdx++}`}>
          {text.slice(lastIdx, m.index)}
        </span>
      )
    if (m[1] !== undefined) {
      tokens.push(<strong key={`${keyBase}-b-${tokenIdx++}`}>{m[1]}</strong>)
    } else if (m[2] !== undefined) {
      tokens.push(
        <code
          key={`${keyBase}-c-${tokenIdx++}`}
          className="text-[12.5px] px-1 py-0.5 rounded bg-muted/60 font-mono"
        >
          {m[2]}
        </code>
      )
    }
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length)
    tokens.push(
      <span key={`${keyBase}-t-${tokenIdx++}`}>{text.slice(lastIdx)}</span>
    )
  return tokens
}

function renderSummary(text: string): React.ReactNode {
  // Split into "blocks" separated by blank lines.
  const blocks = text.split(/\n{2,}/g)
  return blocks.map((block, bi) => {
    const lines = block.split("\n")
    const first = lines[0]

    // Heading block: a single line starting with "## ".
    if (lines.length === 1 && first.startsWith("## ")) {
      return (
        <h3
          key={`h-${bi}`}
          className="text-base font-semibold mt-4 mb-1 text-foreground flex items-center gap-2"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {renderInline(first.slice(3), `h-${bi}`)}
        </h3>
      )
    }

    // Numbered list block: every line begins with "N. ".
    if (lines.length > 1 && lines.every((l) => /^\d+\.\s+/.test(l))) {
      return (
        <ol key={`ol-${bi}`} className="list-decimal pl-6 space-y-1.5 text-sm leading-relaxed marker:text-muted-foreground">
          {lines.map((l, li) => (
            <li key={`ol-${bi}-${li}`}>
              {renderInline(l.replace(/^\d+\.\s+/, ""), `ol-${bi}-${li}`)}
            </li>
          ))}
        </ol>
      )
    }

    // Bullet list block: every line begins with "• ".
    if (lines.length > 1 && lines.every((l) => l.startsWith("• "))) {
      return (
        <ul key={`ul-${bi}`} className="list-disc pl-6 space-y-1 text-sm leading-relaxed marker:text-muted-foreground">
          {lines.map((l, li) => (
            <li key={`ul-${bi}-${li}`}>
              {renderInline(l.slice(2), `ul-${bi}-${li}`)}
            </li>
          ))}
        </ul>
      )
    }

    // Mixed bullets (intro line + bullets) — split into intro + list.
    if (lines.some((l) => l.startsWith("• "))) {
      const intro: string[] = []
      const bullets: string[] = []
      let inBullets = false
      for (const l of lines) {
        if (l.startsWith("• ")) {
          inBullets = true
          bullets.push(l.slice(2))
        } else if (!inBullets) intro.push(l)
        else bullets.push(l) // continuation line
      }
      return (
        <div key={`mix-${bi}`} className="space-y-1.5">
          {intro.length > 0 && (
            <p className="text-sm leading-relaxed">
              {renderInline(intro.join(" "), `mix-${bi}-intro`)}
            </p>
          )}
          {bullets.length > 0 && (
            <ul className="list-disc pl-6 space-y-1 text-sm leading-relaxed marker:text-muted-foreground">
              {bullets.map((b, bii) => (
                <li key={`mix-${bi}-b-${bii}`}>{renderInline(b, `mix-${bi}-b-${bii}`)}</li>
              ))}
            </ul>
          )}
        </div>
      )
    }

    // Default: paragraph.
    return (
      <p key={`p-${bi}`} className="text-sm leading-relaxed">
        {renderInline(block, `p-${bi}`)}
      </p>
    )
  })
}

function triggerDownload(filename: string, content: string, mime: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 0)
}

/* -------------------------------------------------------------------------- */
/* Deterministic Q&A                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Answers common questions strictly from the WorkflowAnalysis — no LLM call.
 * Returns null when the question pattern doesn't match anything we can
 * reliably answer; the caller surfaces the canned "not enough info" line.
 */
function answerFromGraph(
  q: string,
  a: WorkflowAnalysis
): string | null {
  const ql = q.toLowerCase().trim()
  if (!ql) return null

  const list = (xs: string[]) => (xs.length === 0 ? "(none)" : xs.join(", "))

  if (/(entry|entrypoint|main entrypoint|main\s)/.test(ql)) {
    if (a.entrypoints.length === 0)
      return "No explicit entry points were detected in this repository."
    return `Detected ${a.entrypoints.length} entry point${
      a.entrypoints.length === 1 ? "" : "s"
    }:\n${a.entrypoints
      .map((e) => `• ${e.reason} — ${e.file}${e.line ? `:${e.line}` : ""}`)
      .join("\n")}`
  }
  if (/prompt/.test(ql) && /(final|summary|control)/.test(ql)) {
    // "which prompt controls the final summary" — pick the prompt referenced
    // by the most model calls; tiebreak by most variables.
    if (a.prompts.length === 0) return "No prompt templates were detected."
    const ranked = [...a.prompts].sort((x, y) => {
      const xRefs = a.modelCalls.filter((m) => m.promptRefs.includes(x.name)).length
      const yRefs = a.modelCalls.filter((m) => m.promptRefs.includes(y.name)).length
      if (xRefs !== yRefs) return yRefs - xRefs
      return y.variables.length - x.variables.length
    })
    const top = ranked[0]
    return `Likely the **${top.name}** prompt at \`${top.file}${
      top.line ? `:${top.line}` : ""
    }\` (variables: ${list(top.variables)}).`
  }
  if (/prompt/.test(ql)) {
    if (a.prompts.length === 0) return "No prompt templates were detected."
    return `${a.prompts.length} prompt${a.prompts.length === 1 ? "" : "s"} detected:\n${a.prompts
      .map((p) => `• ${p.name} — \`${p.file}${p.line ? `:${p.line}` : ""}\` vars: ${list(p.variables)}`)
      .join("\n")}`
  }
  if (/(llm|model|openai|anthropic|gemini)/.test(ql) && /(call|file|where)/.test(ql)) {
    if (a.modelCalls.length === 0) return "No LLM calls were detected."
    const files = Array.from(new Set(a.modelCalls.map((m) => m.file)))
    return `LLM calls are made from ${files.length} file${files.length === 1 ? "" : "s"}:\n${files
      .map((f) => {
        const calls = a.modelCalls.filter((m) => m.file === f)
        const providers = Array.from(new Set(calls.map((c) => c.provider)))
        return `• ${f} — ${providers.join(", ")}`
      })
      .join("\n")}`
  }
  if (/danger|risk/.test(ql) && /tool/.test(ql)) {
    const risky = a.tools.filter((t) => t.riskTags.length > 0)
    if (risky.length === 0)
      return "No tools were flagged with risk tags (filesystem / shell / payments / external API)."
    return `${risky.length} potentially risky tool${risky.length === 1 ? "" : "s"} detected:\n${risky
      .map(
        (t) =>
          `• ${t.name} — \`${t.file}${t.line ? `:${t.line}` : ""}\` (tags: ${t.riskTags.join(", ")})`
      )
      .join("\n")}`
  }
  if (/tool/.test(ql)) {
    if (a.tools.length === 0) return "No tools were detected."
    return `${a.tools.length} tool${a.tools.length === 1 ? "" : "s"} detected:\n${a.tools
      .map((t) => `• ${t.name} — \`${t.file}\` params: ${list(t.parameters)}`)
      .join("\n")}`
  }
  if (/(data|flow|how.+work)/.test(ql)) {
    return a.summary
  }
  if (/(output|return).+component/.test(ql) || /what.+component.+output/.test(ql)) {
    const ents = a.components.filter((c) => c.outputs.length > 0)
    if (ents.length === 0) return "No component outputs were inferable from static analysis."
    return `Inferred outputs:\n${ents
      .slice(0, 12)
      .map((c) => `• ${c.name} → ${list(c.outputs)}`)
      .join("\n")}`
  }
  if (/(component|node)/.test(ql)) {
    return `Detected ${a.components.length} components:\n${a.components
      .slice(0, 20)
      .map((c) => `• [${c.type}] ${c.name} — \`${c.file}\``)
      .join("\n")}${a.components.length > 20 ? `\n… and ${a.components.length - 20} more.` : ""}`
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Component card                                                             */
/* -------------------------------------------------------------------------- */

function ComponentCard({ c }: { c: WorkflowComponent }) {
  const meta = TYPE_META[c.type] ?? TYPE_META.unknown
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <ComponentIcon
              type={c.type}
              className={`h-4 w-4 mt-1 shrink-0 ${meta.tone}`}
            />
            <div className="min-w-0">
              <CardTitle className="text-sm font-medium leading-tight break-words">
                {c.name}
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                <Badge variant="outline" className="mr-2 font-normal">
                  {meta.label}
                </Badge>
                {c.framework && (
                  <Badge variant="secondary" className="mr-2 font-normal">
                    {c.framework}
                  </Badge>
                )}
                <code className="text-[11px] text-muted-foreground">
                  {c.file}
                  {typeof c.line === "number" ? `:${c.line}` : ""}
                </code>
              </CardDescription>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2 text-xs space-y-2">
        {c.description && (
          <p className="text-muted-foreground">{c.description}</p>
        )}
        {(c.inputs.length > 0 || c.outputs.length > 0) && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                Inputs
              </div>
              <div className="flex flex-wrap gap-1">
                {c.inputs.length === 0 ? (
                  <span className="text-muted-foreground italic">—</span>
                ) : (
                  c.inputs.map((i, idx) => (
                    // Index is part of the key because raw extracted variable
                    // names (from prompt templates / tool params) can repeat
                    // — e.g. two `{user_message}` occurrences. Pure-value
                    // keys produce React's "duplicate key" warnings.
                    <Badge key={`${idx}-${i}`} variant="outline" className="text-[10px] font-normal">
                      {i}
                    </Badge>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                Outputs
              </div>
              <div className="flex flex-wrap gap-1">
                {c.outputs.length === 0 ? (
                  <span className="text-muted-foreground italic">—</span>
                ) : (
                  c.outputs.map((o, idx) => (
                    <Badge key={`${idx}-${o}`} variant="outline" className="text-[10px] font-normal">
                      {o}
                    </Badge>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
        {c.evidence.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
              Evidence ({c.evidence.length})
            </summary>
            <ul className="mt-1 space-y-1">
              {c.evidence.map((e, idx) => (
                <li
                  key={idx}
                  className="font-mono text-[11px] text-muted-foreground bg-muted/30 rounded px-2 py-1 overflow-x-auto"
                >
                  {e}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Main view                                                                  */
/* -------------------------------------------------------------------------- */

interface UnderstandCodeWorkflowProps {
  hasProject?: boolean
  projectPath?: string | null
  projectName?: string | null
  /**
   * Optional escape hatch so the "Configure in Settings" inline button can
   * deep-link to the Settings tab without us reaching for window.location.
   * The parent owns the view router; we just call this.
   */
  onNavigateToSettings?: () => void
}

export function UnderstandCodeWorkflow({
  hasProject = false,
  projectPath = null,
  projectName = null,
  onNavigateToSettings,
}: UnderstandCodeWorkflowProps) {
  const [analysis, setAnalysis] = useState<WorkflowAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [typeFilter, setTypeFilter] = useState<WorkflowComponentType | "all">("all")
  const [question, setQuestion] = useState("")
  // Each chat entry now carries the source (which provider/model answered),
  // an optional latency, and an error flag so the UI can distinguish
  // upstream failures from successful answers.
  const [qaHistory, setQaHistory] = useState<
    {
      q: string
      a: string
      at: string
      source: ChatProviderChoice
      model?: string
      latencyMs?: number
      isError?: boolean
    }[]
  >([])
  const [asking, setAsking] = useState(false)

  // Provider/model selector — persisted in localStorage so the user doesn't
  // have to re-pick each session. We hydrate from storage *after* mount to
  // avoid a SSR/CSR mismatch.
  const [chatProvider, setChatProvider] = useState<ChatProviderChoice>(
    "deterministic"
  )
  const [chatModel, setChatModel] = useState<string>("")

  // Pulled from the existing Settings page's localStorage entries — this is
  // the same source the Prompt Playground and Chat Assistant use. We reload
  // whenever the storage event fires so saving a key in Settings instantly
  // unblocks the chat here without a full reload.
  const [providerConfigs, setProviderConfigs] = useState<
    ModelProviderConfig[]
  >([])

  useEffect(() => {
    setProviderConfigs(loadProviderConfigs())
    const onStorage = (e: StorageEvent): void => {
      if (e.key === null || e.key === "edge-agent-ai.modelKeys") {
        setProviderConfigs(loadProviderConfigs())
      }
    }
    // Cross-tab updates fire `storage`. Same-tab updates (the common case
    // when the user toggles to Settings, saves a key, then comes back) don't
    // fire `storage`, so we ALSO refresh on `focus` / visibility change.
    const refresh = (): void => setProviderConfigs(loadProviderConfigs())
    window.addEventListener("storage", onStorage)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [])

  /** Resolved (provider, apiKey, model, baseUrl) for the current selection. */
  const activeProviderConfig = useMemo(() => {
    if (chatProvider === "deterministic") return null
    const slot = CHAT_PROVIDER_TO_SLOT[chatProvider]
    return getSlotConfig(slot, providerConfigs) ?? null
  }, [chatProvider, providerConfigs])

  useEffect(() => {
    try {
      const p = localStorage.getItem(CHAT_LS_PROVIDER) as ChatProviderChoice | null
      const m = localStorage.getItem(CHAT_LS_MODEL)
      if (p && CHAT_PROVIDER_BY_ID[p]) setChatProvider(p)
      if (m) setChatModel(m)
    } catch {
      // localStorage can throw in private windows — fall back to defaults.
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_LS_PROVIDER, chatProvider)
    } catch {
      /* ignore */
    }
  }, [chatProvider])

  useEffect(() => {
    try {
      if (chatModel) localStorage.setItem(CHAT_LS_MODEL, chatModel)
    } catch {
      /* ignore */
    }
  }, [chatModel])

  // When the user switches providers, snap the model to:
  //   1) what they saved in Settings for this provider (if any), else
  //   2) the previously-picked model if it's still in our recommended list,
  //   3) our balanced default for the provider.
  // Saved-Settings model wins because that's the model the user explicitly
  // signed off on; respecting it means switching the dropdown matches the
  // model the Prompt Playground / Chat Assistant already use.
  useEffect(() => {
    const info = CHAT_PROVIDER_BY_ID[chatProvider]
    if (!info || !info.models) {
      setChatModel("")
      return
    }
    if (activeProviderConfig?.model) {
      // Always honour the Settings model on provider switch, even if it
      // isn't in our recommended list (it'll appear as a custom entry).
      if (chatModel !== activeProviderConfig.model)
        setChatModel(activeProviderConfig.model)
      return
    }
    if (!chatModel || !info.models.some((m) => m.id === chatModel)) {
      setChatModel(info.defaultModel ?? info.models[0]?.id ?? "")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatProvider, activeProviderConfig?.model])

  // When the project switches under us, drop the stale analysis so the user
  // doesn't think they're looking at the new repo when they aren't.
  useEffect(() => {
    setAnalysis(null)
    setError(null)
    setQaHistory([])
  }, [projectPath])

  const runAnalyze = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/workflow/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error ?? data?.detail ?? `HTTP ${res.status}`)
      }
      setAnalysis(data as WorkflowAnalysis)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  const runExport = useCallback(async () => {
    if (!analysis || !projectPath) return
    setExporting(true)
    setError(null)
    try {
      const res = await fetch("/api/workflow/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath, workflow: analysis }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error ?? data?.detail ?? `HTTP ${res.status}`)
      }
      triggerDownload(data.filename, data.markdown, "text/markdown;charset=utf-8")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }, [analysis, projectPath])

  const handleAsk = useCallback(async () => {
    if (!analysis || !question.trim() || asking) return
    const q = question.trim()
    setQuestion("")

    // Deterministic mode — fully local, no network, no API key. Same
    // behaviour as before this feature shipped.
    if (chatProvider === "deterministic") {
      const a =
        answerFromGraph(q, analysis) ??
        "I can answer questions about entry points, prompts, LLM calls, components, tools, and data flow — try rephrasing or pick one of the suggestions above. For richer free-form answers, switch the provider above to OpenAI, Anthropic, or Gemini."
      setQaHistory((h) => [
        ...h,
        { q, a, at: new Date().toISOString(), source: "deterministic" },
      ])
      return
    }

    // LLM mode — ship the question + last N turns + the workflow analysis
    // to /api/workflow/chat. The route owns key resolution and provider
    // dispatch; we just render whatever it returns.
    const history = qaHistory
      .filter((h) => !h.isError) // don't feed broken answers back into context
      .slice(-8)
      .flatMap<{ role: "user" | "assistant"; content: string }>((h) => [
        { role: "user", content: h.q },
        { role: "assistant", content: h.a },
      ])

    setAsking(true)
    try {
      const res = await fetch("/api/workflow/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: chatProvider,
          model: chatModel,
          question: q,
          history,
          analysis,
          // The user pastes their API key into Settings; we forward it on
          // every call. The server never persists it.
          apiKey: activeProviderConfig?.apiKey,
          baseUrl: activeProviderConfig?.baseUrl,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        const msg =
          (data && (data.error ?? data.detail)) ?? `HTTP ${res.status}`
        setQaHistory((h) => [
          ...h,
          {
            q,
            a:
              typeof msg === "string"
                ? msg
                : "Provider returned an error. Check the server logs.",
            at: new Date().toISOString(),
            source: chatProvider,
            model: chatModel,
            isError: true,
          },
        ])
        return
      }
      setQaHistory((h) => [
        ...h,
        {
          q,
          a: data.answer ?? "(empty response)",
          at: new Date().toISOString(),
          source: data.provider ?? chatProvider,
          model: data.model ?? chatModel,
          latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : undefined,
        },
      ])
    } catch (e) {
      setQaHistory((h) => [
        ...h,
        {
          q,
          a:
            e instanceof Error
              ? e.message
              : "Network error talking to the model provider.",
          at: new Date().toISOString(),
          source: chatProvider,
          model: chatModel,
          isError: true,
        },
      ])
    } finally {
      setAsking(false)
    }
  }, [analysis, question, asking, chatProvider, chatModel, qaHistory, activeProviderConfig])

  const filteredComponents = useMemo(() => {
    if (!analysis) return []
    const needle = filter.trim().toLowerCase()
    return analysis.components.filter((c) => {
      if (typeFilter !== "all" && c.type !== typeFilter) return false
      if (!needle) return true
      return (
        c.name.toLowerCase().includes(needle) ||
        c.file.toLowerCase().includes(needle) ||
        (c.framework ?? "").toLowerCase().includes(needle)
      )
    })
  }, [analysis, filter, typeFilter])

  /* -------------------------------- render ------------------------------- */

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-4 p-4 md:p-6 max-w-[1400px]">
        {/* ----- Header -------------------------------------------------- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <Workflow className="h-5 w-5 text-violet-400" />
              Understand Code Workflow
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Static workflow understanding — no runtime tracing.{" "}
              {projectName ? (
                <>
                  Project: <span className="font-mono">{projectName}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={runAnalyze}
              disabled={!hasProject || loading}
              size="sm"
              className="gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Analyzing…
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4" />
                  {analysis ? "Re-analyze repository" : "Analyze Repository Workflow"}
                </>
              )}
            </Button>
            <Button
              onClick={runExport}
              disabled={!analysis || exporting}
              size="sm"
              variant="outline"
              className="gap-2"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Export Workflow Report
            </Button>
          </div>
        </div>

        {/* ----- Empty / loading / error / no-project states -------------- */}
        {!hasProject && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              <Info className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
              Open a local or GitHub project first, then come back here to
              analyze its workflow.
            </CardContent>
          </Card>
        )}

        {hasProject && !analysis && !loading && !error && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              <Workflow className="h-6 w-6 mx-auto mb-2 text-violet-400" />
              Click <strong className="text-foreground">Analyze Repository Workflow</strong>{" "}
              to detect entrypoints, agents, prompts, tools, model calls,
              MCP/OpenAPI configs, and inferred component flow.
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="border-destructive/40">
            <CardContent className="py-4 text-sm">
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">Analysis failed</div>
                  <div className="text-muted-foreground mt-1">{error}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {analysis && (
          <>
            {/* ----- Stat chips + summary --------------------------------- */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="h-4 w-4 text-emerald-400" />
                  What this repo does
                </CardTitle>
                <CardDescription className="text-xs">
                  Plain-English narrative inferred from the detected
                  components — verify against the cards below before relying
                  on it.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                <div className="space-y-3">{renderSummary(analysis.summary)}</div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">
                    {analysis.stats.filesScanned} files scanned
                  </Badge>
                  <Badge variant="secondary">
                    {analysis.stats.componentsDetected} components
                  </Badge>
                  <Badge variant="secondary">
                    {analysis.stats.promptsDetected} prompts
                  </Badge>
                  <Badge variant="secondary">
                    {analysis.stats.toolsDetected} tools
                  </Badge>
                  <Badge variant="secondary">
                    {analysis.stats.modelCallsDetected} model calls
                  </Badge>
                  <Badge variant="outline">
                    {analysis.stats.durationMs} ms
                  </Badge>
                </div>
                {analysis.warnings.length > 0 && (
                  <div className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded p-2 space-y-1">
                    {analysis.warnings.map((w, i) => (
                      <div key={i}>⚠ {w}</div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ----- Mermaid diagram -------------------------------------- */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Network className="h-4 w-4 text-sky-400" />
                  Workflow diagram
                </CardTitle>
                <CardDescription className="text-xs">
                  Nodes show component type and name. Edges are inferred from
                  imports and same-file relationships.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MermaidDiagram source={analysis.mermaid} />
              </CardContent>
            </Card>

            {/* ----- Tabbed inventory ------------------------------------- */}
            <Tabs defaultValue="components" className="w-full">
              <TabsList className="flex flex-wrap h-auto justify-start">
                <TabsTrigger value="components" className="gap-1.5">
                  <Layers className="h-3.5 w-3.5" />
                  Components ({analysis.components.length})
                </TabsTrigger>
                <TabsTrigger value="prompts" className="gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  Prompts ({analysis.prompts.length})
                </TabsTrigger>
                <TabsTrigger value="tools" className="gap-1.5">
                  <Wrench className="h-3.5 w-3.5" />
                  Tools ({analysis.tools.length})
                </TabsTrigger>
                <TabsTrigger value="model-calls" className="gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" />
                  Model calls ({analysis.modelCalls.length})
                </TabsTrigger>
                <TabsTrigger value="flow" className="gap-1.5">
                  <Network className="h-3.5 w-3.5" />
                  Flow ({analysis.edges.length})
                </TabsTrigger>
                <TabsTrigger value="mcp-openapi" className="gap-1.5">
                  <Globe className="h-3.5 w-3.5" />
                  MCP / OpenAPI (
                  {analysis.mcpConfigs.length + analysis.openApiSpecs.length})
                </TabsTrigger>
                <TabsTrigger value="ask" className="gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Ask
                </TabsTrigger>
              </TabsList>

              {/* ----- Components --------------------------------------- */}
              <TabsContent value="components" className="space-y-3 mt-4">
                <div className="flex flex-wrap gap-2">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Filter by name, file, or framework…"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      className="pl-8 h-9"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(["all", "entrypoint", "api_route", "agent", "graph_node", "prompt", "tool", "model_call", "mcp_server", "openapi_tool"] as const).map((t) => (
                      <Button
                        key={t}
                        size="sm"
                        variant={typeFilter === t ? "default" : "outline"}
                        onClick={() => setTypeFilter(t)}
                        className="h-7 text-xs"
                      >
                        {t === "all" ? "All" : TYPE_META[t]?.label ?? t}
                      </Button>
                    ))}
                  </div>
                </div>

                {analysis.entrypoints.length > 0 && (
                  <Card className="border-emerald-500/20 bg-emerald-500/5">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Play className="h-3.5 w-3.5 text-emerald-400" />
                        Entry points
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="text-xs space-y-1 pt-0">
                      {analysis.entrypoints.map((e) => (
                        <div key={e.id} className="flex flex-wrap items-baseline gap-2">
                          <span className="font-medium">{e.reason}</span>
                          <code className="text-muted-foreground">
                            {e.file}
                            {e.line ? `:${e.line}` : ""}
                          </code>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

                {filteredComponents.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      No components match this filter.
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {filteredComponents.map((c) => (
                      <ComponentCard key={c.id} c={c} />
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* ----- Prompts ------------------------------------------ */}
              <TabsContent value="prompts" className="space-y-3 mt-4">
                {analysis.prompts.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      No prompts detected.
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {analysis.prompts.map((p) => (
                      <Card key={`${p.file}:${p.line ?? 0}:${p.name}`}>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <FileText className="h-3.5 w-3.5 text-amber-400" />
                            {p.name}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            <code>
                              {p.file}
                              {p.line ? `:${p.line}` : ""}
                            </code>
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2 pt-0 text-xs">
                          {p.variables.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {p.variables.map((v, idx) => (
                                <Badge
                                  key={`${idx}-${v}`}
                                  variant="outline"
                                  className="text-[10px] font-mono font-normal"
                                >
                                  {`{${v}}`}
                                </Badge>
                              ))}
                            </div>
                          )}
                          <ScrollArea className="max-h-32 rounded border bg-muted/20 p-2">
                            <pre className="text-[11px] whitespace-pre-wrap leading-snug">
                              {p.contentPreview}
                            </pre>
                          </ScrollArea>
                          {p.usedBy.length > 0 && (
                            <div className="text-[11px] text-muted-foreground">
                              Used by {p.usedBy.length} component
                              {p.usedBy.length === 1 ? "" : "s"} in the same
                              file.
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* ----- Tools -------------------------------------------- */}
              <TabsContent value="tools" className="space-y-3 mt-4">
                {analysis.tools.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      No tools detected.
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {analysis.tools.map((t) => (
                      <Card
                        key={`${t.file}:${t.line ?? 0}:${t.name}`}
                        className={
                          t.riskTags.length > 0
                            ? "border-destructive/30 bg-destructive/5"
                            : ""
                        }
                      >
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Wrench className="h-3.5 w-3.5 text-orange-400" />
                            <span className="break-all">{t.name}</span>
                            {t.riskTags.length > 0 && (
                              <ShieldAlert className="h-3.5 w-3.5 text-destructive ml-auto shrink-0" />
                            )}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            <code>
                              {t.file}
                              {t.line ? `:${t.line}` : ""}
                            </code>
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2 pt-0 text-xs">
                          {t.parameters.length > 0 && (
                            <div>
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                                Parameters
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {t.parameters.map((p, idx) => (
                                  <Badge
                                    key={`${idx}-${p}`}
                                    variant="outline"
                                    className="text-[10px] font-mono font-normal"
                                  >
                                    {p}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {t.riskTags.length > 0 && (
                            <div>
                              <div className="text-[11px] uppercase tracking-wide text-destructive mb-1">
                                Risk tags
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {t.riskTags.map((r, idx) => (
                                  <Badge
                                    key={`${idx}-${r}`}
                                    variant="destructive"
                                    className="text-[10px] font-normal"
                                  >
                                    {r}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {t.sideEffects.length > 0 && (
                            <div>
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                                Side effects
                              </div>
                              <ul className="text-[11px] space-y-0.5 text-muted-foreground">
                                {t.sideEffects.map((s, i) => (
                                  <li
                                    key={i}
                                    className="font-mono break-all"
                                  >
                                    {s}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* ----- Model calls -------------------------------------- */}
              <TabsContent value="model-calls" className="space-y-3 mt-4">
                {analysis.modelCalls.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      No model calls detected.
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="p-0">
                      <table className="w-full text-sm">
                        <thead className="text-xs text-muted-foreground">
                          <tr className="border-b">
                            <th className="text-left p-3">Provider</th>
                            <th className="text-left p-3">Model</th>
                            <th className="text-left p-3">File</th>
                            <th className="text-left p-3">Prompts</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analysis.modelCalls.map((m, i) => (
                            <tr
                              key={`${m.file}:${m.line ?? 0}:${i}`}
                              className="border-b last:border-b-0"
                            >
                              <td className="p-3">
                                <Badge variant="secondary" className="font-normal">
                                  {m.provider}
                                </Badge>
                              </td>
                              <td className="p-3 font-mono text-xs">
                                {m.model ?? <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="p-3 font-mono text-xs">
                                {m.file}
                                {m.line ? `:${m.line}` : ""}
                              </td>
                              <td className="p-3 text-xs">
                                {m.promptRefs.length === 0 ? (
                                  <span className="text-muted-foreground">—</span>
                                ) : (
                                  m.promptRefs.join(", ")
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* ----- Flow / edges ------------------------------------ */}
              <TabsContent value="flow" className="space-y-3 mt-4">
                {analysis.edges.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      No formal agent graph detected; the component grid above
                      reflects inferred relationships only.
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="p-0">
                      <table className="w-full text-sm">
                        <thead className="text-xs text-muted-foreground">
                          <tr className="border-b">
                            <th className="text-left p-3">From</th>
                            <th className="text-left p-3">→</th>
                            <th className="text-left p-3">To</th>
                            <th className="text-left p-3">Evidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analysis.edges.map((e, i) => {
                            const from = analysis.components.find((c) => c.id === e.from)
                            const to = analysis.components.find((c) => c.id === e.to)
                            return (
                              <tr
                                key={`${e.from}-${e.to}-${i}`}
                                className="border-b last:border-b-0"
                              >
                                <td className="p-3 text-xs">
                                  {from ? from.name : e.from}
                                  <div className="text-[10px] text-muted-foreground font-mono">
                                    {from?.file}
                                  </div>
                                </td>
                                <td className="p-3 text-xs">
                                  <Badge variant="outline" className="font-normal">
                                    {e.label}
                                  </Badge>
                                </td>
                                <td className="p-3 text-xs">
                                  {to ? to.name : e.to}
                                  <div className="text-[10px] text-muted-foreground font-mono">
                                    {to?.file}
                                  </div>
                                </td>
                                <td className="p-3 text-[11px] text-muted-foreground">
                                  {e.evidence ?? "—"}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* ----- MCP / OpenAPI ---------------------------------- */}
              <TabsContent value="mcp-openapi" className="space-y-3 mt-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Layers className="h-3.5 w-3.5 text-teal-400" />
                      MCP configurations
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs pt-0">
                    {analysis.mcpConfigs.length === 0 ? (
                      <div className="text-muted-foreground">
                        No MCP config files detected.
                      </div>
                    ) : (
                      <ul className="space-y-2">
                        {analysis.mcpConfigs.map((m) => (
                          <li key={m.file}>
                            <code>{m.file}</code> — servers:{" "}
                            {m.servers.length > 0 ? (
                              m.servers.map((s, idx) => (
                                <Badge key={`${idx}-${s}`} variant="secondary" className="ml-1 font-normal">
                                  {s}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground">none parsed</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Code2 className="h-3.5 w-3.5 text-blue-400" />
                      OpenAPI / Swagger specs
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs pt-0 space-y-3">
                    {analysis.openApiSpecs.length === 0 ? (
                      <div className="text-muted-foreground">
                        No OpenAPI / Swagger specs detected.
                      </div>
                    ) : (
                      analysis.openApiSpecs.map((s) => (
                        <div key={s.file} className="space-y-1">
                          <div>
                            <code>{s.file}</code> — {s.title ?? "(no title)"}
                            {s.version ? ` v${s.version}` : ""}
                          </div>
                          {s.operations.length > 0 && (
                            <ul className="ml-4 space-y-0.5 text-muted-foreground">
                              {s.operations.slice(0, 12).map((op, i) => (
                                <li key={i}>
                                  <Badge
                                    variant="outline"
                                    className="mr-1 text-[10px] font-mono font-normal"
                                  >
                                    {op.method}
                                  </Badge>
                                  <code className="text-xs">{op.path}</code>
                                  {op.summary ? ` — ${op.summary}` : ""}
                                </li>
                              ))}
                              {s.operations.length > 12 && (
                                <li>
                                  … and {s.operations.length - 12} more operations
                                </li>
                              )}
                            </ul>
                          )}
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ----- Ask box ----------------------------------------- */}
              <TabsContent value="ask" className="space-y-3 mt-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <MessageSquare className="h-3.5 w-3.5 text-violet-400" />
                      Ask about this repo
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Choose Deterministic for instant answers from the graph
                      (no API key), or pick a model from OpenAI / Anthropic /
                      Google to chat about the repo using full LLM reasoning.
                      The workflow analysis is sent with every turn so answers
                      stay grounded in this codebase.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* ---- provider + model picker ---- */}
                    {(() => {
                      const info = CHAT_PROVIDER_BY_ID[chatProvider]
                      // Has the user actually pasted a key into the
                      // matching Settings slot? Drives the "Configured" /
                      // "Not configured" badge + the inline call-to-action.
                      const configured =
                        chatProvider !== "deterministic" &&
                        !!activeProviderConfig?.apiKey
                      // If the user's Settings model isn't in our hardcoded
                      // recommendations, surface it as a custom option so the
                      // <Select> can render it without a SelectValue mismatch.
                      const customModelOption =
                        info.models &&
                        chatModel &&
                        !info.models.some((m) => m.id === chatModel)
                          ? { id: chatModel, label: chatModel, hint: "from Settings" }
                          : null
                      return (
                        <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-muted-foreground min-w-[60px]">
                              Provider
                            </span>
                            <Select
                              value={chatProvider}
                              onValueChange={(v) =>
                                setChatProvider(v as ChatProviderChoice)
                              }
                            >
                              <SelectTrigger className="h-8 w-[260px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CHAT_PROVIDERS.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {chatProvider !== "deterministic" && (
                              <Badge
                                variant={configured ? "default" : "outline"}
                                className={`h-5 px-1.5 text-[10px] ${
                                  configured
                                    ? "bg-emerald-600/20 text-emerald-300 border-emerald-700/40"
                                    : "border-amber-700/40 text-amber-300"
                                }`}
                              >
                                {configured ? "Key configured" : "Key not set"}
                              </Badge>
                            )}
                            {chatProvider !== "deterministic" &&
                              info.models && (
                                <>
                                  <span className="text-xs font-medium text-muted-foreground ml-2">
                                    Model
                                  </span>
                                  <Select
                                    value={chatModel}
                                    onValueChange={setChatModel}
                                  >
                                    <SelectTrigger className="h-8 w-[280px] text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {customModelOption && (
                                        <SelectItem
                                          key={customModelOption.id}
                                          value={customModelOption.id}
                                        >
                                          <span className="font-mono text-[11px]">
                                            {customModelOption.label}
                                          </span>
                                          <span className="text-muted-foreground ml-2 text-[11px]">
                                            {customModelOption.hint}
                                          </span>
                                        </SelectItem>
                                      )}
                                      {info.models.map((m) => (
                                        <SelectItem key={m.id} value={m.id}>
                                          <span className="font-mono text-[11px]">
                                            {m.label}
                                          </span>
                                          {m.hint && (
                                            <span className="text-muted-foreground ml-2 text-[11px]">
                                              {m.hint}
                                            </span>
                                          )}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </>
                              )}
                          </div>
                          {chatProvider !== "deterministic" && !configured && (
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-amber-300">
                              <KeyRound className="h-3 w-3" />
                              <span>
                                Add your{" "}
                                <span className="font-medium">{info.label}</span>{" "}
                                key in Settings → LLM Providers, or set{" "}
                                <code className="font-mono">{info.envKey}</code>{" "}
                                in <code className="font-mono">.env.local</code>
                                .
                              </span>
                              {onNavigateToSettings && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-[11px]"
                                  onClick={onNavigateToSettings}
                                >
                                  Open Settings
                                </Button>
                              )}
                              {info.docsUrl && (
                                <a
                                  href={info.docsUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-primary hover:underline"
                                >
                                  Get a key
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          )}
                          {chatProvider !== "deterministic" && configured && (
                            <div className="text-[11px] text-muted-foreground">
                              Using the key you saved in Settings. It&apos;s
                              kept in <code className="font-mono">localStorage</code>{" "}
                              on this device and forwarded with each request
                              — never persisted on the server.
                            </div>
                          )}
                          {chatProvider === "deterministic" && (
                            <div className="text-[11px] text-muted-foreground">
                              Fast, fully local. Best for direct factual
                              questions (entry points, dangerous tools,
                              prompts). Switch to an LLM for free-form
                              questions like &ldquo;why does this code work the
                              way it does?&rdquo;.
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* ---- example prompts ---- */}
                    <div className="flex flex-wrap gap-1">
                      {[
                        "What is the main entrypoint?",
                        "Which prompt controls the final summary?",
                        "Which file calls the LLM?",
                        "Which tools are dangerous?",
                        "How does data flow from input to final output?",
                      ].map((q) => (
                        <Button
                          key={q}
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setQuestion(q)}
                          disabled={asking}
                        >
                          {q}
                        </Button>
                      ))}
                    </div>

                    {/* ---- question input ---- */}
                    <div className="flex gap-2">
                      <Textarea
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        placeholder={
                          chatProvider === "deterministic"
                            ? "Ask about entry points, prompts, model calls, tools, data flow…"
                            : "Ask anything about this repo — the answer will be grounded in the workflow analysis above."
                        }
                        className="min-h-[60px]"
                        disabled={asking}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            (e.metaKey || e.ctrlKey) &&
                            !asking
                          ) {
                            e.preventDefault()
                            void handleAsk()
                          }
                        }}
                      />
                      <Button
                        onClick={() => void handleAsk()}
                        disabled={!question.trim() || asking}
                      >
                        {asking ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                            Asking…
                          </>
                        ) : (
                          "Ask"
                        )}
                      </Button>
                    </div>

                    <Separator />

                    {/* ---- history ---- */}
                    {qaHistory.length === 0 ? (
                      <div className="text-xs text-muted-foreground italic">
                        No questions yet — try one of the suggestions above.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {qaHistory
                          .slice()
                          .reverse()
                          .map((h, i) => (
                            <div key={i} className="space-y-1">
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <ChevronRight className="h-3 w-3" />
                                <span className="italic">{h.q}</span>
                              </div>
                              <div className="space-y-1">
                                <pre
                                  className={`text-xs whitespace-pre-wrap leading-relaxed font-sans rounded p-3 ${
                                    h.isError
                                      ? "bg-destructive/10 border border-destructive/30 text-destructive-foreground"
                                      : "bg-muted/30"
                                  }`}
                                >
                                  {h.a}
                                </pre>
                                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                  <Badge
                                    variant="outline"
                                    className="h-4 px-1.5 font-normal text-[10px]"
                                  >
                                    {h.source === "deterministic"
                                      ? "graph"
                                      : (CHAT_PROVIDER_BY_ID[h.source]?.label ?? h.source)}
                                  </Badge>
                                  {h.model && (
                                    <Badge
                                      variant="outline"
                                      className="h-4 px-1.5 font-mono font-normal text-[10px]"
                                    >
                                      {h.model}
                                    </Badge>
                                  )}
                                  {typeof h.latencyMs === "number" && (
                                    <span>{h.latencyMs}&nbsp;ms</span>
                                  )}
                                  {h.isError && (
                                    <span className="text-destructive">
                                      error
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}

export default UnderstandCodeWorkflow
