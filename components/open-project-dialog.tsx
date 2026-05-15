"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  Home,
  Loader2,
  RefreshCw,
  Keyboard,
  AlertCircle,
} from "lucide-react"
import { projectIdFromPath, type Project } from "@/lib/projects"

/**
 * Open Local Project — folder browser dialog.
 *
 * Browsers can't expose absolute filesystem paths to web pages, but
 * the Next.js dev server is running locally on the user's machine and
 * can read directory listings on their behalf. We use that capability
 * to render a familiar "Finder/Explorer-style" picker:
 *   - Left rail: common shortcuts (Home / Desktop / Documents / …) +
 *     the Edge Agent workspace where cloned GitHub repos live.
 *   - Right pane: breadcrumb + back/up + folder list. Click a folder
 *     to enter it; click "Use this folder" to select the current dir.
 *   - Power-user fallback: a "Type a path" toggle reveals an absolute
 *     path input (the original behavior — kept for users who already
 *     know exactly where their project lives).
 *
 * All file-system access is server-side and constrained to
 * `getScanAllowRoot()` (the user's home dir in dev) — same envelope
 * the scanner runs in.
 */

interface OpenProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when project is opened (no scan). */
  onOpenProject: (project: Project) => void
  /** Called when user wants to open and scan immediately. */
  onOpenAndScan: (project: Project) => void
}

interface FsEntry {
  name: string
  isDir: boolean
  isHidden: boolean
}
interface ListResponse {
  ok: boolean
  path?: string
  parent?: string | null
  allowRoot?: string
  entries?: FsEntry[]
  error?: string
}
interface Shortcut {
  id: string
  label: string
  path: string
}

export function OpenProjectDialog({
  open,
  onOpenChange,
  onOpenProject,
  onOpenAndScan,
}: OpenProjectDialogProps) {
  // Browser state ---------------------------------------------------------
  const [cwd, setCwd] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [allowRoot, setAllowRoot] = useState<string | null>(null)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([])
  const [showHidden, setShowHidden] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Power-user fallback ---------------------------------------------------
  const [pathMode, setPathMode] = useState<"browse" | "type">("browse")
  const [typedPath, setTypedPath] = useState("")
  // Submission state ------------------------------------------------------
  const [busy, setBusy] = useState(false)
  // Desktop-only affordance: only true when running inside Electron and
  // the preload bridge has actually exposed `selectFolder`. We can't read
  // `window` during SSR, so it's flipped on after mount.
  const [hasNativePicker, setHasNativePicker] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined") return
    setHasNativePicker(typeof window.edgeAgentAI?.selectFolder === "function")
  }, [])

  // Reset transient state on close so reopening starts clean.
  useEffect(() => {
    if (open) return
    setError(null)
    setBusy(false)
    setLoading(false)
  }, [open])

  // Initial load — grab shortcuts and default to the home dir.
  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const res = await fetch("/api/fs/shortcuts")
        const body = (await res.json()) as {
          ok?: boolean
          allowRoot?: string
          shortcuts?: Shortcut[]
        }
        if (body.ok) {
          setShortcuts(body.shortcuts ?? [])
          setAllowRoot(body.allowRoot ?? null)
          // First call to listDir uses an empty path which the API
          // resolves to the allowRoot (home dir).
          await listDir("")
        }
      } catch {
        setError("Couldn't reach the local file system.")
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const listDir = useCallback(async (target: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/fs/list?path=${encodeURIComponent(target)}`
      )
      const body = (await res.json()) as ListResponse
      if (!body.ok || !body.path) {
        throw new Error(body.error || "List failed.")
      }
      setCwd(body.path)
      setParent(body.parent ?? null)
      setEntries(body.entries ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not list directory.")
    } finally {
      setLoading(false)
    }
  }, [])

  // Validate + open a path. Reused for both the browse flow (uses
  // `cwd`) and the type-a-path flow (uses `typedPath`).
  const validate = async (target: string): Promise<Project | null> => {
    setError(null)
    if (!target.trim()) {
      setError("Pick a folder or type a path.")
      return null
    }
    setBusy(true)
    try {
      const res = await fetch("/api/projects/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: target }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        name?: string
        path?: string
        error?: string
      }
      if (!res.ok || !data.ok || !data.path || !data.name) {
        throw new Error(data.error || "Could not open project")
      }
      return {
        id: projectIdFromPath(data.path),
        name: data.name,
        path: data.path,
        source: "local",
        lastOpenedAt: new Date().toISOString(),
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open project")
      return null
    } finally {
      setBusy(false)
    }
  }

  const selectedPath = pathMode === "browse" ? cwd : typedPath.trim()

  // Native folder picker (Electron-only). On success we drop the
  // chosen path into the type-a-path input and switch to that mode so
  // the user can review the selection and click Open Project /
  // Open and Scan — i.e. the existing validation flow runs unchanged.
  // Errors carry stable code prefixes from main.ts (see electron/main.ts).
  const handleSelectFolder = useCallback(async () => {
    const fn = typeof window !== "undefined" ? window.edgeAgentAI?.selectFolder : undefined
    if (!fn) return
    setError(null)
    try {
      const picked = await fn()
      if (!picked) return // user cancelled — keep current state untouched
      setTypedPath(picked)
      setPathMode("type")
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error"
      if (msg.startsWith("OUTSIDE_ALLOWLIST")) {
        setError(
          "This folder is outside the allowed scan directory. Update " +
            "EDGE_AGENT_SCAN_ALLOWLIST or choose a folder under your home directory."
        )
      } else if (msg.startsWith("NOT_A_DIRECTORY")) {
        setError("Could not select this folder: the selection is not a directory.")
      } else if (msg.startsWith("NOT_FOUND")) {
        setError("Could not select this folder: the folder no longer exists.")
      } else {
        setError(`Could not select this folder: ${msg}`)
      }
    }
  }, [])

  const handleOpen = async () => {
    if (!selectedPath) return
    const project = await validate(selectedPath)
    if (project) {
      onOpenProject(project)
      onOpenChange(false)
    }
  }
  const handleOpenAndScan = async () => {
    if (!selectedPath) return
    const project = await validate(selectedPath)
    if (project) {
      onOpenAndScan(project)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Open Local Project</DialogTitle>
          <DialogDescription>
            Browse to your project folder. The Python scanner runs locally
            and only reads files under the path you pick.
          </DialogDescription>
        </DialogHeader>

        {/* Mode toggle: browse vs type. We default to browse because
         *  it's the friendlier of the two, but power users can flip
         *  to a single-line absolute-path input. Desktop mode adds a
         *  "Select Folder…" shortcut that delegates to the OS-native
         *  picker (Electron only — invisible in browser mode). */}
        <div className="flex items-center gap-2 -mt-1">
          {hasNativePicker && (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void handleSelectFolder()}
                title="Open the native OS folder picker"
              >
                <FolderInput className="h-3.5 w-3.5 mr-1.5" />
                Select Folder…
              </Button>
              <span
                aria-hidden
                className="text-muted-foreground/40 mx-0.5 select-none"
              >
                |
              </span>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant={pathMode === "browse" ? "default" : "outline"}
            onClick={() => setPathMode("browse")}
          >
            <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
            Browse
          </Button>
          <Button
            type="button"
            size="sm"
            variant={pathMode === "type" ? "default" : "outline"}
            onClick={() => setPathMode("type")}
          >
            <Keyboard className="h-3.5 w-3.5 mr-1.5" />
            Type a path
          </Button>
          {allowRoot && (
            <span className="text-[10px] text-muted-foreground ml-auto font-mono truncate max-w-[260px]">
              Allowed root: {allowRoot}
            </span>
          )}
        </div>

        {pathMode === "browse" ? (
          <BrowserPane
            cwd={cwd}
            parent={parent}
            entries={entries}
            shortcuts={shortcuts}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden((v) => !v)}
            loading={loading}
            onNavigate={listDir}
          />
        ) : (
          <TypePathPane value={typedPath} onChange={setTypedPath} />
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter className="gap-2 items-center">
          {/* Selected path preview, so the user always knows what
           *  they're about to open before clicking. */}
          {selectedPath && (
            <div className="mr-auto text-[11px] text-muted-foreground font-mono truncate max-w-[260px]">
              <span className="opacity-70">Selected: </span>
              {selectedPath}
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleOpen()}
            disabled={busy || !selectedPath}
          >
            Open Project
          </Button>
          <Button
            type="button"
            onClick={() => void handleOpenAndScan()}
            disabled={busy || !selectedPath}
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Working…
              </>
            ) : (
              "Open and Scan"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Browse pane                                                                */
/* -------------------------------------------------------------------------- */

function BrowserPane({
  cwd,
  parent,
  entries,
  shortcuts,
  showHidden,
  onToggleHidden,
  loading,
  onNavigate,
}: {
  cwd: string | null
  parent: string | null
  entries: FsEntry[]
  shortcuts: Shortcut[]
  showHidden: boolean
  onToggleHidden: () => void
  loading: boolean
  onNavigate: (path: string) => void
}) {
  const visibleEntries = entries.filter((e) => showHidden || !e.isHidden)
  const dirCount = entries.filter((e) => e.isDir && (showHidden || !e.isHidden)).length

  return (
    <div className="grid grid-cols-[160px_1fr] gap-3">
      {/* Shortcuts rail */}
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-2">
          Shortcuts
        </div>
        {shortcuts.length === 0 ? (
          <p className="text-xs text-muted-foreground px-2">None available.</p>
        ) : (
          shortcuts.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onNavigate(s.path)}
              title={s.path}
              className={`w-full flex items-center gap-2 text-left text-xs rounded px-2 py-1.5 hover:bg-secondary/50 transition-colors ${
                cwd === s.path ? "bg-secondary/60 font-medium" : ""
              }`}
            >
              {s.id === "home" ? (
                <Home className="h-3.5 w-3.5 text-accent" />
              ) : (
                <Folder className="h-3.5 w-3.5 text-accent" />
              )}
              <span className="truncate">{s.label}</span>
            </button>
          ))
        )}
      </div>

      {/* Folder browser */}
      <div className="rounded-md border border-border bg-secondary/10 flex flex-col min-h-[320px]">
        {/* Breadcrumb header */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => parent && onNavigate(parent)}
            disabled={!parent || loading}
            title={parent ? `Up to ${parent}` : "At root of allowed area"}
          >
            <ChevronLeft className="h-4 w-4" />
            Up
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => cwd && onNavigate(cwd)}
            disabled={!cwd || loading}
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Breadcrumb path={cwd} onNavigate={onNavigate} />
          <button
            type="button"
            onClick={onToggleHidden}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground px-1.5"
            title="Toggle hidden files / folders (those starting with '.')"
          >
            {showHidden ? "Hide hidden" : "Show hidden"}
          </button>
        </div>

        {/* Listing */}
        <ScrollArea className="h-[320px]">
          {loading && entries.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading…
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="text-xs text-muted-foreground px-3 py-6 text-center">
              {entries.length === 0
                ? "Empty folder."
                : "All entries hidden — click 'Show hidden' to reveal."}
            </div>
          ) : (
            <ul className="p-1">
              {visibleEntries.map((e) => (
                <li key={e.name}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!e.isDir || !cwd) return
                      onNavigate(`${cwd.replace(/\/+$/, "")}/${e.name}`)
                    }}
                    disabled={!e.isDir}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded transition-colors ${
                      e.isDir
                        ? "hover:bg-secondary/50 cursor-pointer"
                        : "opacity-60 cursor-default"
                    } ${e.isHidden ? "italic text-muted-foreground" : ""}`}
                    title={
                      e.isDir
                        ? `Open ${e.name}`
                        : "Files can't be opened — pick a folder"
                    }
                  >
                    {e.isDir ? (
                      <Folder className="h-4 w-4 text-accent shrink-0" />
                    ) : (
                      <span className="h-4 w-4 shrink-0 text-muted-foreground text-[10px] flex items-center justify-center">
                        ·
                      </span>
                    )}
                    <span className="truncate flex-1 text-left">{e.name}</span>
                    {e.isDir && (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        {/* Footer count */}
        <div className="border-t border-border/50 px-2 py-1 text-[10px] text-muted-foreground">
          {dirCount} folder{dirCount === 1 ? "" : "s"}
          {entries.length > visibleEntries.length && (
            <> · {entries.length - visibleEntries.length} hidden</>
          )}
          <span className="ml-2 opacity-70">
            Tip: click a folder to open it. Use the buttons below to pick the
            currently-shown folder as your project root.
          </span>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Breadcrumb                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Splits an absolute path into clickable segments. Each segment
 * navigates to the prefix path so users can jump back to any
 * ancestor in one click — a much faster alternative to repeatedly
 * pressing "Up".
 */
function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string | null
  onNavigate: (target: string) => void
}) {
  if (!path) {
    return (
      <span className="text-xs text-muted-foreground font-mono px-1">…</span>
    )
  }
  // Split into segments while preserving the leading slash for unix
  // absolute paths. On Windows we'd preserve "C:\" as the first
  // segment — keeping it simple by treating any path with backslashes
  // identically.
  const isWindows = path.includes("\\") && !path.startsWith("/")
  const sep = isWindows ? "\\" : "/"
  const parts = path.split(sep).filter(Boolean)
  const root = isWindows ? "" : "/"

  // Build segment data: cumulative path + display label.
  const segs: { label: string; full: string }[] = []
  let acc = root
  for (const p of parts) {
    acc = acc === "/" ? `/${p}` : `${acc}${sep}${p}`
    segs.push({ label: p, full: acc })
  }

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto text-xs font-mono min-w-0 flex-1">
      {!isWindows && (
        <button
          type="button"
          onClick={() => onNavigate("/")}
          className="text-muted-foreground hover:text-foreground px-1"
          title="/"
        >
          /
        </button>
      )}
      {segs.map((s, i) => (
        <span key={s.full} className="flex items-center gap-0.5 min-w-0">
          {i > 0 && <span className="text-muted-foreground/60">{sep}</span>}
          <button
            type="button"
            onClick={() => onNavigate(s.full)}
            className="hover:text-foreground hover:underline truncate max-w-[140px]"
            title={s.full}
          >
            {s.label}
          </button>
        </span>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Type-a-path pane (power user fallback)                                     */
/* -------------------------------------------------------------------------- */

function TypePathPane({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5 py-2">
      <label htmlFor="project-path" className="text-sm">
        Local project path
      </label>
      <Input
        id="project-path"
        placeholder="/Users/anushka/Desktop/my-agent or ~/Code/my-agent"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-secondary/50 font-mono text-sm"
      />
      <p className="text-[11px] text-muted-foreground">
        Use <span className="font-mono">~</span> as a shortcut for your home
        directory. Path must point to a folder you can read.
      </p>
    </div>
  )
}
