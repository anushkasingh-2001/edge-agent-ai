import { NextResponse } from "next/server"

// Scaffold route.
// Wire this to your Python scanner backend/CLI that calls:
// edge_agent_scanner.behavioral.runner.run_behavioral_suites(repo_path)

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const repoPath = body.repoPath

  if (!repoPath || typeof repoPath !== "string") {
    return NextResponse.json({ error: "repoPath is required" }, { status: 400 })
  }

  return NextResponse.json({
    status: "not_implemented",
    message:
      "Connect this route to the Python behavioral runner. The runner will read .edgeagent/evals.yaml and run the repo in Docker sandbox.",
    repoPath,
  })
}
