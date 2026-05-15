/**
 * Edge Agent AI — Electron preload (Step 3).
 *
 * Bridges the renderer (Next.js / React) to a narrow, audited surface
 * of main-process APIs. With `contextIsolation: true` in main.ts, this
 * is the ONLY sanctioned channel — the renderer cannot reach `fs`,
 * `child_process`, `shell`, `ipcRenderer`, or any other Node primitive.
 *
 * Exposed surface (window.edgeAgentAI):
 *   - platform:     `process.platform` — "darwin" | "win32" | "linux" | …
 *                   Cheap signal for OS-specific UI affordances
 *                   (path separators, keyboard shortcuts, etc.).
 *   - selectFolder: opens the native OS folder picker. Resolves with the
 *                   chosen absolute path, or `null` if the user cancelled.
 *                   Rejects with an `Error` when the selection fails
 *                   validation in main (outside allowlist, not a
 *                   directory, missing, etc.) — the renderer should
 *                   `try/catch` and surface the message.
 *
 * Renderers running in plain-browser mode (`pnpm dev`) never see this
 * preload, so `window.edgeAgentAI` is `undefined` there. That `undefined`
 * is exactly how the React components feature-detect desktop mode.
 */

import { contextBridge, ipcRenderer } from "electron"

const api = {
  platform: process.platform,
  selectFolder: (): Promise<string | null> =>
    ipcRenderer.invoke("edge-agent-ai:select-folder"),
} as const

contextBridge.exposeInMainWorld("edgeAgentAI", api)

export type EdgeAgentAIBridge = typeof api
