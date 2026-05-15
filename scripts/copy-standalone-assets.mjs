#!/usr/bin/env node
/**
 * Postbuild step for `output: "standalone"`.
 *
 * Next.js's standalone bundler only emits the *server* code into
 * `.next/standalone/`. Browser assets — `.next/static/` (CSS, JS
 * chunks, fonts) and the `public/` directory (icons, images, etc.)
 * — are NOT copied automatically, so a freshly-built bundle renders
 * as unstyled HTML with broken images when booted via
 * `node .next/standalone/server.js`.
 *
 * This script mirrors the two directories into the bundle so the
 * standalone server is fully self-contained. It is wired up as
 * the npm `postbuild` lifecycle hook, so a plain `pnpm build`
 * leaves a runnable `.next/standalone/` behind.
 *
 *   `.next/static/`  →  `.next/standalone/.next/static/`
 *   `public/`        →  `.next/standalone/public/`
 *
 * Safe to run repeatedly: `cpSync` with `force: true` overwrites,
 * and missing source directories are skipped with a warning rather
 * than a hard failure (e.g. for builds that don't use `public/`).
 */

import * as fs from "node:fs"
import * as path from "node:path"

const ROOT = process.cwd()
const STANDALONE = path.join(ROOT, ".next", "standalone")

// If there's no standalone bundle (e.g. user changed next.config.mjs
// to drop `output: "standalone"`), skip silently — this is a hook,
// not a hard requirement.
if (!fs.existsSync(STANDALONE)) {
  console.log(
    "postbuild: no .next/standalone (output is not 'standalone') — nothing to copy"
  )
  process.exit(0)
}

const pairs = [
  {
    src: path.join(ROOT, ".next", "static"),
    dst: path.join(STANDALONE, ".next", "static"),
    label: ".next/static",
  },
  {
    src: path.join(ROOT, "public"),
    dst: path.join(STANDALONE, "public"),
    label: "public",
  },
]

let copied = 0
let skipped = 0
for (const { src, dst, label } of pairs) {
  if (!fs.existsSync(src)) {
    console.warn(`postbuild: source missing, skipping: ${label}`)
    skipped += 1
    continue
  }
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true, force: true })
  copied += 1
  console.log(`postbuild: copied ${label} → .next/standalone/${label}`)
}

console.log(
  `postbuild: standalone bundle now self-contained (copied=${copied}, skipped=${skipped})`
)
