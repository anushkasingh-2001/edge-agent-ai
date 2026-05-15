/**
 * Edge Agent AI — Electron main process.
 *
 * Two boot modes, decided at startup:
 *
 *   1. DEVELOPMENT — `ELECTRON_RENDERER_URL` is set (e.g. by
 *      `pnpm dev:electron`). The main process trusts that URL is
 *      already serving the Next.js app (Turbopack dev server on
 *      :3000) and just loads it into the BrowserWindow.
 *
 *   2. PRODUCTION — `ELECTRON_RENDERER_URL` is NOT set. The main
 *      process spawns `.next/standalone/server.js` as an internal
 *      child (Electron-as-Node via `ELECTRON_RUN_AS_NODE=1`), picks
 *      a free loopback port, waits for it to accept connections, and
 *      then loads `http://127.0.0.1:<port>` into the BrowserWindow.
 *      This is the same code path the packaged desktop app will use
 *      — Step 7 (electron-builder) just bolts on a `.app`/`.exe`
 *      wrapper around this exact runtime shape.
 *
 * Cross-cutting concerns kept from Step 2/3:
 *   - App name "Edge Agent AI" (macOS About panel + dock label).
 *   - BrowserWindow webPreferences locked down: contextIsolation:true,
 *     nodeIntegration:false, sandbox:true, devTools only in dev.
 *   - Native folder picker IPC (`edge-agent-ai:select-folder`)
 *     constrained to the user's home directory by default, overridable
 *     via `EDGE_AGENT_SCAN_ALLOWLIST` (matches `lib/server-path-utils.ts`).
 *   - All `window.open` / external links open in the user's default
 *     browser via `shell.openExternal`. In-window navigation away
 *     from the app's own origin is blocked.
 *
 * Intentionally NOT done yet (later steps):
 *   - electron-builder packaging + dmg/exe/AppImage outputs (Step 7).
 *   - Auto-updater, code signing, notarisation.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

/* -------------------------------------------------------------------------- */
/* Mode decision + constants                                                  */
/* -------------------------------------------------------------------------- */

// Renderer URL provided by `dev:electron` (e.g. http://localhost:3000).
// When unset we boot the standalone server ourselves.
const RENDERER_URL_ENV =
  process.env.ELECTRON_RENDERER_URL?.trim() || null

const IS_PRODUCTION_BOOT = !RENDERER_URL_ENV

// DevTools availability mirrors the boot mode. We don't tie it to
// NODE_ENV because the dev:electron script never sets that explicitly,
// and a packaged app would never set ELECTRON_RENDERER_URL.
const IS_DEV = !IS_PRODUCTION_BOOT

app.setName("Edge Agent AI")

// macOS dock label + About panel — keep the headline as our app name
// instead of "Electron 42.0.1".
if (process.platform === "darwin") {
  app.setAboutPanelOptions({
    applicationName: "Edge Agent AI",
    applicationVersion: app.getVersion(),
    copyright: "© Edge Agent AI",
  })
}

let mainWindow: BrowserWindow | null = null
let serverProcess: ChildProcess | null = null
let resolvedRendererUrl: string | null = null

/* -------------------------------------------------------------------------- */
/* Path-safety helpers (mirror lib/server-path-utils.ts)                      */
/* -------------------------------------------------------------------------- */

function expandUser(input: string): string {
  const trimmed = input.trim()
  if (trimmed === "~") return os.homedir()
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return trimmed
}

function getAllowRoot(): string {
  const raw = process.env.EDGE_AGENT_SCAN_ALLOWLIST?.trim()
  if (raw) return path.resolve(expandUser(raw))
  // In production we still default to home; the standalone server
  // child gets the same default via env (see startStandaloneServer).
  return os.homedir()
}

const PLATFORM_CASE_INSENSITIVE =
  process.platform === "darwin" || process.platform === "win32"

function tryRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

function isPathInside(child: string, parent: string): boolean {
  const cReal = tryRealpath(child)
  const pReal = tryRealpath(parent)
  const direct = path.relative(pReal, cReal)
  if (direct === "" || (!direct.startsWith("..") && !path.isAbsolute(direct))) {
    return true
  }
  if (PLATFORM_CASE_INSENSITIVE) {
    const ci = path.relative(pReal.toLowerCase(), cReal.toLowerCase())
    return ci === "" || (!ci.startsWith("..") && !path.isAbsolute(ci))
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* Production-boot helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Find `.next/standalone/server.js`. Returns null when nothing
 * exists at any candidate path. The candidate list is ordered from
 * "running from the dev tree" to "running from a packaged app", so
 * Step 7's electron-builder layout slots in without code changes.
 *
 *   - <repo>/.next/standalone/server.js                  (dev)
 *   - <process.resourcesPath>/standalone/server.js       (packaged)
 *
 * `__dirname` at runtime is `<repo>/electron/dist/` in dev and
 * `…/Contents/Resources/app/electron/dist/` (or similar) inside an
 * asar — both yield the dev path when packaged isn't a match, which
 * is harmless because the packaged path takes precedence.
 */
function findStandaloneServerJs(): string | null {
  const candidates: string[] = []
  // Packaged: extraResources puts `.next/standalone/` under
  // process.resourcesPath/standalone/. Step 7 will wire this in
  // electron-builder.yml. The check exists today so the same main.ts
  // works both unpackaged-and-packaged.
  if (
    typeof process.resourcesPath === "string" &&
    process.resourcesPath.length > 0
  ) {
    candidates.push(
      path.join(process.resourcesPath, "standalone", "server.js")
    )
  }
  // Dev: electron/dist/main.js → ../../.next/standalone/server.js
  candidates.push(
    path.resolve(__dirname, "..", "..", ".next", "standalone", "server.js")
  )
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * Find the bundled PyInstaller scanner binary for the current host.
 * Returns null when nothing exists. Order:
 *
 *   - <process.resourcesPath>/scanner-bin/edge-agent-scanner[.exe]
 *     (packaged: electron-builder strips the per-platform folder
 *     because only one slot is shipped per host. Step 7.)
 *   - <repo>/electron/resources/scanner-bin/<plat>-<arch>/edge-agent-scanner[.exe]
 *     (dev: matches what `pnpm build:scanner` produces.)
 *
 * Never throws — a missing binary just means the app falls back to
 * the Python venv path (see lib/server-scan.ts:buildScannerCommand)
 * and /api/system/health surfaces the situation.
 */
function findScannerBin(): string | null {
  const binName =
    process.platform === "win32"
      ? "edge-agent-scanner.exe"
      : "edge-agent-scanner"
  const candidates: string[] = []
  if (
    typeof process.resourcesPath === "string" &&
    process.resourcesPath.length > 0
  ) {
    candidates.push(
      path.join(process.resourcesPath, "scanner-bin", binName)
    )
  }
  const platKey = `${process.platform}-${process.arch}`
  candidates.push(
    path.resolve(
      __dirname,
      "..",
      "resources",
      "scanner-bin",
      platKey,
      binName
    )
  )
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * Allocate a free loopback port. We bind a `net.createServer` to
 * port 0, read the OS-assigned port, and close immediately. Cheap
 * and atomic enough for a single startup — we don't try to defend
 * against a race where the same port gets stolen between close
 * and `spawn`; on a desktop, that race window is microseconds and
 * the worst case is one retry on EADDRINUSE which Next surfaces
 * with a clear error.
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (typeof addr === "object" && addr) {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error("Could not determine a free port"))
      }
    })
  })
}

/**
 * Poll a TCP port until it accepts a connection, or `timeoutMs`
 * elapses. Returns nothing on success; throws on timeout so the
 * caller can surface a dialog. Polling interval is 200ms — cheap
 * because we're talking loopback.
 */
async function waitForPort(
  host: string,
  port: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host, port })
      sock.once("connect", () => {
        sock.end()
        resolve(true)
      })
      sock.once("error", () => resolve(false))
      sock.setTimeout(1500, () => {
        sock.destroy()
        resolve(false)
      })
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(
    `Standalone server did not accept connections on ${host}:${port} within ${timeoutMs}ms`
  )
}

/**
 * Spawn the Next.js standalone server as a child of this Electron
 * process and return the URL to load. Throws on any failure that
 * makes a load impossible (missing server.js, port pick failure,
 * spawn ENOENT, ready-timeout).
 *
 * We use `process.execPath` (the Electron binary) with
 * `ELECTRON_RUN_AS_NODE=1` so the spawned process behaves as Node.
 * That avoids depending on `node` being on PATH, which can't be
 * relied on inside a packaged `.app` / `.exe`.
 */
async function startStandaloneServer(): Promise<string> {
  const serverJs = findStandaloneServerJs()
  if (!serverJs) {
    throw new Error(
      "Could not find .next/standalone/server.js. " +
        "Run `pnpm build:standalone` first (or the equivalent `pnpm build`)."
    )
  }

  const port = await pickFreePort()
  const hostname = "127.0.0.1"

  // Compose the child env. EDGE_AGENT_SCANNER_BIN is preserved
  // when the user set it explicitly (e.g. via the start:electron-prod
  // script) — otherwise we try to auto-resolve a bundled binary.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOSTNAME: hostname,
    EDGE_AGENT_DESKTOP: "1",
    EDGE_AGENT_SCAN_ALLOWLIST:
      process.env.EDGE_AGENT_SCAN_ALLOWLIST?.trim() || os.homedir(),
  }
  if (!childEnv.EDGE_AGENT_SCANNER_BIN) {
    const auto = findScannerBin()
    if (auto) {
      childEnv.EDGE_AGENT_SCANNER_BIN = auto
      console.log(`[main] auto-resolved EDGE_AGENT_SCANNER_BIN=${auto}`)
    } else {
      // Non-fatal: the app starts, /api/system/health flags the missing
      // scanner, the user can still see / configure the rest of the
      // app. We don't fall back to EDGE_AGENT_PYTHON here — the
      // server's own resolver (lib/server-scan.ts) will pick that up
      // from process.env if the user already set it.
      console.warn(
        "[main] no bundled scanner binary found — scans will use the " +
          "Python venv fallback if EDGE_AGENT_PYTHON is set, or fail until one is configured."
      )
    }
  }

  // Spawn. cwd is the standalone dir so the server's relative
  // .next/static and public lookups (which Next built relative to
  // `process.cwd()`) resolve correctly.
  console.log(`[main] booting standalone server: ${serverJs}`)
  console.log(`[main] listening on http://${hostname}:${port}`)
  serverProcess = spawn(process.execPath, [serverJs], {
    cwd: path.dirname(serverJs),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    // detached:false on POSIX so SIGTERM to Electron also kills the
    // child via process group exit. Windows ignores this.
    detached: false,
  })

  // Forward output line-prefixed so they're easy to grep in logs.
  serverProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[next] ${chunk.toString()}`)
  })
  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[next] ${chunk.toString()}`)
  })
  serverProcess.on("exit", (code, signal) => {
    console.log(
      `[main] standalone server exited code=${code} signal=${signal ?? "-"}`
    )
    serverProcess = null
    // If the server dies AFTER we've already loaded the window, the
    // window will go blank on next navigation. We don't auto-quit
    // here because the user may want to read an error in the
    // already-rendered UI; on macOS they can also reload the window
    // and we'd start a fresh server next time.
  })
  serverProcess.on("error", (err) => {
    console.error("[main] failed to spawn standalone server:", err)
  })

  // Block until the port accepts a connection (or 30s elapses, which
  // is generous for any reasonable hardware).
  await waitForPort(hostname, port, 30_000)

  return `http://${hostname}:${port}`
}

/** Best-effort tear-down of the child server. Called from several
 *  lifecycle hooks for paranoia; killing an already-dead pid is a
 *  no-op so doubling up is safe. */
function killServerProcess(): void {
  if (!serverProcess) return
  const proc = serverProcess
  serverProcess = null
  try {
    proc.kill("SIGTERM")
  } catch {
    /* ignore */
  }
  // Escalate to SIGKILL after a short grace window in case Next.js
  // ignores SIGTERM (it shouldn't, but Turbopack has had bugs here).
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill("SIGKILL")
    } catch {
      /* ignore */
    }
  }, 3000).unref()
}

/* -------------------------------------------------------------------------- */
/* BrowserWindow                                                              */
/* -------------------------------------------------------------------------- */

function createWindow(rendererUrl: string): void {
  resolvedRendererUrl = rendererUrl

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Edge Agent AI",
    backgroundColor: "#0a0a0a",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // Compiled output of electron/preload.ts. tsc emits it alongside main.js
      // in electron/dist/, so both files share __dirname at runtime.
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: IS_DEV,
      // No remote module, no experimental web platform features.
      webSecurity: true,
    },
  })

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show()
    if (IS_DEV) {
      mainWindow?.webContents.openDevTools({ mode: "detach" })
    }
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })

  // Treat anchor target=_blank / window.open as "open in user's default browser"
  // instead of spawning a second Electron window. Cheap defense against
  // accidental escape hatches from the renderer.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  // Block in-window navigation to anything that isn't our renderer origin.
  // This prevents a buggy link or injected URL from yanking the window
  // away from the app.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const target = new URL(url)
      const allowed = new URL(rendererUrl)
      if (target.origin !== allowed.origin) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    } catch {
      event.preventDefault()
    }
  })

  void mainWindow.loadURL(rendererUrl)
}

/* -------------------------------------------------------------------------- */
/* IPC: native folder picker                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Renderer contract (see electron/preload.ts):
 *
 *   window.edgeAgentAI.selectFolder(): Promise<string | null>
 *
 * Resolves with the absolute, realpath-resolved path of the chosen folder,
 * or `null` if the user cancelled. Rejects with an `Error` whose `.message`
 * is prefixed with a stable code so the renderer can branch on cause:
 *
 *   "OUTSIDE_ALLOWLIST: …"  — selection lives outside the allowed root
 *   "NOT_A_DIRECTORY: …"    — selection is a file, symlink loop, etc.
 *   "NOT_FOUND: …"          — selection disappeared between click and resolve
 */
ipcMain.handle("edge-agent-ai:select-folder", async () => {
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

  const result = await dialog.showOpenDialog(parent ?? new BrowserWindow({ show: false }), {
    title: "Select a local agent project",
    properties: ["openDirectory", "dontAddToRecent", "treatPackageAsDirectory"],
    buttonLabel: "Select",
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const picked = result.filePaths[0]

  let stat: fs.Stats
  try {
    stat = fs.statSync(picked)
  } catch {
    throw new Error(`NOT_FOUND: ${picked}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`NOT_A_DIRECTORY: ${picked}`)
  }

  const resolved = tryRealpath(picked)

  const allowRoot = getAllowRoot()
  if (!isPathInside(resolved, allowRoot)) {
    throw new Error(`OUTSIDE_ALLOWLIST: ${resolved}`)
  }

  return resolved
})

/* -------------------------------------------------------------------------- */
/* App lifecycle                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the renderer URL — either from the env var (dev mode) or
 * by booting our own standalone server (production mode). Throws
 * the inner error verbatim on failure; the caller is responsible
 * for surfacing it via dialog.
 */
async function resolveRendererUrl(): Promise<string> {
  if (RENDERER_URL_ENV) {
    console.log(`[main] dev mode — loading ${RENDERER_URL_ENV}`)
    return RENDERER_URL_ENV
  }
  console.log("[main] production mode — booting standalone server")
  return await startStandaloneServer()
}

app.whenReady().then(async () => {
  let url: string
  try {
    url = await resolveRendererUrl()
  } catch (err) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err)
    console.error("[main] startup failed:", detail)
    await dialog.showMessageBox({
      type: "error",
      title: "Edge Agent AI could not start",
      message: "The production server failed to start.",
      detail:
        detail +
        "\n\nFix tips:\n" +
        "  • Run `pnpm build:standalone` to produce .next/standalone/server.js.\n" +
        "  • Or run `pnpm dev:electron` to launch against the dev server.\n",
      buttons: ["Quit"],
    })
    killServerProcess()
    app.quit()
    return
  }
  createWindow(url)

  app.on("activate", () => {
    // macOS: re-create a window when the dock icon is clicked and no
    // windows are open. Reuse the resolved URL — we don't re-spawn
    // the server because it's already running (or never died).
    if (BrowserWindow.getAllWindows().length === 0 && resolvedRendererUrl) {
      createWindow(resolvedRendererUrl)
    }
  })
})

app.on("window-all-closed", () => {
  // Cross-platform: quit on Win/Linux when the last window closes;
  // on macOS the app keeps running in the dock until Cmd-Q.
  if (process.platform !== "darwin") app.quit()
})

// Tear down the child server BEFORE Electron starts disposing its
// own resources, so we don't leave an orphaned node listener bound
// to a loopback port the next launch wants.
app.on("before-quit", () => {
  killServerProcess()
})

// Safety net for non-quit exit paths (segfault, SIGKILL on Electron
// itself, etc.). 'exit' isn't async-safe so we keep this minimal.
process.on("exit", () => {
  killServerProcess()
})

// Forward POSIX signals from the user (Ctrl-C in a launching shell)
// into a clean quit. Without this, the child server can outlive the
// Electron parent on SIGINT in some terminal hosts.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    killServerProcess()
    app.quit()
  })
}
