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

/**
 * Stable, single string describing how this Electron process was launched.
 * Mirrored to the renderer via the preload bridge AND forwarded to the
 * spawned Next standalone server through EDGE_AGENT_MODE so /api/system/health
 * can return it without re-deriving on the server side.
 *
 *   electron-dev               : launched by `pnpm dev:electron`
 *                                (ELECTRON_RENDERER_URL points at next dev)
 *   electron-prod-unpackaged   : launched by `pnpm start:electron-prod`
 *                                (no renderer URL, app.isPackaged === false,
 *                                running against .next/standalone in repo)
 *   packaged                   : launched from a built .app / .exe / AppImage
 *                                (app.isPackaged === true)
 *
 * `app.isPackaged` is the canonical Electron signal for "running inside an
 * asar bundle" — set true when the binary path includes Electron's stock
 * Resources directory rather than the user's checkout.
 */
type BootMode = "electron-dev" | "electron-prod-unpackaged" | "packaged"
const BOOT_MODE: BootMode = RENDERER_URL_ENV
  ? "electron-dev"
  : app.isPackaged
    ? "packaged"
    : "electron-prod-unpackaged"

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
/* PATH enrichment for Finder/launchd launches                                */
/* -------------------------------------------------------------------------- */

/**
 * Augment the inherited PATH with well-known per-OS binary directories
 * that terminal-launched processes see but Finder / launchd-launched
 * apps don't.
 *
 * Background: macOS's launchd hands a packaged .app a minimal default
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) when it's opened from Finder.
 * Homebrew installs to `/opt/homebrew/bin` (Apple Silicon) or
 * `/usr/local/bin` (Intel) — both invisible. Result: `runGh()` / `runGit()`
 * / `which gh` all fail with ENOENT inside the .app even though the
 * user can run them fine from their shell. Linux has a similar gotcha
 * for snap and `~/.local/bin`; Windows has it for GitHub CLI's
 * default install dir.
 *
 * Strategy: prepend (so explicit user PATH entries still win for any
 * already-listed dirs we'd duplicate) every well-known location that
 * actually exists on disk. Idempotent — safe to apply in dev mode too;
 * it'll just be a no-op when the entries are already there.
 *
 * We never expose the augmented PATH to the renderer or the network,
 * so there's no privacy concern. The output is logged so the user
 * (or a future maintainer) can confirm what was added.
 */
function enrichPathForPackaged(currentPath: string | undefined): {
  path: string
  added: string[]
} {
  const sep = process.platform === "win32" ? ";" : ":"
  const existing = (currentPath ?? "").split(sep).filter(Boolean)
  const existingSet = new Set(existing)

  const candidates: string[] = []
  if (process.platform === "darwin") {
    // Homebrew on Apple Silicon → on Intel → MacPorts. Order matters
    // because we prepend in this order.
    candidates.push("/opt/homebrew/bin")
    candidates.push("/opt/homebrew/sbin")
    candidates.push("/usr/local/bin")
    candidates.push("/usr/local/sbin")
    candidates.push("/opt/local/bin")
    // GitHub CLI also occasionally lives under ~/.local/bin via `brew bundle`
    // or piped installers. Cheap to add.
    candidates.push(path.join(os.homedir(), ".local", "bin"))
  } else if (process.platform === "linux") {
    candidates.push("/snap/bin")
    candidates.push("/usr/local/bin")
    candidates.push(path.join(os.homedir(), ".local", "bin"))
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      // GitHub CLI default install location for the per-user MSI.
      candidates.push(path.join(localAppData, "Programs", "GitHub CLI"))
    }
    // Git for Windows — both flavours that the official installer creates.
    candidates.push("C:\\Program Files\\Git\\cmd")
    candidates.push("C:\\Program Files\\Git\\bin")
  }

  const toPrepend: string[] = []
  for (const dir of candidates) {
    if (existingSet.has(dir)) continue
    try {
      if (fs.statSync(dir).isDirectory()) {
        toPrepend.push(dir)
      }
    } catch {
      // Directory missing — skip silently. We only want to add entries
      // that actually resolve, otherwise `which` will just waste a stat
      // probe per call.
    }
  }

  if (toPrepend.length === 0) {
    return { path: existing.join(sep), added: [] }
  }
  return {
    path: [...toPrepend, ...existing].join(sep),
    added: toPrepend,
  }
}

/* -------------------------------------------------------------------------- */
/* Log directory + child-process log redirection                              */
/* -------------------------------------------------------------------------- */

/**
 * Per-OS log directory exposed by Electron via `app.getPath("logs")`:
 *   macOS  : ~/Library/Logs/Edge Agent AI/
 *   Linux  : ~/.config/Edge Agent AI/logs/
 *   Windows: %APPDATA%/Edge Agent AI/logs/
 *
 * We resolve it lazily on first use (cannot call before app is ready in
 * older Electron majors) and `mkdirSync` with recursive:true so first launch
 * doesn't crash on a non-existent path.
 *
 * Two rotating-on-each-launch files live here:
 *   - main.log    — every console.* from the Electron main process
 *                   (boot decisions, IPC events, child process lifecycle)
 *   - server.log  — stdout/stderr of the spawned Next standalone server
 *                   (every API request line, every uncaught exception)
 *
 * On each launch we truncate (not append-with-rotation) — a single launch's
 * logs is exactly what the user needs when copying diagnostics, and keeping
 * historical logs across launches would require a cleanup policy we don't
 * have the lifecycle hooks to enforce reliably.
 */
let logDirCached: string | null = null
let mainLogStream: fs.WriteStream | null = null
let serverLogStream: fs.WriteStream | null = null

function getLogDir(): string {
  if (logDirCached) return logDirCached
  // app.getPath("logs") is documented as available after `app.whenReady()`
  // resolves; we only call this from inside `whenReady` and downstream IPC
  // handlers, so that's safe.
  let dir: string
  try {
    dir = app.getPath("logs")
  } catch {
    // Pre-ready or platform edge case — fall back to a stable per-user
    // location so the rest of the diagnostics block doesn't blow up.
    dir = path.join(os.homedir(), ".edge-agent-ai", "logs")
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* best-effort */
  }
  logDirCached = dir
  return dir
}

/** Open both log streams. Idempotent — safe to call multiple times. */
function openLogStreams(): void {
  const dir = getLogDir()
  if (!mainLogStream) {
    try {
      mainLogStream = fs.createWriteStream(path.join(dir, "main.log"), {
        flags: "w",
      })
      mainLogStream.on("error", () => {
        // Silently drop further main-log writes; we never want logging to
        // crash the app.
      })
    } catch {
      /* ignore */
    }
  }
  if (!serverLogStream) {
    try {
      serverLogStream = fs.createWriteStream(path.join(dir, "server.log"), {
        flags: "w",
      })
      serverLogStream.on("error", () => {
        /* see above */
      })
    } catch {
      /* ignore */
    }
  }
}

/** Best-effort flush + close of the log streams, called on quit. */
function closeLogStreams(): void {
  try {
    mainLogStream?.end()
  } catch {
    /* ignore */
  }
  try {
    serverLogStream?.end()
  } catch {
    /* ignore */
  }
  mainLogStream = null
  serverLogStream = null
}

/**
 * Tee a single chunk of stdio output to a target stream. Used to mirror
 * `[next]`-prefixed child stdout/stderr into server.log without losing the
 * stdout pipe to the parent terminal (so `pnpm start:electron-prod` still
 * shows the same output).
 */
function teeToStream(
  stream: fs.WriteStream | null,
  prefix: string,
  chunk: Buffer
): void {
  if (!stream) return
  try {
    stream.write(prefix + chunk.toString())
  } catch {
    /* see openLogStreams error handler */
  }
}

/**
 * Monkey-patch `console.{log,info,warn,error}` so every line we already
 * print to the terminal also lands in main.log. Done once, after streams
 * are open. We keep the original behaviour (still writing to stdout/stderr)
 * because attaching a debugger to the packaged .app via `Console.app` /
 * `electron .app --inspect` still wants the original sink.
 */
function attachConsoleToMainLog(): void {
  if (!mainLogStream) return
  const stream = mainLogStream
  const ts = () => new Date().toISOString()
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      try {
        const line =
          args
            .map((a) =>
              typeof a === "string"
                ? a
                : a instanceof Error
                  ? a.stack ?? a.message
                  : JSON.stringify(a)
            )
            .join(" ") + "\n"
        stream.write(`[${ts()}] [${level}] ${line}`)
      } catch {
        /* ignore */
      }
      original(...args)
    }
  }
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
  //
  // The EDGE_AGENT_* paths/mode are picked up by /api/system/health so
  // the renderer's diagnostics card can show:
  //   "Mode: packaged", "App: …Edge Agent AI.app", "Resources: …",
  //   "Logs: ~/Library/Logs/Edge Agent AI/" — exactly where the user
  //   should look when something's wrong.
  const logDir = getLogDir()
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOSTNAME: hostname,
    EDGE_AGENT_DESKTOP: "1",
    EDGE_AGENT_SCAN_ALLOWLIST:
      process.env.EDGE_AGENT_SCAN_ALLOWLIST?.trim() || os.homedir(),
    // Diagnostics envelope — read by /api/system/health (and only there
    // today; harmless to extra processes that don't recognise them).
    EDGE_AGENT_MODE: BOOT_MODE,
    EDGE_AGENT_APP_PATH: app.getAppPath(),
    EDGE_AGENT_RESOURCES_PATH:
      typeof process.resourcesPath === "string" ? process.resourcesPath : "",
    EDGE_AGENT_USER_DATA_PATH: (() => {
      try {
        return app.getPath("userData")
      } catch {
        return ""
      }
    })(),
    EDGE_AGENT_LOG_DIR: logDir,
    EDGE_AGENT_ELECTRON_VERSION: process.versions.electron ?? "",
    EDGE_AGENT_CHROME_VERSION: process.versions.chrome ?? "",
    EDGE_AGENT_APP_VERSION: app.getVersion(),
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

  // Forward output line-prefixed so they're easy to grep in logs, AND tee
  // into server.log so the user can hit "Open logs folder" later and find
  // a complete record of what the spawned Next server did. The packaged
  // .app has no terminal, so server.log is the only sink that survives.
  serverProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[next] ${chunk.toString()}`)
    teeToStream(serverLogStream, "[next] ", chunk)
  })
  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[next] ${chunk.toString()}`)
    teeToStream(serverLogStream, "[next err] ", chunk)
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
/* IPC: diagnostics — runtime info + open logs folder                          */
/* -------------------------------------------------------------------------- */

/**
 * Renderer contract:
 *
 *   window.edgeAgentAI.getRuntimeInfo(): Promise<RuntimeInfo>
 *
 * Returns a synchronous-ish snapshot of where this Electron process is
 * running from. Used by `components/system-health-gate.tsx` to render the
 * "Runtime" block and as a cross-check against /api/system/health's view
 * of the world (the API derives the same values from EDGE_AGENT_* env
 * vars; if they disagree, the user has a misconfigured launcher).
 */
type RuntimeInfo = {
  mode: BootMode
  appPath: string
  resourcesPath: string
  userDataPath: string
  logDir: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  appVersion: string
  platform: NodeJS.Platform
  arch: string
}

ipcMain.handle(
  "edge-agent-ai:get-runtime-info",
  async (): Promise<RuntimeInfo> => {
    return {
      mode: BOOT_MODE,
      appPath: app.getAppPath(),
      resourcesPath:
        typeof process.resourcesPath === "string" ? process.resourcesPath : "",
      userDataPath: (() => {
        try {
          return app.getPath("userData")
        } catch {
          return ""
        }
      })(),
      logDir: getLogDir(),
      electronVersion: process.versions.electron ?? "",
      chromeVersion: process.versions.chrome ?? "",
      nodeVersion: process.versions.node ?? "",
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    }
  }
)

/**
 * Renderer contract:
 *
 *   window.edgeAgentAI.openLogsFolder(): Promise<{ ok: boolean; error?: string }>
 *
 * Opens the per-user logs directory in the OS file manager (Finder on macOS,
 * Explorer on Windows, default xdg handler on Linux). Returns the result
 * shape rather than throwing because "logs folder is empty" or "user denied
 * access" aren't UI emergencies — the SystemHealthGate will surface the
 * failure inline.
 */
ipcMain.handle(
  "edge-agent-ai:open-logs-folder",
  async (): Promise<{ ok: boolean; error?: string; path: string }> => {
    const dir = getLogDir()
    try {
      // Ensure something exists to open — `shell.openPath` against a missing
      // directory returns a non-empty string error message.
      fs.mkdirSync(dir, { recursive: true })
      const result = await shell.openPath(dir)
      if (result) {
        return { ok: false, error: result, path: dir }
      }
      return { ok: true, path: dir }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        path: dir,
      }
    }
  }
)

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
  // Stand up the log streams first thing — every subsequent console.* in
  // this process is then mirrored to ~/.../Edge Agent AI/main.log, which
  // is what the diagnostics "Open logs folder" button leads the user to.
  openLogStreams()
  attachConsoleToMainLog()
  console.log(
    `[main] boot — mode=${BOOT_MODE} version=${app.getVersion()} ` +
      `electron=${process.versions.electron} platform=${process.platform}/${process.arch}`
  )
  console.log(`[main] logDir=${getLogDir()}`)
  console.log(`[main] appPath=${app.getAppPath()}`)
  if (typeof process.resourcesPath === "string") {
    console.log(`[main] resourcesPath=${process.resourcesPath}`)
  }

  // Enrich PATH so the spawned Next server's `runGh`/`runGit`/`which`
  // calls can find Homebrew + similar tooling when the .app is launched
  // from Finder (where launchd hands us a minimal `/usr/bin:/bin:…` PATH).
  // We mutate `process.env.PATH` directly so the child env we build later
  // via `...process.env` inherits the augmented value with no further
  // plumbing. Skipped silently in dev mode — terminal-launched processes
  // already have the right PATH, and the helper is idempotent anyway.
  const beforePath = process.env.PATH
  const enriched = enrichPathForPackaged(beforePath)
  process.env.PATH = enriched.path
  if (enriched.added.length > 0) {
    console.log(
      `[main] PATH enriched: prepended ${enriched.added.length} dir(s) → ${enriched.added.join(", ")}`
    )
  } else {
    console.log("[main] PATH already includes all known tool dirs — no change")
  }

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
  // Flush the log streams synchronously so the very last "[main] quit"
  // line survives in main.log — important when the user has just hit
  // "Open logs folder" before quitting to file a bug report.
  closeLogStreams()
})

// Safety net for non-quit exit paths (segfault, SIGKILL on Electron
// itself, etc.). 'exit' isn't async-safe so we keep this minimal.
process.on("exit", () => {
  killServerProcess()
  closeLogStreams()
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
