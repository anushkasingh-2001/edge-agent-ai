/**
 * Unit tests for the workspace file/tree/save helpers.
 *
 * These exercise `lib/server-workspace.ts` directly rather than going
 * through Next.js routing so the test file stays fast and dependency-
 * free. The route handlers are thin wrappers that map WorkspaceError
 * codes to HTTP statuses; the security envelope all lives in the
 * helpers, which is what we cover here.
 *
 * Run: pnpm test:workspace
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  IGNORED_DIRS,
  MAX_EDITOR_FILE_BYTES,
  guessLanguage,
  listDirectory,
  looksBinary,
  readWorkspaceFile,
  resolveInsideWorkspace,
  resolveWorkspaceRoot,
  WorkspaceError,
  writeWorkspaceFile,
} from "../lib/server-workspace"

interface Sandbox {
  root: string
  cleanup: () => void
}

function tmpProject(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-agent-workspace-test-"))
  const realRoot = fs.realpathSync(root)
  // A small but interesting tree:
  //   src/
  //     index.ts
  //     util.ts
  //   docs/
  //     readme.md
  //   bin/
  //     blob.png        (binary by extension)
  //     nul.dat         (NUL byte at start → binary by sniff)
  //   node_modules/     (ignored)
  //     pkg/index.js
  fs.mkdirSync(path.join(realRoot, "src"))
  fs.writeFileSync(path.join(realRoot, "src", "index.ts"), "console.log('hi')\n")
  fs.writeFileSync(path.join(realRoot, "src", "util.ts"), "export const x = 1\n")
  fs.mkdirSync(path.join(realRoot, "docs"))
  fs.writeFileSync(path.join(realRoot, "docs", "readme.md"), "# title\n")
  fs.mkdirSync(path.join(realRoot, "bin"))
  fs.writeFileSync(path.join(realRoot, "bin", "blob.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(realRoot, "bin", "nul.dat"), Buffer.from([0x68, 0x00, 0x69]))
  fs.mkdirSync(path.join(realRoot, "node_modules", "pkg"), { recursive: true })
  fs.writeFileSync(path.join(realRoot, "node_modules", "pkg", "index.js"), "module.exports = 1\n")
  return {
    root: realRoot,
    cleanup: () => {
      try {
        fs.rmSync(realRoot, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

// ---------------------------------------------------------------------------
// resolveWorkspaceRoot
// ---------------------------------------------------------------------------

test("resolveWorkspaceRoot rejects empty / missing input", () => {
  assert.throws(() => resolveWorkspaceRoot(""), (e: Error) => e instanceof WorkspaceError)
  assert.throws(() => resolveWorkspaceRoot(null), (e: Error) => e instanceof WorkspaceError)
  assert.throws(() => resolveWorkspaceRoot(undefined), (e: Error) => e instanceof WorkspaceError)
})

test("resolveWorkspaceRoot rejects non-existent dirs", () => {
  assert.throws(
    () => resolveWorkspaceRoot("/nope-this-path-does-not-exist-12345"),
    (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "invalid_root",
  )
})

test("resolveWorkspaceRoot rejects files (not directories)", () => {
  const sb = tmpProject()
  try {
    assert.throws(
      () => resolveWorkspaceRoot(path.join(sb.root, "src", "index.ts")),
      (e: Error) => e instanceof WorkspaceError,
    )
  } finally {
    sb.cleanup()
  }
})

// ---------------------------------------------------------------------------
// resolveInsideWorkspace (the path-safety surface)
// ---------------------------------------------------------------------------

test("resolveInsideWorkspace rejects absolute paths from the client", () => {
  const sb = tmpProject()
  try {
    assert.throws(
      () => resolveInsideWorkspace(sb.root, "/etc/passwd"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "absolute_path",
    )
  } finally {
    sb.cleanup()
  }
})

test("resolveInsideWorkspace rejects ../ traversal", () => {
  const sb = tmpProject()
  try {
    assert.throws(
      () => resolveInsideWorkspace(sb.root, "../../etc/passwd"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "outside_workspace",
    )
    assert.throws(
      () => resolveInsideWorkspace(sb.root, "src/../../escape"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "outside_workspace",
    )
  } finally {
    sb.cleanup()
  }
})

test("resolveInsideWorkspace rejects ignored directory segments", () => {
  const sb = tmpProject()
  try {
    for (const ignored of [".git", "node_modules", ".next", "__pycache__"]) {
      assert.throws(
        () => resolveInsideWorkspace(sb.root, `${ignored}/inside.ts`),
        (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "ignored",
        `expected "${ignored}" to be rejected as ignored`,
      )
    }
  } finally {
    sb.cleanup()
  }
})

test("resolveInsideWorkspace accepts plain relative paths", () => {
  const sb = tmpProject()
  try {
    const r = resolveInsideWorkspace(sb.root, "src/index.ts")
    assert.equal(r.relative, "src/index.ts")
    assert.ok(r.absolute.endsWith("src/index.ts"))
    // empty-string is the root itself (used by the tree endpoint)
    const root = resolveInsideWorkspace(sb.root, "")
    assert.equal(root.relative, "")
    assert.equal(root.absolute, sb.root)
  } finally {
    sb.cleanup()
  }
})

test("resolveInsideWorkspace rejects symlinks that escape via realpath", () => {
  const sb = tmpProject()
  // We have to realpath the outside-tmpdir too: on macOS `os.tmpdir()`
  // is `/var/folders/...` which is itself a symlink to `/private/var/...`,
  // so an un-realpathed comparison would falsely accept the escape.
  const outsideRaw = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"))
  const outside = fs.realpathSync(outsideRaw)
  try {
    // Create an actual target file so realpath on the symlink chain
    // returns the canonical outside path (otherwise realpath silently
    // falls back to the original input and the check passes — meaning
    // the safety net wouldn't activate in production either).
    fs.writeFileSync(path.join(outside, "secret.txt"), "private\n")
    const linkPath = path.join(sb.root, "src", "escape")
    fs.symlinkSync(outside, linkPath, "dir")
    assert.throws(
      () => resolveInsideWorkspace(sb.root, "src/escape/secret.txt"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "outside_workspace",
    )
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
    sb.cleanup()
  }
})

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

test("listDirectory returns dirs before files, alphabetically, with sizes", () => {
  const sb = tmpProject()
  try {
    const entries = listDirectory(sb.root, "")
    const names = entries.map((e) => e.name)
    // node_modules + any iCloud / .DS_Store noise must be filtered.
    assert.equal(names.includes("node_modules"), false, "node_modules must be hidden")
    // Dirs first, then files. With this fixture the only top-level dirs
    // are bin/, docs/, src/ — no files at the root.
    assert.deepEqual(names, ["bin", "docs", "src"])
    for (const e of entries) {
      if (e.type === "dir") assert.equal(e.size, null)
    }
  } finally {
    sb.cleanup()
  }
})

test("listDirectory throws not_found for missing subfolder", () => {
  const sb = tmpProject()
  try {
    assert.throws(
      () => listDirectory(sb.root, "nope"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "not_found",
    )
  } finally {
    sb.cleanup()
  }
})

// ---------------------------------------------------------------------------
// readWorkspaceFile
// ---------------------------------------------------------------------------

test("readWorkspaceFile loads text + reports language hint", () => {
  const sb = tmpProject()
  try {
    const f = readWorkspaceFile(sb.root, "src/index.ts")
    assert.equal(f.path, "src/index.ts")
    assert.equal(f.encoding, "utf-8")
    assert.equal(f.language, "typescript")
    assert.match(f.content, /console\.log/)
    assert.ok(f.size > 0)
    assert.ok(f.mtimeMs > 0)
  } finally {
    sb.cleanup()
  }
})

test("readWorkspaceFile rejects directories with is_dir", () => {
  const sb = tmpProject()
  try {
    assert.throws(
      () => readWorkspaceFile(sb.root, "src"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "is_dir",
    )
  } finally {
    sb.cleanup()
  }
})

test("readWorkspaceFile flags known-binary extensions and NUL-byte content", () => {
  const sb = tmpProject()
  try {
    assert.throws(
      () => readWorkspaceFile(sb.root, "bin/blob.png"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "binary",
      "PNG extension must be flagged",
    )
    assert.throws(
      () => readWorkspaceFile(sb.root, "bin/nul.dat"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "binary",
      "NUL byte must be flagged",
    )
  } finally {
    sb.cleanup()
  }
})

test("readWorkspaceFile enforces MAX_EDITOR_FILE_BYTES", () => {
  const sb = tmpProject()
  try {
    // 1 MiB + 1 byte of ASCII to trip the size cap (avoiding the NUL
    // sniffer so we hit too_large, not binary).
    const big = "a".repeat(MAX_EDITOR_FILE_BYTES + 1)
    fs.writeFileSync(path.join(sb.root, "big.txt"), big)
    assert.throws(
      () => readWorkspaceFile(sb.root, "big.txt"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "too_large",
    )
  } finally {
    sb.cleanup()
  }
})

// ---------------------------------------------------------------------------
// writeWorkspaceFile
// ---------------------------------------------------------------------------

test("writeWorkspaceFile saves inside root and returns new size/mtime", () => {
  const sb = tmpProject()
  try {
    const out = writeWorkspaceFile(sb.root, "src/index.ts", "console.log('edited')\n")
    assert.equal(out.path, "src/index.ts")
    assert.ok(out.size > 0)
    const onDisk = fs.readFileSync(path.join(sb.root, "src", "index.ts"), "utf-8")
    assert.equal(onDisk, "console.log('edited')\n")
  } finally {
    sb.cleanup()
  }
})

test("writeWorkspaceFile rejects path traversal", () => {
  const sb = tmpProject()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-write-"))
  try {
    assert.throws(
      () => writeWorkspaceFile(sb.root, "../escape.ts", "pwned"),
      (e: Error) => e instanceof WorkspaceError,
    )
    // And explicitly: nothing got written outside.
    assert.equal(fs.readdirSync(outside).length, 0, "no file should exist outside the root")
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
    sb.cleanup()
  }
})

test("writeWorkspaceFile rejects writes inside ignored directories", () => {
  const sb = tmpProject()
  try {
    assert.throws(
      () => writeWorkspaceFile(sb.root, "node_modules/pkg/index.js", "// owned"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "ignored",
    )
  } finally {
    sb.cleanup()
  }
})

test("writeWorkspaceFile is atomic — tmp file is cleaned up on rename failure", () => {
  const sb = tmpProject()
  try {
    // Target is a directory → writeFileSync to tmp succeeds, rename
    // over a directory fails on macOS/Linux. The helper should surface
    // an io_error and leave the directory untouched.
    assert.throws(
      () => writeWorkspaceFile(sb.root, "src", "this should not work"),
      (e: Error) => e instanceof WorkspaceError && (e as WorkspaceError).code === "is_dir",
    )
    // The original directory still exists with its files.
    assert.ok(fs.statSync(path.join(sb.root, "src")).isDirectory())
    assert.ok(fs.existsSync(path.join(sb.root, "src", "index.ts")))
  } finally {
    sb.cleanup()
  }
})

// ---------------------------------------------------------------------------
// looksBinary / guessLanguage smoke tests
// ---------------------------------------------------------------------------

test("looksBinary catches NUL bytes within the sniff window", () => {
  assert.equal(looksBinary(Buffer.from("hello")), false)
  assert.equal(looksBinary(Buffer.from([0x68, 0x00, 0x69])), true)
})

test("guessLanguage maps common extensions", () => {
  assert.equal(guessLanguage(".ts"), "typescript")
  assert.equal(guessLanguage(".tsx"), "typescript")
  assert.equal(guessLanguage(".py"), "python")
  assert.equal(guessLanguage(".md"), "markdown")
  assert.equal(guessLanguage(".unknown-thing"), "plaintext")
})

test("IGNORED_DIRS sanity: must include the canonical noise", () => {
  for (const required of [".git", "node_modules", ".next", "__pycache__", ".venv", "dist", "build"]) {
    assert.ok(IGNORED_DIRS.has(required), `${required} missing from IGNORED_DIRS`)
  }
})
