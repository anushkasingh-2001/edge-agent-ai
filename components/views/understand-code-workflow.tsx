"use client"

import { useCallback, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Workflow, Sparkles, AlertCircle, ShieldCheck } from "lucide-react"
import { apiFetch } from "@/lib/api-fetch"

/**
 * Understand-code Workflow — hosted-only chat over the project's
 * structure. Posts to `/api/hosted/chat?task=workflow`, which routes
 * through the same plan/quota/audit pipeline as Findings.
 */

interface UnderstandCodeWorkflowProps {
  hasProject: boolean
  projectPath: string | null
  projectName: string | null
  onNavigateToSettings: () => void
}

interface Turn {
  role: "user" | "assistant"
  content: string
}

export function UnderstandCodeWorkflow(props: UnderstandCodeWorkflowProps) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ model?: string; remaining?: number }>({})

  const send = useCallback(async () => {
    if (!question.trim() || busy) return
    setBusy(true)
    setError(null)
    const nextTurns: Turn[] = [...turns, { role: "user", content: question }]
    setTurns(nextTurns)
    setQuestion("")
    try {
      const res = await apiFetch("/api/hosted/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intelligenceMode: "auto",
          task: "workflow",
          systemPrompt:
            "You are Edge Agent AI's workflow analyzer. Walk the user through how their project's agents, tools, and prompts fit together. Be concrete and reference files/symbols when possible. ≤200 words.",
          messages: nextTurns.map((t) => ({ role: t.role, content: t.content })),
        }),
      })
      const data = (await res.json()) as {
        reply?: string
        error?: string
        model?: string
        quotaRemaining?: number
      }
      if (!res.ok || !data.reply) {
        setError(data.error ?? `Hosted workflow failed (HTTP ${res.status}).`)
      } else {
        setTurns((prev) => [...prev, { role: "assistant", content: data.reply! }])
        setMeta({ model: data.model, remaining: data.quotaRemaining })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.")
    } finally {
      setBusy(false)
    }
  }, [busy, question, turns])

  if (!props.hasProject) {
    return (
      <div className="p-6 max-w-3xl">
        <Card className="bg-card border-border">
          <CardContent className="py-10 px-6 text-center space-y-3">
            <h2 className="text-lg font-semibold">Open a project first</h2>
            <p className="text-sm text-muted-foreground">
              The workflow analyzer needs an active project. Select one from the sidebar
              and run a scan to seed context.
            </p>
            <Button variant="outline" onClick={props.onNavigateToSettings}>
              Open Settings
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Workflow className="h-5 w-5" />
          Understand Code
        </h1>
        <p className="text-muted-foreground">
          {props.projectName ?? "Your project"} — walk through agents, tools, and prompts.
        </p>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>AI included in your plan. No API key required.</span>
        {typeof meta.remaining === "number" && (
          <Badge variant="secondary" className="ml-2">
            {meta.remaining} credits left
          </Badge>
        )}
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            Conversation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 max-h-[420px] overflow-y-auto">
          {turns.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Ask “What does the patch pipeline do?” or “Which file owns the resolver?”
            </p>
          )}
          {turns.map((t, i) => (
            <div
              key={i}
              className={`text-sm whitespace-pre-wrap rounded p-2 ${
                t.role === "user" ? "bg-accent/10 text-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              <span className="text-xs font-medium uppercase mr-2">
                {t.role === "user" ? "You" : "Assistant"}
              </span>
              {t.content}
            </div>
          ))}
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex gap-2">
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about the project structure…"
          rows={2}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <Button onClick={() => void send()} disabled={busy || !question.trim()}>
          {busy ? "Sending…" : "Ask"}
        </Button>
      </div>
    </div>
  )
}
