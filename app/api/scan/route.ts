import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { NextResponse } from "next/server"
import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"

export async function POST(request: Request) {
  let body: { projectPath?: string; checks?: string[] } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  if (!body.projectPath || typeof body.projectPath !== "string" || !body.projectPath.trim()) {
    return NextResponse.json(
      {
        error:
          "projectPath is required. Open a local project or clone from GitHub before scanning.",
      },
      { status: 400 }
    )
  }

  const repoRoot = process.cwd()
  const allowRoot = getScanAllowRoot()
  const requested = path.resolve(body.projectPath.trim())

  if (!isPathInside(requested, allowRoot)) {
    return NextResponse.json(
      { error: "projectPath is outside the allowed directory" },
      { status: 403 }
    )
  }

  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    return NextResponse.json(
      { error: "projectPath is not a directory" },
      { status: 400 }
    )
  }

  const scannerDir = path.join(repoRoot, "scanner")
  if (!fs.existsSync(scannerDir)) {
    return NextResponse.json(
      { error: "scanner package not found under project root" },
      { status: 500 }
    )
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `edge-scan-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  )
  const python = process.env.EDGE_AGENT_PYTHON || "python3"
  const args = ["-m", "edge_agent_scanner.cli", "scan", requested, "--out", tmpFile]

  const checks = Array.isArray(body.checks) ? body.checks : []
  for (const c of checks) {
    if (typeof c === "string" && c.length > 0) {
      args.push("--check", c)
    }
  }

  const env = {
    ...process.env,
    PYTHONPATH: path.join(scannerDir, "src"),
  }

  const proc = spawnSync(python, args, {
    cwd: scannerDir,
    env,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  })

  if (proc.error) {
    return NextResponse.json(
      { error: `Failed to spawn scanner: ${proc.error.message}` },
      { status: 500 }
    )
  }

  if (proc.status !== 0) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
    } catch {
      /* ignore */
    }
    return NextResponse.json(
      {
        error: "Scanner process failed",
        stderr: proc.stderr?.slice(0, 8000),
        stdout: proc.stdout?.slice(0, 2000),
      },
      { status: 500 }
    )
  }

  try {
    const json = fs.readFileSync(tmpFile, "utf-8")
    fs.unlinkSync(tmpFile)
    return new NextResponse(json, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read report" },
      { status: 500 }
    )
  }
}
