/**
 * POST /api/github/pr/auto-merge
 *
 * Body:
 *   {
 *     projectPath: string
 *     prUrl: string                              // https://github.com/owner/repo/pull/123
 *     mergeMethod?: "squash" | "merge" | "rebase"  // default squash
 *   }
 *
 * Behaviour:
 *   1. Resolve + authorise projectPath; ensure git repo.
 *   2. Load .edgeagent/policy.yaml. Refuse unless
 *        mode === "auto_merge"
 *        AND auto_merge.enabled === true
 *      We do not run a fresh scan here — auto-merge is only ever
 *      requested by the Create PR flow which already evaluated, and
 *      bypassing the policy because the user clicked twice would be
 *      a footgun.
 *   3. `gh pr merge <prUrl> --auto --<method>`.
 *
 * The actual policy-pass check happens at Create-PR time. This endpoint
 * only enforces "is auto-merge structurally allowed by the policy".
 * That keeps it cheap (no scan) and idempotent (safe to call from a
 * "Retry auto-merge" button later).
 */

import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
} from "@/lib/server-git"
import {
  DEFAULT_POLICY,
  parsePolicyYaml,
  type Policy,
} from "@/lib/policy"
import { enableAutoMerge } from "@/lib/server-github"

const POLICY_REL_PATH = ".edgeagent/policy.yaml"

function loadPolicyFor(projectPath: string): Policy {
  const absolute = path.join(projectPath, POLICY_REL_PATH)
  if (!fs.existsSync(absolute)) return DEFAULT_POLICY
  try {
    const text = fs.readFileSync(absolute, "utf-8")
    const { policy } = parsePolicyYaml(text)
    return policy
  } catch {
    return DEFAULT_POLICY
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      prUrl?: string
      mergeMethod?: "squash" | "merge" | "rebase"
    }
    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    if (!body.prUrl || typeof body.prUrl !== "string") {
      return NextResponse.json(
        { ok: false, reason: "validation", message: "prUrl is required." },
        { status: 400 }
      )
    }

    const policy = loadPolicyFor(resolved)
    if (policy.mode !== "auto_merge" || !policy.auto_merge?.enabled) {
      return NextResponse.json(
        {
          ok: false,
          reason: "policy_disallows",
          message:
            "Auto-merge is disabled by .edgeagent/policy.yaml. Set `mode: auto_merge` and `auto_merge.enabled: true` to use this endpoint.",
        },
        { status: 412 }
      )
    }

    const result = enableAutoMerge({
      cwd: resolved,
      prUrl: body.prUrl,
      method: body.mergeMethod ?? "squash",
    })
    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          reason: result.reason,
          message: result.message,
          stderr: result.stderr,
        },
        { status: 502 }
      )
    }
    return NextResponse.json({
      ok: true,
      message: "Auto-merge enabled. GitHub will merge this PR once required checks pass.",
      stdout: result.stdout,
    })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { ok: false, reason: "git_error", message: err.message },
        { status: err.status }
      )
    }
    return NextResponse.json(
      {
        ok: false,
        reason: "unknown",
        message: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
