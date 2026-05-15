#!/usr/bin/env node
/**
 * app:preview — boot the production standalone server + Electron together.
 *
 * The point of this script is to give a one-command, dev-mode-free preview
 * of the desktop app. It runs the precompiled Next.js standalone server
 * (no JIT compile on first hit) and points Electron at it, so the user
 * experiences real production latency without having to remember two
 * terminals' worth of env vars.
 *
 * It is NOT the eventual packaged-app launcher (that arrives in Step 5 via
 * electron-builder, where Electron will internally spawn the standalone
 * server as a hidden child). It IS the closest reliable simulation today.
 *
 * What the script does, in order:
 *   1. Load .env.local from the repo root (the standalone server does NOT
 *      auto-read it at runtime — `next build` only inlines NEXT_PUBLIC_*
 *      vars). Existing process.env wins over .env.local.
 *   2. Fill in defaults so the script works out-of-the-box on a fresh clone:
 *        PORT                      = 3100  (3000 is for `pnpm dev`)
 *        HOSTNAME                  = 127.0.0.1  (loopback, never expose
 *                                                a dev server on a LAN)
 *        EDGE_AGENT_PYTHON         = <repo>/scanner/.venv/bin/python  (if present)
 *        EDGE_AGENT_SCANNER_DIR    = <repo>/scanner
 *        EDGE_AGENT_SCAN_ALLOWLIST = $HOME  (matches dev fallback in
 *                                            lib/server-path-utils.ts)
 *        ELECTRON_RENDERER_URL     = http://${HOSTNAME}:${PORT}
 *        EDGE_AGENT_DESKTOP        = 1
 *   3. Preflight: refuse to start if .next/standalone/server.js or
 *      electron/dist/main.js are missing; print the exact command the user
 *      should run instead of a cryptic spawn failure.
 *   4. Spawn the standalone server. Forward its stdout/stderr line-prefixed
 *      with `[srv]` (blue when stdout is a TTY).
 *   5. Poll TCP on the target port until either it accepts a connection
 *      (== server ready) or a 30s timeout elapses.
 *   6. Spawn Electron pointed at the server. Forward stdout/stderr with
 *      `[elec]` prefix.
 *   7. Hook SIGINT/SIGTERM/exit so Ctrl+C kills the server and Electron
 *      cleanly — no orphaned node-on-3100 next time the user runs this.
 *
 * Designed to be readable. ~250 LOC of plain Node, no deps.
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, "..")

const ANSI_BLUE = "\u001b[34m"
const ANSI_GREEN = "\u001b[32m"
const ANSI_YELLOW = "\u001b[33m"
const ANSI_RED = "\u001b[31m"
const ANSI_DIM = "\u001b[2m"
const ANSI_RESET = "\u001b[0m"
const USE_COLOR = process.stdout.isTTY

function paint(color, s) {
  return USE_COLOR ? `${color}${s}${ANSI_RESET}` : s
}

function logHeader(msg) {
  console.log(paint(ANSI_DIM, `╭── ${msg}`))
}

function logInfo(label, msg) {
  console.log(`${paint(ANSI_DIM, "│")} ${label}  ${msg}`)
}

function logWarn(msg) {
  console.warn(paint(ANSI_YELLOW, `! ${msg}`))
}

function logError(msg) {
  console.error(paint(ANSI_RED, `✖ ${msg}`))
}

/* -------------------------------------------------------------------------- */
/* .env.local loader                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal `.env.local` parser. Honest to the subset we actually use here:
 *   - `KEY=value` (no spaces around =, but trimmed)
 *   - quoted values: `KEY="value with spaces"` (single or double)
 *   - comments: lines starting with `#`
 *   - blank lines: ignored
 *
 * Does NOT support multi-line values, variable expansion, `export `
 * prefixes, or escape sequences inside quotes. If the project needs those
 * later, swap to `dotenv`. For now we keep zero deps.
 */
function loadEnvLocal() {
  const envPath = path.join(ROOT, ".env.local")
  if (!fs.existsSync(envPath)) return { loaded: 0, missing: true }

  let loaded = 0
  const text = fs.readFileSync(envPath, "utf8")
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    // Strip matching single or double quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    // First-set-wins so a shell-exported override beats .env.local.
    if (!(key in process.env)) {
      process.env[key] = value
      loaded += 1
    }
  }
  return { loaded, missing: false }
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

function applyDefaults() {
  if (!process.env.PORT) process.env.PORT = "3100"
  if (!process.env.HOSTNAME) process.env.HOSTNAME = "127.0.0.1"

  if (!process.env.EDGE_AGENT_PYTHON) {
    const candidate = path.join(ROOT, "scanner", ".venv", "bin", "python")
    if (fs.existsSync(candidate)) {
      process.env.EDGE_AGENT_PYTHON = candidate
    } else {
      // Final fallback so the server can at least start; scans will fail
      // until the user creates the venv. We surface a clear warning.
      logWarn(
        "scanner/.venv/bin/python not found — scans will fail until you create the venv or set EDGE_AGENT_PYTHON."
      )
    }
  }

  if (!process.env.EDGE_AGENT_SCANNER_DIR) {
    process.env.EDGE_AGENT_SCANNER_DIR = path.join(ROOT, "scanner")
  }

  if (!process.env.EDGE_AGENT_SCAN_ALLOWLIST) {
    process.env.EDGE_AGENT_SCAN_ALLOWLIST = os.homedir()
  }

  // Renderer URL must point at the loopback server we're about to spawn.
  // Always overwrite this — the dev URL (3000) would be wrong here.
  process.env.ELECTRON_RENDERER_URL = `http://${process.env.HOSTNAME}:${process.env.PORT}`

  // Hint flag for the renderer / main process (mirrors `dev:electron`).
  process.env.EDGE_AGENT_DESKTOP = "1"
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

function preflightOrExit() {
  const serverEntry = path.join(ROOT, ".next", "standalone", "server.js")
  const electronEntry = path.join(ROOT, "electron", "dist", "main.js")

  const missing = []
  if (!fs.existsSync(serverEntry)) missing.push(".next/standalone/server.js")
  if (!fs.existsSync(electronEntry)) missing.push("electron/dist/main.js")

  if (missing.length === 0) return { serverEntry, electronEntry }

  logError("Missing build artifacts:")
  for (const m of missing) console.error(`    ${m}`)
  console.error("")
  console.error("Run one of these first, then re-run `pnpm app:start`:")
  console.error("    pnpm app:build            # builds both web + electron")
  console.error("    pnpm app:preview          # builds and runs in one step")
  process.exit(1)
}

/* -------------------------------------------------------------------------- */
/* TCP readiness probe                                                        */
/* -------------------------------------------------------------------------- */

function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(750, () => done(false))
  })
}

async function waitForServer(host, port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    if (await checkPort(host, port)) return true
    attempt += 1
    if (attempt % 8 === 0) {
      logInfo(
        paint(ANSI_DIM, "···"),
        `still waiting for ${host}:${port} (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`
      )
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* Child-process orchestration                                                */
/* -------------------------------------------------------------------------- */

/**
 * Spawn a child and pipe its output back with a `[label]` prefix per line.
 * Returns the ChildProcess.
 */
function spawnLabeled(label, color, command, args, opts = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    cwd: opts.cwd ?? ROOT,
  })
  const prefix = paint(color, `[${label}]`) + " "

  const pipe = (stream, dest) => {
    let leftover = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      const data = leftover + chunk
      const lines = data.split(/\r?\n/)
      leftover = lines.pop() ?? ""
      for (const line of lines) dest.write(prefix + line + "\n")
    })
    stream.on("end", () => {
      if (leftover) dest.write(prefix + leftover + "\n")
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  return child
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  logHeader("Edge Agent AI — production preview")

  const envState = loadEnvLocal()
  applyDefaults()

  if (envState.missing) {
    logInfo(paint(ANSI_DIM, "env"), ".env.local not found — using defaults only")
  } else {
    logInfo(
      paint(ANSI_DIM, "env"),
      `loaded ${envState.loaded} key${envState.loaded === 1 ? "" : "s"} from .env.local`
    )
  }
  logInfo(paint(ANSI_DIM, "url"), process.env.ELECTRON_RENDERER_URL)
  logInfo(paint(ANSI_DIM, "py "), process.env.EDGE_AGENT_PYTHON ?? "(unset — scans will fail)")
  logInfo(paint(ANSI_DIM, "dir"), process.env.EDGE_AGENT_SCANNER_DIR)
  logInfo(paint(ANSI_DIM, "ok "), process.env.EDGE_AGENT_SCAN_ALLOWLIST)

  const { serverEntry, electronEntry } = preflightOrExit()

  // Forward-declare so the closures below capture stable bindings.
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let server
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let electron
  let shuttingDown = false

  // Kills both children. Escalates SIGTERM → SIGKILL after a grace window
  // because Electron can sometimes ignore SIGTERM when DevTools is in a
  // bad state. Idempotent.
  async function shutdown(exitCode) {
    if (shuttingDown) return
    shuttingDown = true
    for (const child of [electron, server]) {
      if (!child || child.exitCode !== null) continue
      try { child.kill("SIGTERM") } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 800))
    for (const child of [electron, server]) {
      if (!child || child.exitCode !== null) continue
      try { child.kill("SIGKILL") } catch { /* ignore */ }
    }
    process.exit(exitCode)
  }

  process.on("SIGINT", () => shutdown(0))
  process.on("SIGTERM", () => shutdown(0))

  // -- spawn standalone server -----------------------------------------------
  logInfo(paint(ANSI_DIM, "→  "), "starting standalone server…")
  server = spawnLabeled("srv", ANSI_BLUE, process.execPath, [serverEntry])

  let serverExited = false
  server.on("exit", (code, signal) => {
    serverExited = true
    if (!shuttingDown) {
      logError(
        `standalone server exited unexpectedly (code=${code}, signal=${signal ?? "-"})`
      )
      void shutdown(1)
    }
  })

  // -- wait for it to be reachable -------------------------------------------
  const host = process.env.HOSTNAME
  const port = Number(process.env.PORT)
  const ready = await waitForServer(host, port)
  if (!ready) {
    logError(`server did not become reachable on ${host}:${port} within 30s`)
    void shutdown(1)
    return
  }
  if (serverExited) return // shutdown already in flight
  logInfo(paint(ANSI_DIM, "✓  "), "server ready, launching Electron")

  // -- spawn Electron --------------------------------------------------------
  const electronBin = path.join(ROOT, "node_modules", ".bin", "electron")
  if (!fs.existsSync(electronBin)) {
    logError(
      `electron binary not found at ${electronBin} — run \`pnpm install\` (electron is in pnpm.onlyBuiltDependencies)`
    )
    void shutdown(1)
    return
  }
  electron = spawnLabeled("elec", ANSI_GREEN, electronBin, [electronEntry])

  electron.on("exit", (code, signal) => {
    // User closed the Electron window → tear down the server too.
    if (!shuttingDown) {
      logInfo(
        paint(ANSI_DIM, "·  "),
        `Electron exited (code=${code}, signal=${signal ?? "-"}) — stopping server`
      )
      void shutdown(code ?? 0)
    }
  })
}

main().catch((err) => {
  logError(`fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
