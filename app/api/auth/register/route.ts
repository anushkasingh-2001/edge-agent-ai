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
  issueRefreshToken,
  issueVerificationToken,
  rateLimitedResponse,
  sessionCookie,
  tokensVisibleToClient,
} from "@/lib/server-account"
import { clientIp, enforceRateLimit, HOUR } from "@/lib/server-rate-limit"
import { sendVerificationEmail } from "@/lib/server-email"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

export async function POST(req: Request) {
  // Abuse brake: max 5 new accounts per IP per hour.
  const rl = await enforceRateLimit("register:ip", clientIp(req), 5, HOUR)
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

  let created
  try {
    const passwordHash = await hashPassword(password)
    created = await users.createUser({ email, passwordHash, name })
  } catch (e) {
    if (e instanceof UserExistsError) {
      return accountJson(req, { error: e.message, code: e.code }, 409)
    }
    const status = (e as { status?: number })?.status ?? 500
    const code = (e as { code?: string })?.code ?? "register_failed"
    return accountJson(
      req,
      { error: "Could not create account.", code },
      status === 503 ? 503 : 500,
    )
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

  // Create an email-verification token and a refresh token so the client can
  // renew without re-login.
  const verification = await issueVerificationToken(user.id)
  const refresh = await issueRefreshToken(user.id, workspace.id)

  // Send the verification email (best-effort; never blocks account creation,
  // never logs the token/link).
  if (verification) {
    await sendVerificationEmail(user.email, verification.token)
  }

  return accountJsonWithCookie(
    req,
    {
      ok: true,
      token: issued.token,
      expiresAt: issued.expiresAt,
      refreshToken: refresh?.token,
      user: issued.publicUser,
      // Dev/test convenience only — never returned in production.
      ...(tokensVisibleToClient() && verification
        ? { verificationToken: verification.token }
        : {}),
    },
    201,
    sessionCookie(issued.token, issued.expiresIn),
  )
}
