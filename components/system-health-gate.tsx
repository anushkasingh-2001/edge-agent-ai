"use client"

/**
 * Desktop-readiness diagnostic card.
 *
 * Hits `GET /api/system/health` and renders three logical groups:
 *
 *   1. Runtime    — how this build was launched (browser / electron-dev /
 *                   electron-prod-unpackaged / packaged), app + resources +
 *                   logs paths. Powered by the EDGE_AGENT_* env vars that
 *                   `electron/main.ts` forwards to the spawned Next server.
 *   2. Dependencies — git / gh / scanner availability, paths, versions.
 *   3. Logs       — what files are in the launcher's log directory + a
 *                   button that pops it open in Finder/Explorer.
 *
 * Severity model (unchanged from Step 4):
 *   - git missing      → HARD warning. Most flows need git.
 *   - scanner missing  → HARD warning. The message branches on
 *                        `runtime.mode`: in packaged mode we tell the user
 *                        to reinstall / rebuild; in dev mode we tell them
 *                        to create a venv.
 *   - gh missing       → SOFT warning. Create PR requires it.
 *   - gh authenticated=false → SOFT warning.
 *
 * Two action buttons live in the footer:
 *   - Copy diagnostics — serialises {runtime, git, gh, scanner, logs,
 *                        bridgeRuntimeInfo} as pretty-printed JSON into
 *                        the clipboard. Designed to be pasted directly
 *                        into a bug report.
 *   - Open logs folder — only shown when `window.edgeAgentAI.openLogsFolder`
 *                        exists AND the API returned a log dir. Opens
 *                        the folder in the native file manager.
 *
 * Secrets / privacy: the underlying route already strips everything but
 * public metadata (gh login is the user's own GitHub username; no tokens,
 * API keys, or PAT scopes are echoed). The runtime block lists local
 * filesystem paths under the user's home, which is fine for a bug report
 * the user composes themselves and would never auto-submit anywhere.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  ClipboardCheck,
  FolderOpen,
  GitBranch,
  Github,
  HeartPulse,
  Loader2,
  Monitor,
  RefreshCw,
  ScanSearch,
  ScrollText,
  XCircle,
} from "lucide-react"
import type { EdgeAgentRuntimeInfo } from "@/types/preload"

/* -------------------------------------------------------------------------- */
/* Types — kept in sync with app/api/system/health/route.ts                   */
/* -------------------------------------------------------------------------- */

export type SystemHealthRuntimeMode =
  | "browser"
  | "electron-dev"
  | "electron-prod-unpackaged"
  | "packaged"

export type SystemHealthRuntime = {
  mode: SystemHealthRuntimeMode
  appVersion: string | null
  appPath: string | null
  resourcesPath: string | null
  userDataPath: string | null
  cwd: string
  electronVersion: string | null
  chromeVersion: string | null
  nodeVersion: string
  platform: string
  arch: string
}

export type SystemHealthGit = {
  installed: boolean
  version: string | null
  path: string | null
  error: string | null
}

export type SystemHealthGh = {
  installed: boolean
  version: string | null
  path: string | null
  authenticated: boolean | null
  login: string | null
  error: string | null
}

export type SystemHealthScanner = {
  available: boolean
  source: "scanner_bin" | "python_venv" | "pythonpath" | "missing"
  python: string | null
  scannerDir: string | null
  scannerBin: string | null
  error: string | null
}

export type SystemHealthLogFile = {
  name: string
  size: number
  mtime: string | null
}

export type SystemHealthLogs = {
  dir: string | null
  files: SystemHealthLogFile[]
}

export type SystemHealthResponse = {
  runtime: SystemHealthRuntime
  git: SystemHealthGit
  gh: SystemHealthGh
  scanner: SystemHealthScanner
  logs: SystemHealthLogs
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface SystemHealthGateProps {
  /** Optional title override — Overview might want a tighter label. */
  title?: string
  /** Lift the latest snapshot to the parent so a parent banner /
   *  app-level gate can react without doing its own fetch. */
  onChange?: (health: SystemHealthResponse | null) => void
  /** Auto-fetch on mount. Defaults to true. */
  autoFetch?: boolean
}

export function SystemHealthGate({
  title = "System Health",
  onChange,
  autoFetch = true,
}: SystemHealthGateProps) {
  const [data, setData] = useState<SystemHealthResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Cross-check: runtime info reported by the preload bridge (renderer-side).
  // This is the truth source for "where Electron itself thinks it lives"; the
  // /api/system/health response is what the *spawned Next server* thinks
  // (derived from EDGE_AGENT_* env vars). If they disagree, the launcher is
  // misconfigured — we surface both in the Copy-diagnostics blob.
  const [bridgeInfo, setBridgeInfo] =
    useState<EdgeAgentRuntimeInfo | null>(null)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle"
  )
  const [openLogsState, setOpenLogsState] = useState<
    | { status: "idle" }
    | { status: "opening" }
    | { status: "error"; message: string }
  >({ status: "idle" })

  const refresh = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch("/api/system/health", {
        method: "GET",
        cache: "no-store",
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const json = (await res.json()) as SystemHealthResponse
      setData(json)
      onChange?.(json)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
      setData(null)
      onChange?.(null)
    } finally {
      setLoading(false)
    }
  }, [onChange])

  // One-shot pull of the bridge runtime info on mount. Cheap and never throws.
  useEffect(() => {
    let cancelled = false
    const bridge = typeof window !== "undefined" ? window.edgeAgentAI : null
    if (!bridge?.getRuntimeInfo) return
    bridge
      .getRuntimeInfo()
      .then((info) => {
        if (!cancelled) setBridgeInfo(info)
      })
      .catch(() => {
        // Swallow — the renderer-side cross-check is best-effort.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (autoFetch) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFetch])

  /* ---------------- Derived banner state ---------------- */

  const gitMissing = !!data && !data.git.installed
  const scannerMissing = !!data && !data.scanner.available
  const ghMissing = !!data && !data.gh.installed
  const ghUnauthed =
    !!data && data.gh.installed && data.gh.authenticated === false
  const isPackaged = data?.runtime?.mode === "packaged"

  /* ---------------- Diagnostics payload ----------------- */

  const diagnostics = useMemo(() => {
    return {
      generatedAt: new Date().toISOString(),
      // What the spawned Next server sees:
      health: data,
      // What the Electron main process (via preload) sees. May be null
      // in pure browser mode — that's a real and useful signal.
      bridgeRuntimeInfo: bridgeInfo,
      // Tiny client-side context so a bug report includes the user agent
      // and timezone without us having to ask.
      client: {
        userAgent:
          typeof navigator !== "undefined" ? navigator.userAgent : null,
        language:
          typeof navigator !== "undefined" ? navigator.language : null,
        timezone:
          typeof Intl !== "undefined"
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : null,
      },
    }
  }, [data, bridgeInfo])

  const handleCopyDiagnostics = useCallback(async () => {
    try {
      const text = JSON.stringify(diagnostics, null, 2)
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for older Electron / browsers without the async API.
        const ta = document.createElement("textarea")
        ta.value = text
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
      }
      setCopyState("copied")
      // Reset after 2s so the user knows they can copy again with the
      // latest data after refreshing.
      window.setTimeout(() => setCopyState("idle"), 2000)
    } catch {
      setCopyState("error")
      window.setTimeout(() => setCopyState("idle"), 3000)
    }
  }, [diagnostics])

  const handleOpenLogs = useCallback(async () => {
    const bridge = typeof window !== "undefined" ? window.edgeAgentAI : null
    if (!bridge?.openLogsFolder) {
      setOpenLogsState({
        status: "error",
        message:
          "Open Logs Folder is only available inside the desktop app.",
      })
      window.setTimeout(() => setOpenLogsState({ status: "idle" }), 3000)
      return
    }
    setOpenLogsState({ status: "opening" })
    try {
      const result = await bridge.openLogsFolder()
      if (result.ok) {
        setOpenLogsState({ status: "idle" })
      } else {
        setOpenLogsState({
          status: "error",
          message:
            result.error ??
            `Could not open ${result.path || "the logs folder"}.`,
        })
        window.setTimeout(() => setOpenLogsState({ status: "idle" }), 4000)
      }
    } catch (e) {
      setOpenLogsState({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      })
      window.setTimeout(() => setOpenLogsState({ status: "idle" }), 4000)
    }
  }, [])

  const bridgeAvailable =
    typeof window !== "undefined" &&
    typeof window.edgeAgentAI?.openLogsFolder === "function"

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <HeartPulse className="h-4 w-4" />
          {title}
        </CardTitle>
        <CardDescription>
          Edge Agent AI relies on a few tools being installed on this
          machine. This card detects whether they&apos;re present and
          surfaces the exact fix when something&apos;s missing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ---------------- Runtime block ---------------- */}
        <RuntimeBlock data={data?.runtime ?? null} bridge={bridgeInfo} />

        {/* ---------------- Dependency rows ---------------- */}
        <div className="grid grid-cols-1 gap-2">
          <GitRow data={data?.git ?? null} loading={loading} />
          <GhRow data={data?.gh ?? null} loading={loading} />
          <ScannerRow data={data?.scanner ?? null} loading={loading} />
        </div>

        {/* ---------------- Hard warnings ---------------- */}
        {gitMissing && (
          <WarningBanner
            level="hard"
            title="Git is required for local repository operations."
            body={
              <>
                Install Git from{" "}
                <a
                  className="underline"
                  href="https://git-scm.com/downloads"
                  target="_blank"
                  rel="noreferrer"
                >
                  git-scm.com
                </a>
                , then click <b>Refresh</b>. macOS:{" "}
                <code>xcode-select --install</code>. Linux:{" "}
                <code>sudo apt install git</code> (or equivalent).
              </>
            }
          />
        )}
        {scannerMissing && (
          <WarningBanner
            level="hard"
            title={
              isPackaged
                ? "Scanner binary missing from the packaged app."
                : "Scanner runtime not found. Create a venv or configure EDGE_AGENT_PYTHON."
            }
            body={
              isPackaged ? (
                <div className="space-y-2">
                  <p>
                    The bundled scanner binary should ship at{" "}
                    <code>
                      {data?.runtime?.resourcesPath
                        ? `${data.runtime.resourcesPath}/scanner-bin/edge-agent-scanner`
                        : "<Resources>/scanner-bin/edge-agent-scanner"}
                    </code>
                    , but the app can&apos;t find an executable there. This
                    usually means the .app was corrupted during copy or
                    built without running <code>pnpm build:scanner</code>{" "}
                    first.
                  </p>
                  <p>
                    Fix: reinstall the .app from the .dmg, or rebuild from
                    source with <code>pnpm package:mac</code>. Run Scan
                    will fail until this is resolved.
                  </p>
                  {data?.scanner?.error && (
                    <p className="text-[11px] text-muted-foreground">
                      Last probe: {data.scanner.error}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <p>
                    Run these in the project root, then click{" "}
                    <b>Refresh</b>:
                  </p>
                  <pre className="rounded bg-secondary/40 p-2 text-[11px] font-mono whitespace-pre-wrap">
                    {`python3.11 -m venv scanner/.venv
scanner/.venv/bin/python -m pip install -e "./scanner[dev]"`}
                  </pre>
                  {data?.scanner?.error && (
                    <p className="text-[11px] text-muted-foreground">
                      Last probe: {data.scanner.error}
                    </p>
                  )}
                </div>
              )
            }
          />
        )}

        {/* ---------------- Soft warnings ---------------- */}
        {ghMissing && (
          <WarningBanner
            level="soft"
            title="GitHub CLI is required for Create PR in MVP."
            body={
              <>
                Install <code>gh</code> from{" "}
                <a
                  className="underline"
                  href="https://cli.github.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  cli.github.com
                </a>{" "}
                and run <code>gh auth login</code>. Everything else in
                the app keeps working without it.
              </>
            }
          />
        )}
        {ghUnauthed && !ghMissing && (
          <WarningBanner
            level="soft"
            title="GitHub CLI installed but no account is logged in."
            body={
              <>
                Run <code>gh auth login</code> in your terminal, then
                click <b>Refresh</b>. Without this, the Create PR flow
                will fall back to the in-app token (if configured) or
                fail.
              </>
            }
          />
        )}

        {/* ---------------- Logs block ---------------- */}
        <LogsBlock data={data?.logs ?? null} />

        {/* ---------------- Fetch error ---------------- */}
        {fetchError && (
          <WarningBanner
            level="hard"
            title="Could not reach /api/system/health"
            body={<>{fetchError}</>}
          />
        )}

        {/* ---------------- Footer actions ---------------- */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {openLogsState.status === "error" && (
            <span className="text-[11px] text-yellow-300 mr-auto">
              {openLogsState.message}
            </span>
          )}
          {bridgeAvailable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleOpenLogs()}
              disabled={openLogsState.status === "opening"}
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
              {openLogsState.status === "opening"
                ? "Opening…"
                : "Open Logs Folder"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleCopyDiagnostics()}
            disabled={!data && !bridgeInfo}
            title="Copies a JSON blob with runtime info, dependency probes, and log file listing."
          >
            {copyState === "copied" ? (
              <ClipboardCheck className="h-3.5 w-3.5 mr-1.5" />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5 mr-1.5" />
            )}
            {copyState === "copied"
              ? "Copied"
              : copyState === "error"
                ? "Copy failed"
                : "Copy Diagnostics"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Runtime block                                                              */
/* -------------------------------------------------------------------------- */

function RuntimeBlock({
  data,
  bridge,
}: {
  data: SystemHealthRuntime | null
  bridge: EdgeAgentRuntimeInfo | null
}) {
  // Prefer server-side data when available — that's what the rest of
  // the diagnostics card reflects. Fall back to the preload bridge so
  // the Runtime block still renders something useful in pure browser
  // mode (where there's no Electron) and immediately on mount (before
  // the /api/system/health round-trip resolves).
  const mode: SystemHealthRuntimeMode | null =
    data?.mode ??
    (bridge?.mode as SystemHealthRuntimeMode | undefined) ??
    null
  const modeLabel: Record<SystemHealthRuntimeMode, string> = {
    browser: "Browser (pnpm dev)",
    "electron-dev": "Electron — dev",
    "electron-prod-unpackaged": "Electron — prod (unpackaged)",
    packaged: "Packaged .app",
  }
  const tone: Record<SystemHealthRuntimeMode, BadgeTone> = {
    browser: "neutral",
    "electron-dev": "neutral",
    "electron-prod-unpackaged": "neutral",
    packaged: "ok",
  }

  // Build a unified path block. Server-side wins; bridge fills the gaps
  // and provides versions in browser-only sessions.
  const paths: { label: string; value: string | null }[] = [
    { label: "App path", value: data?.appPath ?? bridge?.appPath ?? null },
    {
      label: "Resources path",
      value: data?.resourcesPath ?? bridge?.resourcesPath ?? null,
    },
    {
      label: "User data path",
      value: data?.userDataPath ?? bridge?.userDataPath ?? null,
    },
    { label: "Server cwd", value: data?.cwd ?? null },
  ]

  const versions: { label: string; value: string | null }[] = [
    { label: "App", value: data?.appVersion ?? bridge?.appVersion ?? null },
    {
      label: "Electron",
      value: data?.electronVersion ?? bridge?.electronVersion ?? null,
    },
    {
      label: "Chrome",
      value: data?.chromeVersion ?? bridge?.chromeVersion ?? null,
    },
    {
      label: "Node",
      value: data?.nodeVersion ?? bridge?.nodeVersion ?? null,
    },
    {
      label: "Platform",
      value:
        data && data.platform
          ? `${data.platform}/${data.arch}`
          : bridge
            ? `${bridge.platform}/${bridge.arch}`
            : null,
    },
  ]

  return (
    <div className="rounded-md border border-border bg-secondary/10 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <span>Runtime</span>
        </div>
        {mode ? (
          <ToneBadge badge={{ label: modeLabel[mode], tone: tone[mode] }} />
        ) : (
          <ToneBadge badge={{ label: "Detecting…", tone: "neutral" }} />
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
        {paths.map(({ label, value }) => (
          <PathLine key={label} label={label} value={value} />
        ))}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 border-t border-border/50">
        {versions
          .filter((v) => v.value)
          .map(({ label, value }) => (
            <span
              key={label}
              className="text-[11px] text-muted-foreground"
              title={`${label}: ${value}`}
            >
              <span className="font-mono">{label}</span>:{" "}
              <span className="font-mono text-foreground/80">{value}</span>
            </span>
          ))}
      </div>
    </div>
  )
}

function PathLine({
  label,
  value,
}: {
  label: string
  value: string | null
}) {
  return (
    <div className="flex items-start gap-2 text-[11px] min-w-0">
      <span className="text-muted-foreground shrink-0 w-24">{label}</span>
      <span
        className="font-mono text-foreground/85 truncate"
        title={value ?? undefined}
      >
        {value ?? <span className="text-muted-foreground italic">n/a</span>}
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Per-row renderers                                                          */
/* -------------------------------------------------------------------------- */

function GitRow({
  data,
  loading,
}: {
  data: SystemHealthGit | null
  loading: boolean
}) {
  let badge: BadgeSpec
  let detail: string | null = null
  if (loading && !data) {
    badge = { label: "Checking…", tone: "neutral" }
  } else if (!data) {
    badge = { label: "Unknown", tone: "neutral" }
  } else if (data.installed) {
    badge = { label: "Installed", tone: "ok" }
    detail = data.path ? `${data.version} — ${data.path}` : data.version
  } else {
    badge = { label: "Missing", tone: "bad" }
    detail = data.error
  }
  return (
    <HealthRow
      icon={<GitBranch className="h-4 w-4" />}
      label="Git"
      badge={badge}
      detail={detail}
    />
  )
}

function GhRow({
  data,
  loading,
}: {
  data: SystemHealthGh | null
  loading: boolean
}) {
  let badge: BadgeSpec
  let detail: string | null = null
  if (loading && !data) {
    badge = { label: "Checking…", tone: "neutral" }
  } else if (!data) {
    badge = { label: "Unknown", tone: "neutral" }
  } else if (!data.installed) {
    badge = { label: "Missing", tone: "warn" }
    detail = data.error
  } else if (data.authenticated === false) {
    badge = { label: "Not authenticated", tone: "warn" }
    detail = data.path ? `${data.version} — ${data.path}` : data.version
  } else if (data.authenticated === true) {
    badge = { label: "Installed", tone: "ok" }
    const base = data.version ?? "gh"
    const signedIn = data.login ? ` — signed in as @${data.login}` : ""
    const at = data.path ? ` — ${data.path}` : ""
    detail = `${base}${signedIn}${at}`
  } else {
    badge = { label: "Installed", tone: "ok" }
    detail = data.path ? `${data.version} — ${data.path}` : data.version
  }
  return (
    <HealthRow
      icon={<Github className="h-4 w-4" />}
      label="GitHub CLI"
      badge={badge}
      detail={detail}
    />
  )
}

function ScannerRow({
  data,
  loading,
}: {
  data: SystemHealthScanner | null
  loading: boolean
}) {
  let badge: BadgeSpec
  let detail: string | null = null
  if (loading && !data) {
    badge = { label: "Checking…", tone: "neutral" }
  } else if (!data) {
    badge = { label: "Unknown", tone: "neutral" }
  } else if (data.available) {
    badge = { label: "Ready", tone: "ok" }
    detail = describeScannerSource(data)
  } else {
    badge = { label: "Missing", tone: "bad" }
    detail = data.error
  }
  return (
    <HealthRow
      icon={<ScanSearch className="h-4 w-4" />}
      label="Scanner"
      badge={badge}
      detail={detail}
    />
  )
}

function describeScannerSource(s: SystemHealthScanner): string {
  switch (s.source) {
    case "scanner_bin":
      return `Bundled binary — ${s.scannerBin ?? "?"}`
    case "python_venv":
      return `Python venv — ${s.python ?? "?"}`
    case "pythonpath":
      return `PYTHONPATH — ${s.scannerDir ?? "?"}`
    case "missing":
    default:
      return "no source"
  }
}

/* -------------------------------------------------------------------------- */
/* Logs block                                                                 */
/* -------------------------------------------------------------------------- */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function LogsBlock({ data }: { data: SystemHealthLogs | null }) {
  // Browser mode has no log dir — don't render the block at all so the
  // card stays tight.
  if (!data || !data.dir) return null

  return (
    <div className="rounded-md border border-border bg-secondary/10 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ScrollText className="h-4 w-4 text-muted-foreground" />
        <span>Logs</span>
      </div>
      <PathLine label="Log dir" value={data.dir} />
      {data.files.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">
          No log files yet — they appear after the first request lands.
        </p>
      ) : (
        <ul className="text-[11px] space-y-0.5 font-mono">
          {data.files.map((f) => (
            <li
              key={f.name}
              className="flex items-baseline gap-2 text-foreground/85"
              title={f.mtime ?? undefined}
            >
              <span className="truncate">{f.name}</span>
              <span className="text-muted-foreground">
                {formatSize(f.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Small UI atoms                                                             */
/* -------------------------------------------------------------------------- */

type BadgeTone = "ok" | "warn" | "bad" | "neutral"
type BadgeSpec = { label: string; tone: BadgeTone }

function HealthRow({
  icon,
  label,
  badge,
  detail,
}: {
  icon: React.ReactNode
  label: string
  badge: BadgeSpec
  detail: string | null
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/10 px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <span className="text-sm font-medium shrink-0">{label}</span>
        {detail && (
          <span
            className="text-xs text-muted-foreground truncate"
            title={detail}
          >
            {detail}
          </span>
        )}
      </div>
      <ToneBadge badge={badge} />
    </div>
  )
}

function ToneBadge({ badge }: { badge: BadgeSpec }) {
  const cls =
    badge.tone === "ok"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
      : badge.tone === "warn"
        ? "bg-yellow-500/15 text-yellow-300 border-yellow-500/40"
        : badge.tone === "bad"
          ? "bg-red-500/15 text-red-300 border-red-500/40"
          : "bg-secondary text-muted-foreground"
  const Icon =
    badge.tone === "ok"
      ? CheckCircle2
      : badge.tone === "bad"
        ? XCircle
        : badge.tone === "warn"
          ? AlertTriangle
          : null
  return (
    <Badge variant="outline" className={`${cls} shrink-0`}>
      {Icon && <Icon className="h-3 w-3 mr-1" />}
      {badge.label}
    </Badge>
  )
}

function WarningBanner({
  level,
  title,
  body,
}: {
  level: "hard" | "soft"
  title: string
  body: React.ReactNode
}) {
  const cls =
    level === "hard"
      ? "border-red-500/40 bg-red-500/5 text-red-200"
      : "border-yellow-500/40 bg-yellow-500/5 text-yellow-200"
  const Icon = level === "hard" ? XCircle : AlertTriangle
  return (
    <div className={`rounded-md border ${cls} p-3 text-xs space-y-1`}>
      <div className="flex items-center gap-1.5 font-medium text-sm">
        <Icon className="h-4 w-4" />
        <span>{title}</span>
      </div>
      <div className="pl-5 space-y-1 text-[12px] [&_code]:font-mono [&_code]:text-[11px] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-secondary/50">
        {body}
      </div>
    </div>
  )
}
