/**
 * Edge Agent AI — Electron preload.
 *
 * Bridges the renderer (Next.js / React) to a narrow, audited surface
 * of main-process APIs. With `contextIsolation: true` in main.ts, this
 * is the ONLY sanctioned channel — the renderer cannot reach `fs`,
 * `child_process`, `shell`, `ipcRenderer`, or any other Node primitive.
 *
 * Exposed surface (window.edgeAgentAI):
 *   - platform:        `process.platform` — "darwin" | "win32" | "linux" | …
 *                      Cheap signal for OS-specific UI affordances
 *                      (path separators, keyboard shortcuts, etc.).
 *   - selectFolder:    opens the native OS folder picker. Resolves with the
 *                      chosen absolute path, or `null` if the user cancelled.
 *                      Rejects with an `Error` when the selection fails
 *                      validation in main (outside allowlist, not a
 *                      directory, missing, etc.) — the renderer should
 *                      `try/catch` and surface the message.
 *   - getRuntimeInfo:  one-shot snapshot of how Electron was launched
 *                      (mode, app/resources/logs paths, electron + chrome
 *                      versions). Powers the "Runtime" block in System
 *                      Health and is also embedded in the "Copy
 *                      diagnostics" JSON blob.
 *   - openLogsFolder:  opens the per-user logs directory in Finder /
 *                      Explorer / xdg-open. Returns `{ ok, error?, path }`
 *                      rather than throwing so the UI can decide whether
 *                      to surface the failure inline.
 *
 * Renderers running in plain-browser mode (`pnpm dev`) never see this
 * preload, so `window.edgeAgentAI` is `undefined` there. That `undefined`
 * is exactly how the React components feature-detect desktop mode.
 */

import { contextBridge, ipcRenderer } from "electron"

/** Mirrors `BootMode` in `electron/main.ts`. */
type BootMode = "electron-dev" | "electron-prod-unpackaged" | "packaged"

/** Mirrors `RuntimeInfo` in `electron/main.ts`. */
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

const api = {
  platform: process.platform,
  selectFolder: (): Promise<string | null> =>
    ipcRenderer.invoke("edge-agent-ai:select-folder"),
  getRuntimeInfo: (): Promise<RuntimeInfo> =>
    ipcRenderer.invoke("edge-agent-ai:get-runtime-info"),
  openLogsFolder: (): Promise<{
    ok: boolean
    error?: string
    path: string
  }> => ipcRenderer.invoke("edge-agent-ai:open-logs-folder"),
} as const

contextBridge.exposeInMainWorld("edgeAgentAI", api)

export type EdgeAgentAIBridge = typeof api
