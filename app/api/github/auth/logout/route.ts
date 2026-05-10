/**
 * POST /api/github/auth/logout
 *
 * Removes the on-disk auth file so subsequent requests fall back to
 * gh CLI (if available) or treat the user as signed out. Idempotent.
 */

import { NextResponse } from "next/server"
import { clearAuth } from "@/lib/server-github-auth"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    clearAuth()
    return NextResponse.json({ ok: true, authenticated: false })
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        reason: "storage",
        message: `Could not delete the auth file: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 }
    )
  }
}
