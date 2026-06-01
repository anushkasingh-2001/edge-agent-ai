/**
 * GET/POST /api/auth/verify-email  —  verify an email address.
 *
 * Primary path is the OTP CODE: POST `{ email, code }`.
 *   - If a PENDING registration exists for the email, a correct code PROMOTES
 *     it to a real account (creates users/workspaces rows, seeds billing) and
 *     signs the user in. This is what makes "no account until verified" true.
 *   - Otherwise (legacy unverified user with a verification code), it marks the
 *     existing user verified and signs them in.
 *
 * Legacy LINK path (back-compat): `?token=` (GET) or POST `{ token }`.
 *
 * SECURITY: lookup is by HASH; the raw code/token is never stored. The code
 * path is rate-limited so the small 6-digit space can't be brute-forced.
 */

import { ensureBootstrap, getAsyncBillingStore } from "@/lib/server-billing-bootstrap"
import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import { hashToken } from "@/lib/server-password"
import { UserExistsError, normalizeEmail } from "@/lib/server-user-store"
import {
  accountJson,
  accountJsonWithCookie,
  accountPreflight,
  findVerificationCode,
  issueAccountSession,
  issueRefreshToken,
  rateLimitedResponse,
  sessionCookie,
  verifyPendingRegistration,
} from "@/lib/server-account"
import { clientIp, enforceRateLimit, MIN } from "@/lib/server-rate-limit"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

const INVALID = { error: "That code is invalid or has expired.", code: "invalid_code" } as const

/** Mint a session for a now-verified user (auto-login). */
async function sessionResponse(req: Request, userId: string): Promise<Response> {
  const users = getAsyncUserStore()
  const user = await users.getUserById(userId)
  if (user) {
    const workspace = await users.getWorkspaceForUser(user.id)
    const workspaceId = workspace?.id ?? user.id
    const issued = issueAccountSession({ ...user, emailVerified: true }, workspaceId)
    if (issued) {
      const refresh = await issueRefreshToken(user.id, workspaceId)
      return accountJsonWithCookie(
        req,
        {
          ok: true,
          emailVerified: true,
          token: issued.token,
          expiresAt: issued.expiresAt,
          refreshToken: refresh?.token,
          user: issued.publicUser,
        },
        200,
        sessionCookie(issued.token, issued.expiresIn),
      )
    }
  }
  // Verified, but couldn't mint a session (e.g. no JWT_SECRET). Still report
  // success — the user can sign in with their password now.
  return accountJson(req, { ok: true, emailVerified: true }, 200)
}

/** Best-effort: seed a free billing subscription for a newly created account. */
async function seedBilling(userId: string, workspaceId: string, email: string, name?: string) {
  try {
    await ensureBootstrap()
    await getAsyncBillingStore().upsertSubscription(userId, workspaceId, {
      email,
      firstName: name ? name.split(" ")[0] : undefined,
    })
  } catch {
    /* non-fatal */
  }
}

/** Primary path: verify a 6-digit OTP code entered in the app. */
async function handleCode(req: Request, email: string, code: string): Promise<Response> {
  const normalized = normalizeEmail(email)
  const digits = code.replace(/\D/g, "")

  // Brake brute-force of the 6-digit space: 10 attempts / 15 min per email+IP.
  const rl = await enforceRateLimit("verify-code", `${normalized}|${clientIp(req)}`, 10, 15 * MIN)
  if (!rl.ok) return rateLimitedResponse(req, rl.retryAfterSec)

  if (!normalized || digits.length !== 6) {
    return accountJson(req, INVALID, 400)
  }

  await ensureUserBootstrap()
  const users = getAsyncUserStore()

  // (1) PENDING registration → promote to a real account on the correct code.
  const pending = await verifyPendingRegistration(normalized, digits)
  if (pending) {
    let userId: string
    let workspaceId: string
    try {
      const created = await users.createUser({
        email: pending.email,
        passwordHash: pending.passwordHash,
        name: pending.name,
      })
      userId = created.user.id
      workspaceId = created.workspace.id
    } catch (e) {
      if (e instanceof UserExistsError) {
        // Raced / a legacy row already holds this email — adopt it.
        const u = await users.getUserByEmail(normalized)
        if (!u) return accountJson(req, INVALID, 400)
        await users.updatePassword(u.id, pending.passwordHash)
        userId = u.id
        const ws = await users.getWorkspaceForUser(u.id)
        workspaceId = ws?.id ?? u.id
      } else {
        throw e
      }
    }
    await users.markEmailVerified(userId)
    await seedBilling(userId, workspaceId, pending.email, pending.name)
    await users.deletePendingRegistration(normalized)
    return sessionResponse(req, userId)
  }

  // A pending row exists but the code didn't match → fail closed (don't fall
  // through to the user path).
  if (await users.getPendingRegistration(normalized)) {
    return accountJson(req, INVALID, 400)
  }

  // (2) Existing-user path (legacy unverified user with a verification code).
  const user = await users.getUserByEmail(normalized)
  if (!user) {
    return accountJson(req, INVALID, 400)
  }
  if (user.emailVerified) {
    return accountJson(req, { ok: true, emailVerified: true, alreadyVerified: true }, 200)
  }
  const rec = await findVerificationCode(user.id, digits)
  if (!rec) {
    return accountJson(req, INVALID, 400)
  }
  await users.markEmailVerified(user.id)
  await users.consumeVerificationToken(rec.id)
  return sessionResponse(req, user.id)
}

/** Legacy path: verify a link token (hash lookup). */
async function handleToken(req: Request, token: string): Promise<Response> {
  const raw = token.trim()
  if (!raw) {
    return accountJson(req, { error: "A verification token is required.", code: "bad_request" }, 400)
  }
  await ensureUserBootstrap()
  const users = getAsyncUserStore()
  const rec = await users.findVerificationToken(hashToken(raw))
  if (!rec) {
    return accountJson(
      req,
      { error: "This verification link is invalid or has expired.", code: "invalid_token" },
      400,
    )
  }
  await users.markEmailVerified(rec.userId)
  await users.consumeVerificationToken(rec.id)
  return sessionResponse(req, rec.userId)
}

export async function POST(req: Request) {
  let body: { token?: unknown; email?: unknown; code?: unknown } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    body = {}
  }
  const email = typeof body.email === "string" ? body.email : ""
  const code = typeof body.code === "string" ? body.code : ""
  if (email && code) {
    return handleCode(req, email, code)
  }
  return handleToken(req, typeof body.token === "string" ? body.token : "")
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? ""
  return handleToken(req, token)
}
