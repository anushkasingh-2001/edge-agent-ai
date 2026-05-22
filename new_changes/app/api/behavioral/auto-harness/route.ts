// SCAFFOLD ONLY — DO NOT TREAT AS A WORKING ENDPOINT.
// TODO: UI execution not wired yet.
// TODO: must call the Python behavioral runner
//       (edge_agent_scanner.behavioral.runner.run_behavioral_suites).
// TODO: must run inside the Docker sandbox (edge_agent_scanner.harness).
// This route does not execute behavioral tests; it only returns placeholder data.

import { NextResponse } from "next/server"

// Scaffold only. Wire this route to your Python scanner backend that calls:
// edge_agent_scanner.harness.planner.build_harness_plan(repoPath)
//
// Do not execute arbitrary repo commands directly from this route.

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const repoPath = body.repoPath

  if (!repoPath || typeof repoPath !== "string") {
    return NextResponse.json({ error: "repoPath is required" }, { status: 400 })
  }

  return NextResponse.json({
    status: "not_implemented",
    message:
      "Wire this route to the Python harness planner. It should inspect repo files, propose .edgeagent/evals.yaml, and run only in sandbox.",
    repoPath,
  })
}
