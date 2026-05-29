/**
 * Canonical list of environment variables that must NEVER be present in
 * the desktop app's local Next.js server process.
 *
 * The desktop build runs Next.js on 127.0.0.1 inside the user's machine.
 * Anything in that process's env is, for security purposes, shipped to
 * the user — so provider keys, billing secrets, and the database URL must
 * be stripped before the local server is spawned. Those secrets live ONLY
 * on the cloud backend (your deployment), which the desktop app reaches
 * via `NEXT_PUBLIC_CLOUD_API_BASE` (see lib/api-fetch.ts).
 *
 * `electron/main.ts` mirrors this list inline (it can't import from ../lib
 * under its own tsconfig rootDir). The parity is enforced by
 * tests/desktop-cloud-split.test.ts, which reads main.ts and asserts every
 * key here is stripped there.
 */
export const DESKTOP_FORBIDDEN_ENV_KEYS: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "EDGE_AGENT_CUSTOM_API_KEY",
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
]

/**
 * Return a shallow copy of `env` with every forbidden secret removed, plus
 * the list of keys that were actually stripped (for logging). Pure and
 * dependency-free so both the Electron main process and tests can use it.
 */
export function stripDesktopSecrets(
  env: Record<string, string | undefined>,
): { env: Record<string, string | undefined>; removed: string[] } {
  const out: Record<string, string | undefined> = { ...env }
  const removed: string[] = []
  for (const key of DESKTOP_FORBIDDEN_ENV_KEYS) {
    if (out[key] !== undefined) {
      delete out[key]
      removed.push(key)
    }
  }
  return { env: out, removed }
}
