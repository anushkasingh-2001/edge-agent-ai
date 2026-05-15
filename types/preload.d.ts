/**
 * Renderer-side ambient types for the Electron preload bridge.
 *
 * The runtime object is exposed by `electron/preload.ts` via
 * `contextBridge.exposeInMainWorld("edgeAgentAI", ...)`. That file lives in
 * the Electron tsconfig (separate compile target), so the Next.js / React
 * code can't import its types directly. This .d.ts is the canonical contract
 * for what `window.edgeAgentAI` looks like at runtime, and is what `tsc`
 * uses when typechecking renderer code.
 *
 * `edgeAgentAI` is optional on `Window` because the same renderer code runs
 * unchanged in a plain browser (`pnpm dev`), where the preload never runs
 * and the global is `undefined`. That `undefined` is exactly how components
 * feature-detect browser-vs-desktop mode:
 *
 *     if (typeof window.edgeAgentAI?.selectFolder === "function") {
 *       // we're in Electron — show the native picker button
 *     }
 *
 * Keep this file in sync with `electron/preload.ts` as that bridge grows.
 */

export {}

declare global {
  interface Window {
    edgeAgentAI?: {
      /** `process.platform` from the Electron main process: "darwin" | "win32" | "linux" | ... */
      readonly platform: string
      /**
       * Opens the native OS folder picker. Resolves with the chosen
       * absolute path, or `null` if the user cancelled. Rejects with
       * an `Error` whose `.message` is prefixed with a stable code:
       *   - "OUTSIDE_ALLOWLIST: ..."  — folder is outside EDGE_AGENT_SCAN_ALLOWLIST / home
       *   - "NOT_A_DIRECTORY: ..."    — selection isn't a directory
       *   - "NOT_FOUND: ..."          — selection disappeared between click and resolve
       */
      readonly selectFolder?: () => Promise<string | null>
    }
  }
}
