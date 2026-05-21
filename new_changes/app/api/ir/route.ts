import { NextResponse } from "next/server"

export async function GET() {
  return NextResponse.json({ ir: null, message: "IR endpoint scaffold installed" })
}
