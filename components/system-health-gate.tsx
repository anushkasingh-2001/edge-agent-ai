"use client"

/**
 * Desktop-readiness diagnostic card.
 *
 * Hits `GET /api/system/health` and renders one row per dependency
 * (git / gh / scanner). Designed to live inside Settings (and could
 * be dropped into Overview unchanged) so a user investigating "why
 * doesn't Run Scan work?" has a single canonical place to confirm
 * their local toolchain.
 *
 * Severity model — matches step-4 spec:
 *   - git missing      → HARD warning (red). Most flows need git.
 *   - scanner missing  → HARD warning (red). Run Scan can't work.
 *   - gh missing       → SOFT warning (yellow). Create PR requires
 *                        it but the rest of the app is fine.
 *   - gh authenticated=false → SOFT warning. Surface install/login
 *                        guidance without blocking anything.
 *
 * We never block the rest of the app from this component — the
 * caller decides whether to gate other features on
 * `health.git.installed` / `health.scanner.available`. Today the
 * card is informational; future steps may render an app-level
 * banner using the same data source.
 *
 * Secrets / privacy: the underlying route already strips everything
 * but public metadata (gh login is your own GitHub username; no
 * tokens, no API keys, no PAT scopes are echoed to the client).
 */

import { useCallback, useEffect, useState } from "react"
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
  GitBranch,
  Github,
  HeartPulse,
  Loader2,
  RefreshCw,
  ScanSearch,
  XCircle,
} from "lucide-react"

/* -------------------------------------------------------------------------- */
/* Types — kept in sync with app/api/system/health/route.ts                   */
/* -------------------------------------------------------------------------- */

export type SystemHealthGit = {
  installed: boolean
  version: string | null
  error: string | null
}

export type SystemHealthGh = {
  installed: boolean
  version: string | null
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

export type SystemHealthResponse = {
  git: SystemHealthGit
  gh: SystemHealthGh
  scanner: SystemHealthScanner
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

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <HeartPulse className="h-4 w-4" />
          {title}
        </CardTitle>
        <CardDescription>
          Edge Agent AI relies on a few tools being installed on this
          machine. This card detects whether they're present and
          surfaces the exact fix when something's missing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ---------------- Rows ---------------- */}
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
            title="Scanner runtime not found. Create scanner virtualenv or configure EDGE_AGENT_PYTHON."
            body={
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

        {/* ---------------- Fetch error ---------------- */}
        {fetchError && (
          <WarningBanner
            level="hard"
            title="Could not reach /api/system/health"
            body={<>{fetchError}</>}
          />
        )}

        {/* ---------------- Footer ---------------- */}
        <div className="flex items-center justify-end gap-2">
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
    detail = data.version
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
    detail = data.version
  } else if (data.authenticated === true) {
    badge = { label: "Installed", tone: "ok" }
    detail = data.login
      ? `${data.version ?? "gh"} — signed in as @${data.login}`
      : data.version
  } else {
    badge = { label: "Installed", tone: "ok" }
    detail = data.version
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
