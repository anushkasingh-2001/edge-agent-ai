/**
 * GET /api/policy/load?projectPath=...
 *
 * Convenience alias for `GET /api/policy/evaluate?projectPath=...`. Both
 * return the parsed `.edgeagent/policy.yaml` (or `DEFAULT_POLICY` when
 * the file is missing) plus any lenient-parse warnings; this route exists
 * so the Settings → Policy Rules UI has a semantically obvious endpoint
 * to call on mount without dragging an "evaluate" verb into its
 * vocabulary. Going through `loadPolicyFor` means the file lookup
 * inherits the same allow-root sandboxing as every other policy
 * endpoint.
 */

import { NextResponse } from "next/server"
import { GitError, resolveProjectPath } from "@/lib/server-git"
import { loadPolicyFor } from "@/lib/server-policy"

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const { resolved } = resolveProjectPath(url.searchParams.get("projectPath"))
    const loaded = loadPolicyFor(resolved)
    return NextResponse.json({ ...loaded, evaluation: null })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
