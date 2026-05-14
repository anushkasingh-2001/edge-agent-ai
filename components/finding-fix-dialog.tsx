"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  Loader2,
  Wrench,
} from "lucide-react"
import {
  riskTone,
  runFindingFixesApi,
  type FixMode,
  type FixProposal,
  type FixTarget,
  type RunFixesResult,
} from "@/lib/finding-fixes-client"

interface FindingFixDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Targets to fix. The dialog auto-loads suggestions when opening. */
  targets: FixTarget[]
  /** Initial mode the dialog opens in. "suggest" never writes; "apply"
   *  runs the same engine + writes files and marks each proposal
   *  `applied: true`. */
  mode: FixMode
  /** Project root — needed by the API. */
  projectPath: string | null
  /** Friendly title shown in the dialog header. */
  title: string
  /** Optional after-apply callback so callers can refresh state (e.g.
   *  re-run a scan after auto-fixing all findings). */
  onApplied?: (result: RunFixesResult) => void
}

/**
 * Shared dialog used by ALL three "Fix" triggers (FindingDrawer,
 * Findings table "Fix all", Behavioral test row).
 *
 * The dialog has a single source of truth — `runFindingFixesApi` — so
 * "Provide suggestion" and "Fix it" share the same diff renderer and
 * the same proposal list. The only difference is that "Fix it" sends
 * `mode: "apply"` to the server, which writes the files and stamps
 * each proposal with `applied: true`.
 *
 * Even when opened in "suggest" mode, the user can flip into apply
 * mode via the "Apply all now" footer button — useful for the
 * common "let me review first, looks good, apply" flow.
 */
export function FindingFixDialog({
  open,
  onOpenChange,
  targets,
  mode,
  projectPath,
  title,
  onApplied,
}: FindingFixDialogProps) {
  const [result, setResult] = useState<RunFixesResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Tracks whether the *currently displayed* result was an apply run.
   *  Distinct from the `mode` prop because the user may flip mid-dialog. */
  const [lastMode, setLastMode] = useState<FixMode>(mode)

  const run = useMemo(
    () => async (m: FixMode) => {
      if (!projectPath) {
        setError("No project path available — open a project before fixing.")
        return
      }
      if (targets.length === 0) {
        setError("No findings selected — nothing to fix.")
        return
      }
      setBusy(true)
      setError(null)
      try {
        const r = await runFindingFixesApi({
          projectPath,
          mode: m,
          targets,
        })
        setResult(r)
        setLastMode(m)
        if (m === "apply") onApplied?.(r)
      } catch (e) {
        setError(e instanceof Error ? e.message : "Fix request failed.")
      } finally {
        setBusy(false)
      }
    },
    [projectPath, targets, onApplied]
  )

  // Auto-run on first open. Closing + reopening re-runs so we always
  // show fresh diffs (the file on disk may have changed between opens).
  useEffect(() => {
    if (open) {
      setResult(null)
      void run(mode)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Solid card surface + thicker border + deep shadow so the dialog
          reads as a real surface above the dashboard instead of a
          translucent overlay. */}
      <DialogContent className="sm:max-w-4xl bg-card border-border/80 shadow-2xl shadow-black/40">
        <DialogHeader className="pb-2 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent/15 text-accent">
              <Wrench className="h-4 w-4" />
            </span>
            {title}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {lastMode === "apply"
              ? "Each fix below has been written to disk. A .edge-agent.bak backup sits next to every modified file so you can revert without git."
              : "Suggestions only — no files have been modified. Click \u201cApply all now\u201d to write these changes (a .edge-agent.bak backup is left next to every modified file)."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {busy && !result && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 rounded-md border border-border/60 bg-secondary/40">
            <Loader2 className="h-5 w-5 animate-spin text-accent" />
            <p className="text-sm text-muted-foreground">
              {lastMode === "apply"
                ? "Applying fixes…"
                : "Generating suggestions…"}
            </p>
          </div>
        )}

        {result && (
          <>
            <ResultSummary result={result} />
            <ScrollArea className="max-h-[480px] pr-3">
              <div className="space-y-3">
                {result.proposals.map((p) => (
                  <ProposalCard key={`${p.ref_id}__${p.rule_id}`} proposal={p} />
                ))}
              </div>
            </ScrollArea>
          </>
        )}

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between pt-3 border-t border-border/60">
          <div className="text-[11px] text-muted-foreground">
            {result
              ? `${result.proposals.length} proposal${result.proposals.length === 1 ? "" : "s"} · ${result.applied} applied · ${result.skipped} skipped · ${result.failed} failed`
              : ""}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {result && lastMode === "suggest" && (
              <Button
                onClick={() => void run("apply")}
                disabled={busy || result.proposals.every((p) => Boolean(p.error))}
                className="gap-1.5"
                title="Write every non-errored proposal to disk now"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Apply all now
              </Button>
            )}
            {result && lastMode === "apply" && result.failed > 0 && (
              <Button
                variant="outline"
                onClick={() => void run("apply")}
                disabled={busy}
                className="gap-1.5"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wrench className="h-4 w-4" />
                )}
                Retry failed
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResultSummary({ result }: { result: RunFixesResult }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      <SummaryTile label="Total" value={result.total} />
      <SummaryTile
        label="Applied"
        value={result.applied}
        tone="text-emerald-400"
        icon={<CircleCheck className="h-3 w-3" />}
      />
      <SummaryTile
        label="Skipped"
        value={result.skipped}
        tone="text-muted-foreground"
      />
      <SummaryTile
        label="Failed"
        value={result.failed}
        tone="text-red-400"
        icon={<CircleX className="h-3 w-3" />}
      />
    </div>
  )
}

function SummaryTile({
  label,
  value,
  tone = "text-foreground",
  icon,
}: {
  label: string
  value: number | string
  tone?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/70 px-3 py-2 shadow-sm">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className={`text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  )
}

function ProposalCard({ proposal: p }: { proposal: FixProposal }) {
  const [open, setOpen] = useState(false)
  const rt = riskTone(p.risk)
  const statusBadge = p.error
    ? "bg-red-500/15 text-red-300 border-red-500/40"
    : p.applied
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
      : "bg-yellow-500/15 text-yellow-300 border-yellow-500/40"
  const statusLabel = p.error ? "Error" : p.applied ? "Applied" : "Proposed"
  // Borrow a hair of the status colour for the card edge so the user can
  // scan a row at a glance and tell pass vs fail vs proposed apart
  // without parsing the badges.
  const cardAccent = p.error
    ? "border-red-500/40 bg-red-500/[0.04]"
    : p.applied
      ? "border-emerald-500/40 bg-emerald-500/[0.04]"
      : "border-border bg-secondary/60"
  return (
    <div
      className={`rounded-lg border ${cardAccent} shadow-sm overflow-hidden`}
    >
      <button
        type="button"
        className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-foreground/[0.03] transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <Badge variant="outline" className={`${statusBadge} text-[10px] uppercase`}>
          {statusLabel}
        </Badge>
        <Badge variant="outline" className={`${rt.badge} text-[10px] uppercase`} title={rt.hint}>
          {rt.label}
        </Badge>
        <span className="text-sm font-medium truncate">{p.title}</span>
        <span className="ml-auto text-[11px] font-mono text-muted-foreground truncate max-w-[280px]">
          {p.file}
          {p.line ? `:${p.line}` : ""}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border/60 bg-background/60 px-3 py-3 space-y-3 text-sm">
          <p className="text-xs text-foreground/85 leading-relaxed">
            {p.description}
          </p>

          {p.error ? (
            <div className="rounded-md border border-red-500/50 bg-red-500/10 p-2.5 text-xs text-red-200">
              {p.error}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <DiffPane
                title="Before"
                tone="border-border bg-[#0d1117]"
                body={p.before}
              />
              <DiffPane
                title={p.applied ? "After (on disk)" : "After (proposed)"}
                tone={
                  p.applied
                    ? "border-emerald-500/50 bg-emerald-950/40"
                    : "border-yellow-500/50 bg-yellow-950/30"
                }
                body={p.after}
              />
            </div>
          )}

          {p.diff && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
                Unified diff
              </summary>
              <pre className="mt-2 whitespace-pre overflow-x-auto rounded-md border border-border bg-[#0d1117] p-2 font-mono text-[11px] leading-relaxed">
                {p.diff}
              </pre>
            </details>
          )}

          {p.backup_path && (
            <p className="text-[11px] text-muted-foreground">
              Backup written: <span className="font-mono">{p.backup_path}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function DiffPane({
  title,
  tone,
  body,
}: {
  title: string
  tone: string
  body: string
}) {
  return (
    <div className={`rounded-md border ${tone} p-2.5 shadow-inner`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
        {title}
      </div>
      <pre className="whitespace-pre overflow-x-auto font-mono text-[11px] leading-relaxed min-h-[2.5rem] text-foreground/90">
        {body || "(empty)"}
      </pre>
    </div>
  )
}
