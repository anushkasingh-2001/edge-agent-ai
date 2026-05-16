/**
 * GET /api/system/health
 *
 * Local-machine readiness probe for the desktop app. Inspects whether
 * the three external dependencies Edge Agent AI needs are present and
 * (where relevant) usable:
 *
 *   - git              — required for every local repo flow
 *   - gh (GitHub CLI)  — required for Create PR in MVP, optional otherwise
 *   - Python scanner   — required to run any scan
 *
 * Every check uses `spawnSync` with an args array — never a shell
 * string — so user-controlled values (none here, but a precedent
 * worth preserving) can't be interpolated into the command line.
 *
 * The response intentionally never includes paths to tokens, API
 * keys, or any user-supplied secret. The `gh` login is public
 * metadata (your own GitHub username), nothing else.
 *
 * Scanner resolution mirrors /api/scan and extends it for the
 * forthcoming packaged desktop build:
 *
 *   1. EDGE_AGENT_SCANNER_BIN   — precompiled PyInstaller binary
 *                                 (used by packaged macOS/Win/Linux
 *                                 builds; not wired into /api/scan yet,
 *                                 but the health gate already accepts
 *                                 it so step 5 lands cleanly).
 *   2. EDGE_AGENT_PYTHON + EDGE_AGENT_SCANNER_DIR
 *                               — explicit overrides used by the
 *                                 standalone server + Electron launcher.
 *   3. <cwd>/scanner/.venv      — dev fallback (what `pnpm dev` uses).
 *   4. PYTHONPATH               — last-resort fallback: any directory
 *                                 on PYTHONPATH that contains
 *                                 `edge_agent_scanner/cli.py`.
 *
 * The route is `force-dynamic` because env / filesystem state can
 * change between requests (user installs git, points
 * EDGE_AGENT_PYTHON at a fresh venv, etc.).
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { NextResponse } from "next/server"
import { runGh } from "@/lib/server-github"

export const dynamic = "force-dynamic"

/** Hard cap on any individual subprocess so a slow/hung `gh auth
 *  status` (e.g. behind a corp proxy) can't pin the health route
 *  forever. `gh` already has its own 10s cap via runGh — this is the
 *  cap for the git probe and any future subprocesses. */
const COMMAND_TIMEOUT_MS = 10_000

/**
 * Boot mode strings — kept in sync with `electron/main.ts` and
 * `types/preload.d.ts`. The server can never observe Electron's
 * `app.isPackaged` directly (it runs in the spawned Next process),
 * so we trust the EDGE_AGENT_MODE env var the Electron launcher
 * forwards. When no env signal is present we default to "browser".
 */
type RuntimeMode =
  | "browser"
  | "electron-dev"
  | "electron-prod-unpackaged"
  | "packaged"

type GitStatus = {
  installed: boolean
  version: string | null
  /** Absolute path to the resolved `git` executable, or null when
   *  not on PATH or `which`/`where` failed. */
  path: string | null
  error: string | null
}

type GhStatus = {
  installed: boolean
  version: string | null
  /** Absolute path to the resolved `gh` executable. */
  path: string | null
  /** null when gh isn't installed; true/false otherwise. */
  authenticated: boolean | null
  login: string | null
  error: string | null
}

type ScannerStatus = {
  available: boolean
  source: "scanner_bin" | "python_venv" | "pythonpath" | "missing"
  python: string | null
  scannerDir: string | null
  scannerBin: string | null
  error: string | null
}

/** Where the process is running and where it lives on disk. */
type RuntimeStatus = {
  mode: RuntimeMode
  /** App version (from EDGE_AGENT_APP_VERSION, set by electron/main.ts). */
  appVersion: string | null
  /** `app.getAppPath()` snapshot from the launcher. */
  appPath: string | null
  /** `process.resourcesPath` snapshot from the launcher. */
  resourcesPath: string | null
  /** `app.getPath("userData")` snapshot from the launcher. */
  userDataPath: string | null
  /** Server-side `process.cwd()` — useful to spot a packaged app booted
   *  from the wrong directory. */
  cwd: string
  electronVersion: string | null
  chromeVersion: string | null
  nodeVersion: string
  platform: NodeJS.Platform
  arch: string
}

type LogsStatus = {
  /** Absolute path to the log directory the Electron launcher told us
   *  about. Null in pure browser mode. */
  dir: string | null
  /** Per-file presence + size, so the UI can warn if a file is missing
   *  or unusually large. Only populated when `dir` exists. */
  files: { name: string; size: number; mtime: string | null }[]
}

type HealthResponse = {
  runtime: RuntimeStatus
  git: GitStatus
  gh: GhStatus
  scanner: ScannerStatus
  logs: LogsStatus
}

/* -------------------------------------------------------------------------- */
/* which / where helper — resolves the absolute path of a PATH executable     */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the absolute path of an executable on PATH. Uses `which` on
 * POSIX, `where` on Windows; both ship with the OS and never invoke a
 * shell here (args array, not a single string). Returns null when the
 * executable isn't found or the probe itself failed — callers should
 * gracefully fall back to "version known, path unknown".
 *
 * We DO NOT trust user-controlled input for `name`; today the only
 * callers are hard-coded "git" / "gh" string literals.
 */
function resolveExecutablePath(name: string): string | null {
  const probe = process.platform === "win32" ? "where" : "which"
  let proc
  try {
    proc = spawnSync(probe, [name], {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1 * 1024 * 1024,
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
      },
    })
  } catch {
    return null
  }
  if (proc.error || proc.status !== 0) return null
  // `which` prints one line; `where` may print several (e.g. `git.exe` +
  // `git.cmd` shim) — we keep the first one because it's what would
  // actually execute under spawn-without-shell.
  const first = (proc.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!first) return null
  try {
    return path.resolve(first)
  } catch {
    return first
  }
}

/* -------------------------------------------------------------------------- */
/* git --version                                                              */
/* -------------------------------------------------------------------------- */

function checkGit(): GitStatus {
  let proc
  try {
    proc = spawnSync("git", ["--version"], {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1 * 1024 * 1024,
      env: {
        ...process.env,
        // Force English so we don't have to parse localised banners.
        LANG: "C",
        LC_ALL: "C",
      },
    })
  } catch (e) {
    return {
      installed: false,
      version: null,
      path: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        installed: false,
        version: null,
        path: null,
        error: "git executable not found on PATH",
      }
    }
    return {
      installed: false,
      version: null,
      path: null,
      error: proc.error.message,
    }
  }
  if (proc.status !== 0) {
    return {
      installed: false,
      version: null,
      path: null,
      error:
        (proc.stderr ?? "").trim() ||
        `git --version exited with status ${proc.status}`,
    }
  }
  // `git --version` prints e.g. "git version 2.39.5 (Apple Git-154)".
  // Keep the whole line so users can copy-paste it into a bug report.
  return {
    installed: true,
    version: (proc.stdout ?? "").trim() || null,
    path: resolveExecutablePath("git"),
    error: null,
  }
}

/* -------------------------------------------------------------------------- */
/* gh --version + gh auth status + gh api user --jq .login                    */
/* -------------------------------------------------------------------------- */

function checkGh(): GhStatus {
  // runGh handles ENOENT detection and 10s timeout internally.
  const ver = runGh(["--version"])
  if (ver.notInstalled) {
    return {
      installed: false,
      version: null,
      path: null,
      authenticated: null,
      login: null,
      error: ver.stderr.trim() || "gh executable not found on PATH",
    }
  }
  if (ver.status !== 0) {
    return {
      installed: false,
      version: null,
      path: null,
      authenticated: null,
      login: null,
      error:
        ver.stderr.trim() ||
        `gh --version exited with status ${ver.status}`,
    }
  }
  // `gh --version` prints e.g. "gh version 2.55.0 (2024-08-15)\nhttps...".
  // We only want the first line so the UI doesn't render the
  // release-notes URL into a one-line badge.
  const version =
    ver.stdout.trim().split("\n")[0]?.trim() || null
  // Resolve the absolute path now — same probe as git. Cheap (single
  // OS-builtin spawn) and saves the user from running `which gh`
  // themselves to file a bug report.
  const ghPath = resolveExecutablePath("gh")

  // gh IS installed. Check auth — but never fail the whole route
  // just because the user isn't logged in. Create-PR-in-MVP is the
  // only feature that strictly needs auth.
  const auth = runGh(["auth", "status"])
  if (auth.notInstalled) {
    // Shouldn't happen (we just confirmed gh is installed) but the
    // type union demands we handle it. Treat as "installed but
    // disappeared between calls".
    return {
      installed: true,
      version,
      path: ghPath,
      authenticated: false,
      login: null,
      error: "gh disappeared between subprocess calls",
    }
  }
  if (auth.status !== 0) {
    return {
      installed: true,
      version,
      path: ghPath,
      authenticated: false,
      login: null,
      error: null,
    }
  }

  // Authenticated → fetch the login (public username; not a secret).
  // We use `gh api user --jq .login` rather than parsing
  // `auth status` because the latter's output format has changed
  // across gh releases.
  const user = runGh(["api", "user", "--jq", ".login"])
  if (user.notInstalled || user.status !== 0) {
    // Reachable e.g. when the token has expired since `auth status`
    // succeeded against the cached state. Surface the stderr so the
    // user has something actionable.
    return {
      installed: true,
      version,
      path: ghPath,
      authenticated: false,
      login: null,
      error: user.stderr.trim() || null,
    }
  }
  const login = user.stdout.trim()
  return {
    installed: true,
    version,
    path: ghPath,
    authenticated: true,
    login: login || null,
    error: null,
  }
}

/* -------------------------------------------------------------------------- */
/* Scanner: mirror /api/scan resolution + EDGE_AGENT_SCANNER_BIN +            */
/* PYTHONPATH fallback                                                        */
/* -------------------------------------------------------------------------- */

/** Cheap existence + executable-bit check on a single file. Returns
 *  null on success, or a human-readable reason string on failure. */
function fileExecutableProblem(p: string): string | null {
  if (!fs.existsSync(p)) return `not found: ${p}`
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return `not a file: ${p}`
  } catch (e) {
    return `stat failed: ${e instanceof Error ? e.message : String(e)}`
  }
  try {
    fs.accessSync(p, fs.constants.X_OK)
  } catch {
    return `not executable: ${p}`
  }
  return null
}

/** Validate a (python, scannerDir) pair the same way `/api/scan`
 *  does: cli.py must live at scannerDir/src/edge_agent_scanner/cli.py.
 *  Returns null when the pair is usable, or a reason string otherwise.
 *  Side-effect free — does NOT spawn Python. */
function pythonPairProblem(
  python: string,
  scannerDir: string
): string | null {
  if (!fs.existsSync(python)) {
    return `python not found: ${python}`
  }
  if (!fs.existsSync(scannerDir)) {
    return `scannerDir not found: ${scannerDir}`
  }
  try {
    if (!fs.statSync(scannerDir).isDirectory()) {
      return `scannerDir is not a directory: ${scannerDir}`
    }
  } catch (e) {
    return `scannerDir stat failed: ${
      e instanceof Error ? e.message : String(e)
    }`
  }
  const cli = path.join(scannerDir, "src", "edge_agent_scanner", "cli.py")
  if (!fs.existsSync(cli)) {
    return `missing ${cli}`
  }
  return null
}

function checkScanner(): ScannerStatus {
  /* -------- (1) EDGE_AGENT_SCANNER_BIN — packaged build path ------ */
  const binEnv = process.env.EDGE_AGENT_SCANNER_BIN?.trim()
  if (binEnv) {
    const resolved = path.resolve(binEnv)
    const problem = fileExecutableProblem(resolved)
    if (problem) {
      return {
        available: false,
        source: "missing",
        python: null,
        scannerDir: null,
        scannerBin: resolved,
        error: `EDGE_AGENT_SCANNER_BIN ${problem}`,
      }
    }
    return {
      available: true,
      source: "scanner_bin",
      python: null,
      scannerDir: null,
      scannerBin: resolved,
      error: null,
    }
  }

  /* -------- (2) EDGE_AGENT_PYTHON + EDGE_AGENT_SCANNER_DIR -------- */
  const pyEnvRaw = process.env.EDGE_AGENT_PYTHON?.trim()
  const dirEnvRaw = process.env.EDGE_AGENT_SCANNER_DIR?.trim()
  if (pyEnvRaw && dirEnvRaw) {
    const python = path.resolve(pyEnvRaw)
    const scannerDir = path.resolve(dirEnvRaw)
    const problem = pythonPairProblem(python, scannerDir)
    if (!problem) {
      return {
        available: true,
        source: "python_venv",
        python,
        scannerDir,
        scannerBin: null,
        error: null,
      }
    }
    // Don't silently fall through to /scanner — the user explicitly
    // configured both env vars, so the right behaviour is to surface
    // why their explicit choice didn't work.
    return {
      available: false,
      source: "missing",
      python,
      scannerDir,
      scannerBin: null,
      error: `EDGE_AGENT_PYTHON + EDGE_AGENT_SCANNER_DIR pair unusable: ${problem}`,
    }
  }

  /* -------- (3) <cwd>/scanner/.venv — dev fallback ---------------- */
  // This matches what `pnpm dev` does today: the venv lives next to
  // the scanner source in the repo. We try the obvious python paths
  // for both POSIX and Windows so the health gate works on every
  // platform we ship for. Fall back to system python3 as a last
  // resort so users who installed the scanner globally still pass.
  //
  // The path segments are joined at runtime (Array.join) rather than as
  // inline string literals so Next 16's Turbopack build doesn't treat
  // `scanner/.venv` as a static DirAssetReference and try to bundle it
  // (the venv contains a Homebrew Python symlink that points outside
  // the project root, which makes the build fail).
  const cwdScannerDir = path.join(process.cwd(), "scanner")
  const venvDir = [".", "venv"].join("")
  const posixBin = ["bi", "n"].join("")
  const winBin = ["Scrip", "ts"].join("")
  const pyExe = ["python", ".exe"].join("")
  if (fs.existsSync(cwdScannerDir)) {
    const candidates: string[] = []
    candidates.push(path.join(cwdScannerDir, venvDir, posixBin, "python"))
    candidates.push(path.join(cwdScannerDir, venvDir, posixBin, "python3"))
    candidates.push(
      path.join(cwdScannerDir, venvDir, winBin, pyExe)
    )
    // Honour EDGE_AGENT_PYTHON even when EDGE_AGENT_SCANNER_DIR is
    // missing — this is the standalone-server case where the launcher
    // sets only one of the two.
    if (pyEnvRaw) candidates.unshift(path.resolve(pyEnvRaw))
    for (const python of candidates) {
      if (!fs.existsSync(python)) continue
      const problem = pythonPairProblem(python, cwdScannerDir)
      if (!problem) {
        return {
          available: true,
          source: "python_venv",
          python,
          scannerDir: cwdScannerDir,
          scannerBin: null,
          error: null,
        }
      }
    }
  }

  /* -------- (4) PYTHONPATH — last-resort import probe ------------- */
  const pyPath = process.env.PYTHONPATH?.trim()
  if (pyPath) {
    for (const part of pyPath.split(path.delimiter)) {
      const dir = part.trim()
      if (!dir) continue
      // edge_agent_scanner is the package directory; cli.py is the
      // entry point /api/scan invokes.
      const cli = path.join(dir, "edge_agent_scanner", "cli.py")
      if (fs.existsSync(cli)) {
        return {
          available: true,
          source: "pythonpath",
          // Surface EDGE_AGENT_PYTHON if set; we don't try to
          // discover system python here because that requires a
          // spawn and `which python3` semantics differ per platform.
          python: pyEnvRaw ? path.resolve(pyEnvRaw) : null,
          // `scannerDir` here is the parent that holds the
          // edge_agent_scanner package — the equivalent of
          // <scannerDir>/src in the dev layout.
          scannerDir: path.resolve(dir),
          scannerBin: null,
          error: null,
        }
      }
    }
  }

  /* -------- Nothing matched --------------------------------------- */
  return {
    available: false,
    source: "missing",
    python: pyEnvRaw ? path.resolve(pyEnvRaw) : null,
    scannerDir: dirEnvRaw ? path.resolve(dirEnvRaw) : null,
    scannerBin: null,
    error:
      "Scanner runtime not found. Tried EDGE_AGENT_SCANNER_BIN, " +
      "EDGE_AGENT_PYTHON + EDGE_AGENT_SCANNER_DIR, <cwd>/scanner/.venv, " +
      "and PYTHONPATH — none resolved to a usable scanner.",
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime: derive how this server was launched from EDGE_AGENT_* env vars    */
/* -------------------------------------------------------------------------- */

/**
 * Decide the runtime mode in the order that produces the most specific
 * answer possible. `EDGE_AGENT_MODE` is the canonical source — set by
 * `electron/main.ts` when it spawns the child Next server. If it's
 * missing entirely we fall back to "browser" because that's the only
 * remaining case we ship.
 */
function inferMode(): RuntimeMode {
  const explicit = process.env.EDGE_AGENT_MODE?.trim()
  if (
    explicit === "packaged" ||
    explicit === "electron-dev" ||
    explicit === "electron-prod-unpackaged"
  ) {
    return explicit
  }
  // Fallback heuristic for the (currently unsupported, but possible)
  // future case of a packaged app whose launcher forgot to set
  // EDGE_AGENT_MODE: EDGE_AGENT_DESKTOP=1 with no renderer URL
  // strongly implies electron-prod, with renderer URL set implies dev.
  if (process.env.EDGE_AGENT_DESKTOP === "1") {
    return process.env.ELECTRON_RENDERER_URL?.trim()
      ? "electron-dev"
      : "electron-prod-unpackaged"
  }
  return "browser"
}

function checkRuntime(): RuntimeStatus {
  const nonEmpty = (s: string | undefined): string | null => {
    const v = s?.trim()
    return v && v.length > 0 ? v : null
  }
  return {
    mode: inferMode(),
    appVersion: nonEmpty(process.env.EDGE_AGENT_APP_VERSION),
    appPath: nonEmpty(process.env.EDGE_AGENT_APP_PATH),
    resourcesPath: nonEmpty(process.env.EDGE_AGENT_RESOURCES_PATH),
    userDataPath: nonEmpty(process.env.EDGE_AGENT_USER_DATA_PATH),
    cwd: process.cwd(),
    electronVersion: nonEmpty(process.env.EDGE_AGENT_ELECTRON_VERSION),
    chromeVersion: nonEmpty(process.env.EDGE_AGENT_CHROME_VERSION),
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }
}

/* -------------------------------------------------------------------------- */
/* Logs: enumerate the contents of EDGE_AGENT_LOG_DIR                         */
/* -------------------------------------------------------------------------- */

function checkLogs(): LogsStatus {
  const dirRaw = process.env.EDGE_AGENT_LOG_DIR?.trim()
  if (!dirRaw) {
    return { dir: null, files: [] }
  }
  const dir = path.resolve(dirRaw)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    // Directory doesn't exist yet (first launch before openLogStreams
    // ran) or we lack read permission. Surface the configured path so
    // the user can still open it manually.
    return { dir, files: [] }
  }
  const files: LogsStatus["files"] = []
  for (const name of entries) {
    if (!/\.(log|txt)$/i.test(name)) continue
    try {
      const st = fs.statSync(path.join(dir, name))
      if (!st.isFile()) continue
      files.push({
        name,
        size: st.size,
        mtime: st.mtime.toISOString(),
      })
    } catch {
      // Ignore individual file errors; the directory listing is still
      // useful even if one entry is stat-failing (e.g. mid-rotation).
    }
  }
  // Sort by mtime descending so the freshest log shows first — that's
  // what the user usually wants to inspect.
  files.sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""))
  return { dir, files }
}

/* -------------------------------------------------------------------------- */
/* Route entry                                                                */
/* -------------------------------------------------------------------------- */

export async function GET() {
  // Every check is spawnSync-based, so wrapping them in Promise.all
  // wouldn't actually parallelise. Run sequentially in the cheapest
  // order: runtime (env reads only), git (fast), scanner (filesystem
  // only), logs (filesystem only), gh (can take seconds when the auth
  // probe hits the network).
  const runtime = checkRuntime()
  const git = checkGit()
  const scanner = checkScanner()
  const logs = checkLogs()
  const gh = checkGh()
  // Reserve the `os` import for future per-route diagnostics (tmpdir,
  // free memory, etc.); silence the lint warning meanwhile.
  void os
  const body: HealthResponse = { runtime, git, gh, scanner, logs }
  return NextResponse.json(body, {
    headers: {
      // Don't let a stale "everything OK" response stick around in
      // any intermediary cache — the whole point of the gate is to
      // reflect *current* machine state.
      "Cache-Control": "no-store, max-age=0, must-revalidate",
    },
  })
}
