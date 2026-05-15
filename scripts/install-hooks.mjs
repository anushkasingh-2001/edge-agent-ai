#!/usr/bin/env node
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  process.exit(0)
}

if (!fs.existsSync(path.resolve(".git"))) {
  process.exit(0)
}

try {
  execSync("git config core.hooksPath .githooks", { stdio: "ignore" })
  for (const name of ["pre-commit", "pre-push"]) {
    const p = path.resolve(".githooks", name)
    if (fs.existsSync(p)) {
      try {
        fs.chmodSync(p, 0o755)
      } catch {
        /* ignore */
      }
    }
  }
  console.log("edge-agent: git hooks wired (.githooks/)")
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.warn("edge-agent: could not install hooks:", msg)
}
