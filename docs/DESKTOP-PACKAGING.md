# Edge Agent AI — Desktop Packaging

This doc covers how to build the desktop bundles produced by
`pnpm package:mac` (the primary, fully-exercised target),
`pnpm package:win`, and `pnpm package:linux`.

> **Cross-compile note up front:** PyInstaller cannot produce a Windows
> scanner binary from macOS (or vice versa). Each `package:*` script
> therefore expects the matching slot under
> `electron/resources/scanner-bin/<plat>-<arch>/` to already contain a
> binary that was built on a *native* host of that OS+arch. The
> `scripts/check-scanner-bin.mjs` pre-flight refuses to invoke
> electron-builder otherwise, with a clear remediation message. See
> [Building the scanner binary per OS](#building-the-scanner-binary-per-os).

## Build a macOS package

```bash
pnpm package:mac
```

This script chains five steps:

1. `pnpm build:standalone` — produces `.next/standalone/server.js` plus the
   trimmed `node_modules` that Next.js's tracer determined the production
   server needs, then copies `.next/static/` and `public/` into the bundle.
2. `pnpm build:scanner` — runs PyInstaller against `scanner/` and drops the
   resulting binary at `electron/resources/scanner-bin/darwin-arm64/edge-agent-scanner`.
3. `pnpm build:electron` — compiles `electron/main.ts` and `electron/preload.ts`
   to `electron/dist/main.js` + `preload.js`.
4. `node scripts/check-scanner-bin.mjs --platform=darwin --arch=arm64` —
   pre-flight gate. Fails fast if step 2 didn't produce a usable binary.
5. `electron-builder --mac -c electron-builder.yml` — packs everything into
   `release/Edge Agent AI-<version>-arm64.dmg` and a matching `.zip`.

The unpacked app sits at `release/mac-arm64/Edge Agent AI.app`.

## Build a Windows package

> **Run this on a Windows host.** macOS-hosted builds will fail at the
> pre-flight check because there's no `win32-x64` scanner binary in the
> repo, and cross-compiling one isn't supported.

```powershell
pnpm install
pnpm build:scanner          # produces electron/resources/scanner-bin/win32-x64/edge-agent-scanner.exe
pnpm package:win
```

The `package:win` script chains:

1. `pnpm build:standalone`
2. `pnpm build:electron`
3. `node scripts/check-scanner-bin.mjs --platform=win32 --arch=x64`
4. `electron-builder --win -c electron-builder.yml`

Output:

* `release\Edge Agent AI Setup <version>.exe` — NSIS one-click installer
  (per-user install, creates Start menu + Desktop shortcuts, includes an
  uninstaller). Unsigned for now; users will see a SmartScreen warning
  on first launch they can click "More info → Run anyway" past.

Architectures shipped: `x64`. Adding `arm64` requires running
`pnpm build:scanner` on a Windows-on-ARM host (Surface Pro X, WSL on a
Pi, etc.) and adding `arch: arm64` to `win.target` in `electron-builder.yml`.

## Build a Linux package

> **Run this on a Linux host** (any modern glibc-based distro: Ubuntu 22.04+,
> Debian 12+, Fedora 38+ are all fine). Old-glibc distros may produce
> AppImages that won't run on newer hosts and vice versa — match the
> oldest target distro you want to support.

```bash
pnpm install
pnpm build:scanner          # produces electron/resources/scanner-bin/linux-x64/edge-agent-scanner
pnpm package:linux
```

The `package:linux` script chains the same four steps as
`package:win`, just substituting `--linux`. Output:

* `release/Edge Agent AI-<version>.AppImage` — single-file portable
  binary. `chmod +x` it and run; no install needed.
* `release/edge-agent-ai_<version>_amd64.deb` — Debian/Ubuntu package
  with a `.desktop` launcher and an explicit `Depends:` list (git,
  openssh-client, libgtk-3-0, …) so a `sudo apt install ./<file>.deb`
  pulls in the runtime libraries the app needs.

Install:

```bash
# AppImage — no admin required
chmod +x "Edge Agent AI-0.1.0.AppImage"
./"Edge Agent AI-0.1.0.AppImage"

# .deb — adds a .desktop entry under /usr/share/applications/
sudo apt install ./edge-agent-ai_0.1.0_amd64.deb
edge-agent-ai
```

Architectures shipped: `x64`. arm64 Linux is a future task — build
`pnpm build:scanner` on an arm64 Linux host and add `arch: arm64` to
`linux.target`.

## Building the scanner binary per OS

PyInstaller bundles a host-specific C bootloader (`run` on macOS/Linux,
`run.exe` on Windows) into every binary it produces, so the same source
must be built independently on each OS+arch combo you ship for:

| Target              | Build host                          | Output path                                                  |
| ------------------- | ----------------------------------- | ------------------------------------------------------------ |
| macOS arm64         | macOS arm64 (Apple Silicon)         | `electron/resources/scanner-bin/darwin-arm64/edge-agent-scanner` |
| macOS x64           | macOS x64 (Intel — or arm64 + Rosetta with care) | `electron/resources/scanner-bin/darwin-x64/edge-agent-scanner` |
| Windows x64         | Windows x64                         | `electron/resources/scanner-bin/win32-x64/edge-agent-scanner.exe` |
| Windows arm64       | Windows arm64                       | `electron/resources/scanner-bin/win32-arm64/edge-agent-scanner.exe` |
| Linux x64 (glibc)   | Linux x64 (use the oldest glibc target distro you support) | `electron/resources/scanner-bin/linux-x64/edge-agent-scanner` |
| Linux arm64         | Linux arm64                         | `electron/resources/scanner-bin/linux-arm64/edge-agent-scanner` |

`pnpm build:scanner` auto-detects the host with `process.platform` and
`process.arch` and writes into the correct slot. Commit the resulting
binary so other contributors (and CI) don't need their own PyInstaller
toolchain set up; the slot's mtime is what tells the pre-flight check
the binary is fresh enough.

If you forget to build it first, `pnpm package:win` / `package:linux`
will abort BEFORE invoking electron-builder with:

```
xx scanner binary problem: binary not found
   electron/resources/scanner-bin/win32-x64/edge-agent-scanner.exe

Fix: build the Windows scanner binary on a Windows host, then commit / copy it back here.

  PyInstaller cannot cross-compile: the bootloader is a C executable
  that's specific to each OS+arch combination. Run `pnpm build:scanner`
  on a Windows/x64 machine, then check in / scp the resulting
  file:
    electron/resources/scanner-bin/win32-x64/edge-agent-scanner.exe
```

### Recommended workflow for shipping all three OSes

Until we have proper CI matrices:

1. macOS contributor runs `pnpm package:mac` locally → publishes the .dmg.
2. Windows contributor runs `pnpm build:scanner` on their machine, commits
   `electron/resources/scanner-bin/win32-x64/edge-agent-scanner.exe`,
   then runs `pnpm package:win` → publishes the installer.
3. Linux contributor does the equivalent for `linux-x64`.

The committed binaries are tracked in git so any contributor's host
machine can package any platform whose binary is already in the tree —
they only need a native host to *regenerate* a stale binary.

Practical size note: each binary is ~14 MB, so the repo grows ~42 MB
once all three are committed. That's fine for a desktop-app repo and
preferable to setting up cross-OS CI just for packaging.

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

* **macOS**: arm64 only. An Intel slice requires running PyInstaller on
  an Intel Mac (no cross-compile) and adding `arch: x64` to `mac.target`.
* **Windows**: x64 only, unsigned. arm64 needs PyInstaller on a Windows-on-ARM
  host. Signing needs a code-signing certificate (Step-9 work).
* **Linux**: x64 only. arm64 needs PyInstaller on an arm64 Linux host.
* **All platforms**: unsigned / unnotarized. macOS users see Gatekeeper,
  Windows users see SmartScreen — both bypassable for local testing.
* No auto-update channel wired up (`electron-updater` would consume
  `latest.yml` / `latest-mac.yml` / `latest-linux.yml` that electron-builder
  already emits, but the publisher target + signing key are out of scope).
* No app icon / `.icns` / `.ico` / `.png` asset is configured yet; the
  default Electron icon is used. Add one via `mac.icon: build/icon.icns`,
  `win.icon: build/icon.ico`, `linux.icon: build/icon.png` (512×512) in
  `electron-builder.yml` when brand art is ready.

## Feature inventory in the bundle

As of this build the packaged `.app` ships:

* **Scan / Policy Gate / GitHub PR** — original Step 1–6 capabilities, backed
  by the bundled PyInstaller scanner binary.
* **Understand Code Workflow** — static workflow analyzer (`/api/workflow/analyze`,
  `/api/workflow/export`), Mermaid diagram rendering, component/prompt/tool
  inventories, deterministic Q&A from the workflow graph.
* **LLM-backed "Ask about this repo" chat** — `/api/workflow/chat`
  dispatches to OpenAI (GPT-5.x / GPT-4o), Anthropic (Claude 4.x), or
  Google (Gemini 3.x / 2.5.x) via plain HTTPS. API keys are read from the
  in-app Settings page (browser `localStorage`, scoped to this installation)
  and forwarded with each request — never persisted on the server. Power
  users can also set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
  `GEMINI_API_KEY` in `.env.local` as a fallback.

### Network requirements (LLM chat only)

The chat feature is the only packaged surface that talks to the outside
internet. If the host is on a restricted network, outbound HTTPS to one or
more of the following must be reachable:

* `api.openai.com` — OpenAI
* `api.anthropic.com` — Anthropic
* `generativelanguage.googleapis.com` — Google Gemini

If none are reachable, the rest of the app (scanner, policy gate, workflow
analysis, deterministic chat) still works fully offline.

## Diagnosing a packaged install

When a user reports "Edge Agent AI doesn't work on my machine" after
installing the .dmg, the **System Health** card (Settings → System Health)
is the single source of truth. It hits `GET /api/system/health` and renders
three groups:

* **Runtime** — boot mode (`packaged` vs. `electron-prod-unpackaged` vs.
  `electron-dev`), app version, app/resources/userData/cwd paths, Electron
  + Chrome + Node versions, platform/arch.
* **Dependencies** — git / GitHub CLI / scanner availability, with absolute
  executable paths (`which git`, `which gh`) and the resolved scanner source
  (`scanner_bin` / `python_venv` / `pythonpath` / `missing`).
* **Logs** — log directory + per-file size and mtime.

### Where the diagnostics signal comes from

`electron/main.ts` forwards a small envelope of `EDGE_AGENT_*` env vars to
the spawned Next standalone server, which `app/api/system/health/route.ts`
mirrors back out:

| env var                          | value source                          |
| -------------------------------- | -------------------------------------- |
| `EDGE_AGENT_MODE`                | `app.isPackaged ? "packaged" : …`     |
| `EDGE_AGENT_APP_PATH`            | `app.getAppPath()`                    |
| `EDGE_AGENT_RESOURCES_PATH`      | `process.resourcesPath`               |
| `EDGE_AGENT_USER_DATA_PATH`      | `app.getPath("userData")`             |
| `EDGE_AGENT_LOG_DIR`             | `app.getPath("logs")`                 |
| `EDGE_AGENT_APP_VERSION`         | `app.getVersion()`                    |
| `EDGE_AGENT_ELECTRON_VERSION`    | `process.versions.electron`           |
| `EDGE_AGENT_CHROME_VERSION`      | `process.versions.chrome`             |
| `EDGE_AGENT_DESKTOP`             | `1` whenever launched by Electron     |
| `EDGE_AGENT_SCANNER_BIN`         | resolved bundled scanner path         |
| `EDGE_AGENT_SCAN_ALLOWLIST`      | `os.homedir()` by default             |

The renderer ALSO calls `window.edgeAgentAI.getRuntimeInfo()` via the
preload bridge to read the same info directly from the Electron main
process. The two values should agree; if they disagree, the launcher's
env forwarding is misconfigured (the "Copy diagnostics" JSON shows both
sides so the discrepancy is obvious).

### Log files

On macOS the per-user log directory is
`~/Library/Logs/Edge Agent AI/`. The card's **Open Logs Folder** button
reveals it in Finder; from the terminal:

```bash
open "$HOME/Library/Logs/Edge Agent AI"
```

Each launch truncates and rewrites these two files:

* `main.log` — every `console.{log,info,warn,error}` from the Electron
  main process: boot decisions, port allocation, IPC events, child-process
  lifecycle, fatal startup errors. ISO-timestamped per line.
* `server.log` — line-buffered stdout/stderr of the spawned Next standalone
  server. Includes every API request log, scanner spawn output, and any
  uncaught route error.

We intentionally do **not** rotate across launches — the user is almost
always debugging the *current* session, and a stable filename makes copy-paste
trivial. If you need an older session's log, recover it before the next
launch overwrites it.

### Copy Diagnostics

Footer button on the System Health card. Serialises the full health JSON,
the renderer-side bridge runtime info, and a tiny client envelope (user
agent, locale, timezone) into the clipboard as pretty-printed JSON. Designed
to be pasted directly into a bug report — and it deliberately contains no
tokens, no API keys, no PAT scopes, no environment variable values other
than the `EDGE_AGENT_*` paths.

### "Scanner missing" is now mode-aware

The hard warning that fires when `scanner.available === false` branches
on `runtime.mode`:

* `packaged` → "Scanner binary missing from the packaged app." with the
  exact bundled path it expected (`<resourcesPath>/scanner-bin/edge-agent-scanner`)
  and a "reinstall the .dmg" remediation. Almost always indicates a corrupt
  copy or a `package:mac` that skipped `pnpm build:scanner`.
* dev / unpackaged-prod → "Scanner runtime not found." with the
  `python3.11 -m venv …` venv-creation commands as before.

### Tracing notes for the standalone bundle

* `mermaid` is imported only on the client (`await import("mermaid")` inside
  the workflow view). Next.js bundles client-side dynamic imports into
  `.next/static/chunks/`, which `scripts/copy-standalone-assets.mjs` then
  mirrors into `.next/standalone/.next/static/`. The package is intentionally
  **not** listed in `outputFileTracingIncludes` — doing so would also drag
  mermaid + d3 + katex + cytoscape + elkjs into every server route trace
  and roughly 10× the standalone bundle.
* The workflow chat library (`lib/workflow-chat.ts`) only uses Node built-ins
  (`fetch`, `AbortController`, `setTimeout`), so no additional native bindings
  need to be packaged.
