/**
 * POST /api/auth/reset-password  —  complete a password reset.
 *
 * Body: { token, password }
 *
 * Verifies the (hashed) reset token, sets the new scrypt password hash, and
 * consumes the token so it can't be replayed. All of the user's refresh
 * tokens are revoked so any stolen session is cut off.
 *
 * SECURITY: lookup by token HASH; the new password is scrypt-hashed; nothing
 * plaintext is stored.
 */

import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import { hashPassword, hashToken, passwordPolicyError } from "@/lib/server-password"
import { accountJson, accountPreflight, rateLimitedResponse } from "@/lib/server-account"
import { clientIp, enforceRateLimit, HOUR } from "@/lib/server-rate-limit"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

export async function POST(req: Request) {
  // Brake brute-force of the token space: 10 attempts per IP per hour.
  const rl = await enforceRateLimit("reset:ip", clientIp(req), 10, HOUR)
  if (!rl.ok) return rateLimitedResponse(req, rl.retryAfterSec)

  let body: { token?: unknown; password?: unknown } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    return accountJson(req, { error: "Invalid JSON body.", code: "bad_request" }, 400)
  }

  const token = typeof body.token === "string" ? body.token.trim() : ""
  const password = typeof body.password === "string" ? body.password : ""
  if (!token) {
    return accountJson(req, { error: "A reset token is required.", code: "bad_request" }, 400)
  }
  const pwErr = passwordPolicyError(password)
  if (pwErr) {
    return accountJson(req, { error: pwErr, code: "weak_password" }, 400)
  }

  await ensureUserBootstrap()
  const users = getAsyncUserStore()
  const rec = await users.findResetToken(hashToken(token))
  if (!rec) {
    return accountJson(
      req,
      { error: "This reset link is invalid or has expired.", code: "invalid_token" },
      400,
    )
  }

  const passwordHash = await hashPassword(password)
  await users.updatePassword(rec.userId, passwordHash)
  await users.consumeResetToken(rec.id)
  // Cut off every existing session: a reset means "lock everyone out, log in
  // again with the new password."
  await users.revokeAllRefreshTokens(rec.userId)

  return accountJson(req, { ok: true }, 200)
}
