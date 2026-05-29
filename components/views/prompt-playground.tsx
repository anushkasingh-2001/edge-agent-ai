"use client"

import { useCallback, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Sparkles, FlaskConical, AlertCircle, ShieldCheck } from "lucide-react"
import type { ScanReport } from "@/lib/scan-report"
import type { IntelligenceMode } from "@/lib/context-bundle"
import { apiFetch } from "@/lib/api-fetch"

/**
 * Prompt Playground — hosted only.
 *
 * Sandbox surface for trying prompts against the active plan's hosted
 * model. Calls `/api/hosted/chat?task=playground` so it shares the same
 * auth/plan/quota/audit pipeline as the rest of the AI surface.
 */

interface PromptPlaygroundProps {
  scanReport: ScanReport | null
  projectId?: string | null
}

const MODES: IntelligenceMode[] = ["save", "auto", "pro", "max"]

export function PromptPlayground(_props: PromptPlaygroundProps) {
  const [mode, setMode] = useState<IntelligenceMode>("auto")
  const [systemPrompt, setSystemPrompt] = useState(
    "You are Edge Agent AI's prompt playground. Be concise. Avoid running code.",
  )
  const [userPrompt, setUserPrompt] = useState("")
  const [reply, setReply] = useState<string>("")
  const [meta, setMeta] = useState<{ model?: string; provider?: string; credits?: number; remaining?: number }>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    if (!userPrompt.trim() || busy) return
    setBusy(true)
    setError(null)
    setReply("")
    try {
      const res = await apiFetch("/api/hosted/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intelligenceMode: mode,
          systemPrompt,
          task: "playground",
          messages: [{ role: "user", content: userPrompt }],
        }),
      })
      const data = (await res.json()) as {
        reply?: string
        error?: string
        model?: string
        provider?: string
        creditsUsed?: number
        quotaRemaining?: number
      }
      if (!res.ok || !data.reply) {
        setError(data.error ?? `Hosted playground failed (HTTP ${res.status}).`)
      } else {
        setReply(data.reply)
        setMeta({
          model: data.model,
          provider: data.provider,
          credits: data.creditsUsed,
          remaining: data.quotaRemaining,
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.")
    } finally {
      setBusy(false)
    }
  }, [busy, mode, systemPrompt, userPrompt])

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FlaskConical className="h-5 w-5" />
          Prompt Playground
        </h1>
        <p className="text-muted-foreground">
          Try prompts against your plan's hosted model.
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
            Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Intelligence Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as IntelligenceMode)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">System Prompt</Label>
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">User Prompt</Label>
            <Textarea
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              rows={4}
              placeholder="Ask anything…"
            />
          </div>
          <Button onClick={() => void run()} disabled={busy || !userPrompt.trim()}>
            {busy ? "Running…" : "Run"}
          </Button>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {reply && (
        <Card className="bg-card border-border">
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-accent" />
                Output
              </span>
              {meta.model && (
                <span className="text-xs font-normal text-muted-foreground">
                  {meta.provider} · {meta.model}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm text-foreground">{reply}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
