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

/**
 * Mirrors `BootMode` in `electron/main.ts` — kept in sync manually because
 * the Electron tsconfig is a separate compile target.
 */
export type EdgeAgentBootMode =
  | "electron-dev"
  | "electron-prod-unpackaged"
  | "packaged"

/**
 * Mirrors the `RuntimeInfo` shape returned by the `edge-agent-ai:get-runtime-info`
 * IPC handler. Treat every string as untrusted display data — never inject into
 * `eval`, `<script>` tags, or shell commands.
 */
export type EdgeAgentRuntimeInfo = {
  mode: EdgeAgentBootMode
  appPath: string
  resourcesPath: string
  userDataPath: string
  logDir: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  appVersion: string
  platform: NodeJS.Platform | string
  arch: string
}

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
      /**
       * Snapshot of how this Electron process was launched: which boot mode
       * (`electron-dev` / `electron-prod-unpackaged` / `packaged`), where
       * `.app` / asar / standalone bundle / logs live, and which Electron /
       * Chrome / Node versions are running. Used by System Health to render
       * the Runtime block; the same data is embedded in "Copy diagnostics".
       */
      readonly getRuntimeInfo?: () => Promise<EdgeAgentRuntimeInfo>
      /**
       * Reveals the per-user logs directory in the OS file manager (Finder /
       * Explorer / xdg-open). Resolves with `{ ok: true, path }` on success;
       * `{ ok: false, error, path }` if the folder couldn't be opened (e.g.
       * permission denied, missing default handler). Never throws — the UI
       * decides whether to surface the failure inline.
       */
      readonly openLogsFolder?: () => Promise<{
        ok: boolean
        error?: string
        path: string
      }>
    }
  }
}
