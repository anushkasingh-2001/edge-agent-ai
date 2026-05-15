/**
 * POST /api/policy/save
 *
 * Body: { projectPath: string, policy: Policy }
 *
 * Writes the supplied Policy to `<projectPath>/.edgeagent/policy.yaml`
 * via an atomic tmp-then-rename. Creates `.edgeagent/` if it doesn't
 * exist. The same lenient parser used at load time then re-reads the
 * file and is returned in the response so the client can detect a
 * mismatch between "what I sent" and "what's now on disk" without a
 * second round-trip.
 *
 * Validation: we parse the supplied policy through the lenient YAML
 * parser (after serialising to YAML and back) so unknown keys are
 * dropped and parse warnings surface to the user instead of being
 * silently persisted.
 */

import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { GitError, resolveProjectPath } from "@/lib/server-git"
import {
  DEFAULT_POLICY,
  parsePolicyYaml,
  serializePolicyToYaml,
  TOGGLABLE_NUMERIC_KEYS,
  type Policy,
} from "@/lib/policy"
import { loadPolicyFor, POLICY_REL_PATH } from "@/lib/server-policy"

interface SaveBody {
  projectPath?: string
  policy?: unknown
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as SaveBody
    const { resolved } = resolveProjectPath(body.projectPath)

    // Run the supplied policy through the same merge-with-defaults
    // path the loader uses. This drops unknown keys, applies the
    // canonical key order, and guarantees the file we write is
    // round-trippable.
    const merged = mergeWithDefaults(body.policy)
    const yaml = serializePolicyToYaml(merged)

    // Validate by re-parsing — if the parser disagrees with our
    // output we bail rather than persisting something we can't read
    // back.
    const reparsed = parsePolicyYaml(yaml)
    if (reparsed.errors.length > 0 && !reparsed.parsed) {
      return NextResponse.json(
        {
          error: "Serialised policy failed re-parse",
          errors: reparsed.errors,
        },
        { status: 400 }
      )
    }

    const absolute = path.join(resolved, POLICY_REL_PATH)
    const dir = path.dirname(absolute)
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
      const tmp = `${absolute}.tmp.${process.pid}`
      fs.writeFileSync(tmp, yaml, { mode: 0o644, encoding: "utf-8" })
      fs.renameSync(tmp, absolute)
    } catch (e) {
      return NextResponse.json(
        {
          error: `Failed to write ${POLICY_REL_PATH}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
        { status: 500 }
      )
    }

    // Re-load via the same code path the rest of the app uses so the
    // response reflects exactly what the backend will enforce.
    const loaded = loadPolicyFor(resolved)
    return NextResponse.json({
      ...loaded,
      saved: true,
      bytesWritten: yaml.length,
    })
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

/**
 * Merge a client-supplied object into `DEFAULT_POLICY`. Tolerant of
 * missing sub-objects (so callers can PATCH just `security` without
 * sending the whole policy) and of unknown keys (dropped).
 *
 * Important: togglable numeric thresholds (see TOGGLABLE_NUMERIC_KEYS)
 * use `null` on the wire to mean "user explicitly disabled this rule".
 * For those keys we MUST NOT fall back to DEFAULT_POLICY — otherwise
 * toggling a threshold off in the UI silently reappears as ON after
 * save, because JSON.stringify already drops `undefined` and our merge
 * would re-apply the default. We strip `null` so the rest of the code
 * (which uses `undefined` for "off") stays unchanged, but `serialize`
 * will re-emit it as `null` on disk to make the choice durable.
 */
function mergeWithDefaults(raw: unknown): Policy {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_POLICY
  }
  const r = raw as Record<string, unknown>
  const mode = typeof r.mode === "string" ? r.mode : DEFAULT_POLICY.mode
  const get = <K extends keyof Policy>(k: K): Record<string, unknown> => {
    const v = r[k as string]
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  }
  const mergeSection = <T extends object>(
    defaults: T,
    incoming: Record<string, unknown>,
    togglableKeys: readonly string[] = []
  ): T => {
    const merged = { ...(defaults as Record<string, unknown>) }
    const togglable = new Set(togglableKeys)
    for (const [k, v] of Object.entries(incoming)) {
      if (v === null && togglable.has(k)) {
        delete merged[k]
      } else if (v !== undefined) {
        merged[k] = v
      }
    }
    return merged as T
  }
  return {
    mode: mode as Policy["mode"],
    security: mergeSection<Policy["security"]>(
      DEFAULT_POLICY.security,
      get("security"),
      TOGGLABLE_NUMERIC_KEYS.security
    ),
    evals: mergeSection<Policy["evals"]>(
      DEFAULT_POLICY.evals,
      get("evals"),
      TOGGLABLE_NUMERIC_KEYS.evals
    ),
    agents:
      r.agents && typeof r.agents === "object" && !Array.isArray(r.agents)
        ? (r.agents as Policy["agents"])
        : {},
    auto_merge: mergeSection(DEFAULT_POLICY.auto_merge, get("auto_merge")),
    pull_request: mergeSection(DEFAULT_POLICY.pull_request, get("pull_request")),
    commit: mergeSection(DEFAULT_POLICY.commit, get("commit")),
    push: mergeSection(DEFAULT_POLICY.push, get("push")),
  }
}
