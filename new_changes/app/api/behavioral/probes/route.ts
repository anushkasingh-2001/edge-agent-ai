// SCAFFOLD ONLY — DO NOT TREAT AS A WORKING ENDPOINT.
// TODO: UI execution not wired yet.
// TODO: must call the Python behavioral runner
//       (edge_agent_scanner.behavioral.runner.run_behavioral_suites).
// TODO: must run inside the Docker sandbox (edge_agent_scanner.harness).
// This route does not execute behavioral tests; it only returns placeholder data.

import { NextResponse } from "next/server"

export async function GET() {
  return NextResponse.json({ probes: [] })
}
