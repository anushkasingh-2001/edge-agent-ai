/**
 * Tests for `lib/workspace-store`.
 *
 * Run with:
 *    pnpm test:workspace-store
 *
 * which expands to:
 *    node --import tsx/esm --test tests/workspace-store.test.ts
 *
 * These tests directly exercise the module-level store, with a stub
 * `fetch` injected via `_setFetcherForTests`. They do not render any
 * React tree — the React layer is a thin `useSyncExternalStore`
 * wrapper and its correctness reduces to the store's correctness.
 *
 * The "Regression for current bug" test below is the explicit guard
 * against the failure mode that motivated this whole refactor: when a
 * component that owns an in-flight fetch unmounts (Strict Mode, parent
 * re-render dropping the subtree), the next requester for the same
 * key must still receive the resolved data.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

// `lib/workspace-store` only reads `window.location.origin` inside
// its fetcher functions (not at module init), so a static import is
// safe as long as we stub `window` before the first call that
// actually hits the fetcher.
const g = globalThis as unknown as { window: { location: { origin: string } } }
g.window = { location: { origin: "http://test.local" } }

import {
  _resetForTests,
  _setFetcherForTests,
  _inflightTreePromise,
  _inflightFilePromise,
  getTree,
  getFile,
  invalidate,
  subscribe,
  updateFileCache,
} from "../lib/workspace-store"

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

interface StubResponse {
  status?: number
  ok?: boolean
  body?: unknown
}

function makeResponse({ status = 200, ok, body = {} }: StubResponse): Response {
  return {
    status,
    ok: ok ?? (status >= 200 && status < 300),
    json: async () => body,
  } as unknown as Response
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// `notifyAll` defers via `queueMicrotask` to avoid the React
// "setState during render" warning, so listener assertions need to
// flush the microtask queue. A single macrotask hop is enough.
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// Tree fetches
// ---------------------------------------------------------------------------

test("two concurrent getTree calls share one fetch", async () => {
  _resetForTests()
  let callCount = 0
  _setFetcherForTests(async () => {
    callCount += 1
    return makeResponse({ body: { entries: [{ name: "a", path: "a", type: "file", size: 1 }] } })
  })

  const a = getTree("/repo", "")
  const b = getTree("/repo", "")
  assert.equal(a.loading, true, "first read should be loading")
  assert.equal(b.loading, true, "second read should also be loading (same promise)")
  assert.strictEqual(a, b, "two concurrent reads must return the same snapshot identity")

  await _inflightTreePromise("/repo", "")
  assert.equal(callCount, 1, "fetch should fire exactly once for two concurrent reads")
  const after = getTree("/repo", "")
  assert.equal(after.loading, false)
  assert.deepEqual(after.data?.entries.map((e) => e.name), ["a"])
})

test("third call after resolve returns cached snapshot synchronously", async () => {
  _resetForTests()
  let callCount = 0
  _setFetcherForTests(async () => {
    callCount += 1
    return makeResponse({ body: { entries: [{ name: "x", path: "x", type: "file", size: 0 }] } })
  })

  getTree("/repo", "src")
  await _inflightTreePromise("/repo", "src")
  const first = getTree("/repo", "src")
  const second = getTree("/repo", "src")
  assert.strictEqual(first, second, "cached snapshot identity must be stable")
  assert.equal(callCount, 1, "third call must hit the cache, not re-fetch")
})

test("regression: mount A starts fetch, A unmounts, mount B gets the same data", async () => {
  // Repros the failure mode the workspace view had with per-mount
  // inflight refs: the original requester goes away while the fetch
  // is in flight, then a new requester arrives. The store must
  // serve the new requester from the resolved cache without re-
  // fetching.
  _resetForTests()
  let callCount = 0
  const gate = deferred<Response>()
  _setFetcherForTests(async () => {
    callCount += 1
    return gate.promise
  })

  // Mount A subscribes and reads → kicks off the fetch.
  const seenA: number[] = []
  const unsubA = subscribe(() => {
    seenA.push(getTree("/repo", "").version)
  })
  getTree("/repo", "")
  assert.equal(callCount, 1)

  // Mount A unmounts (Strict Mode double-mount or parent re-render
  // dropping the subtree) before the fetch resolves.
  unsubA()

  // Mount B arrives — should observe the same in-flight promise and
  // see the resolved data, not start a second fetch.
  const seenB: number[] = []
  const unsubB = subscribe(() => {
    seenB.push(getTree("/repo", "").version)
  })
  const beforeResolveB = getTree("/repo", "")
  assert.equal(beforeResolveB.loading, true, "B reads while fetch is still in flight")

  gate.resolve(makeResponse({ body: { entries: [{ name: "ok", path: "ok", type: "file", size: 1 }] } }))
  await _inflightTreePromise("/repo", "")
  await flushMicrotasks()

  const finalB = getTree("/repo", "")
  assert.equal(finalB.loading, false, "B must see the resolved data")
  assert.deepEqual(finalB.data?.entries.map((e) => e.name), ["ok"])
  assert.equal(callCount, 1, "exactly one fetch must have happened across both mounts")
  assert.ok(seenB.length >= 1, "B's listener must have been notified")

  unsubB()
})

test("invalidate(root) clears both successful and in-flight entries", async () => {
  _resetForTests()
  let callCount = 0
  _setFetcherForTests(async () => {
    callCount += 1
    return makeResponse({ body: { entries: [{ name: `n${callCount}`, path: "p", type: "file", size: 0 }] } })
  })

  getTree("/repo", "")
  await _inflightTreePromise("/repo", "")
  assert.equal(callCount, 1)

  invalidate("/repo")
  const after = getTree("/repo", "")
  assert.equal(after.loading, true, "post-invalidate read must re-fetch")
  await _inflightTreePromise("/repo", "")
  assert.equal(callCount, 2, "invalidate must drop the cache so the next read re-fetches")
})

test("invalidate(otherRoot) leaves unrelated entries alone", async () => {
  _resetForTests()
  let calls = 0
  _setFetcherForTests(async () => {
    calls += 1
    return makeResponse({ body: { entries: [] } })
  })

  getTree("/repoA", "")
  await _inflightTreePromise("/repoA", "")
  assert.equal(calls, 1)

  invalidate("/repoB")
  const a = getTree("/repoA", "")
  assert.equal(a.loading, false, "/repoA must remain cached when /repoB is invalidated")
  assert.equal(calls, 1, "no extra fetch should happen")
})

test("non-OK tree response is cached as an error snapshot", async () => {
  _resetForTests()
  let calls = 0
  _setFetcherForTests(async () => {
    calls += 1
    return makeResponse({ status: 500, body: { error: "boom" } })
  })

  getTree("/repo", "")
  await _inflightTreePromise("/repo", "")
  const snap = getTree("/repo", "")
  assert.equal(snap.loading, false)
  assert.equal(snap.error, "boom")
  assert.equal(snap.data, null)

  // Second read returns the cached error without re-fetching. Users
  // hit "Retry" to force a refetch via invalidate.
  getTree("/repo", "")
  assert.equal(calls, 1)
})

test("network exception ends up on the error field", async () => {
  _resetForTests()
  _setFetcherForTests(async () => {
    throw new Error("ECONNRESET")
  })

  getTree("/repo", "x")
  await _inflightTreePromise("/repo", "x")
  const snap = getTree("/repo", "x")
  assert.equal(snap.loading, false)
  assert.ok(snap.error?.includes("ECONNRESET"))
  assert.equal(snap.data, null)
})

// ---------------------------------------------------------------------------
// File fetches
// ---------------------------------------------------------------------------

test("getFile dedupes concurrent reads the same way as getTree", async () => {
  _resetForTests()
  let calls = 0
  _setFetcherForTests(async () => {
    calls += 1
    return makeResponse({
      body: {
        path: "src/index.ts",
        content: "export {}\n",
        language: "ts",
        size: 10,
        mtimeMs: 1,
      },
    })
  })

  const a = getFile("/repo", "src/index.ts")
  const b = getFile("/repo", "src/index.ts")
  assert.strictEqual(a, b)
  await _inflightFilePromise("/repo", "src/index.ts")
  const after = getFile("/repo", "src/index.ts")
  assert.equal(after.data?.content, "export {}\n")
  assert.equal(after.data?.readOnly, false)
  assert.equal(after.data?.placeholder, null)
  assert.equal(calls, 1)
})

test("getFile 415 binary is cached as a read-only placeholder, not an error", async () => {
  _resetForTests()
  _setFetcherForTests(async () => makeResponse({ status: 415, body: { error: "binary" } }))

  getFile("/repo", "img/logo.png")
  await _inflightFilePromise("/repo", "img/logo.png")
  const snap = getFile("/repo", "img/logo.png")
  assert.equal(snap.error, null, "415 is not an error from the UI's perspective")
  assert.equal(snap.data?.readOnly, true)
  assert.equal(snap.data?.placeholder, "Binary file — preview not shown.")
})

test("getFile 413 too-large is cached as a read-only placeholder", async () => {
  _resetForTests()
  _setFetcherForTests(async () => makeResponse({ status: 413, body: { error: "too large" } }))

  getFile("/repo", "logs/huge.log")
  await _inflightFilePromise("/repo", "logs/huge.log")
  const snap = getFile("/repo", "logs/huge.log")
  assert.equal(snap.error, null)
  assert.equal(snap.data?.readOnly, true)
  assert.equal(snap.data?.placeholder, "File is too large to open in the editor.")
})

test("getFile 5xx is surfaced as a regular error snapshot", async () => {
  _resetForTests()
  _setFetcherForTests(async () => makeResponse({ status: 500, body: { error: "io" } }))

  getFile("/repo", "src/broken.ts")
  await _inflightFilePromise("/repo", "src/broken.ts")
  const snap = getFile("/repo", "src/broken.ts")
  assert.equal(snap.loading, false)
  assert.equal(snap.error, "io")
  assert.equal(snap.data, null)
})

// ---------------------------------------------------------------------------
// Empty-key short-circuit
// ---------------------------------------------------------------------------

test("getTree('', anything) returns the empty snapshot without fetching", async () => {
  _resetForTests()
  let calls = 0
  _setFetcherForTests(async () => {
    calls += 1
    return makeResponse({ body: { entries: [] } })
  })

  const snap = getTree("", "src")
  assert.equal(snap.loading, false)
  assert.equal(snap.data, null)
  assert.equal(calls, 0, "no fetch should fire for empty root")
})

test("getFile('repo', '') returns the empty snapshot without fetching", async () => {
  _resetForTests()
  let calls = 0
  _setFetcherForTests(async () => {
    calls += 1
    return makeResponse({ body: {} })
  })

  const snap = getFile("/repo", "")
  assert.equal(snap.loading, false)
  assert.equal(snap.data, null)
  assert.equal(calls, 0)
})

// ---------------------------------------------------------------------------
// updateFileCache (optimistic Save)
// ---------------------------------------------------------------------------

test("updateFileCache patches the cached file snapshot in place", async () => {
  _resetForTests()
  _setFetcherForTests(async () =>
    makeResponse({
      body: {
        path: "src/a.ts",
        content: "old\n",
        language: "ts",
        size: 4,
        mtimeMs: 100,
      },
    }),
  )
  getFile("/repo", "src/a.ts")
  await _inflightFilePromise("/repo", "src/a.ts")

  let notifyCount = 0
  const unsub = subscribe(() => {
    notifyCount += 1
  })
  updateFileCache("/repo", "src/a.ts", { content: "new\n", size: 4, mtimeMs: 200 })
  const snap = getFile("/repo", "src/a.ts")
  assert.equal(snap.data?.content, "new\n")
  assert.equal(snap.data?.mtimeMs, 200)
  assert.equal(snap.data?.language, "ts", "untouched fields must be preserved")
  await flushMicrotasks()
  assert.ok(notifyCount > 0, "subscribers must be notified of the patch")
  unsub()
})

test("updateFileCache is a no-op when the file isn't cached", async () => {
  _resetForTests()
  // Should not throw, should not allocate a snapshot.
  updateFileCache("/repo", "src/missing.ts", { content: "hi" })
  const snap = getFile("/repo", "")
  assert.equal(snap.data, null)
})

// ---------------------------------------------------------------------------
// subscribe()
// ---------------------------------------------------------------------------

test("subscribe receives notifications when a fetch resolves", async () => {
  _resetForTests()
  _setFetcherForTests(async () => makeResponse({ body: { entries: [] } }))

  let n = 0
  const unsub = subscribe(() => {
    n += 1
  })
  getTree("/repo", "")
  await _inflightTreePromise("/repo", "")
  await flushMicrotasks()
  assert.ok(n >= 1, "subscribe must fire at least once across loading→resolved")
  unsub()
})

test("subscribe returned function unsubscribes cleanly", async () => {
  _resetForTests()
  _setFetcherForTests(async () => makeResponse({ body: { entries: [] } }))

  let n = 0
  const unsub = subscribe(() => {
    n += 1
  })
  unsub()
  getTree("/repo", "")
  await _inflightTreePromise("/repo", "")
  await flushMicrotasks()
  assert.equal(n, 0, "after unsub, listener must not be called")
})
