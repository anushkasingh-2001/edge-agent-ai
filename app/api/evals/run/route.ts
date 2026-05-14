import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
  resolveRef,
} from "@/lib/server-git"
import {
  appendEvalRun,
  loadEvalsConfig,
  newEvalRunId,
  runAgentEvals,
  setupEvalWorktree,
  type AgentRunReport,
  type PersistedEvalRun,
} from "@/lib/server-evals"

/**
 * POST /api/evals/run
 *
 * Body: {
 *   projectPath: string,
 *   branch?: string,             // default: HEAD
 *   agents?: string[],           // default: every agent in the config
 *   includeStashes?: boolean,    // default: false
 *   includeWorkingTree?: boolean // default: true — mirror the
 *                                //   user's tracked-modified +
 *                                //   untracked files into the
 *                                //   eval worktree. Set to false
 *                                //   to evaluate pristine HEAD only.
 * }
 *
 * Materialises a temp `git worktree` at `branch`'s HEAD with the
 * user's working tree mirrored on top (so an as-yet-uncommitted
 * `evals/run_my_eval.py` actually runs), and — if
 * `includeStashes: true` — every `git stash` attributed to that
 * branch layered on top of THAT (oldest → newest, latest wins).
 * Then runs each agent's command from `.edgeagent/evals.yaml`
 * inside the worktree and persists results to
 * `.edgeagent/eval-history.jsonl` for the History view.
 *
 * Errors at the per-agent level (timeout, non-zero exit, malformed
 * JSON) are returned as `AgentRunReport` entries with `status !==
 * "ok"` rather than failing the whole request — partial results
 * are more useful than a single 500.
 */
export async function POST(request: Request) {
  let cleanup: (() => void) | null = null
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      branch?: string
      agents?: string[]
      includeStashes?: boolean
      includeWorkingTree?: boolean
    }
    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const loaded = loadEvalsConfig(resolved)
    if (!loaded.exists) {
      return NextResponse.json(
        {
          ok: false,
          error: `No eval config at ${loaded.configPath}. Create the file with at least one agent before running evals.`,
          configPath: loaded.configPath,
        },
        { status: 404 }
      )
    }
    if (loaded.errors.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "evals.yaml failed to parse",
          configPath: loaded.configPath,
          errors: loaded.errors,
        },
        { status: 400 }
      )
    }
    const allAgents = Object.entries(loaded.config.agents)
    if (allAgents.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "evals.yaml has no `agents:` entries. Add at least one agent block before running.",
          configPath: loaded.configPath,
        },
        { status: 400 }
      )
    }

    const requestedAgents = Array.isArray(body.agents) ? body.agents : []
    const agents =
      requestedAgents.length > 0
        ? allAgents.filter(([name]) => requestedAgents.includes(name))
        : allAgents
    if (agents.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `None of the requested agents are configured. Available: ${allAgents
            .map(([n]) => n)
            .join(", ")}.`,
        },
        { status: 400 }
      )
    }

    const branchInput = (body.branch ?? "HEAD").trim() || "HEAD"
    const includeStashes = body.includeStashes === true
    // Default ON: 99% of the time the user is iterating on an
    // eval script that isn't committed yet. Honour an explicit
    // `false` for callers who want to score pristine HEAD.
    const includeWorkingTree = body.includeWorkingTree !== false

    // Resolve the branch to a concrete SHA up front. We feed the
    // SHA (not the branch name) to `worktree add --detach` so a
    // mid-run branch switch on the user's side can't surprise us.
    let branchSha: string
    let branchName: string
    try {
      const resolved2 = resolveRef(resolved, branchInput)
      branchSha = resolved2.sha
      // For stash attribution we want the SHORT branch name the
      // user picked, not e.g. `refs/remotes/origin/main`. Stash
      // subjects are recorded with short names.
      branchName = branchInput
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: `Could not resolve branch '${branchInput}': ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
        { status: 400 }
      )
    }

    // Build the worktree (mirror working tree + apply stashes if
    // asked). Wrap in try/finally so cleanup runs even if the
    // run throws.
    const setup = setupEvalWorktree({
      repo: resolved,
      branch: branchName,
      sha: branchSha,
      includeStashes,
      includeWorkingTree,
    })
    cleanup = setup.cleanup

    // Run each agent's command and collect per-agent reports.
    const reports: AgentRunReport[] = runAgentEvals({
      worktreeDir: setup.dir,
      agents: agents.map(([name, config]) => ({ name, config })),
    })

    const entry: PersistedEvalRun = {
      id: newEvalRunId(),
      ranAt: new Date().toISOString(),
      branch: branchName,
      sha: branchSha,
      includeStashes,
      includeWorkingTree,
      mirroredFiles: setup.mirroredFiles,
      appliedStashes: setup.stashApply.applied.map((s) => ({
        ref: s.ref,
        subject: s.subject,
      })),
      skippedStashes: setup.stashApply.skipped.map((s) => ({
        ref: s.entry.ref,
        subject: s.entry.subject,
        reason: s.reason,
      })),
      reports,
    }
    const written = appendEvalRun(resolved, entry)

    return NextResponse.json({
      ok: true,
      run: entry,
      historyWritten: written.ok,
      historyError: written.ok ? null : written.error,
    })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: err.status }
      )
    }
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 }
    )
  } finally {
    if (cleanup) {
      try {
        cleanup()
      } catch {
        /* swallow — cleanup is best-effort */
      }
    }
  }
}
