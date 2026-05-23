/**
 * Module-level workspace data store.
 *
 * Purpose
 * -------
 * Holds the in-flight Promise and cached response for every
 * `/api/workspace/tree` and `/api/workspace/file` request the workspace
 * UI makes. Lives *outside* React on purpose: by sharing one cache
 * across every component instance, we sidestep the entire class of
 * bugs where a React Strict-Mode double-mount (or any parent re-render
 * that drops the workspace subtree) tears down the component that
 * "owns" an inflight fetch, leaving every future mount stuck on a
 * spinner because a per-instance dedup ref is still set.
 *
 * Design notes
 * ------------
 *   * Two endpoints, two key-spaces: `tree::<root>::<path>` and
 *     `file::<root>::<path>`. Tree and file caches never collide so a
 *     directory and a file with the same path don't share state.
 *   * Coalesce in-flight requests: a second call for the same key
 *     returns the same Promise the first call kicked off. The cached
 *     `Snapshot` is updated atomically when the Promise resolves
 *     (success → `data` filled; failure → `error` filled) and every
 *     subscriber is notified.
 *   * Stable `Snapshot` identity: the Snapshot returned for a key is
 *     reference-stable while nothing has changed, which is required
 *     for `useSyncExternalStore` to skip re-renders. Mutations
 *     allocate a new Snapshot object.
 *   * No `AbortController` plumbed in here. Cancellation has no
 *     useful semantics for a shared cache (the next subscriber will
 *     still want the data); we rely on a fetch-side timeout instead.
 *   * `invalidate(root)` is a deliberate sledgehammer: clears every
 *     entry whose key starts with the given root. Used by the
 *     "Refresh" buttons and after Re-run Scan, where any file on
 *     disk could plausibly have changed.
 *
 * Public surface is intentionally tiny:
 *   getTree(root, path) -> Snapshot<TreeResponse>
 *   getFile(root, path) -> Snapshot<FileResponse>
 *   subscribe(fn) -> unsubscribe
 *   invalidate(root) -> void
 *
 * The two getters NEVER throw. Network/parse failures end up on
 * `snapshot.error` so callers can render an error UI without
 * try/catching every read.
 *
 * Rollback
 * --------
 * `USE_STORE` at the top of this file disables shared caching: every
 * read becomes a fresh fetch and `subscribe` becomes a no-op. Useful
 * if the shared cache ever causes user-visible staleness; flip and
 * ship without removing the hook layer.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// One flag to fall back to per-call fetches if the shared store ever
// surprises us in production. The hook layer doesn't care which mode
// is active.
const USE_STORE = true

export interface TreeEntry {
  name: string
  path: string
  type: "file" | "dir"
  size: number | null
}

export interface TreeResponse {
  entries: TreeEntry[]
}

export interface FileResponse {
  path: string
  content: string
  language: string | null
  mtimeMs: number | null
  size: number
  /** Set when the server returned 415 (binary) or 413 (too large).
   *  The UI shows a placeholder instead of the editor. */
  placeholder: string | null
  /** True for placeholder responses (binary / too-large). */
  readOnly: boolean
}

export interface Snapshot<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** Monotonically increasing version stamp for this key. Cheap way to
   *  invalidate `useMemo`s that derive from the snapshot without
   *  recomputing identity rules. */
  version: number
}

// Empty snapshots are reference-stable so `useSyncExternalStore`'s
// `getServerSnapshot` and the "no key yet" branches don't trigger
// spurious re-renders in development.
const EMPTY_TREE: Snapshot<TreeResponse> = Object.freeze({
  data: null,
  error: null,
  loading: false,
  version: 0,
})
const EMPTY_FILE: Snapshot<FileResponse> = Object.freeze({
  data: null,
  error: null,
  loading: false,
  version: 0,
})

type Listener = () => void

interface State {
  tree: Map<string, Snapshot<TreeResponse>>
  file: Map<string, Snapshot<FileResponse>>
  inflightTree: Map<string, Promise<Snapshot<TreeResponse>>>
  inflightFile: Map<string, Promise<Snapshot<FileResponse>>>
  listeners: Set<Listener>
  version: number
}

const state: State = {
  tree: new Map(),
  file: new Map(),
  inflightTree: new Map(),
  inflightFile: new Map(),
  listeners: new Set(),
  version: 0,
}

function notifyAll(): void {
  // CRITICAL: deferred to a microtask.
  //
  // `getTree`/`getFile` are called from React `useSyncExternalStore`
  // snapshot readers during the render phase. The very first read of a
  // key seeds a `loading: true` snapshot synchronously so the calling
  // component sees the spinner state on its current render. Without
  // this deferral, the resulting `setTreeSnapshot` → `notifyAll` would
  // call subscribed `forceUpdate`s while React is mid-render of
  // another component, which React turns into the warning:
  //   "Cannot update a component (TreeChildren) while rendering a
  //    different component (TreeChildren)"
  // and then bails out of in-flight commits — which is what was
  // killing the AI-explanation `AbortController` (the side panel's
  // effect cleanup fired during the bail, aborting the OpenAI fetch).
  //
  // A microtask defers the listener fan-out past the current render
  // pass without measurable latency: by the time React's commit
  // phase finishes, the queue drains and everyone gets the update.
  queueMicrotask(() => {
    for (const fn of state.listeners) {
      try {
        fn()
      } catch {
        // A buggy listener must not break other listeners — render
        // logic that throws will be caught by React's own error
        // boundary, this is belt-and-braces.
      }
    }
  })
}

function treeKey(root: string, relPath: string): string {
  return `${root}\u0000${relPath}`
}

function fileKey(root: string, relPath: string): string {
  return `${root}\u0000${relPath}`
}

// ---------------------------------------------------------------------------
// Fetcher injection
// ---------------------------------------------------------------------------
// The store uses `globalThis.fetch` by default, which is fine for the
// browser and Node 18+. Tests inject a stub via `_setFetcherForTests`
// so they can simulate concurrency, errors, and slow responses without
// spinning up a real server.

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetcher: Fetcher = (input, init) => globalThis.fetch(input as any, init)

/** @internal Test seam: override the fetcher. Returns the previous one
 *  so tests can restore it in `t.after`. */
export function _setFetcherForTests(next: Fetcher | null): Fetcher {
  const prev = fetcher
  fetcher = next ?? ((input, init) => globalThis.fetch(input as any, init))
  return prev
}

/** @internal Test seam: blow away every map / counter. Call in
 *  `t.beforeEach` so tests don't bleed state into each other. */
export function _resetForTests(): void {
  state.tree.clear()
  state.file.clear()
  state.inflightTree.clear()
  state.inflightFile.clear()
  state.listeners.clear()
  state.version = 0
}

// ---------------------------------------------------------------------------
// Fetch helpers (private)
// ---------------------------------------------------------------------------

/**
 * Wraps `fetcher` with an explicit timeout so a dev server / OS hang
 * surfaces as a regular error on the snapshot instead of an infinite
 * spinner.
 *
 * The timeout intentionally lives here, not at the call site: every
 * store consumer must inherit the same hang-detection behaviour
 * (otherwise we re-introduce the "ref says busy, state says idle"
 * trap we're trying to escape).
 */
async function timedFetch(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException("timeout", "AbortError")),
    timeoutMs,
  )
  try {
    return await fetcher(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function bumpVersion(): number {
  state.version += 1
  return state.version
}

function setTreeSnapshot(key: string, snap: Snapshot<TreeResponse>): void {
  state.tree.set(key, snap)
  notifyAll()
}

function setFileSnapshot(key: string, snap: Snapshot<FileResponse>): void {
  state.file.set(key, snap)
  notifyAll()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to store changes. Returns the unsubscribe function. Pair
 * with `getTree` / `getFile` to drive `useSyncExternalStore`.
 *
 * Listeners are called once per state mutation across the whole
 * store. We rely on React 18's snapshot equality check to skip
 * re-renders for components whose specific key hasn't changed.
 */
export function subscribe(fn: Listener): () => void {
  state.listeners.add(fn)
  return () => {
    state.listeners.delete(fn)
  }
}

/**
 * Read the current snapshot for a tree entry. Triggers a fetch if
 * we've never loaded this key (or if it was invalidated) and there's
 * no fetch already in flight.
 *
 * Returns synchronously. `loading: true` while a fetch is in flight,
 * `data` filled on success, `error` filled on failure. The same
 * snapshot identity is returned across renders while nothing has
 * changed — required for `useSyncExternalStore`'s skip-render
 * optimisation.
 */
export function getTree(root: string, relPath: string): Snapshot<TreeResponse> {
  if (!root) return EMPTY_TREE
  const key = treeKey(root, relPath)
  const cached = state.tree.get(key)
  if (cached) return cached

  if (!USE_STORE) {
    // Hatch: fall back to a fire-and-forget fetch that updates the
    // cache once but never reuses it. Effectively the per-mount
    // behaviour, while keeping the hook surface identical.
    void startTreeFetch(root, relPath, key)
    const snap: Snapshot<TreeResponse> = {
      data: null,
      error: null,
      loading: true,
      version: bumpVersion(),
    }
    state.tree.set(key, snap)
    return snap
  }

  if (!state.inflightTree.has(key)) {
    void startTreeFetch(root, relPath, key)
  }
  // startTreeFetch synchronously seeds a loading snapshot so the very
  // first reader sees `loading: true` rather than `EMPTY_TREE`.
  return state.tree.get(key) ?? EMPTY_TREE
}

/**
 * Read the current snapshot for a file. Same semantics as `getTree`.
 */
export function getFile(root: string, relPath: string): Snapshot<FileResponse> {
  if (!root || !relPath) return EMPTY_FILE
  const key = fileKey(root, relPath)
  const cached = state.file.get(key)
  if (cached) return cached

  if (!USE_STORE) {
    void startFileFetch(root, relPath, key)
    const snap: Snapshot<FileResponse> = {
      data: null,
      error: null,
      loading: true,
      version: bumpVersion(),
    }
    state.file.set(key, snap)
    return snap
  }

  if (!state.inflightFile.has(key)) {
    void startFileFetch(root, relPath, key)
  }
  return state.file.get(key) ?? EMPTY_FILE
}

/**
 * Drop every cached entry whose `root` matches. Both successful and
 * in-flight entries are evicted so the next `getTree`/`getFile` issues
 * a fresh fetch.
 *
 * Used by the "Refresh" button in the file tree and after Re-run Scan
 * (because any file on disk could have changed).
 */
export function invalidate(root: string): void {
  if (!root) return
  const prefix = `${root}\u0000`
  let mutated = false
  for (const key of state.tree.keys()) {
    if (key.startsWith(prefix)) {
      state.tree.delete(key)
      mutated = true
    }
  }
  for (const key of state.file.keys()) {
    if (key.startsWith(prefix)) {
      state.file.delete(key)
      mutated = true
    }
  }
  for (const key of state.inflightTree.keys()) {
    if (key.startsWith(prefix)) state.inflightTree.delete(key)
  }
  for (const key of state.inflightFile.keys()) {
    if (key.startsWith(prefix)) state.inflightFile.delete(key)
  }
  if (mutated) notifyAll()
}

/**
 * Optimistic write after a successful Save: updates the cached file
 * snapshot in place so the editor reflects the new content without a
 * round-trip. The next `invalidate(root)` (e.g. Re-run Scan) re-reads
 * from disk to confirm.
 */
export function updateFileCache(
  root: string,
  relPath: string,
  patch: Partial<FileResponse>,
): void {
  const key = fileKey(root, relPath)
  const current = state.file.get(key)
  if (!current?.data) return
  const next: Snapshot<FileResponse> = {
    data: { ...current.data, ...patch },
    error: null,
    loading: false,
    version: bumpVersion(),
  }
  state.file.set(key, next)
  notifyAll()
}

// ---------------------------------------------------------------------------
// Fetch orchestration (private)
// ---------------------------------------------------------------------------

function startTreeFetch(root: string, relPath: string, key: string): Promise<Snapshot<TreeResponse>> {
  // Seed a `loading: true` snapshot synchronously so every
  // `useSyncExternalStore` reader on the very first frame after the
  // request was kicked off sees the spinner state instead of EMPTY.
  const loadingSnap: Snapshot<TreeResponse> = {
    data: null,
    error: null,
    loading: true,
    version: bumpVersion(),
  }
  setTreeSnapshot(key, loadingSnap)

  const promise = (async (): Promise<Snapshot<TreeResponse>> => {
    try {
      const url = new URL("/api/workspace/tree", window.location.origin)
      url.searchParams.set("root", root)
      if (relPath) url.searchParams.set("path", relPath)
      const res = await timedFetch(url.toString(), 8_000)
      const body = await res.json().catch(() => ({} as any))
      if (!res.ok) {
        const err: Snapshot<TreeResponse> = {
          data: null,
          error: body?.error || `tree failed: ${res.status}`,
          loading: false,
          version: bumpVersion(),
        }
        setTreeSnapshot(key, err)
        return err
      }
      const ok: Snapshot<TreeResponse> = {
        data: { entries: Array.isArray(body?.entries) ? body.entries : [] },
        error: null,
        loading: false,
        version: bumpVersion(),
      }
      setTreeSnapshot(key, ok)
      return ok
    } catch (e) {
      const err: Snapshot<TreeResponse> = {
        data: null,
        error: (e as Error).message || "tree failed",
        loading: false,
        version: bumpVersion(),
      }
      setTreeSnapshot(key, err)
      return err
    } finally {
      state.inflightTree.delete(key)
    }
  })()

  state.inflightTree.set(key, promise)
  return promise
}

function startFileFetch(root: string, relPath: string, key: string): Promise<Snapshot<FileResponse>> {
  const loadingSnap: Snapshot<FileResponse> = {
    data: null,
    error: null,
    loading: true,
    version: bumpVersion(),
  }
  setFileSnapshot(key, loadingSnap)

  const promise = (async (): Promise<Snapshot<FileResponse>> => {
    try {
      const url = new URL("/api/workspace/file", window.location.origin)
      url.searchParams.set("root", root)
      url.searchParams.set("path", relPath)
      const res = await timedFetch(url.toString(), 10_000)
      const body = await res.json().catch(() => ({} as any))
      if (!res.ok) {
        // 415/binary and 413/too-large are NOT errors from the user's
        // perspective — we surface them as cached read-only
        // placeholder snapshots so the next reader sees the same
        // banner without re-fetching.
        if (res.status === 415) {
          const snap: Snapshot<FileResponse> = {
            data: {
              path: relPath,
              content: "",
              language: null,
              mtimeMs: null,
              size: 0,
              placeholder: "Binary file — preview not shown.",
              readOnly: true,
            },
            error: null,
            loading: false,
            version: bumpVersion(),
          }
          setFileSnapshot(key, snap)
          return snap
        }
        if (res.status === 413) {
          const snap: Snapshot<FileResponse> = {
            data: {
              path: relPath,
              content: "",
              language: null,
              mtimeMs: null,
              size: 0,
              placeholder: "File is too large to open in the editor.",
              readOnly: true,
            },
            error: null,
            loading: false,
            version: bumpVersion(),
          }
          setFileSnapshot(key, snap)
          return snap
        }
        const err: Snapshot<FileResponse> = {
          data: null,
          error: body?.error || `load failed: ${res.status}`,
          loading: false,
          version: bumpVersion(),
        }
        setFileSnapshot(key, err)
        return err
      }
      const ok: Snapshot<FileResponse> = {
        data: {
          path: body.path ?? relPath,
          content: body.content ?? "",
          language: body.language ?? null,
          mtimeMs: body.mtimeMs ?? null,
          size: body.size ?? 0,
          placeholder: null,
          readOnly: false,
        },
        error: null,
        loading: false,
        version: bumpVersion(),
      }
      setFileSnapshot(key, ok)
      return ok
    } catch (e) {
      const err: Snapshot<FileResponse> = {
        data: null,
        error: (e as Error).message || "load failed",
        loading: false,
        version: bumpVersion(),
      }
      setFileSnapshot(key, err)
      return err
    } finally {
      state.inflightFile.delete(key)
    }
  })()

  state.inflightFile.set(key, promise)
  return promise
}

// Tests need to await the in-flight Promise without re-issuing a
// fetch; this lets them assert deterministically that the cached
// result is correct, instead of guessing at a setTimeout.
/** @internal */
export function _inflightTreePromise(root: string, relPath: string): Promise<unknown> | undefined {
  return state.inflightTree.get(treeKey(root, relPath))
}

/** @internal */
export function _inflightFilePromise(root: string, relPath: string): Promise<unknown> | undefined {
  return state.inflightFile.get(fileKey(root, relPath))
}
