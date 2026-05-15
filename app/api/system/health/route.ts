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
import * as path from "node:path"
import { NextResponse } from "next/server"
import { runGh } from "@/lib/server-github"

export const dynamic = "force-dynamic"

/** Hard cap on any individual subprocess so a slow/hung `gh auth
 *  status` (e.g. behind a corp proxy) can't pin the health route
 *  forever. `gh` already has its own 10s cap via runGh — this is the
 *  cap for the git probe and any future subprocesses. */
const COMMAND_TIMEOUT_MS = 10_000

type GitStatus = {
  installed: boolean
  version: string | null
  error: string | null
}

type GhStatus = {
  installed: boolean
  version: string | null
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

type HealthResponse = {
  git: GitStatus
  gh: GhStatus
  scanner: ScannerStatus
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
      error: e instanceof Error ? e.message : String(e),
    }
  }
  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        installed: false,
        version: null,
        error: "git executable not found on PATH",
      }
    }
    return {
      installed: false,
      version: null,
      error: proc.error.message,
    }
  }
  if (proc.status !== 0) {
    return {
      installed: false,
      version: null,
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
      authenticated: null,
      login: null,
      error: ver.stderr.trim() || "gh executable not found on PATH",
    }
  }
  if (ver.status !== 0) {
    return {
      installed: false,
      version: null,
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
      authenticated: false,
      login: null,
      error: "gh disappeared between subprocess calls",
    }
  }
  if (auth.status !== 0) {
    return {
      installed: true,
      version,
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
      authenticated: false,
      login: null,
      error: user.stderr.trim() || null,
    }
  }
  const login = user.stdout.trim()
  return {
    installed: true,
    version,
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
  const cwdScannerDir = path.join(process.cwd(), "scanner")
  if (fs.existsSync(cwdScannerDir)) {
    const candidates: string[] = []
    candidates.push(path.join(cwdScannerDir, ".venv", "bin", "python"))
    candidates.push(path.join(cwdScannerDir, ".venv", "bin", "python3"))
    candidates.push(
      path.join(cwdScannerDir, ".venv", "Scripts", "python.exe")
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
/* Route entry                                                                */
/* -------------------------------------------------------------------------- */

export async function GET() {
  // Every check is spawnSync-based, so wrapping them in Promise.all
  // wouldn't actually parallelise. Run sequentially in the cheapest
  // order: git (fast), scanner (filesystem only), gh (can take
  // seconds when the auth probe hits the network).
  const git = checkGit()
  const scanner = checkScanner()
  const gh = checkGh()
  const body: HealthResponse = { git, gh, scanner }
  return NextResponse.json(body, {
    headers: {
      // Don't let a stale "everything OK" response stick around in
      // any intermediary cache — the whole point of the gate is to
      // reflect *current* machine state.
      "Cache-Control": "no-store, max-age=0, must-revalidate",
    },
  })
}
