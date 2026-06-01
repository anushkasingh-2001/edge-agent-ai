/**
 * POST /api/auth/login  —  authenticate an Edge Agent AI account.
 *
 * Body: { email, password }
 *
 * Verifies the scrypt password hash and returns a signed session JWT carrying
 * the account's userId/workspaceId (NOT a GitHub id). The desktop stores that
 * token via setCloudAuthToken() and apiFetch sends it as a Bearer to cloud
 * routes.
 *
 * SECURITY: a wrong email and a wrong password return the SAME generic 401 so
 * the endpoint doesn't leak which emails are registered. No provider keys in
 * the response.
 */

import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import { verifyPassword } from "@/lib/server-password"
import { normalizeEmail } from "@/lib/server-user-store"
import {
  accountJson,
  accountJsonWithCookie,
  accountPreflight,
  isValidEmail,
  issueAccountSession,
  issueRefreshToken,
  issueVerificationCode,
  rateLimitedResponse,
  reissuePendingCode,
  sessionCookie,
  verificationCodePayload,
} from "@/lib/server-account"
import {
  clientIp,
  enforceRateLimit,
  isRateLimited,
  recordFailure,
  HOUR,
  MIN,
} from "@/lib/server-rate-limit"
import { emailVerificationEnforced } from "@/lib/server-email-verification"
import { sendVerificationCodeEmail } from "@/lib/server-email"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

const INVALID = { error: "Invalid email or password.", code: "invalid_credentials" } as const
// Max 10 failed attempts per (email+IP) per 15 minutes. Successful logins don't
// consume the budget.
const LOGIN_MAX_FAILURES = 10
const LOGIN_WINDOW_MS = 15 * MIN

export async function POST(req: Request) {
  let body: { email?: unknown; password?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return accountJson(req, { error: "Invalid JSON body.", code: "bad_request" }, 400)
  }

  const email = normalizeEmail(typeof body.email === "string" ? body.email : "")
  const password = typeof body.password === "string" ? body.password : ""
  // Key on both email and IP so neither a single email nor a single IP can be
  // brute-forced. (A generic 429 still doesn't reveal account existence.)
  const limitKey = `${email}|${clientIp(req)}`
  const limited = await isRateLimited("login:fail", limitKey, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS)
  if (!limited.ok) return rateLimitedResponse(req, limited.retryAfterSec)

  if (!isValidEmail(email) || !password) {
    await recordFailure("login:fail", limitKey, LOGIN_WINDOW_MS)
    return accountJson(req, INVALID, 401)
  }

  await ensureUserBootstrap()
  const users = getAsyncUserStore()

  let user
  try {
    user = await users.getUserByEmail(email)
  } catch (e) {
    const status = (e as { status?: number })?.status === 503 ? 503 : 500
    return accountJson(req, { error: "Login failed.", code: "login_failed" }, status)
  }
  if (!user) {
    // No real account — but they may have registered and not verified yet
    // (pending registration; no users row exists until the OTP is entered).
    // If the password matches the parked signup, guide them to verify instead
    // of returning a confusing "invalid credentials".
    if (emailVerificationEnforced()) {
      const pending = await users.getPendingRegistration(email)
      if (pending && (await verifyPassword(password, pending.passwordHash))) {
        const reissued = await reissuePendingCode(email)
        let emailSent = false
        if (reissued) {
          emailSent = (await sendVerificationCodeEmail(email, reissued.code)).ok
        }
        return accountJson(
          req,
          {
            error:
              "Please verify your email to finish creating your account. We've emailed you a new code.",
            code: "email_not_verified",
            email,
            ...(reissued ? verificationCodePayload(reissued.code, !emailSent) : {}),
          },
          403,
        )
      }
    }
    await recordFailure("login:fail", limitKey, LOGIN_WINDOW_MS)
    return accountJson(req, INVALID, 401)
  }

  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) {
    await recordFailure("login:fail", limitKey, LOGIN_WINDOW_MS)
    return accountJson(req, INVALID, 401)
  }

  // STRICT FLOW: a correct password is not enough — the email must be verified
  // before a session is issued (production default; off in dev). We (re)send a
  // fresh verification link so the user can complete the step, then return a
  // dedicated 403 the client renders as "verify your email".
  if (emailVerificationEnforced() && user.emailVerified === false) {
    // Best-effort resend of a fresh code, rate-limited so login spam can't
    // blast emails.
    let verification: { code: string; expiresAt: string } | null = null
    let emailSent = false
    const resendRl = await enforceRateLimit("login-verify-resend:user", user.id, 10, HOUR)
    if (resendRl.ok) {
      verification = await issueVerificationCode(user.id)
      if (verification) {
        const res = await sendVerificationCodeEmail(user.email, verification.code)
        emailSent = res.ok
      }
    }
    return accountJson(
      req,
      {
        error: "Please verify your email before signing in. We've emailed you a new verification code.",
        code: "email_not_verified",
        email: user.email,
        ...(verification ? verificationCodePayload(verification.code, !emailSent) : {}),
      },
      403,
    )
  }

  const workspace = await users.getWorkspaceForUser(user.id)
  const workspaceId = workspace?.id ?? user.id

  const issued = issueAccountSession(user, workspaceId)
  if (!issued) {
    return accountJson(
      req,
      { error: "Server auth is not configured (JWT_SECRET missing).", code: "auth_unconfigured" },
      503,
    )
  }

  const refresh = await issueRefreshToken(user.id, workspaceId)

  return accountJsonWithCookie(
    req,
    {
      ok: true,
      token: issued.token,
      expiresAt: issued.expiresAt,
      refreshToken: refresh?.token,
      user: issued.publicUser,
    },
    200,
    sessionCookie(issued.token, issued.expiresIn),
  )
}
