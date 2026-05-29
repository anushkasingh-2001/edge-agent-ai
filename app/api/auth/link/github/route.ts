/**
 * POST /api/auth/link/github  —  link a GitHub identity to the account.
 *
 * Body: { token }  (a GitHub access token / PAT)
 *
 * Requires an Edge Agent AI account session (Bearer JWT). The GitHub token is
 * verified server-side against GitHub's /user, and the resulting identity is
 * stored in `linked_accounts` keyed by the ACCOUNT userId. GitHub remains an
 * OPTIONAL integration for repo/PR access — it never becomes the billing
 * identity, and subscriptions/credits stay attached to the account.
 *
 * SECURITY: the GitHub token is used only to confirm the identity and is NOT
 * persisted or returned to the renderer. We store an opaque `token_ref` only.
 * No provider API key is involved.
 */

import { getOptionalSession } from "@/lib/server-auth"
import { verifyGithubIdentity } from "@/lib/server-cloud-session"
import { ensureUserBootstrap, getAsyncUserStore } from "@/lib/server-user-bootstrap"
import { hashToken } from "@/lib/server-password"
import { accountJson, accountPreflight } from "@/lib/server-account"

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

  let body: { token?: unknown } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    body = {}
  }
  const token = typeof body.token === "string" ? body.token.trim() : ""
  if (!token) {
    return accountJson(req, { error: "A GitHub token is required.", code: "missing_token" }, 400)
  }

  const identity = await verifyGithubIdentity(token)
  if (!identity.ok) {
    return accountJson(req, { error: identity.error, code: identity.code }, identity.status)
  }

  await ensureUserBootstrap()
  // We store only a non-reversible reference to the token, never the token
  // itself. (The desktop edition holds the actual PAT on local disk for git
  // operations; the cloud only needs to know the link exists.)
  const link = await getAsyncUserStore().linkAccount({
    userId: session.userId,
    provider: "github",
    providerUserId: identity.userId.replace(/^github:/, ""),
    tokenRef: `gh_${hashToken(token).slice(0, 24)}`,
  })

  // Public info only — never the PAT.
  return accountJson(
    req,
    {
      ok: true,
      linked: {
        provider: link.provider,
        login: identity.login,
        providerUserId: link.providerUserId,
        linkedAt: link.createdAt,
      },
    },
    200,
  )
}
