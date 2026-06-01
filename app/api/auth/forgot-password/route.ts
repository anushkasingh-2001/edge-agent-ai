/**
 * POST /api/auth/forgot-password  —  start a password reset.
 *
 * Body: { email }
 *
 * Always returns 200 with a generic message, whether or not the email exists,
 * so the endpoint can't be used to enumerate accounts. When the account does
 * exist, a short-lived reset token is created (hash stored only) and emailed
 * in production / surfaced in dev.
 */

import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import { normalizeEmail } from "@/lib/server-user-store"
import {
  accountJson,
  accountPreflight,
  isValidEmail,
  issueResetToken,
  rateLimitedResponse,
  resetLinkPayload,
} from "@/lib/server-account"
import { clientIp, enforceRateLimit, HOUR } from "@/lib/server-rate-limit"
import { sendPasswordResetEmail } from "@/lib/server-email"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

const GENERIC = {
  ok: true,
  message: "If an account exists for that email, a password reset link has been sent.",
} as const

export async function POST(req: Request) {
  // Per-IP brake (60/hour) so the endpoint can't be used to enumerate/spam.
  const ipRl = await enforceRateLimit("forgot:ip", clientIp(req), 60, HOUR)
  if (!ipRl.ok) return rateLimitedResponse(req, ipRl.retryAfterSec)

  let body: { email?: unknown } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    body = {}
  }
  const email = normalizeEmail(typeof body.email === "string" ? body.email : "")
  if (!isValidEmail(email)) {
    // Still generic — don't reveal that the email was malformed vs unknown.
    return accountJson(req, GENERIC, 200)
  }

  // Max 8 reset requests per email per hour. The 429 is returned generically
  // (same shape as the success path would never reveal account existence).
  const emailRl = await enforceRateLimit("forgot:email", email, 8, HOUR)
  if (!emailRl.ok) return rateLimitedResponse(req, emailRl.retryAfterSec)

  await ensureUserBootstrap()
  const user = await getAsyncUserStore().getUserByEmail(email)
  if (!user) {
    return accountJson(req, GENERIC, 200)
  }

  const reset = await issueResetToken(user.id)
  let emailSent = false
  if (reset) {
    const res = await sendPasswordResetEmail(user.email, reset.token)
    emailSent = res.ok
  }

  return accountJson(
    req,
    {
      ...GENERIC,
      // Surfaced in demo mode (no provider, or the email bounced) or dev opt-in;
      // once a real provider delivers successfully the link is email-only.
      ...(reset ? resetLinkPayload(reset.token, !emailSent) : {}),
    },
    200,
  )
}
