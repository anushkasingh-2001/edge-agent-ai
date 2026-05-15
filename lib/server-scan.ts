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

export function runScannerOn(
  targetPath: string,
  opts: { timeoutMs?: number; checks?: string[] } = {}
): Promise<ScanReportLite> {
  return new Promise((resolve, reject) => {
    let scannerDir: string
    try {
      scannerDir = resolveScannerDir()
    } catch (err) {
      reject(err)
      return
    }
    const tmpFile = path.join(
      os.tmpdir(),
      `edge-pre-op-scan-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.json`
    )
    const python = process.env.EDGE_AGENT_PYTHON || "python3"
    const args = [
      "-m",
      "edge_agent_scanner.cli",
      "scan",
      targetPath,
      "--out",
      tmpFile,
    ]
    for (const c of opts.checks ?? []) {
      if (typeof c === "string" && c.length > 0) {
        args.push("--check", c)
      }
    }
    const env = {
      ...process.env,
      PYTHONPATH: path.join(scannerDir, "src"),
    }
    const proc = spawn(python, args, {
      cwd: scannerDir,
      env,
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
