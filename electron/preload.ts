/**
 * Edge Agent AI — Electron preload (Step 2).
 *
 * The preload runs in an isolated world between Electron's main process
 * and the Next.js renderer. With `contextIsolation: true` enabled in
 * main.ts, this is the *only* sanctioned channel for exposing
 * functionality to the React/Next.js code running inside the window.
 *
 * At Step 2 we deliberately expose only:
 *   - `isDesktop`: a constant boolean the renderer can use to switch
 *     UI affordances (e.g. show "Pick Folder…" instead of a manual
 *     path input) without doing brittle userAgent sniffing.
 *   - `versions`: the Electron/Chrome/Node version triple — useful for
 *     debug output and "About" panels.
 *
 * Step 3 will add IPC bridges here (folder picker, system info, etc.)
 * via `ipcRenderer.invoke` wrapped behind narrow, audited methods.
 * Until then, the renderer cannot reach `ipcRenderer`, `fs`, `child_process`,
 * or any other Node primitive — which is the point.
 */

import { contextBridge } from "electron"

const bridge = {
  isDesktop: true as const,
  versions: {
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
    node: process.versions.node ?? "unknown",
  },
} as const

contextBridge.exposeInMainWorld("edgeAgent", bridge)

export type EdgeAgentBridge = typeof bridge
