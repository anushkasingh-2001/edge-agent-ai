import { NextResponse } from "next/server"

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  return NextResponse.json({ patch: null, message: "Patch generator scaffold installed", request: body })
}
