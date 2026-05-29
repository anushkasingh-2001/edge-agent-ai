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
  rateLimitedResponse,
  sessionCookie,
} from "@/lib/server-account"
import {
  clientIp,
  isRateLimited,
  recordFailure,
  MIN,
} from "@/lib/server-rate-limit"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

const INVALID = { error: "Invalid email or password.", code: "invalid_credentials" } as const
// Max 5 failed attempts per (email+IP) per 15 minutes. Successful logins don't
// consume the budget.
const LOGIN_MAX_FAILURES = 5
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
    await recordFailure("login:fail", limitKey, LOGIN_WINDOW_MS)
    return accountJson(req, INVALID, 401)
  }

  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) {
    await recordFailure("login:fail", limitKey, LOGIN_WINDOW_MS)
    return accountJson(req, INVALID, 401)
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
