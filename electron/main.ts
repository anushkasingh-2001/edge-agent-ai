/**
 * Edge Agent AI — Electron main process (dev mode).
 *
 * Step 2 responsibilities (window + safe defaults):
 *   1. Boot a single BrowserWindow that points at the running Next.js
 *      dev server (default http://localhost:3000, overridable via
 *      ELECTRON_RENDERER_URL so we can swap to a packaged build URL
 *      later without touching this file).
 *   2. Enforce safe webPreferences from day one:
 *        contextIsolation: true   -> renderer cannot reach Node globals
 *        nodeIntegration:  false  -> no `require` in renderer
 *        sandbox:          true   -> chromium sandbox enabled
 *      The preload script is the *only* bridge between the renderer
 *      (browser-world Next.js code) and the Electron main world.
 *   3. Set the app name early so the macOS menu bar / dock title
 *      reads "Edge Agent AI" instead of "Electron".
 *
 * Step 3 additions (native folder picker IPC):
 *   - `ipcMain.handle("edge-agent-ai:select-folder", …)` opens the
 *     native OS folder picker (`dialog.showOpenDialog`) and returns
 *     the chosen absolute path back to the renderer.
 *   - Selections are validated in main (path exists, is a directory,
 *     resolves to a real path via `fs.realpathSync`) and constrained
 *     to the same envelope the Python scanner uses:
 *       - default: the user's home directory
 *       - override: `EDGE_AGENT_SCAN_ALLOWLIST` (single root path)
 *     This mirrors `lib/server-path-utils.ts#getScanAllowRoot` so that
 *     anything the user can pick here will also pass the API-side
 *     `assertReadableDirectory` checks downstream.
 *
 * Intentionally NOT done yet (later steps):
 *   - Packaged production loading (file:// or loopback) — Step 5+.
 *   - Auto-updater, code signing, deep links.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Renderer URL is provided by the `dev:electron` script via cross-env.
// Fallback keeps the file runnable if someone launches Electron directly.
const RENDERER_URL =
  process.env.ELECTRON_RENDERER_URL?.trim() || "http://localhost:3000"

// In dev we want DevTools available; we'll flip this off for packaged builds
// later. EDGE_AGENT_DESKTOP is set by the dev script as a hint, but we also
// treat anything that isn't NODE_ENV=production as dev.
const IS_DEV = process.env.NODE_ENV !== "production"

app.setName("Edge Agent AI")

// macOS dock label. setAboutPanelOptions tightens the About dialog so it
// doesn't leak Electron version strings as the headline.
if (process.platform === "darwin") {
  app.setAboutPanelOptions({
    applicationName: "Edge Agent AI",
    applicationVersion: app.getVersion(),
    copyright: "© Edge Agent AI",
  })
}

let mainWindow: BrowserWindow | null = null

/* -------------------------------------------------------------------------- */
/* Path-safety helpers (mirror lib/server-path-utils.ts in the renderer)      */
/* -------------------------------------------------------------------------- */

/** Expand a leading `~` to the user's home directory. */
function expandUser(input: string): string {
  const trimmed = input.trim()
  if (trimmed === "~") return os.homedir()
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return trimmed
}

/**
 * Default-deny allowlist root.
 *  - If `EDGE_AGENT_SCAN_ALLOWLIST` is set, that wins (and gets `~` expanded).
 *  - Otherwise the user's home directory in dev.
 *  - Otherwise the app cwd in production (unused at this step, but kept so
 *    behavior matches the server-side helper when we package later).
 */
function getAllowRoot(): string {
  const raw = process.env.EDGE_AGENT_SCAN_ALLOWLIST?.trim()
  if (raw) return path.resolve(expandUser(raw))
  if (process.env.NODE_ENV === "production") return process.cwd()
  return os.homedir()
}

// macOS (APFS default) and Windows (NTFS) are case-insensitive. Comparing
// absolute paths byte-for-byte breaks containment checks when the user
// types `/users/anushka/...` and the canonical form is `/Users/anushka/...`.
const PLATFORM_CASE_INSENSITIVE =
  process.platform === "darwin" || process.platform === "win32"

function tryRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

/** Returns true iff `child` is inside (or equal to) `parent`, symlinks resolved. */
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
/* BrowserWindow                                                              */
/* -------------------------------------------------------------------------- */

function createWindow(): void {
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
  // In dev, that's http://localhost:3000. This prevents a buggy link or
  // injected URL from yanking the window away from the app.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const target = new URL(url)
      const allowed = new URL(RENDERER_URL)
      if (target.origin !== allowed.origin) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    } catch {
      event.preventDefault()
    }
  })

  void mainWindow.loadURL(RENDERER_URL)
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
 *
 * Anything thrown here surfaces to the renderer's `try/catch`; we never
 * leak raw filesystem error objects (they can contain paths the user
 * didn't pick or stack traces from internal modules).
 */
ipcMain.handle("edge-agent-ai:select-folder", async () => {
  // Use the focused window so the dialog attaches as a sheet on macOS.
  // Falls back to mainWindow, then to "detached" if nothing's focused.
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

  // Stat first, so we never realpath a non-existent path (some
  // resolvers will silently invent parents otherwise).
  let stat: fs.Stats
  try {
    stat = fs.statSync(picked)
  } catch {
    throw new Error(`NOT_FOUND: ${picked}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`NOT_A_DIRECTORY: ${picked}`)
  }

  // Resolve symlinks so the allowlist check can't be tricked by a
  // symlink that points to /etc or wherever.
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

app.whenReady().then(() => {
  createWindow()

  app.on("activate", () => {
    // macOS: re-create a window when the dock icon is clicked and no
    // windows are open. Keeps the Mac UX feel right.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  // Standard cross-platform behavior: quit on Win/Linux when the last
  // window closes; on macOS the app keeps running in the dock.
  if (process.platform !== "darwin") app.quit()
})
