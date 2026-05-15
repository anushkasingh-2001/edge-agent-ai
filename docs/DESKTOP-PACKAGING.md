# Edge Agent AI — Desktop Packaging (macOS)

This doc covers how to build and run the macOS desktop bundle produced by
`pnpm package:mac`. Windows/Linux packaging is intentionally deferred.

## Build a macOS package

```bash
pnpm package:mac
```

This script chains four steps:

1. `pnpm build:standalone` — produces `.next/standalone/server.js` plus the
   trimmed `node_modules` that Next.js's tracer determined the production
   server needs, then copies `.next/static/` and `public/` into the bundle.
2. `pnpm build:scanner` — runs PyInstaller against `scanner/` and drops the
   resulting binary at `electron/resources/scanner-bin/darwin-arm64/edge-agent-scanner`.
3. `pnpm build:electron` — compiles `electron/main.ts` and `electron/preload.ts`
   to `electron/dist/main.js` + `preload.js`.
4. `electron-builder --mac -c electron-builder.yml` — packs everything into
   `release/Edge Agent AI-<version>-arm64.dmg` and a matching `.zip`.

The unpacked app sits at `release/mac-arm64/Edge Agent AI.app`.

## Install + run

Open the `.dmg` or unzip the `.zip`, then drag **Edge Agent AI.app** to
`/Applications/` and launch it.

### Unsigned build

This build is **unsigned**. Apple Developer ID signing and notarization are
deliberately out of scope for the current step. On first launch macOS may show
one of:

* *"Edge Agent AI" cannot be opened because the developer cannot be verified.*
* *Apple could not verify "Edge Agent AI" is free of malware that may harm your Mac.*

To bypass the warning **for local testing only**:

1. Find **Edge Agent AI.app** in Finder.
2. Right-click (or Control-click) → **Open**.
3. In the dialog that appears, click **Open** again.

After the first successful launch the warning won't reappear for that copy.

For redistributable signed builds we'll wire up `mac.identity`,
`hardenedRuntime: true`, an entitlements plist, and `electron-notarize` in a
future packaging step.

## What ships inside the bundle

Inside `Edge Agent AI.app/Contents/Resources/`:

* `app.asar` (≈1 MB) — only the compiled Electron entry points
  (`electron/dist/main.js` + `preload.js`) and a stub `package.json`.
  Everything else lives outside asar — see below for why.
* `standalone/` (≈50 MB) — the Next.js standalone server bundle:
  `server.js`, the trimmed `node_modules` that Next.js traced, the copied
  `.next/static/` and `public/` directories. This is what `electron/main.ts`
  spawns in production mode.
* `scanner-bin/edge-agent-scanner` (≈14 MB) — the PyInstaller scanner
  binary. `electron/main.ts` auto-detects this on launch and sets
  `EDGE_AGENT_SCANNER_BIN` for the spawned Next server, so `/api/scan` runs
  the native binary instead of needing a Python venv.

### Why the standalone bundle is OUTSIDE app.asar

Spawning a child Node process with `cwd: <somewhere inside app.asar>` fails
with `ENOTDIR` — the OS-level `chdir()` syscall cannot traverse into
`app.asar` because at the filesystem level it's a single regular file.
Electron's fs hooks make `require()` work transparently inside asar, but
they don't (and can't) patch the kernel's chdir/spawn machinery. So we
keep `standalone/` outside asar and let the child server boot from a real
directory.

It also avoids a related issue: `sharp-darwin-arm64.node` (which
Next.js pulls in at runtime even with `images: { unoptimized: true }`)
cannot be `dlopen()`'d from inside asar.

## Runtime layout (what main.ts does on launch)

1. Picks a free loopback port via `net.createServer({port:0})`.
2. Spawns `Resources/standalone/server.js` (via Electron-as-Node,
   `ELECTRON_RUN_AS_NODE=1`) with this child env:
   ```
   PORT=<free>           HOSTNAME=127.0.0.1
   EDGE_AGENT_DESKTOP=1  EDGE_AGENT_SCAN_ALLOWLIST=$HOME
   EDGE_AGENT_SCANNER_BIN=<resources>/scanner-bin/edge-agent-scanner
   ```
3. Waits for the port to accept connections (max 30 s).
4. Loads `http://127.0.0.1:<port>` in the BrowserWindow.
5. On Cmd-Q / app.before-quit, SIGTERMs the child server then SIGKILLs after
   a 3 s grace window.

## Limitations of the current build

* macOS arm64 only. Building an Intel slice requires running PyInstaller on
  an Intel Mac (no cross-compile) and adding `arch: x64` to the `mac.target`
  array.
* Unsigned, unnotarized — see above.
* No auto-update channel wired up.
* No app icon / .icns asset is configured yet; the default Electron icon is
  used. Add one via `mac.icon: build/icon.icns` in `electron-builder.yml`
  when a brand mark is ready.
