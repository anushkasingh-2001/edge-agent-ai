/**
 * GET /api/github/auth/status
 *
 * Lightweight check that returns whether the user has signed in via
 * Edge Agent AI itself. This is separate from /api/github/status,
 * which also probes the gh CLI — handy when the UI just wants to
 * decide "show login button" vs "show signed-in name".
 *
 * Never returns the token itself, only public metadata.
 */

import { NextResponse } from "next/server"
import { getStoredAuthPublic } from "@/lib/server-github-auth"

export const dynamic = "force-dynamic"

export async function GET() {
  const auth = getStoredAuthPublic()
  return NextResponse.json({
    ok: true,
    authenticated: !!auth,
    login: auth?.login ?? null,
    kind: auth?.kind ?? null,
    savedAt: auth?.savedAt ?? null,
    scopes: auth?.scopes ?? null,
  })
}
