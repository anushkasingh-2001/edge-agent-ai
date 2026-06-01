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
import { normalizeEmail } from "@/lib/server-user-store"
import {
  accountJson,
  accountPreflight,
  isValidEmail,
  issueVerificationCode,
  rateLimitedResponse,
  reissuePendingCode,
  verificationCodePayload,
} from "@/lib/server-account"
import { clientIp, enforceRateLimit, HOUR } from "@/lib/server-rate-limit"
import { sendVerificationCodeEmail } from "@/lib/server-email"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

/** Generic response for the public (unauthenticated) path — never reveals
 *  whether the email exists or is already verified. */
const PUBLIC_GENERIC = {
  ok: true,
  message: "If an unverified account exists for that email, a verification link has been sent.",
} as const

export async function POST(req: Request) {
  await ensureUserBootstrap()
  const users = getAsyncUserStore()

  let body: { email?: unknown } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    body = {}
  }
  const email = normalizeEmail(typeof body.email === "string" ? body.email : "")

  // ---- Authenticated path: resend for the signed-in user ---------------- //
  // Only when NO email is supplied in the body. A request that carries an
  // email is always treated as the public "resend by email" path below, so a
  // stale/leftover Bearer token from an earlier session can never turn a
  // legitimate pre-login resend into a 404 "account not found".
  const session = !email ? getOptionalSession(req) : null
  if (session) {
    const rl = await enforceRateLimit("send-verification:user", session.userId, 10, HOUR)
    if (!rl.ok) return rateLimitedResponse(req, rl.retryAfterSec)

    const user = await users.getUserById(session.userId)
    if (!user) {
      return accountJson(req, { error: "Account not found.", code: "user_not_found" }, 404)
    }
    if (user.emailVerified) {
      return accountJson(req, { ok: true, alreadyVerified: true }, 200)
    }
    const verification = await issueVerificationCode(user.id)
    if (!verification) {
      return accountJson(
        req,
        { error: "Could not create a verification code.", code: "verification_failed" },
        500,
      )
    }
    const sent = await sendVerificationCodeEmail(user.email, verification.code)
    return accountJson(
      req,
      { ok: true, ...verificationCodePayload(verification.code, !sent.ok) },
      200,
    )
  }

  // ---- Public path: resend by email (used by the "verify your email"
  //      screen before the user can sign in). Always returns a generic 200 so
  //      it can't be used to enumerate accounts. Rate-limited by email + IP. //
  if (!isValidEmail(email)) {
    return accountJson(req, PUBLIC_GENERIC, 200)
  }

  const ipRl = await enforceRateLimit("send-verification:ip", clientIp(req), 60, HOUR)
  if (!ipRl.ok) return rateLimitedResponse(req, ipRl.retryAfterSec)
  const emailRl = await enforceRateLimit("send-verification:email", email, 10, HOUR)
  if (!emailRl.ok) return rateLimitedResponse(req, emailRl.retryAfterSec)

  const user = await users.getUserByEmail(email)
  if (user) {
    // Existing (legacy) unverified account → reissue its verification code.
    if (user.emailVerified === false) {
      const verification = await issueVerificationCode(user.id)
      if (verification) {
        const sent = await sendVerificationCodeEmail(user.email, verification.code)
        return accountJson(
          req,
          { ...PUBLIC_GENERIC, ...verificationCodePayload(verification.code, !sent.ok) },
          200,
        )
      }
    }
    // Verified accounts fall through to the generic response (no resend).
  } else {
    // No account yet — maybe a PENDING registration is awaiting its code.
    const reissued = await reissuePendingCode(email)
    if (reissued) {
      const sent = await sendVerificationCodeEmail(email, reissued.code)
      return accountJson(
        req,
        { ...PUBLIC_GENERIC, ...verificationCodePayload(reissued.code, !sent.ok) },
        200,
      )
    }
  }
  return accountJson(req, PUBLIC_GENERIC, 200)
}
