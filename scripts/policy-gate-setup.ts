#!/usr/bin/env node
/**
 * One-time setup: ensure ~/.edge-agent-ai/scanner-venv has pydantic and
 * record python path in config.json for the policy-gate wrapper.
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const EDGE = path.join(os.homedir(), ".edge-agent-ai")
const CFG = path.join(EDGE, "config.json")
const VENV = path.join(EDGE, "scanner-venv")

function loadCfg(): Record<string, unknown> {
  try {
    if (fs.existsSync(CFG)) {
      return JSON.parse(fs.readFileSync(CFG, "utf8")) as Record<string, unknown>
    }
  } catch {
    /* ignore */
  }
  return {}
}

function saveCfg(c: Record<string, unknown>): void {
  fs.mkdirSync(EDGE, { recursive: true })
  fs.writeFileSync(
    CFG,
    JSON.stringify({ ...c, updatedAt: new Date().toISOString() }, null, 2) + "\n"
  )
}

function canImportPydantic(py: string): boolean {
  const r = spawnSync(py, ["-c", "import pydantic; print(pydantic.VERSION)"], {
    encoding: "utf8",
  })
  return r.status === 0 && Boolean(r.stdout?.trim())
}

function which(cmd: string): string | null {
  const r = spawnSync("which", [cmd], { encoding: "utf8" })
  if (r.status !== 0) return null
  const o = r.stdout.trim()
  return o || null
}

function main(): number {
  process.stderr.write("Edge Agent AI · policy-gate-setup\n")

  const cur = loadCfg()
  for (const py of [
    process.env.EDGE_AGENT_PYTHON,
    typeof cur.pythonExecutable === "string" ? cur.pythonExecutable : "",
    which("python3"),
    which("python"),
  ].filter((x): x is string => typeof x === "string" && x.length > 0)) {
    if (canImportPydantic(py)) {
      saveCfg({ ...cur, pythonExecutable: py })
      process.stderr.write(`Using Python with pydantic: ${py}\n`)
      return 0
    }
  }

  const base = which("python3") || which("python")
  if (!base) {
    process.stderr.write("No python3 on PATH.\n")
    return 1
  }

  fs.mkdirSync(EDGE, { recursive: true })
  const mk = spawnSync(base, ["-m", "venv", "--clear", VENV], { stdio: "inherit" })
  if (mk.status !== 0) {
    process.stderr.write("Failed to create venv.\n")
    return 1
  }

  const vp = path.join(VENV, "bin", "python")
  const vpWin = path.join(VENV, "Scripts", "python.exe")
  const vpy = fs.existsSync(vp) ? vp : fs.existsSync(vpWin) ? vpWin : null
  if (!vpy) {
    process.stderr.write("Venv python not found.\n")
    return 1
  }

  const pip = spawnSync(vpy, ["-m", "pip", "install", "--quiet", "pydantic>=2.0"], {
    stdio: "inherit",
  })
  if (pip.status !== 0) {
    process.stderr.write("pip install pydantic failed (offline?).\n")
    return 1
  }

  if (!canImportPydantic(vpy)) {
    process.stderr.write("pydantic import failed after install.\n")
    return 1
  }

  saveCfg({ ...cur, pythonExecutable: vpy })
  process.stderr.write(`Installed scanner venv: ${vpy}\n`)
  return 0
}

process.exit(main())
