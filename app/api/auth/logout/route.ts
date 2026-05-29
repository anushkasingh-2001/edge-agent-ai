/**
 * POST /api/auth/logout  —  clear the Edge Agent AI session cookie.
 *
 * The desktop also drops its stored Bearer token client-side (clearCloud
 * session). This route just expires the same-origin cookie; it is safe to
 * call when not logged in.
 */

import { accountJsonWithCookie, accountPreflight, sessionCookie } from "@/lib/server-account"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

export async function POST(req: Request) {
  // Max-Age=0 expires the cookie immediately.
  return accountJsonWithCookie(req, { ok: true }, 200, sessionCookie("", 0))
}
