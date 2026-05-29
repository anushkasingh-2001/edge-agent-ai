/**
 * POST /api/auth/send-verification  —  (re)issue an email-verification token.
 *
 * Requires an account session (Bearer JWT). Creates a fresh verification token
 * for the signed-in user. In production the token is emailed; in dev/test it
 * is returned in the response (see tokensVisibleToClient).
 *
 * SECURITY: only the hashed token is stored. No provider key is involved.
 */

import { getOptionalSession } from "@/lib/server-auth"
import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import {
  accountJson,
  accountPreflight,
  issueVerificationToken,
  rateLimitedResponse,
  tokensVisibleToClient,
} from "@/lib/server-account"
import { enforceRateLimit, HOUR } from "@/lib/server-rate-limit"
import { sendVerificationEmail } from "@/lib/server-email"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

export async function POST(req: Request) {
  const session = getOptionalSession(req)
  if (!session) {
    return accountJson(req, { error: "Not authenticated.", code: "not_authenticated" }, 401)
  }

  // Max 3 verification emails per user per hour.
  const rl = await enforceRateLimit("send-verification:user", session.userId, 3, HOUR)
  if (!rl.ok) return rateLimitedResponse(req, rl.retryAfterSec)

  await ensureUserBootstrap()
  const user = await getAsyncUserStore().getUserById(session.userId)
  if (!user) {
    return accountJson(req, { error: "Account not found.", code: "user_not_found" }, 404)
  }
  if (user.emailVerified) {
    return accountJson(req, { ok: true, alreadyVerified: true }, 200)
  }

  const verification = await issueVerificationToken(user.id)
  if (!verification) {
    return accountJson(
      req,
      { error: "Could not create a verification token.", code: "verification_failed" },
      500,
    )
  }

  await sendVerificationEmail(user.email, verification.token)

  return accountJson(
    req,
    {
      ok: true,
      // Dev/test only — never returned in production (emailed instead).
      ...(tokensVisibleToClient() ? { verificationToken: verification.token } : {}),
    },
    200,
  )
}
