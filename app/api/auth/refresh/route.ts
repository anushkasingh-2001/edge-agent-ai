/**
 * POST /api/auth/refresh  —  renew an account session without re-login.
 *
 * Body: { refreshToken }
 *
 * Verifies the (hashed) refresh token, ROTATES it (revokes the presented one,
 * issues a new one), and mints a fresh access JWT reflecting the account's
 * current state (e.g. a now-verified email). This lets clients stay signed in
 * past the access-token lifetime without storing the password.
 *
 * GitHub is NEVER used to mint an account session here — this is the
 * account-only renewal path.
 *
 * SECURITY: refresh tokens are looked up by HASH; the response carries the new
 * access + refresh tokens and identity only — no provider key.
 */

import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import { hashToken } from "@/lib/server-password"
import {
  accountJson,
  accountPreflight,
  issueAccountSession,
  issueRefreshToken,
  rateLimitedResponse,
} from "@/lib/server-account"
import { clientIp, enforceRateLimit, MIN } from "@/lib/server-rate-limit"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

const INVALID = { error: "Invalid or expired refresh token.", code: "invalid_refresh_token" } as const

export async function POST(req: Request) {
  // Brake token-guessing: 30 attempts per IP per 15 minutes.
  const rl = await enforceRateLimit("refresh:ip", clientIp(req), 30, 15 * MIN)
  if (!rl.ok) return rateLimitedResponse(req, rl.retryAfterSec)

  let body: { refreshToken?: unknown } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    body = {}
  }
  const presented = typeof body.refreshToken === "string" ? body.refreshToken.trim() : ""
  if (!presented) {
    return accountJson(req, INVALID, 401)
  }

  await ensureUserBootstrap()
  const users = getAsyncUserStore()

  const rec = await users.findRefreshToken(hashToken(presented))
  if (!rec) {
    return accountJson(req, INVALID, 401)
  }

  const user = await users.getUserById(rec.userId)
  if (!user) {
    await users.revokeRefreshToken(rec.id)
    return accountJson(req, INVALID, 401)
  }

  // Rotate: the presented token is single-use.
  await users.revokeRefreshToken(rec.id)

  const issued = issueAccountSession(user, rec.workspaceId)
  if (!issued) {
    return accountJson(
      req,
      { error: "Server auth is not configured (JWT_SECRET missing).", code: "auth_unconfigured" },
      503,
    )
  }
  const nextRefresh = await issueRefreshToken(user.id, rec.workspaceId)

  return accountJson(
    req,
    {
      ok: true,
      token: issued.token,
      expiresAt: issued.expiresAt,
      refreshToken: nextRefresh?.token,
      user: issued.publicUser,
    },
    200,
  )
}
