import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Async helper that spawns the Python scanner against `targetPath` and
 * returns the parsed report. Used by /api/git/commit and /api/git/push so
 * those routes can gate the git operation on critical/high findings.
 *
 * Mirrors the spawn shape used by /api/scan and /api/git/compare-scan:
 *   - python path overridable via EDGE_AGENT_PYTHON
 *   - PYTHONPATH points at scanner/src so the package import works without
 *     install
 *   - hard timeout (default 120s) so a runaway scan can't hang the request
 *   - tmp output file is always cleaned up
 */

export type ScanFindingLite = {
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  title: string
  file: string
  line: number
}

export type ScanReportLite = {
  schema_version?: string
  scan_root?: string
  generated_at?: string
  risk_score: number
  summary: {
    critical: number
    high: number
    medium: number
    low: number
    total: number
  }
  findings: ScanFindingLite[]
}

export class ScannerError extends Error {
  status: number
  stderr: string
  constructor(message: string, status = 500, stderr = "") {
    super(message)
    this.status = status
    this.stderr = stderr
  }
}

function safeUnlink(p: string): void {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {
    /* ignore */
  }
}

/**
 * Resolve the directory that contains the Python scanner source tree
 * (the parent of `src/edge_agent_scanner/`).
 *
 * Priority:
 *   1. `EDGE_AGENT_SCANNER_DIR` — explicit override. Used by the desktop
 *      launcher (Electron) where `process.cwd()` is unpredictable, and
 *      by anyone running the standalone Next server (which `chdir`s into
 *      `.next/standalone/` on startup — see `.next/standalone/server.js`).
 *   2. `<process.cwd()>/scanner` — the repo layout when running
 *      `pnpm dev` or invoking the API from the project root.
 *
 * Throws `ScannerError` (status 500) with a precise reason when no
 * usable directory exists, so the caller can surface it without
 * a generic "scanner not found".
 *
 * NOTE: only called on the Python branches of `buildScannerCommand`.
 * When `EDGE_AGENT_SCANNER_BIN` is set the bundled binary is fully
 * self-contained and we never need the source tree at all.
 */
export function resolveScannerDir(): string {
  const override = process.env.EDGE_AGENT_SCANNER_DIR?.trim()
  if (override) {
    const resolved = path.resolve(override)
    if (!fs.existsSync(resolved)) {
      throw new ScannerError(
        `EDGE_AGENT_SCANNER_DIR points to a missing path: ${resolved}`,
        500
      )
    }
    const pkg = path.join(resolved, "src", "edge_agent_scanner")
    if (!fs.existsSync(pkg)) {
      throw new ScannerError(
        `EDGE_AGENT_SCANNER_DIR is missing src/edge_agent_scanner: ${resolved}`,
        500
      )
    }
    return resolved
  }
  const fallback = path.join(process.cwd(), "scanner")
  if (!fs.existsSync(fallback)) {
    throw new ScannerError("scanner package not found under project root", 500)
  }
  return fallback
}

/* -------------------------------------------------------------------------- */
/* buildScannerCommand — single source of truth for "how do we invoke the     */
/* scanner?". Every API route + script that runs a scan goes through here so  */
/* the three resolution branches stay in lockstep.                            */
/* -------------------------------------------------------------------------- */

/**
 * Where this scanner invocation came from. Mirrors the values returned
 * by `/api/system/health` (minus `pythonpath` which is a probe-only
 * source; we never spawn against it directly).
 */
export type ScannerSource = "scanner_bin" | "python_venv" | "python_fallback"

/**
 * Spawn-ready scanner invocation. `cmd` + `args` go straight into
 * `spawn()` / `spawnSync()`; never join into a shell string.
 *
 * The metadata fields (`source`, `scannerBin`, `python`, `scannerDir`)
 * exist so the caller can attribute "scanner failed" errors back to
 * the right thing (binary vs venv vs fallback) without re-deriving the
 * resolution.
 */
export type ScannerCommand = {
  cmd: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  source: ScannerSource
  scannerBin: string | null
  python: string | null
  scannerDir: string | null
}

/**
 * Build the `spawn` shape for one scanner invocation. Resolution order:
 *
 *   A. `EDGE_AGENT_SCANNER_BIN` — bundled PyInstaller binary.
 *      - Validated to exist; on POSIX, validated executable (X_OK).
 *      - Invoked directly as `<bin> scan <projectPath> --out <tmpReport> ...`
 *      - PYTHONPATH is NOT injected — the binary is self-contained and
 *        a stray PYTHONPATH from the user's shell could shadow its
 *        bundled modules.
 *   B. `EDGE_AGENT_PYTHON` set — explicit venv path.
 *      - Validated to exist.
 *      - `EDGE_AGENT_SCANNER_DIR` is honoured if set (via
 *        `resolveScannerDir`); otherwise falls back to `<cwd>/scanner`.
 *      - cwd = scannerDir; PYTHONPATH = `<scannerDir>/src` prepended
 *        onto any existing PYTHONPATH so user-set imports still work.
 *   C. Fallback — no env vars set.
 *      - `<cwd>/scanner/.venv/bin/python` if present (matches `pnpm dev`).
 *      - Else `python3` (the user must have the scanner installed via
 *        their system Python).
 *      - scannerDir = `<cwd>/scanner`; PYTHONPATH same shape as B.
 *
 * Throws `ScannerError` (status 500) with a precise reason when an
 * explicit override doesn't resolve. Throwing — rather than silently
 * falling through — is deliberate: if the user set EDGE_AGENT_SCANNER_BIN
 * and got the path wrong, they want to know, not get a "scanner not
 * found in /scanner" error fifty lines later.
 */
export function buildScannerCommand(opts: {
  targetPath: string
  outFile: string
  checks?: string[]
  excludes?: string[]
}): ScannerCommand {
  const buildArgs = (header: string[]): string[] => {
    const args = [...header, opts.targetPath, "--out", opts.outFile]
    for (const c of opts.checks ?? []) {
      if (typeof c === "string" && c.length > 0) args.push("--check", c)
    }
    for (const e of opts.excludes ?? []) {
      if (typeof e === "string" && e.length > 0) args.push("--exclude", e)
    }
    return args
  }

  /* ---------- A. EDGE_AGENT_SCANNER_BIN ---------- */
  const binEnv = process.env.EDGE_AGENT_SCANNER_BIN?.trim()
  if (binEnv) {
    const bin = path.resolve(binEnv)
    if (!fs.existsSync(bin)) {
      throw new ScannerError(
        `EDGE_AGENT_SCANNER_BIN points to a missing file: ${bin}`,
        500
      )
    }
    try {
      if (!fs.statSync(bin).isFile()) {
        throw new ScannerError(
          `EDGE_AGENT_SCANNER_BIN is not a file: ${bin}`,
          500
        )
      }
    } catch (err) {
      if (err instanceof ScannerError) throw err
      throw new ScannerError(
        `EDGE_AGENT_SCANNER_BIN stat failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        500
      )
    }
    if (process.platform !== "win32") {
      try {
        fs.accessSync(bin, fs.constants.X_OK)
      } catch {
        throw new ScannerError(
          `EDGE_AGENT_SCANNER_BIN is not executable: ${bin} (try: chmod +x "${bin}")`,
          500
        )
      }
    }
    return {
      cmd: bin,
      args: buildArgs(["scan"]),
      env: process.env,
      cwd: path.dirname(bin),
      source: "scanner_bin",
      scannerBin: bin,
      python: null,
      scannerDir: null,
    }
  }

  /* ---------- B. EDGE_AGENT_PYTHON ---------- */
  const pyEnv = process.env.EDGE_AGENT_PYTHON?.trim()
  if (pyEnv) {
    const python = path.resolve(pyEnv)
    if (!fs.existsSync(python)) {
      throw new ScannerError(
        `EDGE_AGENT_PYTHON points to a missing file: ${python}`,
        500
      )
    }
    // `resolveScannerDir` already prefers EDGE_AGENT_SCANNER_DIR over
    // <cwd>/scanner — we just inherit its behaviour here so the two
    // env-var pairs compose.
    const scannerDir = resolveScannerDir()
    return {
      cmd: python,
      args: buildArgs(["-m", "edge_agent_scanner.cli", "scan"]),
      env: buildPythonEnv(scannerDir),
      cwd: scannerDir,
      source: "python_venv",
      scannerBin: null,
      python,
      scannerDir,
    }
  }

  /* ---------- C. Dev fallback ---------- */
  const scannerDir = resolveScannerDir() // <cwd>/scanner (throws if missing)
  // The path segments are assembled at runtime (Array.join / concat)
  // rather than as inline string literals so that Next 16's Turbopack
  // build doesn't see `.venv` as a static DirAssetReference and try to
  // bundle `scanner/.venv/` (which contains a Homebrew Python symlink
  // pointing outside the project root, causing the build to fail).
  const venvDir = [".", "venv"].join("")
  const isWin = process.platform === "win32"
  const binDir = isWin ? ["Scrip", "ts"].join("") : ["bi", "n"].join("")
  const pyName = isWin ? ["python", ".exe"].join("") : ["py", "thon"].join("")
  const venvPython = path.join(scannerDir, venvDir, binDir, pyName)
  const python = fs.existsSync(venvPython) ? venvPython : "python3"
  return {
    cmd: python,
    args: buildArgs(["-m", "edge_agent_scanner.cli", "scan"]),
    env: buildPythonEnv(scannerDir),
    cwd: scannerDir,
    source: "python_fallback",
    scannerBin: null,
    python,
    scannerDir,
  }
}

/**
 * Compose the env for the python branches: prepend `<scannerDir>/src`
 * onto any existing PYTHONPATH so a user who's already set PYTHONPATH
 * (eg. to develop a sibling agent library against the running app)
 * keeps that on the search path AFTER our scanner package.
 */
function buildPythonEnv(scannerDir: string): NodeJS.ProcessEnv {
  const existing = process.env.PYTHONPATH ?? ""
  const ours = path.join(scannerDir, "src")
  const pythonPath = existing
    ? `${ours}${path.delimiter}${existing}`
    : ours
  return { ...process.env, PYTHONPATH: pythonPath }
}

export function runScannerOn(
  targetPath: string,
  opts: { timeoutMs?: number; checks?: string[] } = {}
): Promise<ScanReportLite> {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(
      os.tmpdir(),
      `edge-pre-op-scan-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.json`
    )
    let cmd: ScannerCommand
    try {
      cmd = buildScannerCommand({
        targetPath,
        outFile: tmpFile,
        checks: opts.checks,
      })
    } catch (err) {
      reject(err)
      return
    }
    const proc = spawn(cmd.cmd, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      // We never read stdout — the scanner just prints "Wrote ..." and the
      // real payload goes to `tmpFile`. Stderr is captured for diagnostics.
      stdio: ["ignore", "ignore", "pipe"],
    })

    let stderr = ""
    proc.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString()
    })

    const timeoutMs = opts.timeoutMs ?? 120_000
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
    }, timeoutMs)

    proc.on("error", (err) => {
      clearTimeout(timer)
      safeUnlink(tmpFile)
      reject(new ScannerError(`Failed to spawn scanner: ${err.message}`, 500))
    })

    proc.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        safeUnlink(tmpFile)
        reject(
          new ScannerError(
            "Scanner process failed",
            500,
            stderr.slice(0, 2000)
          )
        )
        return
      }
      try {
        const raw = fs.readFileSync(tmpFile, "utf-8")
        const json = JSON.parse(raw) as ScanReportLite
        resolve(json)
      } catch (e) {
        reject(
          new ScannerError(
            `Failed to read scanner output: ${
              e instanceof Error ? e.message : String(e)
            }`,
            500
          )
        )
      } finally {
        safeUnlink(tmpFile)
      }
    })
  })
}
