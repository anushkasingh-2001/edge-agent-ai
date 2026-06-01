/**
 * Shared helpers for the Edge Agent AI account auth routes
 * (register / login / logout / me).
 *
 * Centralizes: CORS (desktop → cloud), the session cookie, JSON responses,
 * email validation, and minting an account session JWT. The JWT carries the
 * Edge Agent AI `userId` / `workspaceId` (NOT a GitHub id) so subscriptions
 * and credits attach to the account.
 */

import { randomInt } from "node:crypto"
import { issueSessionToken, SESSION_COOKIE_NAME, DEFAULT_SESSION_TTL_SECONDS } from "./server-auth"
import { cloudCorsHeaders } from "./server-cloud-cors"
import { generateToken, hashToken } from "./server-password"
import { getAsyncUserStore } from "./server-user-bootstrap"
import { emailConfigured, resetPasswordLink, verifyEmailLink } from "./server-email"
import { billingMockEnabled } from "./server-billing-mock"
import { normalizeEmail } from "./server-user-store"
import type { AuthTokenRecord, PendingRegistration, PublicUser, UserRecord } from "./server-user-store"

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

/**
 * Whether to surface a verification / reset *link* in the HTTP response so the
 * client can show a clickable button when no email actually gets delivered.
 *
 * This is true when EITHER:
 *   - tokens are already visible (dev opt-in), OR
 *   - this is a demo deployment (`BILLING_MOCK=1`) AND no real email provider
 *     is configured. In that case email can't be sent, so the only way to
 *     complete verification/reset is to show the link on screen.
 *
 * As soon as `RESEND_API_KEY` (or SMTP) is configured, `emailConfigured()`
 * becomes true and links are NO LONGER surfaced — delivery is by email only,
 * which is the secure production behaviour.
 */
export function shouldSurfaceAuthLink(): boolean {
  // NEVER surface a code/link on-screen in production — email is the only
  // delivery channel there. Surfacing is a dev/demo convenience only.
  if (process.env.NODE_ENV === "production") return false
  if (tokensVisibleToClient()) return true
  if (billingMockEnabled() && !emailConfigured()) return true
  return false
}

/**
 * Whether to surface the link for THIS response, given whether the email
 * actually went out. Surfaces when:
 *   - links are generally visible (dev opt-in / no provider in demo), OR
 *   - the email send FAILED and this is a demo deployment (`BILLING_MOCK=1`).
 *     This is the safety net for the Resend test sender, which only delivers
 *     to the account owner: when delivery to some other address bounces, the
 *     user still gets a clickable link instead of being stuck.
 *
 * Once a verified sending domain is configured, sends succeed and the link is
 * never surfaced — delivery is by email only.
 */
function surfaceLink(sendFailed: boolean): boolean {
  // Hard stop in production: a failed send must never leak the code/link to the
  // client. The user retries / resends; the secret stays in email only.
  if (process.env.NODE_ENV === "production") return false
  if (shouldSurfaceAuthLink()) return true
  if (sendFailed && billingMockEnabled()) return true
  return false
}

/** Build the demo link payload merged into a response when email can't be
 *  delivered. `sendFailed` is the result of the email attempt. Returns {} when
 *  links must stay hidden (real email was delivered). */
export function verificationLinkPayload(token: string, sendFailed = false): Record<string, string> {
  if (!surfaceLink(sendFailed)) return {}
  return { verifyUrl: verifyEmailLink(token), verificationToken: token }
}

export function resetLinkPayload(token: string, sendFailed = false): Record<string, string> {
  if (!surfaceLink(sendFailed)) return {}
  return { resetUrl: resetPasswordLink(token), resetToken: token }
}

/** Surface the OTP code in the response only when the email couldn't be
 *  delivered (demo) or dev opt-in — so the user can still enter it. */
export function verificationCodePayload(code: string, sendFailed = false): Record<string, string> {
  if (!surfaceLink(sendFailed)) return {}
  return { verificationCode: code }
}

// --- email-verification CODES (OTP) ---------------------------------------- //

export const VERIFICATION_CODE_TTL_SECONDS = 15 * 60 // 15 min — short by design

/**
 * Hash input for a verification CODE. The userId is mixed in so a short
 * 6-digit code is unique PER USER — we can reuse the single-column
 * `findVerificationToken(hash)` lookup with zero risk of cross-user collisions
 * (two users can both have code "123456" without clashing).
 */
function codeHashInput(userId: string, code: string): string {
  return `verify-code:${userId}:${code}`
}

/** A fresh 6-digit OTP, always zero-padded (000000–999999). */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0")
}

function codeExpiry(): string {
  return new Date(Date.now() + VERIFICATION_CODE_TTL_SECONDS * 1000).toISOString()
}

/** Create a 6-digit email-verification code, persisting only its (namespaced)
 *  hash. Returns the raw code + expiry. Best-effort: null on store failure. */
export async function issueVerificationCode(
  userId: string,
): Promise<{ code: string; expiresAt: string } | null> {
  try {
    const code = generateOtpCode()
    const expiresAt = codeExpiry()
    await getAsyncUserStore().createVerificationToken(
      userId,
      hashToken(codeHashInput(userId, code)),
      expiresAt,
    )
    return { code, expiresAt }
  } catch {
    return null
  }
}

/** Look up a usable (unused, unexpired) verification code for a specific user. */
export async function findVerificationCode(
  userId: string,
  code: string,
): Promise<AuthTokenRecord | null> {
  const rec = await getAsyncUserStore().findVerificationToken(hashToken(codeHashInput(userId, code)))
  // Defensive: the namespaced hash already binds to the user, but double-check.
  return rec && rec.userId === userId ? rec : null
}

// --- pending registrations (no account until OTP verified) ----------------- //

/** Hash input for a pending-registration OTP. Namespaced by email so the code
 *  is bound to the signup it belongs to. */
function pendingCodeHashInput(email: string, code: string): string {
  return `pending-code:${normalizeEmail(email)}:${code}`
}

/**
 * Park a signup as a PENDING registration (no users row yet) with a fresh OTP.
 * Upserts by email, so re-registering simply refreshes the parked credentials
 * and issues a new code. Returns the raw code + expiry, or null on failure.
 */
export async function issuePendingRegistration(input: {
  email: string
  passwordHash: string
  name?: string
}): Promise<{ code: string; expiresAt: string } | null> {
  try {
    const code = generateOtpCode()
    const expiresAt = codeExpiry()
    await getAsyncUserStore().createPendingRegistration({
      email: input.email,
      passwordHash: input.passwordHash,
      name: input.name,
      codeHash: hashToken(pendingCodeHashInput(input.email, code)),
      expiresAt,
    })
    return { code, expiresAt }
  } catch {
    return null
  }
}

/** Validate an OTP against the pending registration for an email. Returns the
 *  pending record on success, or null if there's none / it's expired / wrong. */
export async function verifyPendingRegistration(
  email: string,
  code: string,
): Promise<PendingRegistration | null> {
  const pending = await getAsyncUserStore().getPendingRegistration(email)
  if (!pending) return null
  return pending.codeHash === hashToken(pendingCodeHashInput(email, code)) ? pending : null
}

/** Issue a fresh OTP for an existing pending registration (resend), keeping the
 *  parked credentials. Returns the new code, or null if there's no pending row. */
export async function reissuePendingCode(
  email: string,
): Promise<{ code: string; expiresAt: string } | null> {
  const pending = await getAsyncUserStore().getPendingRegistration(email)
  if (!pending) return null
  return issuePendingRegistration({
    email: pending.email,
    passwordHash: pending.passwordHash,
    name: pending.name,
  })
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
