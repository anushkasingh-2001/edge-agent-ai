/**
 * Install Edge Agent policy-gate git hooks into any project opened or
 * cloned through the app. Hooks call `~/.edge-agent-ai/bin/policy-gate`,
 * which runs this app's `scripts/policy-gate.ts` with the correct
 * PYTHONPATH and optional EDGE_AGENT_PYTHON from config.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { DEFAULT_POLICY, serializePolicyToYaml } from "@/lib/policy"

const EDGE_DIR_NAME = ".edge-agent-ai"
const HOOK_VERSION = "1"
const GATE_WRAPPER_VERSION = "3"

function edgeDir(): string {
  return path.join(os.homedir(), EDGE_DIR_NAME)
}

function binDir(): string {
  return path.join(edgeDir(), "bin")
}

function configPath(): string {
  return path.join(edgeDir(), "config.json")
}

function defaultPolicyPath(): string {
  return path.join(edgeDir(), "policy.default.yaml")
}

function installedRegistryPath(): string {
  return path.join(edgeDir(), "installed.json")
}

function wrapperPath(): string {
  return path.join(binDir(), "policy-gate")
}

function appRoot(): string {
  return process.cwd()
}

function buildWrapperScript(): string {
  return `#!/usr/bin/env bash
# Edge Agent AI policy-gate wrapper (v${GATE_WRAPPER_VERSION}).
# DO NOT EDIT — managed by the desktop app.
set -e
CONFIG="$HOME/${EDGE_DIR_NAME}/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "edge-agent: not installed (no $CONFIG) — skipping" >&2
  exit 0
fi
export _EA_CONFIG="$CONFIG"
APP_DIR="$(node -e "const fs=require('fs'); try { console.log(JSON.parse(fs.readFileSync(process.env._EA_CONFIG,'utf8')).appDir||'') } catch (e) { console.log('') }")"
unset _EA_CONFIG
if [ -z "$APP_DIR" ] || [ ! -d "$APP_DIR" ]; then
  echo "edge-agent: app dir missing or moved — open the app to re-install" >&2
  exit 0
fi
TSX="$APP_DIR/node_modules/.bin/tsx"
GATE="$APP_DIR/scripts/policy-gate.ts"
SCANNER_SRC="$APP_DIR/scanner/src"
if [ ! -x "$TSX" ] || [ ! -f "$GATE" ]; then
  echo "edge-agent: app installation incomplete — run 'pnpm install' in $APP_DIR" >&2
  exit 0
fi
if [ ! -d "$SCANNER_SRC/edge_agent_scanner" ]; then
  echo "edge-agent: scanner source missing at $SCANNER_SRC — skipping" >&2
  exit 0
fi
export EDGE_AGENT_APP_DIR="$APP_DIR"
if [ -n "$PYTHONPATH" ]; then
  export PYTHONPATH="$SCANNER_SRC:$PYTHONPATH"
else
  export PYTHONPATH="$SCANNER_SRC"
fi
export _EA_CONFIG="$CONFIG"
PYTHON_FROM_CFG="$(node -e "const fs=require('fs'); try { const c=JSON.parse(fs.readFileSync(process.env._EA_CONFIG,'utf8')); console.log(c.pythonExecutable||'') } catch(e) { console.log('') }")"
unset _EA_CONFIG
if [ -n "$PYTHON_FROM_CFG" ] && [ -x "$PYTHON_FROM_CFG" ]; then
  export EDGE_AGENT_PYTHON="$PYTHON_FROM_CFG"
fi
exec "$TSX" "$GATE" --repo "$(pwd)" "$@"
`
}

function buildPreCommitHook(): string {
  return `#!/usr/bin/env bash
# Edge Agent AI pre-commit (v${HOOK_VERSION}). Managed by the desktop app.
set -e
if [ "\${EDGE_AGENT_SKIP:-0}" = "1" ]; then
  echo "edge-agent: pre-commit skipped (EDGE_AGENT_SKIP=1)"
  exit 0
fi
GATE="$HOME/${EDGE_DIR_NAME}/bin/policy-gate"
if [ ! -x "$GATE" ]; then
  echo "edge-agent: gate wrapper missing — skipping" >&2
  exit 0
fi
echo "edge-agent: pre-commit gate running (use --no-verify to skip)…"
exec "$GATE" --target HEAD
`
}

function buildPrePushHook(): string {
  return `#!/usr/bin/env bash
# Edge Agent AI pre-push (v${HOOK_VERSION}). Managed by the desktop app.
set -e
if [ "\${EDGE_AGENT_SKIP:-0}" = "1" ]; then
  echo "edge-agent: pre-push skipped (EDGE_AGENT_SKIP=1)"
  exit 0
fi
GATE="$HOME/${EDGE_DIR_NAME}/bin/policy-gate"
if [ ! -x "$GATE" ]; then
  echo "edge-agent: gate wrapper missing — skipping" >&2
  exit 0
fi
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -z "$UPSTREAM" ]; then
  echo "edge-agent: pre-push gate running (no upstream — absolute rules only)…"
  exec "$GATE" --target HEAD
fi
echo "edge-agent: pre-push gate running (target=HEAD, base=$UPSTREAM)…"
exec "$GATE" --target HEAD --base "$UPSTREAM"
`
}

function writeFileIfChanged(p: string, content: string, mode?: number): void {
  const prev = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null
  if (prev === content) {
    if (mode != null) {
      try {
        fs.chmodSync(p, mode)
      } catch {
        /* ignore */
      }
    }
    return
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, "utf8")
  if (mode != null) {
    try {
      fs.chmodSync(p, mode)
    } catch {
      /* ignore */
    }
  }
}

function ensureGlobalScaffolding(): void {
  fs.mkdirSync(edgeDir(), { recursive: true })
  fs.mkdirSync(binDir(), { recursive: true })

  let prev: Record<string, unknown> = {}
  try {
    if (fs.existsSync(configPath())) {
      const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        prev = parsed as Record<string, unknown>
      }
    }
  } catch {
    /* ignore */
  }

  const conf = {
    ...prev,
    appDir: appRoot(),
    wrapperVersion: GATE_WRAPPER_VERSION,
    hookVersion: HOOK_VERSION,
    updatedAt: new Date().toISOString(),
  }
  writeFileIfChanged(configPath(), JSON.stringify(conf, null, 2) + "\n", 0o644)
  writeFileIfChanged(wrapperPath(), buildWrapperScript(), 0o755)

  if (!fs.existsSync(defaultPolicyPath())) {
    const yamlText =
      `# Edge Agent AI — global default policy (used when a project has no local file).\n\n` +
      serializePolicyToYaml(DEFAULT_POLICY)
    writeFileIfChanged(defaultPolicyPath(), yamlText, 0o644)
  }
}

function existingHookOwner(projectPath: string): string | null {
  const cur = spawnSync(
    "git",
    ["-C", projectPath, "config", "--local", "--get", "core.hooksPath"],
    { encoding: "utf8" }
  )
  if (cur.status === 0) {
    const v = cur.stdout.trim()
    if (v && v !== ".githooks") return v
  }
  if (fs.existsSync(path.join(projectPath, ".husky", "pre-commit"))) {
    return ".husky/"
  }
  if (fs.existsSync(path.join(projectPath, "lefthook.yml"))) {
    return "lefthook.yml"
  }
  const native = path.join(projectPath, ".git", "hooks", "pre-commit")
  if (fs.existsSync(native)) {
    try {
      const txt = fs.readFileSync(native, "utf8")
      const st = fs.statSync(native)
      const isExec = (st.mode & 0o111) !== 0
      const isSample =
        txt.startsWith("#!/bin/sh") && txt.includes("Example")
      if (isExec && !isSample) return ".git/hooks/pre-commit"
    } catch {
      /* ignore */
    }
  }
  return null
}

function isGitRepo(projectPath: string): boolean {
  if (!fs.existsSync(path.join(projectPath, ".git"))) return false
  const r = spawnSync(
    "git",
    ["-C", projectPath, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8" }
  )
  return r.status === 0 && r.stdout.trim() === "true"
}

function recordInstall(projectPath: string): void {
  const p = installedRegistryPath()
  let prev: { projects: { path: string; installedAt: string; hookVersion: string }[] } =
    { projects: [] }
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"))
      if (parsed && Array.isArray(parsed.projects)) prev = parsed
    }
  } catch {
    /* ignore */
  }
  const without = prev.projects.filter((x) => x.path !== projectPath)
  without.push({
    path: projectPath,
    installedAt: new Date().toISOString(),
    hookVersion: HOOK_VERSION,
  })
  fs.writeFileSync(p, JSON.stringify({ projects: without }, null, 2) + "\n", "utf8")
}

export interface InstallGateResult {
  installed: boolean
  reason?: string
  projectPath: string
  wrapperPath: string
  defaultPolicyPath: string
}

export function installEdgeAgentGate(projectPath: string): InstallGateResult {
  const abs = path.resolve(projectPath)
  const result: InstallGateResult = {
    installed: false,
    projectPath: abs,
    wrapperPath: wrapperPath(),
    defaultPolicyPath: defaultPolicyPath(),
  }

  try {
    ensureGlobalScaffolding()
  } catch (e) {
    result.reason = `global scaffolding failed: ${
      e instanceof Error ? e.message : String(e)
    }`
    return result
  }

  if (!isGitRepo(abs)) {
    result.reason = "not a git repo"
    return result
  }

  const owner = existingHookOwner(abs)
  if (owner) {
    result.reason = `another tool owns hooks (${owner})`
    return result
  }

  const hooksDir = path.join(abs, ".githooks")
  fs.mkdirSync(hooksDir, { recursive: true })
  writeFileIfChanged(path.join(hooksDir, "pre-commit"), buildPreCommitHook(), 0o755)
  writeFileIfChanged(path.join(hooksDir, "pre-push"), buildPrePushHook(), 0o755)

  const r = spawnSync("git", [
    "-C",
    abs,
    "config",
    "core.hooksPath",
    ".githooks",
  ])
  if (r.status !== 0) {
    result.reason = "git config core.hooksPath failed"
    return result
  }

  recordInstall(abs)
  result.installed = true
  return result
}
