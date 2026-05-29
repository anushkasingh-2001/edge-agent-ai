/**
 * Shared helpers for the Edge Agent AI account auth routes
 * (register / login / logout / me).
 *
 * Centralizes: CORS (desktop → cloud), the session cookie, JSON responses,
 * email validation, and minting an account session JWT. The JWT carries the
 * Edge Agent AI `userId` / `workspaceId` (NOT a GitHub id) so subscriptions
 * and credits attach to the account.
 */

import { issueSessionToken, SESSION_COOKIE_NAME, DEFAULT_SESSION_TTL_SECONDS } from "./server-auth"
import { cloudCorsHeaders } from "./server-cloud-cors"
import { generateToken, hashToken } from "./server-password"
import { getAsyncUserStore } from "./server-user-bootstrap"
import type { PublicUser, UserRecord } from "./server-user-store"

export function accountJson(
  req: Request,
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cloudCorsHeaders(req) },
  })
}

export function accountPreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: cloudCorsHeaders(req) })
}

/** Generic 429 — never reveals which limit/email triggered it. */
export function rateLimitedResponse(req: Request, retryAfterSec: number): Response {
  const res = accountJson(
    req,
    { error: "Too many requests. Please wait a moment and try again.", code: "rate_limited" },
    429,
  )
  res.headers.set("Retry-After", String(Math.max(1, retryAfterSec)))
  return res
}

/** JSON response that also writes the session cookie (same-origin web) and
 *  CORS headers (desktop → cloud). The desktop path uses the Bearer token in
 *  the body; the cookie is a convenience for the same-origin browser app. */
export function accountJsonWithCookie(
  req: Request,
  body: Record<string, unknown>,
  status: number,
  cookie: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "set-cookie": cookie,
      ...cloudCorsHeaders(req),
    },
  })
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email)
}

/** Build the `__edge_session` Set-Cookie value. `SameSite=Lax` authenticates
 *  same-origin web; the desktop/cloud split relies on the Bearer token. */
export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ")
}

export interface IssuedAccountSession {
  token: string
  expiresAt: number
  expiresIn: number
  publicUser: PublicUser
}

/**
 * Mint a session JWT for an account. Returns null when the server can't sign
 * (no JWT_SECRET) so the caller can return a 503. The token carries the
 * account's verification state so the resolver can gate paid AI.
 */
export function issueAccountSession(
  user: UserRecord,
  workspaceId: string,
): IssuedAccountSession | null {
  const issued = issueSessionToken(
    {
      userId: user.id,
      workspaceId,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      role: "owner",
    },
    { ttlSeconds: DEFAULT_SESSION_TTL_SECONDS },
  )
  if (!issued) return null
  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    expiresIn: issued.expiresIn,
    publicUser: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      workspaceId,
      role: "owner",
    },
  }
}

export const VERIFICATION_TOKEN_TTL_SECONDS = 60 * 60 * 24 // 24h
export const RESET_TOKEN_TTL_SECONDS = 60 * 60 // 1h — short-lived by design

/**
 * Whether raw verification/reset tokens may be returned in the HTTP response.
 *
 * Production: ALWAYS false — tokens are delivered by email only and never
 * echoed. Dev: opt-in via `EDGE_AGENT_RETURN_AUTH_TOKENS=1` (default off), so
 * developers/tests can complete the flow without an email provider. The flag
 * is intentionally ignored in production.
 */
export function tokensVisibleToClient(): boolean {
  // NEVER in production — raw tokens are delivered by email only.
  if (process.env.NODE_ENV === "production") return false
  // In dev, opt-in only. Default off so even local responses don't leak tokens
  // unless a developer explicitly asks for them.
  return (process.env.EDGE_AGENT_RETURN_AUTH_TOKENS ?? "").trim() === "1"
}

/** Create an email-verification token, persisting only its hash. Returns the
 *  raw token + expiry. Best-effort: null on store failure. */
export async function issueVerificationToken(
  userId: string,
): Promise<{ token: string; expiresAt: string } | null> {
  try {
    const raw = generateToken(32)
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_SECONDS * 1000).toISOString()
    await getAsyncUserStore().createVerificationToken(userId, hashToken(raw), expiresAt)
    return { token: raw, expiresAt }
  } catch {
    return null
  }
}

/** Create a password-reset token, persisting only its hash. */
export async function issueResetToken(
  userId: string,
): Promise<{ token: string; expiresAt: string } | null> {
  try {
    const raw = generateToken(32)
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000).toISOString()
    await getAsyncUserStore().createResetToken(userId, hashToken(raw), expiresAt)
    return { token: raw, expiresAt }
  } catch {
    return null
  }
}

/** Refresh tokens live longer than access JWTs (default 30 days) so a user
 *  isn't forced to re-enter their password every access-token lifetime. */
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30

/**
 * Issue a refresh token for an account, persisting only its hash. Returns the
 * RAW token (shown once to the client) plus its expiry. Best-effort: returns
 * null on store failure so login still succeeds with just the access token.
 */
export async function issueRefreshToken(
  userId: string,
  workspaceId: string,
): Promise<{ token: string; expiresAt: string } | null> {
  try {
    const raw = generateToken(32)
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString()
    await getAsyncUserStore().createRefreshToken(userId, workspaceId, hashToken(raw), expiresAt)
    return { token: raw, expiresAt }
  } catch {
    return null
  }
}
