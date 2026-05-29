/**
 * apiFetch — the single seam every client → API call should go through.
 *
 * Desktop/cloud split
 * -------------------
 * The packaged desktop app runs a Next.js server locally on 127.0.0.1.
 * That local server must NEVER hold provider keys, billing secrets, or
 * `DATABASE_URL`. So hosted-AI / billing / auth / plan traffic is sent
 * to a SEPARATE cloud backend (your deployment) that owns those secrets,
 * while filesystem-bound work (scanner, git, fix-apply, workflow graph)
 * stays on the local server where the user's code actually lives.
 *
 * `apiFetch(route, init)` decides per-route:
 *   - **cloud** routes → prefixed with the configured cloud base URL,
 *     with the caller's session token attached as a Bearer header and
 *     credentials included (so a cross-origin cookie works too).
 *   - **local** routes → same-origin relative fetch, exactly as before.
 *
 * When no cloud base is configured (the plain web deployment, or local
 * dev where one origin serves everything) EVERY route is same-origin —
 * so this helper is a no-op there and fully backwards compatible.
 *
 * Cloud base is read from (first non-empty wins):
 *   - `NEXT_PUBLIC_CLOUD_API_BASE`  (inlined into the client bundle at
 *     build time — this is the one that matters in the browser/desktop)
 *   - `EDGE_AGENT_CLOUD_API_BASE`   (server-side runtime fallback, e.g.
 *     for any server-to-server proxy)
 *
 * Hosted-only contract preserved: this helper NEVER attaches a provider
 * API key. It only attaches the user's *session* token. BYOK is gone and
 * is not reintroduced here.
 */

/**
 * Route prefixes that must be served by the cloud backend (they need the
 * provider keys / billing secrets / `DATABASE_URL`, none of which exist
 * on the desktop's local server).
 *
 * NOTE on fix/patch: `/api/finding/patch`, `/api/findings/fix` and
 * `/api/findings/fix-filtered` are deliberately NOT here. They read and
 * (in apply mode) WRITE the user's local files, so they must run on the
 * local server. Their model-GENERATION step is delegated to the cloud
 * generation endpoints (`/api/cloud/...generate`) by the local server
 * itself — see `LOCAL_CLOUD_FORWARDING_PREFIXES` below and
 * `lib/server-patch-generation-gateway.ts`. The apply/validate/re-scan
 * legs stay local so file-apply keeps working on desktop.
 */
export const CLOUD_ROUTE_PREFIXES: readonly string[] = [
  "/api/hosted/", // chat / playground / workflow chat — pure model calls
  "/api/finding/explain", // client sends the code snippet; no local FS
  "/api/workflow/chat", // "ask about this repo" — pure model call
  "/api/cloud/", // patch/fix GENERATION endpoints (server-to-server target)
  "/api/plan",
  "/api/billing/",
  "/api/auth/",
]

/**
 * LOCAL routes whose model-generation step is relayed to the cloud by the
 * local server. They stay same-origin (they touch local files), but when the
 * desktop/cloud split is active the client attaches the session Bearer token
 * so the local server can forward it to the cloud generation endpoint.
 * Matched exact-or-subpath.
 */
export const LOCAL_CLOUD_FORWARDING_PREFIXES: readonly string[] = [
  "/api/finding/patch",
  "/api/findings/fix",
  "/api/findings/fix-filtered",
]

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (path === prefix) return true
    const withSlash = prefix.endsWith("/") ? prefix : prefix + "/"
    if (path.startsWith(withSlash)) return true
  }
  return false
}

/** True for local routes that forward their generation step to the cloud. */
export function forwardsGenerationToCloud(route: string): boolean {
  return matchesPrefix(pathOnly(route), LOCAL_CLOUD_FORWARDING_PREFIXES)
}

export type ApiRouteCategory = "cloud" | "local"

function pathOnly(route: string): string {
  const q = route.indexOf("?")
  const h = route.indexOf("#")
  let end = route.length
  if (q >= 0) end = Math.min(end, q)
  if (h >= 0) end = Math.min(end, h)
  return route.slice(0, end)
}

/** Decide whether a route belongs to the cloud backend or the local
 *  server. Matching is exact-or-subpath so `/api/plan` matches both
 *  `/api/plan` and `/api/plan/anything`, but not `/api/planner`. */
export function classifyApiRoute(route: string): ApiRouteCategory {
  const path = pathOnly(route)
  for (const prefix of CLOUD_ROUTE_PREFIXES) {
    if (path === prefix) return "cloud"
    const withSlash = prefix.endsWith("/") ? prefix : prefix + "/"
    if (path.startsWith(withSlash)) return "cloud"
  }
  return "local"
}

function readStaticEnv(): string {
  // Static member access so Next.js inlines NEXT_PUBLIC_* into the client
  // bundle. Dynamic indexing (process.env[name]) would NOT be inlined and
  // would read as undefined in the browser.
  const fromPublic =
    typeof process !== "undefined" && process.env
      ? process.env.NEXT_PUBLIC_CLOUD_API_BASE
      : undefined
  const fromServer =
    typeof process !== "undefined" && process.env
      ? process.env.EDGE_AGENT_CLOUD_API_BASE
      : undefined
  return String(fromPublic || fromServer || "")
}

/** Configured cloud backend base URL, normalised without a trailing
 *  slash. Empty string means "no split configured → everything local". */
export function getCloudApiBase(): string {
  return readStaticEnv().trim().replace(/\/+$/, "")
}

/** True when a cloud backend is configured (i.e. the desktop/cloud split
 *  is active). */
export function isCloudSplitEnabled(): boolean {
  return getCloudApiBase().length > 0
}

// ---------------------------------------------------------------------------
// Session token (Bearer) used for cross-origin cloud calls.
//
// Same-origin calls rely on the `__edge_session` cookie. Cross-origin
// desktop → cloud calls can't read an HttpOnly cookie, so the auth flow
// stores the issued JWT here and apiFetch attaches it as a Bearer header.
// This is a SESSION token, never a provider key.
// ---------------------------------------------------------------------------

const TOKEN_STORAGE_KEY = "edge-agent-ai.cloudAuthToken"
let inMemoryToken: string | null = null

export function setCloudAuthToken(token: string | null): void {
  inMemoryToken = token && token.trim() ? token.trim() : null
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      if (inMemoryToken) window.localStorage.setItem(TOKEN_STORAGE_KEY, inMemoryToken)
      else window.localStorage.removeItem(TOKEN_STORAGE_KEY)
    }
  } catch {
    /* storage may be unavailable (private mode, SSR) — memory still works */
  }
}

export function getCloudAuthToken(): string | null {
  if (inMemoryToken) return inMemoryToken
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const v = window.localStorage.getItem(TOKEN_STORAGE_KEY)
      if (v && v.trim()) {
        inMemoryToken = v.trim()
        return inMemoryToken
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

// ---------------------------------------------------------------------------
// Refresh token. Long-lived, account-only credential used to mint a fresh
// access JWT (via POST /api/auth/refresh) without re-entering the password.
// It is NOT a provider key. Stored alongside the access token.
// ---------------------------------------------------------------------------

const REFRESH_STORAGE_KEY = "edge-agent-ai.cloudRefreshToken"
let inMemoryRefresh: string | null = null

export function setCloudRefreshToken(token: string | null): void {
  inMemoryRefresh = token && token.trim() ? token.trim() : null
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      if (inMemoryRefresh) window.localStorage.setItem(REFRESH_STORAGE_KEY, inMemoryRefresh)
      else window.localStorage.removeItem(REFRESH_STORAGE_KEY)
    }
  } catch {
    /* storage may be unavailable — memory still works */
  }
}

export function getCloudRefreshToken(): string | null {
  if (inMemoryRefresh) return inMemoryRefresh
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const v = window.localStorage.getItem(REFRESH_STORAGE_KEY)
      if (v && v.trim()) {
        inMemoryRefresh = v.trim()
        return inMemoryRefresh
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Clear both the access + refresh tokens. Called on logout. */
export function clearCloudTokens(): void {
  setCloudAuthToken(null)
  setCloudRefreshToken(null)
}

// ---------------------------------------------------------------------------
// Session re-mint on 401 + "login required" hook.
//
// IDENTITY MODEL: the Edge Agent AI account (email/password → JWT) is the
// identity of record. A password session cannot be silently re-minted (there
// is no stored credential), so on a 401 apiFetch surfaces a "login required"
// signal and the UI prompts an account re-login.
//
// The re-mint step is PLUGGABLE and OFF by default. GitHub is an optional
// integration, not the subscription identity, so we no longer auto-exchange
// the GitHub login for a session on 401 (that would silently switch billing
// identity to GitHub). A deployment that genuinely wants a non-interactive
// refresh (e.g. a future refresh-token flow) can register one via
// `setSessionReminter`. The GitHub bridge helper (`remintCloudSession`) is
// still exported for the optional "link GitHub" path but is not wired here.
// ---------------------------------------------------------------------------

/** Local route that exchanges the on-disk GitHub login for a session JWT.
 *  Used only by the optional GitHub-link flow, never automatically. */
export const CLOUD_SESSION_BRIDGE_ROUTE = "/api/desktop/cloud-session"

let loginRequiredHandler: (() => void) | null = null

/** Register a callback invoked when a cloud request is 401 and cannot be
 *  silently recovered. The app uses this to open the account sign-in dialog. */
export function setOnLoginRequired(handler: (() => void) | null): void {
  loginRequiredHandler = handler
}

function notifyLoginRequired(): void {
  try {
    loginRequiredHandler?.()
  } catch {
    /* a UI handler must never break the fetch path */
  }
}

// Optional, pluggable non-interactive re-mint. When set, it OVERRIDES the
// built-in account refresh on 401 (used by the optional GitHub-bridge path).
// When null (the default), apiFetch falls back to `refreshAccountSession`.
let sessionReminter: (() => Promise<boolean>) | null = null

/** Override the non-interactive session re-minter used on 401. Pass null to
 *  restore the default account refresh-token flow. */
export function setSessionReminter(fn: (() => Promise<boolean>) | null): void {
  sessionReminter = fn
}

// De-dupe concurrent account refreshes.
let accountRefreshInFlight: Promise<boolean> | null = null

/** Base URL for cloud auth routes (cross-origin when the split is active). */
function cloudAuthUrl(route: string): string {
  const base = getCloudApiBase()
  return base ? base + route : route
}

/**
 * Built-in account session refresh. Exchanges the stored refresh token for a
 * fresh access JWT via POST /api/auth/refresh and stores the rotated tokens.
 * Returns false (without any network call) when no refresh token is stored, so
 * a 401 with no refresh credential falls straight through to "login required".
 *
 * GitHub is NEVER used here — this is the account-only renewal path.
 */
export async function refreshAccountSession(): Promise<boolean> {
  const refreshToken = getCloudRefreshToken()
  if (!refreshToken) return false
  if (accountRefreshInFlight) return accountRefreshInFlight
  accountRefreshInFlight = (async () => {
    try {
      const res = await fetch(cloudAuthUrl("/api/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ refreshToken }),
      })
      if (!res.ok) {
        // A rejected refresh token is dead — drop it so we don't loop.
        if (res.status === 401) setCloudRefreshToken(null)
        return false
      }
      const data = (await res.json()) as { ok?: boolean; token?: string; refreshToken?: string }
      if (data?.ok && typeof data.token === "string" && data.token) {
        setCloudAuthToken(data.token)
        if (typeof data.refreshToken === "string" && data.refreshToken) {
          setCloudRefreshToken(data.refreshToken)
        }
        return true
      }
      return false
    } catch {
      return false
    } finally {
      accountRefreshInFlight = null
    }
  })()
  return accountRefreshInFlight
}

// De-dupe concurrent re-mints: a burst of 401s shares one bridge round-trip.
let remintInFlight: Promise<boolean> | null = null

/**
 * Ask the local bridge to mint a session JWT from the stored GitHub login and
 * store it via `setCloudAuthToken`. Returns true on success. Same origin (the
 * bridge is a LOCAL route), so the GitHub token never reaches this layer.
 *
 * This exists for the OPTIONAL "link GitHub / GitHub-derived session" path. It
 * is no longer invoked automatically on 401 — see the identity-model note
 * above. Wire it explicitly via `setSessionReminter(remintCloudSession)` only
 * if you intend GitHub to back the session.
 */
export async function remintCloudSession(): Promise<boolean> {
  if (remintInFlight) return remintInFlight
  remintInFlight = (async () => {
    try {
      const res = await fetch(CLOUD_SESSION_BRIDGE_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      if (!res.ok) return false
      const data = (await res.json()) as { ok?: boolean; token?: string }
      if (data?.ok && typeof data.token === "string" && data.token) {
        setCloudAuthToken(data.token)
        return true
      }
      return false
    } catch {
      return false
    } finally {
      remintInFlight = null
    }
  })()
  return remintInFlight
}

/**
 * Fetch an API route, transparently directing cloud-category routes to the
 * configured cloud backend (with the session Bearer token + credentials)
 * and leaving local routes as same-origin relative requests.
 *
 * `route` MUST be an absolute API path beginning with "/" (e.g.
 * "/api/plan"). Pass a full URL only if you intend to bypass routing —
 * which this helper does not support, by design.
 */
export async function apiFetch(route: string, init: RequestInit = {}): Promise<Response> {
  if (!route.startsWith("/")) {
    throw new Error(`apiFetch expects an absolute path beginning with "/": got "${route}"`)
  }

  const category = classifyApiRoute(route)
  const base = category === "cloud" ? getCloudApiBase() : ""

  if (!base) {
    // Local route. When the desktop/cloud split is active, fix/patch routes
    // relay their model-generation step to the cloud, so the local server
    // needs the session token. Attach it as a Bearer here (still same-origin)
    // so the local route can forward it. Other local routes (scan, git) stay
    // token-free. With no split configured this is a plain same-origin fetch.
    if (isCloudSplitEnabled() && forwardsGenerationToCloud(route)) {
      const token = getCloudAuthToken()
      if (token) {
        const headers = new Headers(init.headers)
        if (!headers.has("authorization")) {
          headers.set("authorization", `Bearer ${token}`)
        }
        return fetch(route, { ...init, headers })
      }
    }
    return fetch(route, init)
  }

  const url = base + route
  const build = (): RequestInit => {
    const headers = new Headers(init.headers)
    const token = getCloudAuthToken()
    if (token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`)
    }
    return {
      ...init,
      headers,
      // Include the cookie too, in case the cloud backend is configured for
      // cross-site credentialed requests (CORS + SameSite=None).
      credentials: init.credentials ?? "include",
    }
  }

  let res = await fetch(url, build())
  if (res.status !== 401) return res

  // Expired access token. Refresh ONCE then retry ONCE. A custom reminter
  // (e.g. the optional GitHub bridge) overrides the built-in account refresh;
  // otherwise we use the refresh-token flow. A string/JSON body is safe to
  // replay; a streaming body would already be consumed (not retried).
  const reminter = sessionReminter ?? refreshAccountSession
  const reminted = await reminter()
  if (reminted) {
    res = await fetch(url, build())
    if (res.status !== 401) return res
  }

  // Still unauthorized — prompt an account re-login and return the 401.
  notifyLoginRequired()
  return res
}
