/**
 * POST /api/auth/register  —  create an Edge Agent AI account.
 *
 * Body: { email, password, name? }
 *
 * Creates the account (users + workspaces rows), seeds the billing
 * subscription keyed to the new userId/workspaceId, and auto-logs the user
 * in by returning a signed session JWT. The desktop stores that JWT via
 * setCloudAuthToken().
 *
 * SECURITY: password is scrypt-hashed before storage (never plaintext, never
 * logged). The response carries identity + token only — no provider API key.
 */

import { ensureBootstrap, getAsyncBillingStore } from "@/lib/server-billing-bootstrap"
import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import { hashPassword, passwordPolicyError } from "@/lib/server-password"
import { UserExistsError, normalizeEmail } from "@/lib/server-user-store"
import {
  accountJson,
  accountJsonWithCookie,
  accountPreflight,
  isValidEmail,
  issueAccountSession,
  issuePendingRegistration,
  issueRefreshToken,
  issueVerificationCode,
  rateLimitedResponse,
  sessionCookie,
  verificationCodePayload,
} from "@/lib/server-account"
import { clientIp, enforceRateLimit, HOUR } from "@/lib/server-rate-limit"
import { sendVerificationCodeEmail } from "@/lib/server-email"
import { emailVerificationEnforced } from "@/lib/server-email-verification"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

export async function POST(req: Request) {
  // Abuse brake: max 20 new accounts per IP per hour.
  const rl = await enforceRateLimit("register:ip", clientIp(req), 20, HOUR)
  if (!rl.ok) return rateLimitedResponse(req, rl.retryAfterSec)

  let body: { email?: unknown; password?: unknown; name?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return accountJson(req, { error: "Invalid JSON body.", code: "bad_request" }, 400)
  }

  const email = normalizeEmail(typeof body.email === "string" ? body.email : "")
  const password = typeof body.password === "string" ? body.password : ""
  const name = typeof body.name === "string" ? body.name.trim() : undefined

  if (!isValidEmail(email)) {
    return accountJson(req, { error: "A valid email is required.", code: "invalid_email" }, 400)
  }
  const pwErr = passwordPolicyError(password)
  if (pwErr) {
    return accountJson(req, { error: pwErr, code: "weak_password" }, 400)
  }

  await ensureUserBootstrap()
  const users = getAsyncUserStore()

  // (1) An account that ALREADY EXISTS must never be recreated.
  let existing
  try {
    existing = await users.getUserByEmail(email)
  } catch (e) {
    const status = (e as { status?: number })?.status === 503 ? 503 : 500
    return accountJson(req, { error: "Could not create account.", code: "register_failed" }, status)
  }
  if (existing) {
    if (existing.emailVerified) {
      // Real, verified account — tell them to sign in instead.
      return accountJson(
        req,
        { error: "An account already exists for this email. Please sign in.", code: "user_exists" },
        409,
      )
    }
    // Legacy unverified account (created before the pending-registration flow).
    // Treat a re-register as "resend my code": refresh the password + reissue.
    if (emailVerificationEnforced()) {
      await users.updatePassword(existing.id, await hashPassword(password))
      const verification = await issueVerificationCode(existing.id)
      let emailSent = false
      if (verification) {
        emailSent = (await sendVerificationCodeEmail(existing.email, verification.code)).ok
      }
      return accountJson(
        req,
        {
          ok: true,
          requiresVerification: true,
          email: existing.email,
          ...(verification ? verificationCodePayload(verification.code, !emailSent) : {}),
        },
        201,
      )
    }
    return accountJson(
      req,
      { error: "An account already exists for this email. Please sign in.", code: "user_exists" },
      409,
    )
  }

  const passwordHash = await hashPassword(password)

  // (2) STRICT FLOW (production default): the account is NOT created yet. We
  // park the signup as a pending registration with an OTP and email the code.
  // The real users/workspaces rows are created only when the code is verified
  // (see /api/auth/verify-email) — so "no account until verified" holds, and
  // re-registering simply refreshes the parked credentials + code.
  if (emailVerificationEnforced()) {
    const pending = await issuePendingRegistration({ email, passwordHash, name })
    if (!pending) {
      return accountJson(
        req,
        { error: "Could not start registration.", code: "register_failed" },
        500,
      )
    }
    const sent = await sendVerificationCodeEmail(email, pending.code)
    return accountJson(
      req,
      {
        ok: true,
        requiresVerification: true,
        email,
        // Surfaced only in dev / when the email couldn't be delivered.
        ...verificationCodePayload(pending.code, !sent.ok),
      },
      201,
    )
  }

  // (3) DEV / self-hosted (enforcement off): create the account immediately and
  // auto-login so local development and tests aren't gated on email delivery.
  let created
  try {
    created = await users.createUser({ email, passwordHash, name })
  } catch (e) {
    if (e instanceof UserExistsError) {
      return accountJson(req, { error: e.message, code: e.code }, 409)
    }
    const status = (e as { status?: number })?.status ?? 500
    const code = (e as { code?: string })?.code ?? "register_failed"
    return accountJson(req, { error: "Could not create account.", code }, status === 503 ? 503 : 500)
  }

  const { user, workspace } = created

  // Seed the billing subscription so plan/credits attach to THIS account
  // (free tier by default). Best-effort: a billing hiccup must not fail
  // account creation — the row is lazily seeded on first plan read anyway.
  try {
    await ensureBootstrap()
    await getAsyncBillingStore().upsertSubscription(user.id, workspace.id, {
      email: user.email,
      firstName: name ? name.split(" ")[0] : undefined,
    })
  } catch {
    /* non-fatal */
  }

  const verification = await issueVerificationCode(user.id)
  let emailSent = false
  if (verification) {
    const res = await sendVerificationCodeEmail(user.email, verification.code)
    emailSent = res.ok
  }

  const issued = issueAccountSession(user, workspace.id)
  if (!issued) {
    // Account exists but we can't sign a token (no JWT_SECRET). Surface a
    // clear 503 so the client knows the server is misconfigured.
    return accountJson(
      req,
      { error: "Server auth is not configured (JWT_SECRET missing).", code: "auth_unconfigured" },
      503,
    )
  }

  const refresh = await issueRefreshToken(user.id, workspace.id)

  return accountJsonWithCookie(
    req,
    {
      ok: true,
      token: issued.token,
      expiresAt: issued.expiresAt,
      refreshToken: refresh?.token,
      user: issued.publicUser,
      // Dev/test convenience only — never returned in production.
      ...(verification ? verificationCodePayload(verification.code, !emailSent) : {}),
    },
    201,
    sessionCookie(issued.token, issued.expiresIn),
  )
}
