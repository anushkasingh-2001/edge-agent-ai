/**
 * GET /api/github/status
 *
 * Inspects the user's local `gh` CLI install:
 *   - is it on PATH? (gh --version)
 *   - is anyone logged in? (gh auth status)
 *   - if so, who? (gh api user --jq .login)
 *
 * Returns a flat `{ ghInstalled, authenticated, login, message }` shape
 * so the Settings card can render any of the four states without
 * having to interpret `gh` exit codes itself.
 */

import { NextResponse } from "next/server"
import { checkGitHubStatus } from "@/lib/server-github"

export async function GET() {
  try {
    const status = checkGitHubStatus()
    return NextResponse.json(status)
  } catch (err) {
    return NextResponse.json(
      {
        ghInstalled: false,
        authenticated: false,
        login: null,
        message:
          "Failed to inspect GitHub auth: " +
          (err instanceof Error ? err.message : String(err)),
        authSource: null,
        appAuthenticated: false,
        appLogin: null,
        ghAuthenticated: false,
        ghLogin: null,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
