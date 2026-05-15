/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits a self-contained `.next/standalone/server.js` plus the minimal
  // node_modules slice needed to run it. Required so the desktop wrapper
  // (Electron, planned in a later step) can boot the Next server as a
  // child process without shipping the entire repo. Has no effect on
  // `pnpm dev`.
  output: "standalone",
  // Next's file-tracer is a JS-aware static analyser; it cannot follow
  // Python imports, so any attempt to drag `scanner/` into the standalone
  // bundle leaves us with a broken partial copy (e.g. `rules/` with only
  // `__pycache__/` and no `.py` files). Worse, when the standalone server
  // boots it `process.chdir(__dirname)` so any API route that resolves
  // the scanner via `process.cwd() + "/scanner"` would then load that
  // half-copied tree and fail with `ImportError`. We keep the scanner
  // out of the bundle entirely and rely on `EDGE_AGENT_SCANNER_DIR`
  // (set by the desktop launcher) to point at the real source tree.
  //
  // The other entries trim repo cruft the tracer picked up incidentally
  // (`.git/` symlinks even caused EPERM warnings during `pnpm build`).
  // None of these are needed at runtime by any API route.
  outputFileTracingExcludes: {
    "**/*": [
      "scanner/**",
      ".git/**",
      ".githooks/**",
      ".github/**",
      ".cursor/**",
      ".edgeagent/**",
      "tmp-git-test-*/**",
      "edge-agent-output/**",
      "sample-agent/**",
      "docs/**",
      "scripts/**",
      "report.json",
      "tsconfig.tsbuildinfo",
      ".next/cache/**",
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
