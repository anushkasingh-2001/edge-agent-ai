/**
 * POST /api/auth/logout-all  —  sign out of every device.
 *
 * Requires an account session (Bearer JWT). Revokes ALL of the caller's
 * refresh tokens so no device can mint a new access token; each will fall back
 * to the login dialog on its next 401.
 *
 * Also clears the same-origin session cookie. The current access JWT remains
 * valid until it expires (JWTs are stateless) — to make logout-all instant you
 * can pair this with a short access-token TTL; refresh is what's revoked here.
 *
 * SECURITY: no provider key, password hash, or raw token is involved.
 */

import { getOptionalSession } from "@/lib/server-auth"
import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import {
  accountJson,
  accountJsonWithCookie,
  accountPreflight,
  sessionCookie,
} from "@/lib/server-account"

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

  await ensureUserBootstrap()
  let revoked = 0
  try {
    revoked = await getAsyncUserStore().revokeAllRefreshTokens(session.userId)
  } catch (e) {
    const status = (e as { status?: number })?.status === 503 ? 503 : 500
    return accountJson(req, { error: "Could not sign out everywhere.", code: "logout_all_failed" }, status)
  }

  // Expire the same-origin cookie too.
  return accountJsonWithCookie(req, { ok: true, revoked }, 200, sessionCookie("", 0))
}
