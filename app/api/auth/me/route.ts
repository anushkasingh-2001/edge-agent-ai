/**
 * GET /api/auth/me  —  the current Edge Agent AI account.
 *
 * Resolves the session from the Bearer JWT (or session cookie) and returns
 * identity + the account's plan/credit summary. Returns 401 when there is no
 * valid session. Never returns a password hash or any provider key.
 */

import { getOptionalSession } from "@/lib/server-auth"
import { ensureBootstrap, getAsyncBillingStore } from "@/lib/server-billing-bootstrap"
import { accountJson, accountPreflight } from "@/lib/server-account"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function OPTIONS(req: Request) {
  return accountPreflight(req)
}

export async function GET(req: Request) {
  const session = getOptionalSession(req)
  if (!session) {
    return accountJson(req, { error: "Not authenticated.", code: "not_authenticated" }, 401)
  }

  let plan: { tier: string; creditsLimit: number; creditsUsed: number } | undefined
  try {
    await ensureBootstrap()
    const sub = await getAsyncBillingStore().loadSubscription(
      session.userId,
      session.workspaceId,
    )
    plan = {
      tier: sub.planTier,
      creditsLimit: sub.creditsLimit,
      creditsUsed: sub.creditsUsed,
    }
  } catch {
    /* plan summary is best-effort; identity still returns */
  }

  return accountJson(
    req,
    {
      ok: true,
      user: {
        id: session.userId,
        userId: session.userId,
        workspaceId: session.workspaceId,
        email: session.email,
        name: session.name,
        role: session.role ?? "owner",
      },
      plan,
    },
    200,
  )
}
