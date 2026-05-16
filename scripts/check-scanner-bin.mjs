#!/usr/bin/env node
/**
 * check-scanner-bin — pre-flight gate for the per-OS package:* scripts.
 *
 * Verifies that the PyInstaller scanner binary exists for the target
 * platform/arch slot before electron-builder runs. Fails loudly with a
 * clear, copy-pasteable remediation message when something's missing —
 * a much better user experience than letting electron-builder happily
 * produce an installer with a missing scanner-bin entry that then
 * surfaces as "Scanner missing" in System Health on every user's
 * machine.
 *
 * PyInstaller deliberately cannot cross-compile (the bootloader is C
 * built per host OS+arch), so a Windows binary MUST be built on Windows
 * and a Linux binary MUST be built on Linux. This script enforces that
 * invariant before we waste 5+ minutes packaging.
 *
 * Usage:
 *   node scripts/check-scanner-bin.mjs --platform=darwin --arch=arm64
 *   node scripts/check-scanner-bin.mjs --platform=win32  --arch=x64
 *   node scripts/check-scanner-bin.mjs --platform=linux  --arch=x64
 *
 * Defaults to the *host* platform/arch when called with no args, which
 * is how the `package:mac` / `package:win` / `package:linux` scripts in
 * package.json wire it up.
 *
 * Exits 0 when the binary is present, 1 when missing.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, "..")

/* -------------------------------------------------------------------------- */
/* Tiny argv parser — avoids a runtime dependency just for two flags          */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        out[a.slice(2)] = "true"
      }
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const targetPlatform = (args.platform ?? process.platform).trim()
const targetArch = (args.arch ?? process.arch).trim()

/* -------------------------------------------------------------------------- */
/* Resolve the expected slot + binary name                                    */
/* -------------------------------------------------------------------------- */

const slotKey = `${targetPlatform}-${targetArch}`
const binName =
  targetPlatform === "win32" ? "edge-agent-scanner.exe" : "edge-agent-scanner"
const expectedPath = path.join(
  ROOT,
  "electron",
  "resources",
  "scanner-bin",
  slotKey,
  binName
)

/* -------------------------------------------------------------------------- */
/* Friendly labels + remediation                                              */
/* -------------------------------------------------------------------------- */

const PLATFORM_LABELS = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
}

function color(code, s) {
  return process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s
}
const red = (s) => color("31", s)
const yellow = (s) => color("33", s)
const green = (s) => color("32", s)
const dim = (s) => color("2", s)

const label = PLATFORM_LABELS[targetPlatform] ?? targetPlatform

/* -------------------------------------------------------------------------- */
/* The check                                                                  */
/* -------------------------------------------------------------------------- */

function checkExecutableBit(p) {
  if (targetPlatform === "win32") return true // no x-bit on Windows
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

console.log(
  `${dim("check-scanner-bin")} target=${label}/${targetArch}  expected=${path.relative(ROOT, expectedPath)}`
)

let problem = null
if (!fs.existsSync(expectedPath)) {
  problem = `binary not found`
} else {
  try {
    const st = fs.statSync(expectedPath)
    if (!st.isFile()) {
      problem = `path exists but is not a file`
    } else if (st.size < 1024) {
      // PyInstaller binaries are tens of MB. A < 1 KB file is almost
      // certainly a stub / corrupted copy that would baffle users at
      // first scan attempt.
      problem = `binary suspiciously small (${st.size} bytes) — looks corrupted`
    } else if (!checkExecutableBit(expectedPath)) {
      problem = `binary is not executable (missing +x bit)`
    }
  } catch (e) {
    problem = `stat failed: ${e instanceof Error ? e.message : String(e)}`
  }
}

if (problem) {
  console.error()
  console.error(red(`xx scanner binary problem: ${problem}`))
  console.error(red(`   ${expectedPath}`))
  console.error()

  const isHost =
    targetPlatform === process.platform && targetArch === process.arch
  if (isHost) {
    // The user is running on the same platform they're packaging for —
    // we can just tell them to run the build-scanner script.
    console.error(yellow("Fix:"))
    console.error(`  ${green("pnpm build:scanner")}`)
    console.error()
    console.error(
      dim(
        "  build-scanner runs PyInstaller inside scanner/.venv and drops the\n" +
          "  result at the expected path above."
      )
    )
  } else {
    // Cross-OS packaging attempt. PyInstaller doesn't cross-compile —
    // tell the user they need to build on the target OS first.
    console.error(
      yellow(
        `Fix: build the ${label} scanner binary on a ${label} host, then commit / copy it back here.`
      )
    )
    console.error()
    console.error(
      dim(
        "  PyInstaller cannot cross-compile: the bootloader is a C executable\n" +
          "  that's specific to each OS+arch combination. Run `pnpm build:scanner`\n" +
          `  on a ${label}/${targetArch} machine, then check in / scp the resulting\n` +
          `  file:\n` +
          `    ${path.relative(ROOT, expectedPath)}`
      )
    )
    console.error()
    console.error(
      dim(
        "  Once committed it becomes part of the repo and packaging on this host\n" +
          "  works without needing a Windows/Linux machine again — until the\n" +
          "  scanner code changes and you need a rebuild."
      )
    )
  }
  console.error()
  process.exit(1)
}

const size = fs.statSync(expectedPath).size
const sizeMb = (size / (1024 * 1024)).toFixed(1)
console.log(green(`    ok ${path.relative(ROOT, expectedPath)} (${sizeMb} MB)`))
process.exit(0)
