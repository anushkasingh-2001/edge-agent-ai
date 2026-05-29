"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Bot, Send, Sparkles, AlertCircle, ShieldCheck } from "lucide-react"
import type { ScanReport } from "@/lib/scan-report"
import type { Project } from "@/lib/projects"
import { apiFetch } from "@/lib/api-fetch"

/**
 * Chat Assistant — hosted, plan-gated, no user API keys.
 *
 * Posts to `/api/hosted/chat`. The server enforces auth + plan + quota,
 * runs the upstream model, debits credits, and writes an audit row.
 * The client never sees or stores a provider key.
 */

interface ChatAssistantProps {
  currentBranch: string
  scanReport: ScanReport | null
  selectedProject: Project | null
  latestScanId?: string | null
  latestScanTimestamp?: string | null
}

type Role = "user" | "assistant" | "system"
interface ChatMessage {
  role: Role
  content: string
}

export function ChatAssistant(props: ChatAssistantProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [credits, setCredits] = useState<{ used?: number; remaining?: number }>({})
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const systemPrompt = useMemo(() => {
    const parts: string[] = [
      "You are Edge Agent AI's chat assistant. Be concise (≤200 words).",
      "Ground answers in the user's project context when relevant.",
    ]
    if (props.selectedProject?.name) parts.push(`Project: ${props.selectedProject.name}.`)
    if (props.currentBranch) parts.push(`Current branch: ${props.currentBranch}.`)
    if (props.scanReport?.summary) {
      parts.push(
        `Last scan summary: total=${props.scanReport.summary.total}, ` +
          `critical=${props.scanReport.summary.critical ?? 0}, high=${props.scanReport.summary.high ?? 0}, ` +
          `medium=${props.scanReport.summary.medium ?? 0}, low=${props.scanReport.summary.low ?? 0}.`,
      )
    }
    return parts.join(" ")
  }, [props.currentBranch, props.scanReport?.summary, props.selectedProject?.name])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || busy) return
    setError(null)
    setBusy(true)
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }]
    setMessages(nextMessages)
    setDraft("")
    try {
      const res = await apiFetch("/api/hosted/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intelligenceMode: "auto",
          systemPrompt,
          messages: nextMessages,
          task: "explain",
        }),
      })
      const data = (await res.json()) as {
        reply?: string
        error?: string
        creditsUsed?: number
        quotaRemaining?: number
      }
      if (!res.ok || !data.reply) {
        setError(data.error ?? `Hosted chat failed (HTTP ${res.status}).`)
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: data.reply! }])
        setCredits({
          used: (credits.used ?? 0) + (data.creditsUsed ?? 0),
          remaining: data.quotaRemaining,
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.")
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }, [busy, credits.used, draft, messages, systemPrompt])

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Bot className="h-5 w-5" />
          Chat Assistant
        </h1>
        <p className="text-muted-foreground">Ask questions grounded in your latest scan.</p>
      </div>

      <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>AI included in your plan. No API key required.</span>
        {typeof credits.remaining === "number" && (
          <Badge variant="secondary" className="ml-2">
            {credits.remaining} credits left
          </Badge>
        )}
      </div>

      <Card className="bg-card border-border mb-3">
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            Conversation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 max-h-[420px] overflow-y-auto">
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Start by asking about a finding, a file, or last scan trends.
            </p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`text-sm whitespace-pre-wrap rounded p-2 ${
                m.role === "user"
                  ? "bg-accent/10 text-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <span className="text-xs font-medium uppercase mr-2">
                {m.role === "user" ? "You" : "Assistant"}
              </span>
              {m.content}
            </div>
          ))}
        </CardContent>
      </Card>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex gap-2">
        <Textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about your code or scan…"
          rows={2}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <Button onClick={() => void send()} disabled={busy || !draft.trim()}>
          <Send className="h-4 w-4 mr-1" />
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  )
}
