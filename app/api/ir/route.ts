// SCAFFOLD ONLY — DO NOT TREAT AS A WORKING ENDPOINT.
// TODO: UI execution not wired yet.
// TODO: must call the Python IR builder
//       (edge_agent_scanner.ir.builder.build_agent_ir) and serialize the
//       AgentIR with `model_dump()`.
// TODO: should accept a `repoPath` query/body param and refuse paths outside
//       the active project root.
// This route does not return a real IR; it only returns a placeholder so the
// UI can wire up the request/response shape.

import { NextResponse } from "next/server"

export async function GET() {
  return NextResponse.json({
    ir: null,
    status: "not_implemented",
    message: "IR endpoint scaffold installed. Wire to edge_agent_scanner.ir.builder.",
  })
}
