/**
 * POST /api/github/auth/login
 *
 * Body: { token: string }
 *
 * Validates the token by calling GitHub's /user endpoint, captures
 * the login + granted scopes, and persists everything to the
 * on-disk auth file (mode 0600). Returns the public-safe metadata.
 *
 * Why server-side instead of letting the browser hit GitHub directly:
 *   1. The token never reaches the React tree, even via fetch
 *      response. We only return { login, scopes }.
 *   2. We want to atomically validate + store. A 200 means the token
 *      worked AND was saved.
 *   3. Same module that PR creation reads from, so no replication.
 */

import { NextResponse } from "next/server"
import { storeAuth } from "@/lib/server-github-auth"

export const dynamic = "force-dynamic"

const GH_API = "https://api.github.com"

export async function POST(request: Request) {
  let body: { token?: string } = {}
  try {
    body = (await request.json()) as { token?: string }
  } catch {
    return NextResponse.json(
      { ok: false, reason: "invalid_body", message: "Body must be JSON." },
      { status: 400 }
    )
  }

  const token = (body.token ?? "").trim()
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        reason: "missing_token",
        message: "Provide a Personal Access Token to sign in.",
      },
      { status: 400 }
    )
  }
  // Cheap shape check before we make a network call. PATs are
  // either classic (40-char hex with optional "ghp_" prefix) or
  // fine-grained ("github_pat_" + alphanum). Anything outside
  // that range is almost certainly a paste mistake.
  if (token.length < 20 || token.length > 255 || /\s/.test(token)) {
    return NextResponse.json(
      {
        ok: false,
        reason: "malformed_token",
        message:
          "That doesn't look like a GitHub Personal Access Token. Tokens are a single line, 20+ characters, no whitespace.",
      },
      { status: 400 }
    )
  }

  /* ----------- Validate via GET /user ----------- */
  let userJson: { login?: string } | null = null
  let scopes: string | undefined
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 15_000)
    let res: Response
    try {
      res = await fetch(`${GH_API}/user`, {
        signal: ac.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "edge-agent-ai",
          Authorization: `Bearer ${token}`,
        },
      })
    } finally {
      clearTimeout(t)
    }
    if (res.status === 401) {
      return NextResponse.json(
        {
          ok: false,
          reason: "invalid_token",
          message:
            "GitHub rejected this token (401). Generate a new Personal Access Token and try again.",
        },
        { status: 401 }
      )
    }
    if (res.status === 403) {
      return NextResponse.json(
        {
          ok: false,
          reason: "forbidden",
          message:
            "Token works but is forbidden from /user (403). It may be missing the 'read:user' scope.",
        },
        { status: 403 }
      )
    }
    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          reason: "github_error",
          message: `GitHub returned HTTP ${res.status} when validating the token.`,
        },
        { status: 502 }
      )
    }
    // Classic PATs include the granted scopes in this response header.
    // Fine-grained tokens don't (their scopes live on a different
    // endpoint), so this is best-effort.
    scopes = res.headers.get("x-oauth-scopes") ?? undefined
    userJson = (await res.json()) as { login?: string }
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        reason: "network",
        message: `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 }
    )
  }

  const login = userJson?.login?.trim()
  if (!login) {
    return NextResponse.json(
      {
        ok: false,
        reason: "no_login",
        message: "GitHub did not return a login for this token.",
      },
      { status: 502 }
    )
  }

  /* ----------- Persist ----------- */
  try {
    const stored = storeAuth({ token, login, kind: "pat", scopes })
    return NextResponse.json({
      ok: true,
      authenticated: true,
      login: stored.login,
      kind: stored.kind,
      savedAt: stored.savedAt,
      scopes: stored.scopes ?? null,
      message: `Signed in as ${stored.login}.`,
    })
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        reason: "storage",
        message: `Could not write the auth file: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 }
    )
  }
}
