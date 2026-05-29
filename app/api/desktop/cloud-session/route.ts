/**
 * POST /api/desktop/cloud-session  —  desktop login bridge (LOCAL route).
 *
 * Runs on the desktop's local Next server. The browser/renderer never sees
 * the user's GitHub token (it lives on disk via lib/server-github-auth.ts),
 * so the renderer can't call the cloud issuer directly. This route reads the
 * stored GitHub token server-side and exchanges it for a session JWT at the
 * cloud issuer (`${CLOUD_BASE}/api/auth/session`), then returns ONLY the
 * minted token + public user info to the renderer.
 *
 * This is a LOCAL route on purpose (it is NOT under a cloud route prefix in
 * lib/api-fetch.ts), because it must read the on-disk GitHub token. The
 * GitHub token is never returned to the client.
 *
 * When no separate cloud base is configured (single-origin web), the issuer
 * is this same deployment's `/api/auth/session`.
 */

import { NextResponse } from "next/server"
import { getStoredAuth } from "@/lib/server-github-auth"
import { getCloudApiBase } from "@/lib/api-fetch"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(req: Request) {
  const stored = getStoredAuth()
  if (!stored?.token) {
    return NextResponse.json(
      {
        ok: false,
        code: "github_login_required",
        error: "Sign in with GitHub first, then start a cloud session.",
      },
      { status: 401 },
    )
  }

  // Prefer the configured cloud backend; fall back to this same origin for a
  // single-origin web deployment that holds JWT_SECRET itself.
  const base = getCloudApiBase() || new URL(req.url).origin
  const issuer = `${base}/api/auth/session`

  let res: Response
  try {
    res = await fetch(issuer, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", token: stored.token }),
    })
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "cloud_unreachable",
        error: `Could not reach the cloud auth service: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      { status: 502 },
    )
  }

  let data: Record<string, unknown> = {}
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch {
    data = { ok: false, code: "bad_gateway", error: "Cloud auth service returned an unreadable response." }
  }

  // Pass the issuer's result straight through (it already excludes the
  // GitHub token and any secrets). Status is preserved so the client sees
  // 401/503 etc. unchanged.
  return NextResponse.json(data, { status: res.status })
}
