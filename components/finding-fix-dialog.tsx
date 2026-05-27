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
  type FixProviderKind,
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
  /** Selected intelligence mode, threaded from the Findings view →
   *  drawer → button → here → runFindingFixesApi. */
  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  /** Hosted (server-side key) vs BYOK (caller-supplied). */
  aiProviderMode?: "hosted" | "byok"
  /** Manual-mode per-task model picks. ``manualModelSelection`` is
   *  the v2 canonical name; ``manualModels`` is kept as a legacy
   *  alias to preserve compatibility with the Step-1 wiring. */
  manualModelSelection?: Record<string, string>
  manualModels?: Record<string, string>
  /** BYOK provider config, forwarded to the fix API. Only sent on
   *  the wire when ``aiProviderMode === "byok"``; the client
   *  enforces that gate inside ``runFindingFixesApi``. */
  provider?: FixProviderKind
  apiKey?: string
  baseUrl?: string
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
  intelligenceMode,
  aiProviderMode,
  manualModelSelection,
  manualModels,
  provider,
  apiKey,
  baseUrl,
  onApplied,
}: FindingFixDialogProps) {
  // Single normalised manual-model map for everything below.
  const manualMap = manualModelSelection ?? manualModels
  const [result, setResult] = useState<RunFixesResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Tracks whether the *currently displayed* result was an apply run.
   *  Distinct from the `mode` prop because the user may flip mid-dialog. */
  const [lastMode, setLastMode] = useState<FixMode>(mode)
  /**
   * True after the user has actively clicked a footer action button
   * (as opposed to the initial auto-apply that runs when the dialog
   * opens). Drives the primary-button transition the user asked for:
   * after a "Fix it" auto-apply, the footer shows a "Fix all" primary
   * button — clicking it sets this flag, which flips the button to
   * "Close" so the user has a clean exit.
   */
  const [userActed, setUserActed] = useState(false)

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
          intelligenceMode,
          aiProviderMode,
          provider,
          apiKey,
          baseUrl,
          manualModelSelection: manualMap,
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
    [
      projectPath,
      targets,
      onApplied,
      intelligenceMode,
      aiProviderMode,
      manualMap,
      provider,
      apiKey,
      baseUrl,
    ]
  )

  // Auto-run on first open. Closing + reopening re-runs so we always
  // show fresh diffs (the file on disk may have changed between opens).
  useEffect(() => {
    if (open) {
      setResult(null)
      setUserActed(false)
      void run(mode)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Wraps `run` so any user-initiated click marks the dialog as
  // "acted upon" — this is what flips the post-apply button from
  // "Fix all" to "Close".
  const runFromUser = async (m: FixMode) => {
    setUserActed(true)
    await run(m)
  }

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
              ? "Each \u201CApplied\u201D fix below was written directly to its original file. A backup of every modified file is kept under <project>/.edge-agent/backups/ — wipe that folder when you're confident, or rely on git."
              : "Suggestions only \u2014 no files have been modified yet. Click the apply button below to write changes to the original files (backups go to <project>/.edge-agent/backups/)."}
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
            {lastMode === "apply" ? (
              <PostApplyBanner result={result} />
            ) : (
              <ApplyabilityHint result={result} />
            )}
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
          <FooterActions
            result={result}
            busy={busy}
            lastMode={lastMode}
            userActed={userActed}
            run={runFromUser}
            onClose={() => onOpenChange(false)}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Footer button cluster. Three real states, picked together so the
 * Close button can promote to primary styling when it's the ONLY
 * action — the user shouldn't have to hunt for a CTA when nothing else
 * is available.
 */
function FooterActions({
  result,
  busy,
  lastMode,
  userActed,
  run,
  onClose,
}: {
  result: RunFixesResult | null
  busy: boolean
  lastMode: FixMode
  /** True once the user has actively clicked a footer button — used
   *  to swap the apply-mode CTA from "Fix all" → "Close". */
  userActed: boolean
  run: (m: FixMode) => Promise<void>
  onClose: () => void
}) {
  // No result yet (initial load / error before render) — just give a way out.
  if (!result) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  const { applicable, transientFailures } = bucketResult(result)

  // ── SUGGEST mode ─────────────────────────────────────────────────
  if (lastMode === "suggest") {
    const canApply = applicable > 0
    return (
      <div className="flex items-center gap-2">
        <Button
          variant={canApply ? "outline" : "default"}
          onClick={onClose}
        >
          Close
        </Button>
        <Button
          onClick={() => void run("apply")}
          disabled={busy || !canApply}
          className="gap-1.5"
          title={
            canApply
              ? `Write ${applicable} proposal${applicable === 1 ? "" : "s"} to disk now (a backup is kept under .edge-agent/backups/).`
              : "Nothing here can be auto-applied — every row is either already fixed or its file type isn't auto-fixable."
          }
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {canApply
            ? `Apply ${applicable} ${applicable === 1 ? "fix" : "fixes"}`
            : "Nothing to apply"}
        </Button>
      </div>
    )
  }

  // ── APPLY mode (already executed) ───────────────────────────────
  // If there are retryable failures, the dominant action is Retry.
  if (transientFailures > 0) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button
          onClick={() => void run("apply")}
          disabled={busy}
          className="gap-1.5"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wrench className="h-4 w-4" />
          )}
          Retry {transientFailures} failed
        </Button>
      </div>
    )
  }

  // No retryable failures. Two sub-states, controlled by `userActed`:
  //
  //   1. The user JUST opened Fix-it — auto-apply ran behind the scenes
  //      to populate the dialog, but the user hasn't actively confirmed
  //      anything yet. Show a primary "Fix all" button so they have an
  //      explicit confirmation step. Clicking it re-runs apply (which
  //      is idempotent for the already-fixed rows but will catch any
  //      drift if the files changed between auto-apply and click) and
  //      flips us into the next state.
  //
  //   2. The user clicked "Fix all" — apply has now run with their
  //      explicit consent. The CTA becomes "Close" so they have a
  //      clean exit.
  if (!userActed) {
    return (
      <div className="flex items-center gap-2">
        <Button
          onClick={() => void run("apply")}
          disabled={busy}
          className="gap-1.5"
          title="Re-run the fix engine to make sure nothing has drifted since the dialog opened."
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          Fix all
        </Button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Button onClick={onClose} className="gap-1.5">
        <Check className="h-4 w-4" />
        Close
      </Button>
    </div>
  )
}

/** A "true no-op" is a row the engine deliberately skipped because the
 * file already carries our fix marker. We must EXCLUDE rows that also
 * have an `error` set, because `makeErrorProposal` reports those with
 * `risk: "no-op"` too — counting them as idempotent skips would inflate
 * the banner numbers (e.g. "8 rows already have a fix marker" when
 * really 4 were already fixed and 4 errored). */
function bucketResult(result: RunFixesResult) {
  const idempotentSkips = result.proposals.filter(
    (p) => p.risk === "no-op" && !p.error
  ).length
  const permanentFailures = result.proposals.filter(
    (p) => p.error && !p.retryable
  ).length
  const transientFailures = result.proposals.filter(
    (p) => p.error && p.retryable
  ).length
  const applicable = result.proposals.filter(
    (p) => !p.error && p.risk !== "no-op"
  ).length
  return {
    idempotentSkips,
    permanentFailures,
    transientFailures,
    applicable,
  }
}

/**
 * Status strip shown after an "apply" run. Three colors, picked so the
 * user immediately knows whether action is required:
 *
 *   GREEN   — at least one file was actually written to disk.
 *   YELLOW  — 0 written, but the failures are deterministic dead-ends
 *             (file type can't be auto-fixed) or were already
 *             idempotent skips. "Nothing went wrong, nothing to do
 *             here, move on."
 *   RED     — 0 written and there's a recoverable failure to retry.
 */
function PostApplyBanner({ result }: { result: RunFixesResult }) {
  const { idempotentSkips, permanentFailures, transientFailures } =
    bucketResult(result)
  if (result.applied > 0) {
    const tail: string[] = []
    if (idempotentSkips > 0) {
      tail.push(
        `${idempotentSkips} ${idempotentSkips === 1 ? "row was" : "rows were"} already fixed in a previous run`
      )
    }
    if (permanentFailures > 0) {
      tail.push(
        `${permanentFailures} ${permanentFailures === 1 ? "row needs" : "rows need"} a manual edit (file type isn't auto-fixable)`
      )
    }
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200 leading-relaxed">
        <span className="font-semibold">
          {result.applied} {result.applied === 1 ? "fix" : "fixes"} written to
          disk.
        </span>{" "}
        Those rows are now hidden from the Findings list — close this dialog
        to see the updated count. Backups are kept under{" "}
        <span className="font-mono">.edge-agent/backups/</span>.
        {tail.length > 0 && (
          <span className="block mt-1 text-emerald-200/80">
            {tail.join(" · ")}.
          </span>
        )}
      </div>
    )
  }
  // applied === 0 cases
  if (transientFailures > 0) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200 leading-relaxed">
        <span className="font-semibold">No fixes were applied.</span>{" "}
        {transientFailures} {transientFailures === 1 ? "row failed" : "rows failed"}{" "}
        with a recoverable error — use the Retry button below.
        {permanentFailures > 0 &&
          ` ${permanentFailures} other ${permanentFailures === 1 ? "row needs" : "rows need"} a manual edit (e.g. .json).`}
      </div>
    )
  }
  // No transient failures, just idempotent skips and/or permanent errors.
  // This is a NEUTRAL state, not an error: the system did exactly what
  // it should, there's just nothing left to auto-fix.
  return (
    <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-200 leading-relaxed">
      <span className="font-semibold">Nothing new to apply.</span>
      {idempotentSkips > 0 && (
        <>
          {" "}
          {idempotentSkips} {idempotentSkips === 1 ? "row was" : "rows were"}{" "}
          already fixed in an earlier run.
        </>
      )}
      {permanentFailures > 0 && (
        <>
          {" "}
          {permanentFailures} {permanentFailures === 1 ? "row" : "rows"}{" "}
          can&apos;t be auto-fixed by the engine (file type has no comment
          syntax — e.g. <span className="font-mono">.json</span>) and need a
          manual edit.
        </>
      )}
    </div>
  )
}

/**
 * SUGGEST-mode counterpart of PostApplyBanner. Shown before any apply
 * has happened, when every proposal would either no-op or fail
 * permanently. Tells the user up front "the upcoming Apply will do
 * nothing", so they don't keep clicking it.
 */
function ApplyabilityHint({ result }: { result: RunFixesResult }) {
  const { applicable, idempotentSkips, permanentFailures, transientFailures } =
    bucketResult(result)
  if (applicable > 0) return null
  const parts: string[] = []
  if (idempotentSkips > 0) {
    parts.push(
      `${idempotentSkips} ${idempotentSkips === 1 ? "row" : "rows"} already have a fix marker.`
    )
  }
  if (permanentFailures > 0) {
    parts.push(
      `${permanentFailures} ${permanentFailures === 1 ? "row needs" : "rows need"} a manual fix (file type has no comment syntax we can safely use, e.g. .json).`
    )
  }
  if (transientFailures > 0) {
    parts.push(
      `${transientFailures} ${transientFailures === 1 ? "row failed" : "rows failed"} with a recoverable error.`
    )
  }
  if (parts.length === 0) return null
  return (
    <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-200 leading-relaxed">
      <span className="font-semibold">Nothing here is auto-applicable.</span>{" "}
      {parts.join(" ")}
    </div>
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

          {/* Surface the FULL absolute path so the user can verify
              "yes, the engine is touching the original file in my
              real repo, not a workspace copy." */}
          <div className="rounded-md border border-border/60 bg-secondary/50 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground break-all">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1.5">
              On disk:
            </span>
            {p.absolute_path}
            {p.line ? <span className="text-muted-foreground/70">:{p.line}</span> : null}
          </div>

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
