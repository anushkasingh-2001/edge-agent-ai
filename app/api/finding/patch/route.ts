// SCAFFOLD ONLY — DO NOT TREAT AS A WORKING ENDPOINT.
// TODO: UI execution not wired yet.
// TODO: must call the Python remediation generator
//       (edge_agent_scanner.remediation.patches / .templates / .validators).
// TODO: any patch suggestion that touches files must be reviewed by the user
//       before being written to disk — never auto-apply from this route.
// This route does not generate real patches; it only returns a placeholder
// response so the UI can wire up the request shape.

import { NextResponse } from "next/server"

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  return NextResponse.json({
    patch: null,
    status: "not_implemented",
    message: "Patch generator scaffold installed. Wire to edge_agent_scanner.remediation.",
    request: body,
  })
}
