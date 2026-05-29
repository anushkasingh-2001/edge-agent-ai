/**
 * Cloud session issuance — the production "login → signed JWT" exchange.
 *
 * This runs on the hosted cloud backend (the only party that holds
 * `JWT_SECRET`). A desktop/web client presents a *verified third-party
 * identity proof* — today a GitHub access token / PAT — and receives a
 * short-lived session JWT in return. That JWT is what every cloud AI /
 * billing / plan route then verifies (see `lib/server-auth.ts`).
 *
 * Contract:
 *   - Production-safe: works with `NODE_ENV=production`. It does NOT depend
 *     on `/api/auth/dev-login` (which stays disabled in production).
 *   - The GitHub token is used ONLY to confirm the caller's identity by
 *     calling GitHub's `GET /user`. It is never persisted here and never
 *     returned to the client.
 *   - The minted JWT carries identity claims only: `sub` (userId),
 *     `workspaceId`, `email` (when GitHub exposes it), `role`, `iat`, `exp`.
 *   - Hosted-only: no provider API key is ever read, embedded in the token,
 *     or returned. BYOK is not reintroduced.
 *
 * Errors:
 *   - 400 missing/unsupported provider or token
 *   - 401 GitHub rejected the token (invalid identity)
 *   - 502 GitHub unreachable / unexpected response
 *   - 503 server has no usable `JWT_SECRET` (misconfiguration)
 */

import { issueSessionToken, DEFAULT_SESSION_TTL_SECONDS } from "./server-auth"
import { cloudCorsHeaders, cloudPreflightResponse } from "./server-cloud-cors"

const GH_API = "https://api.github.com"

interface SessionRequestBody {
  provider?: string
  token?: string
}

interface GithubUser {
  login?: string
  id?: number | string
  email?: string | null
  name?: string | null
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  })
}

/** CORS preflight for cross-origin desktop → cloud calls. */
export function handleCloudSessionPreflight(req: Request): Response {
  return cloudPreflightResponse(req)
}

/**
 * Validate a GitHub access token and return the canonical identity, or a
 * structured failure. Kept separate so callers/tests can reason about the
 * GitHub leg independently of token signing.
 */
export async function verifyGithubIdentity(
  token: string,
): Promise<
  | { ok: true; userId: string; login: string; email?: string; name?: string }
  | { ok: false; status: number; error: string; code: string }
> {
  let res: Response
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 15_000)
    try {
      res = await fetch(`${GH_API}/user`, {
        signal: ac.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "edge-agent-ai",
          Authorization: `Bearer ${token}`,
        },
      })
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    return {
      ok: false,
      status: 502,
      code: "github_unreachable",
      error: `Could not reach GitHub to verify the login: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }

  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      code: "invalid_token",
      error: "GitHub rejected this token (401). Sign in again with a valid token.",
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      status: 502,
      code: "github_error",
      error: `GitHub returned HTTP ${res.status} while verifying the login.`,
    }
  }

  let user: GithubUser
  try {
    user = (await res.json()) as GithubUser
  } catch {
    return { ok: false, status: 502, code: "github_error", error: "GitHub returned an unparseable response." }
  }

  const login = (user.login ?? "").toString().trim()
  if (!login) {
    return { ok: false, status: 502, code: "no_login", error: "GitHub did not return a login for this token." }
  }
  const idPart = user.id != null && String(user.id).trim() ? String(user.id).trim() : login
  return {
    ok: true,
    userId: `github:${idPart}`,
    login,
    email: typeof user.email === "string" && user.email.trim() ? user.email.trim() : undefined,
    name: typeof user.name === "string" && user.name.trim() ? user.name.trim() : login,
  }
}

/**
 * POST handler for `/api/auth/session`. Body: `{ provider?: "github",
 * token: string }`. Returns `{ ok, token, expiresAt, expiresIn, user }`.
 */
export async function handleCloudSession(req: Request): Promise<Response> {
  const cors = cloudCorsHeaders(req)

  let body: SessionRequestBody = {}
  try {
    body = (await req.json()) as SessionRequestBody
  } catch {
    body = {}
  }

  const provider = (body.provider ?? "github").toString().trim().toLowerCase()
  if (provider !== "github") {
    return jsonResponse(
      {
        ok: false,
        code: "unsupported_provider",
        error: `Unsupported identity provider '${provider}'. Only 'github' is supported.`,
      },
      400,
      cors,
    )
  }

  const token = (body.token ?? "").toString().trim()
  if (!token) {
    return jsonResponse(
      { ok: false, code: "missing_token", error: "An identity token is required to start a session." },
      400,
      cors,
    )
  }

  const identity = await verifyGithubIdentity(token)
  if (!identity.ok) {
    return jsonResponse({ ok: false, code: identity.code, error: identity.error }, identity.status, cors)
  }

  const issued = issueSessionToken(
    {
      userId: identity.userId,
      workspaceId: identity.userId,
      email: identity.email,
      name: identity.name,
      role: "owner",
    },
    { ttlSeconds: DEFAULT_SESSION_TTL_SECONDS },
  )
  if (!issued) {
    return jsonResponse(
      {
        ok: false,
        code: "server_misconfigured",
        error:
          "This server cannot sign sessions: JWT_SECRET (or EDGE_AGENT_JWT_SECRET) must be set to at least 16 characters.",
      },
      503,
      cors,
    )
  }

  // Identity claims only — never a provider key, never the GitHub token.
  return jsonResponse(
    {
      ok: true,
      token: issued.token,
      expiresAt: issued.expiresAt,
      expiresIn: issued.expiresIn,
      user: {
        userId: identity.userId,
        login: identity.login,
        email: identity.email ?? null,
      },
    },
    200,
    cors,
  )
}
