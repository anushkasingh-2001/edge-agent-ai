/**
 * POST /api/auth/dev-login  —  DUMMY email login (no password, dev-only).
 *
 * Issues a signed `__edge_session` cookie (the same HS256 JWT format the
 * real OAuth callback would set) containing the user's email. This lets
 * the demo flow establish identity — "user enters email" — without a
 * real identity provider. The cookie is then resolved by
 * `getOptionalSession` / `assertSession` exactly like a production
 * session, so `/api/plan` and `/api/billing/dev-checkout` see the user.
 *
 * Body: { email: string }
 *
 * Requirements / guards:
 *   - `BILLING_MOCK=1` (same gate as dev-checkout; works on Vercel when enabled).
 *   - `JWT_SECRET` (or `EDGE_AGENT_JWT_SECRET`) set to >= 16 chars so the
 *     cookie can be signed and later verified.
 *
 * POST /api/auth/dev-login with no body and `?logout=1` clears the cookie.
 */

import { NextResponse } from "next/server"
import { _signHs256, SESSION_COOKIE_NAME } from "@/lib/server-auth"
import { billingMockEnabled } from "@/lib/server-billing-mock"
import { ensureBootstrap, getAsyncBillingStore } from "@/lib/server-billing-bootstrap"

export const dynamic = "force-dynamic"

interface DevLoginBody {
  email?: string
  firstName?: string
  lastName?: string
}

function jwtSecret(): string | null {
  const s =
    (process.env.JWT_SECRET ?? "").trim() ||
    (process.env.EDGE_AGENT_JWT_SECRET ?? "").trim()
  return s.length >= 16 ? s : null
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

function sessionCookie(value: string, maxAge: number): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ]
  return parts.join("; ")
}

export async function POST(req: Request) {
  if (!billingMockEnabled()) {
    return NextResponse.json(
      { error: "Dev login is disabled. Set BILLING_MOCK=1 or use /api/auth/login." },
      { status: 404 },
    )
  }

  const url = new URL(req.url)
  if (url.searchParams.get("logout") === "1") {
    const res = NextResponse.json({ ok: true, loggedOut: true })
    res.headers.set("Set-Cookie", sessionCookie("", 0))
    return res
  }

  const secret = jwtSecret()
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "JWT_SECRET (or EDGE_AGENT_JWT_SECRET) must be set to at least 16 characters to sign a dev session.",
        code: "jwt_secret_missing",
      },
      { status: 500 },
    )
  }

  let body: DevLoginBody = {}
  try {
    body = (await req.json()) as DevLoginBody
  } catch {
    body = {}
  }

  const email = (body.email ?? "").trim().toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 })
  }
  const firstName = (body.firstName ?? "").trim() || undefined
  const lastName = (body.lastName ?? "").trim() || undefined
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || undefined

  const now = Math.floor(Date.now() / 1000)
  const token = _signHs256(
    {
      sub: email,
      email,
      name: fullName,
      given_name: firstName,
      family_name: lastName,
      workspaceId: email,
      role: "owner",
      iat: now,
      exp: now + COOKIE_MAX_AGE,
    },
    secret,
  )

  // Persist the account (email + name) to the billing store now, so the
  // user's details land in the cloud at sign-up even before they pick a
  // plan. No planTier in the patch → the seeded "free"/"none" row is
  // kept; only identity fields are written.
  try {
    await ensureBootstrap()
    await getAsyncBillingStore().upsertSubscription(email, email, {
      email,
      firstName,
      lastName,
    })
  } catch {
    // Best-effort: a billing-store hiccup must not block sign-in. The
    // session cookie is still issued; the row will be created/updated on
    // the next /api/plan or plan selection.
  }

  // Return the JWT in the body too. On a single-origin web deployment the
  // HttpOnly cookie is what authenticates; on the desktop/cloud split the
  // renderer stores this token via `setCloudAuthToken` and apiFetch sends it
  // as a Bearer to cloud routes (and to the local fix/patch routes so they
  // can relay it to the cloud generation endpoint). It is a SESSION token,
  // never a provider key.
  const res = NextResponse.json({
    ok: true,
    email,
    name: fullName,
    authSource: "cookie",
    token,
  })
  res.headers.set("Set-Cookie", sessionCookie(token, COOKIE_MAX_AGE))
  return res
}
