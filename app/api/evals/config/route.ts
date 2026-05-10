import { NextResponse } from "next/server"
import {
  GitError,
  resolveProjectPath,
} from "@/lib/server-git"
import {
  EVALS_CONFIG_REL_PATH,
  loadEvalsConfig,
} from "@/lib/server-evals"

/**
 * GET /api/evals/config?projectPath=/abs/path
 *
 * Reads `<projectPath>/.edgeagent/evals.yaml` and returns the parsed
 * config plus a list of agent names. Returns `exists: false` (with
 * an empty agents map and the canonical config path) when the file
 * isn't present so the UI can render the empty state with a path
 * for the user to create.
 *
 * Schema/YAML errors are surfaced verbatim in `errors` — never as a
 * 500 — so the user can fix their YAML inline without digging
 * through server logs.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectPath = (url.searchParams.get("projectPath") ?? "").trim()
  if (!projectPath) {
    return NextResponse.json(
      { error: "projectPath is required" },
      { status: 400 }
    )
  }
  try {
    const { resolved } = resolveProjectPath(projectPath)
    const loaded = loadEvalsConfig(resolved)
    return NextResponse.json({
      exists: loaded.exists,
      configPath: loaded.configPath,
      // Echo the canonical relative path so the UI can show
      // "create a file at <project>/.edgeagent/evals.yaml" without
      // hard-coding the constant.
      configRelPath: EVALS_CONFIG_REL_PATH,
      agents: Object.entries(loaded.config.agents).map(([name, cfg]) => ({
        name,
        command: cfg.command,
        timeoutMs: cfg.timeout_ms ?? null,
        cwd: cfg.cwd ?? null,
        // Surface metric hints (UI uses them to render placeholder
        // columns before the first run); strip env values to avoid
        // leaking secrets through the config response.
        metrics: cfg.metrics ?? null,
        envKeys: cfg.env ? Object.keys(cfg.env) : [],
      })),
      errors: loaded.errors,
    })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
