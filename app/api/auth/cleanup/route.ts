/**
 * POST/GET /api/auth/cleanup  —  cron-safe auth-token maintenance.
 *
 * Deletes spent/expired verification, reset, and refresh tokens. Intended for
 * a scheduled invocation (e.g. Vercel Cron hitting it daily).
 *
 * AUTH: requires `AUTH_CLEANUP_SECRET` (or Vercel's `CRON_SECRET`) to be set
 * AND presented either as `Authorization: Bearer <secret>` or `?key=<secret>`.
 * Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET`. If no
 * secret is configured the route is disabled (404) so it can't be abused.
 *
 * SECURITY: returns only delete COUNTS — never any token value.
 */

import { cleanupAuthTokens } from "@/lib/server-auth-token-cleanup"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

function secrets(): string[] {
  return [process.env.AUTH_CLEANUP_SECRET, process.env.CRON_SECRET]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
}

function authorized(req: Request): boolean {
  const allowed = secrets()
  if (allowed.length === 0) return false
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  const key = new URL(req.url).searchParams.get("key") ?? ""
  return allowed.includes(bearer) || allowed.includes(key)
}

async function handle(req: Request): Promise<Response> {
  if (secrets().length === 0) {
    return new Response(JSON.stringify({ error: "Not found." }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  }
  const deleted = await cleanupAuthTokens()
  return new Response(JSON.stringify({ ok: true, deleted }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

export async function POST(req: Request) {
  return handle(req)
}

export async function GET(req: Request) {
  return handle(req)
}
