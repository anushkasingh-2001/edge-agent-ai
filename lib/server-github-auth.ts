/**
 * In-app GitHub authentication storage.
 *
 * The MVP "sign in with GitHub" flow stores a Personal Access Token
 * (or an OAuth-device-flow token in the future) on disk so the user
 * never has to install the `gh` CLI to push branches or open PRs.
 *
 * Where the token lives:
 *   ~/.config/edge-agent-ai/auth.json   (POSIX)
 *   %APPDATA%/edge-agent-ai/auth.json   (Windows)
 *   $EDGE_AGENT_HOME/auth.json          (override for tests / portable mode)
 *
 * The file is written with mode 0600 (owner read/write only) and the
 * directory with mode 0700, so other local users can't read it.
 *
 * Why disk and not the OS keychain:
 *   - Cross-platform without native deps.
 *   - The Next.js dev server runs as a normal user process; the
 *     keychain isn't reachable without bringing in `keytar` (which
 *     pulls a prebuilt native module per platform). Disk + 0600 is
 *     the same threat model as `~/.gitconfig` or `~/.netrc`.
 *
 * Tokens are never returned to the browser. The `/api/github/auth/status`
 * route returns `{ authenticated, login }` only.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type StoredAuth = {
  /** GitHub Personal Access Token or OAuth access token. */
  token: string
  /** Login name returned by GitHub /user when the token was stored. */
  login: string
  /** ISO timestamp of when the token was last validated/saved. */
  savedAt: string
  /** Source of the token — "pat" today, "oauth_device" later. */
  kind: "pat" | "oauth_device"
  /** Comma-separated scope list (best-effort, from the
   *  `x-oauth-scopes` response header). Optional. */
  scopes?: string
}

const APP_DIR_NAME = "edge-agent-ai"
const FILE_NAME = "auth.json"

/**
 * Resolve the directory that holds the auth file. Honours
 * `$EDGE_AGENT_HOME` for tests and portable installs.
 */
function authDir(): string {
  const override = process.env.EDGE_AGENT_HOME
  if (override) return override

  const platform = process.platform
  if (platform === "win32") {
    const appData =
      process.env.APPDATA ||
      path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, APP_DIR_NAME)
  }
  // Default to XDG-style on macOS + Linux. macOS technically prefers
  // ~/Library/Application Support, but ~/.config is what most CLI
  // tools (gh, gcloud) use and matches user expectations for an
  // "agent" tool.
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, APP_DIR_NAME)
}

function authFile(): string {
  return path.join(authDir(), FILE_NAME)
}

/** Returns null when no token is stored or the file is unreadable / corrupt. */
export function getStoredAuth(): StoredAuth | null {
  const file = authFile()
  if (!fs.existsSync(file)) return null
  try {
    const raw = fs.readFileSync(file, "utf-8")
    const parsed = JSON.parse(raw) as Partial<StoredAuth>
    if (!parsed || typeof parsed !== "object") return null
    if (typeof parsed.token !== "string" || parsed.token.length < 10) return null
    if (typeof parsed.login !== "string" || parsed.login.length === 0) return null
    return {
      token: parsed.token,
      login: parsed.login,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
      kind: parsed.kind === "oauth_device" ? "oauth_device" : "pat",
      scopes: typeof parsed.scopes === "string" ? parsed.scopes : undefined,
    }
  } catch {
    return null
  }
}

/** Write the token + login to disk with mode 0600. */
export function storeAuth(auth: Omit<StoredAuth, "savedAt">): StoredAuth {
  const dir = authDir()
  // Create the parent dir with mode 0700 so other users on a shared
  // machine can't list the contents either.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const full: StoredAuth = {
    ...auth,
    savedAt: new Date().toISOString(),
  }
  const file = authFile()
  // writeFileSync with mode covers the create-from-scratch case; for
  // an overwrite the existing mode is preserved, so we explicitly
  // chmod afterwards too.
  fs.writeFileSync(file, JSON.stringify(full, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort — non-POSIX filesystems may reject chmod */
  }
  return full
}

/** Delete the stored token. Idempotent. */
export function clearAuth(): void {
  const file = authFile()
  if (fs.existsSync(file)) {
    try {
      // Overwrite with zeros first so the token isn't trivially
      // recoverable from filesystem caches before deletion.
      const size = fs.statSync(file).size
      fs.writeFileSync(file, Buffer.alloc(size, 0), { mode: 0o600 })
    } catch {
      /* ignore — we still try to unlink */
    }
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
}

/** Convenience for callers that only need a "do we have a token?" check. */
export function hasStoredToken(): boolean {
  return getStoredAuth() !== null
}

/**
 * Build the `git -c …` arguments needed to push to GitHub over HTTPS
 * using the stored token. Returns `[]` when no token is stored, in
 * which case the caller should fall back to whatever git's credential
 * helper chain does (gh, osxkeychain, etc.).
 *
 * Why HTTP Basic instead of `Authorization: bearer …`:
 *   GitHub's git/HTTPS endpoint authenticates against credential
 *   helpers that pass the token as the *password* (with username
 *   `x-access-token`). The REST API accepts `Bearer <token>` but the
 *   git server frequently rejects it with "Invalid credentials" —
 *   that's the failure mode behind this helper.
 *
 * We also clear the credential helper chain (`-c credential.helper=`)
 * so a stale cached account from a previous `gh auth login` or OS
 * keychain entry can't override our header. Without this, users who
 * had `gh` configured against another GitHub account would still get
 * a 403 because git would silently fall back to the cached creds.
 *
 * The token is only present in argv for the duration of one spawn
 * (visible to other local users via `ps aux`, same threat model as
 * `git push https://x-access-token:TOKEN@…`).
 */
export function gitHubAuthArgs(token: string | null | undefined): string[] {
  if (!token) return []
  // base64("x-access-token:<TOKEN>") — the canonical scheme used by
  // GitHub Actions checkout, gh, and every credential helper.
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64")
  return [
    "-c",
    `http.https://github.com/.extraheader=Authorization: Basic ${basic}`,
    // Empty value clears git's credential.helper chain for this
    // command only, so cached accounts can't shadow our header.
    "-c",
    "credential.helper=",
  ]
}

/**
 * Public-safe view of the stored auth — never includes the token
 * itself. Used by /api/github/auth/status and by client-facing
 * GitHubStatus responses.
 */
export type StoredAuthPublic = Omit<StoredAuth, "token">

export function getStoredAuthPublic(): StoredAuthPublic | null {
  const a = getStoredAuth()
  if (!a) return null
  const { token: _t, ...rest } = a
  return rest
}
