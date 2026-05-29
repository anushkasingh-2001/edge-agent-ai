/**
 * POST /api/auth/session  —  production session issuance (cloud backend).
 *
 * Exchanges a verified third-party identity proof (a GitHub access token)
 * for a signed session JWT. This is the production-safe replacement for the
 * dev-only `/api/auth/dev-login` cookie flow: it works under
 * `NODE_ENV=production` and mints a token signed with the server's
 * `JWT_SECRET`. See lib/server-cloud-session.ts for the full contract.
 *
 * The response never contains a provider API key or the GitHub token.
 */

import { handleCloudSession, handleCloudSessionPreflight } from "@/lib/server-cloud-session"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(req: Request) {
  return handleCloudSession(req)
}

export async function OPTIONS(req: Request) {
  return handleCloudSessionPreflight(req)
}
