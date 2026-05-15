/**
 * Edge Agent AI — Electron main process (dev mode only, Step 2).
 *
 * Responsibilities at this step:
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
 * Intentionally NOT done yet (later steps):
 *   - Native folder picker IPC (Step 3).
 *   - Packaged production loading (file:// or loopback) — Step 5+.
 *   - Auto-updater, code signing, deep links.
 */

import { app, BrowserWindow, shell } from "electron"
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
