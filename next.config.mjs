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
  // NOTE: `mermaid` is loaded *client-side* via `await import("mermaid")` in
  // the Understand Code Workflow view, so it ends up in `.next/static/chunks/`
  // (copied into the standalone bundle by `scripts/copy-standalone-assets.mjs`).
  // It is NOT a server-side dependency, so it deliberately does NOT appear
  // in `outputFileTracingIncludes` — adding it there would force-copy
  // mermaid + d3 + katex + cytoscape + elkjs into every traced route and
  // inflate the standalone bundle by hundreds of MB.
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
