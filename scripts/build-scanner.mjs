#!/usr/bin/env node
/**
 * build-scanner — produce a standalone scanner binary via PyInstaller.
 *
 * What it does, in order:
 *   1. Detect host platform/arch (process.platform, process.arch) and
 *      decide the output slot: electron/resources/scanner-bin/<plat>-<arch>/.
 *   2. Find or create scanner/.venv (Python 3.11+). If creation is
 *      needed, try python3.11 → python3.12 → python3 in that order.
 *   3. Upgrade pip + setuptools + wheel inside the venv.
 *   4. `pip install -e "./scanner[dev]"` so the package is importable
 *      AND tests are available locally for users who want to run them.
 *   5. `pip install "pyinstaller>=6.5" "pyinstaller-hooks-contrib>=2024.7"`.
 *      Pinning hooks-contrib is critical for pydantic v2 / pydantic_core.
 *   6. Defensive clean of scanner/build, scanner/dist, scanner/__pycache__
 *      so stale artefacts can't poison the build.
 *   7. Run PyInstaller with scanner/pyinstaller.spec.
 *   8. Copy scanner/dist/<bin> → electron/resources/scanner-bin/<slot>/<bin>,
 *      chmod 0o755 on POSIX.
 *   9. Smoke-test: invoke the new binary against sample-agent and
 *      verify the resulting JSON parses.
 *
 * NEVER uses shell strings. Every spawn passes args as an array so
 * filenames with spaces / shell metacharacters don't break the build.
 *
 * Single-file output is intentional — see scanner/pyinstaller.spec for
 * the trade-off discussion.
 */

import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, "..")
const SCANNER_DIR = path.join(ROOT, "scanner")
const VENV_DIR = path.join(SCANNER_DIR, ".venv")
const PY_EXTRAS_TARGET = "./scanner[dev]" // run from ROOT so the relative path resolves

const IS_WIN = process.platform === "win32"
const VENV_PY = IS_WIN
  ? path.join(VENV_DIR, "Scripts", "python.exe")
  : path.join(VENV_DIR, "bin", "python")

const PLATFORM_KEY = `${process.platform}-${process.arch}`
const BIN_NAME = IS_WIN ? "edge-agent-scanner.exe" : "edge-agent-scanner"

const OUT_DIR = path.join(
  ROOT,
  "electron",
  "resources",
  "scanner-bin",
  PLATFORM_KEY
)
const OUT_PATH = path.join(OUT_DIR, BIN_NAME)

/* -------------------------------------------------------------------------- */
/* Logging                                                                    */
/* -------------------------------------------------------------------------- */

const USE_COLOR = process.stdout.isTTY
const c = (code, s) =>
  USE_COLOR ? `\u001b[${code}m${s}\u001b[0m` : s
const blue = (s) => c("34", s)
const green = (s) => c("32", s)
const yellow = (s) => c("33", s)
const red = (s) => c("31", s)
const dim = (s) => c("2", s)

function step(msg) {
  console.log(`${blue("==>")} ${msg}`)
}
function ok(msg) {
  console.log(`    ${green("ok")} ${msg}`)
}
function info(msg) {
  console.log(`    ${dim(msg)}`)
}
function fail(msg) {
  console.error(`${red("xx")} ${msg}`)
}

/* -------------------------------------------------------------------------- */
/* Spawn helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Run a command synchronously, streaming stdout/stderr to the parent
 * console so the user sees pip/pyinstaller output in real time. Throws
 * with a clean message when the exit code is non-zero, so the caller
 * doesn't have to repeat error-handling boilerplate.
 */
function run(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? ROOT
  info(`$ ${cmd} ${args.join(" ")}  ${dim(`(cwd: ${path.relative(ROOT, cwd) || "."})`)}`)
  const r = spawnSync(cmd, args, {
    cwd,
    env: opts.env ?? process.env,
    stdio: "inherit",
  })
  if (r.error) {
    throw new Error(`Failed to launch ${cmd}: ${r.error.message}`)
  }
  if (typeof r.status !== "number" || r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited with status ${r.status ?? "?"}`
    )
  }
}

/**
 * Capture stdout/stderr instead of streaming. Used only when we need
 * to read output (smoke-test parse, command-presence probes). Returns
 * { status, stdout, stderr } without throwing — caller decides what
 * counts as failure.
 */
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
    encoding: "utf-8",
    maxBuffer: 4 * 1024 * 1024,
  })
  return {
    status: r.status,
    error: r.error ?? null,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  }
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

/** Find an existing venv python, or pick a system python3 candidate to
 *  bootstrap one with. Returns the absolute path to the chosen python. */
function ensureVenv() {
  if (fs.existsSync(VENV_PY)) {
    ok(`reusing existing venv: ${path.relative(ROOT, VENV_PY)}`)
    return VENV_PY
  }
  step("creating scanner/.venv")
  const candidates = IS_WIN
    ? ["py", "python3.11", "python3.12", "python3", "python"]
    : ["python3.11", "python3.12", "python3"]
  let bootstrap = null
  for (const cand of candidates) {
    const probe =
      cand === "py"
        ? capture("py", ["-3.11", "--version"])
        : capture(cand, ["--version"])
    if (probe.status === 0) {
      bootstrap = cand
      info(`bootstrap python: ${cand} (${probe.stdout.trim() || probe.stderr.trim()})`)
      break
    }
  }
  if (!bootstrap) {
    throw new Error(
      "No Python 3.11+ found on PATH (tried python3.11, python3.12, python3). " +
        "Install one from https://www.python.org/downloads/, then re-run."
    )
  }
  const venvArgs = bootstrap === "py" ? ["-3.11", "-m", "venv", VENV_DIR] : ["-m", "venv", VENV_DIR]
  run(bootstrap, venvArgs)
  if (!fs.existsSync(VENV_PY)) {
    throw new Error(`venv creation failed: ${VENV_PY} does not exist`)
  }
  ok(`created venv at ${path.relative(ROOT, VENV_DIR)}`)
  return VENV_PY
}

function installScannerAndPyInstaller(py) {
  step("upgrading pip / setuptools / wheel")
  run(py, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])

  step("installing edge-agent-scanner in editable mode (with [dev])")
  run(py, ["-m", "pip", "install", "-e", PY_EXTRAS_TARGET], { cwd: ROOT })

  step("installing pyinstaller + hooks-contrib")
  run(py, [
    "-m",
    "pip",
    "install",
    "pyinstaller>=6.5",
    "pyinstaller-hooks-contrib>=2024.7",
  ])
}

function cleanPreviousBuild() {
  step("cleaning previous PyInstaller artefacts")
  for (const sub of ["build", "dist"]) {
    const p = path.join(SCANNER_DIR, sub)
    if (fs.existsSync(p)) {
      info(`rm -rf scanner/${sub}`)
      fs.rmSync(p, { recursive: true, force: true })
    }
  }
}

function runPyInstaller(py) {
  step("running PyInstaller")
  run(
    py,
    ["-m", "PyInstaller", "--noconfirm", "--clean", "pyinstaller.spec"],
    { cwd: SCANNER_DIR }
  )
}

function placeBinary() {
  const distPath = path.join(SCANNER_DIR, "dist", BIN_NAME)
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `PyInstaller did not produce ${distPath}. Inspect scanner/build/ for warnings.`
    )
  }
  step(`installing binary into ${path.relative(ROOT, OUT_DIR)}`)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.copyFileSync(distPath, OUT_PATH)
  if (!IS_WIN) {
    fs.chmodSync(OUT_PATH, 0o755)
  }
  const size = fs.statSync(OUT_PATH).size
  ok(`${path.relative(ROOT, OUT_PATH)} (${formatBytes(size)})`)
}

function smokeTest() {
  step("smoke test: scanner binary against sample-agent")
  const sampleAgent = path.join(ROOT, "sample-agent")
  if (!fs.existsSync(sampleAgent)) {
    info(`skipping smoke test — ${path.relative(ROOT, sampleAgent)} not found`)
    return
  }
  const tmpReport = path.join(
    os.tmpdir(),
    `eaa-build-smoke-${Date.now()}.json`
  )
  const r = capture(OUT_PATH, ["scan", sampleAgent, "--out", tmpReport])
  if (r.status !== 0) {
    fail(`binary smoke test failed (exit ${r.status})`)
    if (r.stderr) console.error(red("stderr:"), r.stderr.slice(0, 4000))
    if (r.stdout) console.error(red("stdout:"), r.stdout.slice(0, 2000))
    throw new Error("smoke test failed")
  }
  try {
    const raw = fs.readFileSync(tmpReport, "utf-8")
    const json = JSON.parse(raw)
    if (typeof json !== "object" || json === null) {
      throw new Error("not an object")
    }
    const total = json?.summary?.total ?? "?"
    const sv = json?.schema_version ?? "?"
    ok(`schema_version=${sv}, total=${total}, files_scanned=${json.files_scanned ?? "?"}`)
  } catch (e) {
    fail(`smoke test report unreadable: ${e instanceof Error ? e.message : String(e)}`)
    throw e
  } finally {
    try {
      fs.unlinkSync(tmpReport)
    } catch {
      /* ignore */
    }
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(
    blue("Edge Agent AI — build-scanner"),
    dim(`(host: ${PLATFORM_KEY})`)
  )

  const py = ensureVenv()
  installScannerAndPyInstaller(py)
  cleanPreviousBuild()
  runPyInstaller(py)
  placeBinary()
  smokeTest()

  console.log()
  console.log(green("Done."))
  console.log(
    `Binary: ${OUT_PATH}\n` +
      `To exercise it from the app:\n` +
      `  EDGE_AGENT_SCANNER_BIN="${OUT_PATH}" pnpm dev`
  )
}

main().catch((err) => {
  console.error()
  fail(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
