/**
 * Renderer-side ambient types for the Electron preload bridge.
 *
 * The actual runtime object is exposed by `electron/preload.ts` via
 * `contextBridge.exposeInMainWorld("edgeAgent", ...)`. That file lives in
 * the Electron tsconfig (separate compile target), so the Next.js / React
 * code can't import its types directly. This .d.ts mirrors the shape so
 * components can do:
 *
 *     if (window.edgeAgent?.isDesktop) {
 *       // show native folder picker UI (wired in Step 3)
 *     }
 *
 * Keep this file in sync with `electron/preload.ts` as that bridge grows.
 *
 * `edgeAgent` is optional on `Window` because the same renderer code runs
 * unchanged in a plain browser (`pnpm dev`), where preload never executes
 * and the global is therefore undefined. That `undefined` is exactly how
 * the renderer detects browser-vs-desktop mode.
 */

export {}

declare global {
  interface EdgeAgentBridge {
    readonly isDesktop: true
    readonly versions: {
      readonly electron: string
      readonly chrome: string
      readonly node: string
    }
  }

  interface Window {
    edgeAgent?: EdgeAgentBridge
  }
}
