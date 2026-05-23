"use client"

/**
 * Split-view workspace: file tree | code editor | finding detail panel.
 *
 * Drops in as the "main content" of the Findings page once a finding
 * has been opened. The Findings list is hidden while this view is
 * active; closing returns to the list.
 *
 * Owns:
 *   * Loading / caching the file the finding pins
 *   * Wiring the file tree to the workspace APIs
 *   * Dirty/save state for the active file
 *   * Forwarding "Re-run scan" to the parent
 *
 * The finding-detail panel is rendered as a sibling and reads finding
 * data straight from props — we deliberately keep the existing drawer
 * markup reusable rather than duplicating it. See
 * `FindingSidePanel` further down for the right-rail layout.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowLeft, ExternalLink, Loader2, PlayCircle, RefreshCw, Sparkles } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { displayCategoryLabel } from "@/lib/security-checks"
import { severityBadgeClass } from "@/lib/severity-styles"
import {
  type AIExplanationResponse,
  fetchFindingExplanation,
} from "@/lib/finding-explanation-client"
import { useFile } from "@/lib/use-workspace"
import { invalidate as invalidateWorkspace, updateFileCache } from "@/lib/workspace-store"
import type { Finding } from "@/components/views/findings"

import { CodeEditor } from "./code-editor"
import { FileTree } from "./file-tree"

export interface WorkspaceViewProps {
  projectPath: string
  finding: Finding
  /** Close the workspace view and go back to the findings list. */
  onClose: () => void
  /** Fire the global re-scan (TopBar Run Scan button). Optional —
   *  hides the Re-run button when not provided. */
  onRerunScan?: () => void
}

export function WorkspaceView(props: WorkspaceViewProps): JSX.Element {
  const { projectPath, finding, onClose, onRerunScan } = props
  const [openPath, setOpenPath] = useState<string>(finding.file ?? "")
  const [refreshKey, setRefreshKey] = useState(0)
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null)

  // File data + loading state come from the shared store via
  // `useFile`. The store transparently dedupes concurrent reads
  // across mounts, so a Strict-Mode double-mount or parent re-render
  // never strands a fetch.
  const fileSnap = useFile(projectPath, openPath)
  const file = fileSnap.data
  const fileLoading = fileSnap.loading
  const fileError = fileSnap.error
  const filePath = file?.path ?? (openPath || null)
  const fileReadOnly = file?.readOnly ?? false
  const filePlaceholder = file?.placeholder ?? null

  // Prefetch the CodeMirror chunk eagerly so by the time the file
  // fetch resolves the editor module is already in memory and the
  // pane swaps from spinner to code with no second-stage "Loading
  // editor…" wait. The promise is intentionally not awaited — its
  // only side effect is warming the bundler cache.
  useEffect(() => {
    void import("@uiw/react-codemirror")
  }, [])

  // Re-pin the editor whenever the user opens a different finding
  // (e.g. clicks Back, picks another finding, then opens it).
  useEffect(() => {
    if (finding.file && finding.file !== openPath) {
      setOpenPath(finding.file)
    }
  }, [finding.file, openPath])

  // 3-second escape hatch for the file load: if the editor pane is
  // still in the loading state after 3s, surface a "Still loading,
  // Refresh" button so the user always has a way out even if a dev-
  // server module hot-reload glitched the fetch.
  const [slowLoad, setSlowLoad] = useState(false)
  useEffect(() => {
    if (!fileLoading) {
      setSlowLoad(false)
      return
    }
    const t = setTimeout(() => setSlowLoad(true), 3_000)
    return () => clearTimeout(t)
  }, [fileLoading, openPath, refreshKey])

  // Auto-dismiss toast after 2.5s.
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(id)
  }, [toast])

  const handleRefresh = useCallback(() => {
    invalidateWorkspace(projectPath)
    setRefreshKey((k) => k + 1)
  }, [projectPath])

  const handleSave = useCallback(
    async (content: string) => {
      if (!file || file.readOnly) return
      const res = await fetch("/api/workspace/file/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: projectPath, path: file.path, content }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setToast({ kind: "err", msg: body?.error || `save failed: ${res.status}` })
        throw new Error(body?.error || "save failed")
      }
      // Optimistically refresh the cached snapshot so the editor's
      // dirty-baseline lines up with what we just persisted, without
      // a second round-trip.
      updateFileCache(projectPath, file.path, {
        content,
        size: body.size ?? content.length,
        mtimeMs: body.mtimeMs ?? Date.now(),
      })
      setToast({ kind: "ok", msg: "Saved" })
    },
    [file, projectPath],
  )

  const handleRerun = useCallback(() => {
    if (!onRerunScan) return
    onRerunScan()
    // Files on disk could have changed — drop everything in the
    // store for this root so the tree + editor re-fetch.
    invalidateWorkspace(projectPath)
    setRefreshKey((k) => k + 1)
  }, [onRerunScan, projectPath])

  const highlightLine = useMemo(() => {
    if (!file || fileError || fileLoading) return null
    if (file.path !== finding.file) return null
    return typeof finding.line === "number" && finding.line > 0 ? finding.line : null
  }, [file, fileError, fileLoading, finding.file, finding.line])

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={onClose} className="gap-1">
            <ArrowLeft className="h-4 w-4" />
            Back to findings
          </Button>
          <span className="text-xs text-muted-foreground truncate" title={projectPath}>
            {projectPath}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onRerunScan && (
            <Button size="sm" variant="default" className="gap-1" onClick={handleRerun}>
              <PlayCircle className="h-4 w-4" />
              Re-run scan
            </Button>
          )}
        </div>
      </div>

      {/* Body: tree | editor | side panel */}
      <div className="grid h-full min-h-0 flex-1" style={{ gridTemplateColumns: "260px 1fr 420px" }}>
        <FileTree
          root={projectPath}
          rootLabel={projectPath.split("/").pop() || projectPath}
          selectedPath={file?.path ?? openPath}
          onSelectFile={(p) => setOpenPath(p)}
          refreshKey={refreshKey}
        />
        <div className="min-w-0 border-r border-border bg-[#1e1e1e]">
          {fileLoading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <div>Loading {filePath ?? "file"}…</div>
              {slowLoad && (
                <button
                  type="button"
                  className="mt-2 inline-flex items-center gap-1.5 rounded border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:bg-secondary/60"
                  onClick={handleRefresh}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Still loading — Refresh
                </button>
              )}
            </div>
          ) : fileError ? (
            <div className="p-4 text-sm text-destructive">
              <div className="mb-2 font-medium">Could not open {filePath}</div>
              <div className="text-xs text-destructive/80">{fileError}</div>
              <button
                type="button"
                className="mt-3 rounded border border-border bg-card px-2.5 py-1 text-xs text-foreground hover:bg-secondary/60"
                onClick={handleRefresh}
              >
                Retry
              </button>
            </div>
          ) : (
            <CodeEditor
              filePath={filePath}
              value={file?.content ?? ""}
              language={file?.language}
              highlightLine={highlightLine ?? undefined}
              readOnly={fileReadOnly}
              placeholder={filePlaceholder}
              onSave={handleSave}
            />
          )}
        </div>
        <FindingSidePanel
          finding={finding}
          projectPath={projectPath}
          onOpenFile={(p, line) => {
            setOpenPath(p)
            // We can't directly scroll Monaco from here, but loading the
            // file will reapply the highlight effect because the
            // `highlightLine` memo recomputes from `finding.line`. For
            // explicit re-jumps to a different line (same file), the
            // caller can replace `finding.line` upstream.
            void line
          }}
        />
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={
            "pointer-events-none fixed bottom-6 right-6 z-50 rounded-md px-3 py-2 text-sm shadow-lg " +
            (toast.kind === "ok"
              ? "bg-emerald-500 text-white"
              : "bg-destructive text-destructive-foreground")
          }
          role="status"
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Right-rail: condensed finding summary that stays visible while the user
// navigates files. The full AI-explanation drawer is still available via
// the "Open full details" button.
// ---------------------------------------------------------------------------

interface FindingSidePanelProps {
  finding: Finding
  projectPath: string
  onOpenFile: (path: string, line?: number) => void
}

function FindingSidePanel({ finding, projectPath, onOpenFile }: FindingSidePanelProps): JSX.Element {
  // On-demand, cache-first AI explanation. Uses a stale-flag pattern
  // (NOT AbortController + lastRequestKey ref) because React 18 Strict
  // Mode in dev runs every effect through setup → cleanup → setup
  // again, with refs preserved across the simulated unmount. The
  // previous AbortController approach interacted badly:
  //   1. Mount setup A starts the fetch with controllerA
  //   2. Strict-Mode cleanup A aborts controllerA
  //   3. Mount setup B sees `lastRequestKey === key` and bails
  //   4. Fetch A finishes as AbortError, .finally sets loading=false,
  //      ai stays null → UI falls back to "Scanner explanation"
  // The stale flag (closure-scoped) is fresh per effect setup, so
  // setup B's flag never goes stale just because setup A's did. The
  // server caches /api/finding/explain results so the second request
  // (when Strict Mode is on) is nearly free.
  const [ai, setAi] = useState<AIExplanationResponse | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectPath) return
    setAi(null)
    setAiError(null)
    setAiLoading(true)
    let stale = false
    fetchFindingExplanation({ projectPath, finding })
      .then((res) => {
        if (!stale) setAi(res)
      })
      .catch((err: unknown) => {
        if (stale) return
        setAiError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!stale) setAiLoading(false)
      })
    return () => {
      stale = true
    }
    // We depend on the finding's stable identity fields (id,
    // scannerFindingId) rather than the object reference so a parent
    // re-render that hands us a fresh-but-equal finding doesn't kick
    // off a redundant request. `finding` is intentionally read from
    // closure inside the .then/.catch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, finding.id, finding.scannerFindingId])

  const handleCopyFixPrompt = useCallback(async () => {
    const prompt = [
      `# Fix the following finding from the Edge Agent AI scanner`,
      ``,
      `**Title:** ${finding.title}`,
      `**Severity:** ${finding.severity}`,
      `**Category:** ${displayCategoryLabel(finding.category)}`,
      `**File:** ${finding.file}:${finding.line}`,
      ``,
      `## Evidence`,
      finding.evidence ?? "(none)",
      ``,
      `## Suggested fix (from scanner)`,
      finding.suggestedFix ?? "(none)",
      ``,
      `## Code`,
      "```",
      finding.code ?? "",
      "```",
    ].join("\n")
    try {
      await navigator.clipboard.writeText(prompt)
    } catch {
      // Clipboard not available (insecure context); silently skip.
    }
  }, [finding])

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-l border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Badge variant="outline" className={severityBadgeClass(finding.severity)}>
          {finding.severity}
        </Badge>
        <span className="truncate text-xs text-muted-foreground" title={displayCategoryLabel(finding.category)}>
          {displayCategoryLabel(finding.category)}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 text-sm">
        <h2 className="text-base font-semibold leading-snug mb-2">{finding.title}</h2>
        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            className="font-mono hover:underline"
            onClick={() => onOpenFile(finding.file, finding.line)}
            title="Reveal in editor"
          >
            {finding.file}:{finding.line}
          </button>
          <ExternalLink className="h-3 w-3" />
        </div>
        {finding.agent && finding.agent !== "unknown" && (
          <div className="mb-3 text-xs text-muted-foreground">
            Agent: <span className="text-foreground">{finding.agent}</span>
          </div>
        )}

        {/* AI explanation block. Three states:
            - loading: a single line so the panel isn't visually empty
              while the model call is in flight
            - error: the deterministic scanner reason still wins below
              so the user always has *something* actionable
            - success: render what_detected / why_risky / suggested_fix
              with a tiny "AI explanation • model" badge so it's clear
              this came from the LLM, not the static scanner. */}
        <section className="mb-4 rounded-md border border-border bg-card/60 p-3">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
            {aiLoading ? (
              <span>Generating project-specific explanation…</span>
            ) : ai?.source === "ai" || ai?.source === "cached_ai" ? (
              <span>
                {ai.source === "cached_ai" ? "Cached AI explanation" : "AI explanation"}
                {ai.model_used && (
                  <span className="ml-1 text-muted-foreground/70">· {ai.model_used}</span>
                )}
              </span>
            ) : (
              <span>Scanner explanation</span>
            )}
          </div>
          {aiLoading ? (
            <div className="space-y-1.5 py-1">
              <div className="h-2 w-3/4 animate-pulse rounded bg-muted/50" />
              <div className="h-2 w-2/3 animate-pulse rounded bg-muted/50" />
            </div>
          ) : ai && (ai.source === "ai" || ai.source === "cached_ai") ? (
            <div className="space-y-3 text-sm leading-relaxed">
              {ai.what_detected && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    What was detected
                  </div>
                  <p className="whitespace-pre-wrap">{ai.what_detected}</p>
                </div>
              )}
              {ai.why_risky && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Why it can be risky
                  </div>
                  <p className="whitespace-pre-wrap">{ai.why_risky}</p>
                </div>
              )}
              {ai.suggested_fix && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Suggested fix
                  </div>
                  <p className="whitespace-pre-wrap">{ai.suggested_fix}</p>
                </div>
              )}
            </div>
          ) : finding.reason ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{finding.reason}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No explanation available.</p>
          )}
          {aiError && (
            <p className="mt-2 text-xs text-destructive">{aiError}</p>
          )}
        </section>

        {finding.suggestedFix && !(ai && (ai.source === "ai" || ai.source === "cached_ai") && ai.suggested_fix) && (
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Suggested fix
            </h3>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{finding.suggestedFix}</p>
          </section>
        )}
        {finding.evidence && (
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Evidence
            </h3>
            <pre className="whitespace-pre-wrap break-all rounded bg-muted/40 px-2 py-1.5 text-xs font-mono">
              {finding.evidence}
            </pre>
          </section>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={handleCopyFixPrompt}>
          Copy fix prompt
        </Button>
      </div>
    </aside>
  )
}
