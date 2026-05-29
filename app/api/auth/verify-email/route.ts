/**
 * GET/POST /api/auth/verify-email  —  consume an email-verification token.
 *
 * The token is read from `?token=` (GET, for an email link) or the JSON body
 * `{ token }` (POST). On a valid, unexpired, unused token the user's
 * `emailVerified` flag is set and the token is consumed (single-use).
 *
 * After verifying, the client should call /api/auth/refresh (or re-login) to
 * obtain an access token whose `email_verified` claim is now true.
 *
 * SECURITY: lookup is by token HASH; the raw token is never stored. No
 * provider key is involved.
 */

import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import { hashToken } from "@/lib/server-password"
import { accountJson, accountPreflight } from "@/lib/server-account"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

async function handle(req: Request, token: string): Promise<Response> {
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

  return accountJson(req, { ok: true, emailVerified: true }, 200)
}

export async function POST(req: Request) {
  let body: { token?: unknown } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    body = {}
  }
  return handle(req, typeof body.token === "string" ? body.token : "")
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? ""
  return handle(req, token)
}
