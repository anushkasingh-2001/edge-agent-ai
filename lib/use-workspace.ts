"use client"

/**
 * React hook layer over `lib/workspace-store`.
 *
 * Two thin hooks, both built on `useSyncExternalStore`:
 *
 *   useTree(root, relPath) -> Snapshot<TreeResponse>
 *   useFile(root, relPath) -> Snapshot<FileResponse>
 *
 * Behaviour
 * ---------
 *   * If `root` (or, for files, `relPath`) is empty, returns the
 *     `EMPTY` snapshot synchronously without ever touching the network.
 *     Lets callers render with `null`/empty selection without
 *     conditionally wrapping the hook (which would break React's
 *     rules-of-hooks).
 *   * The store starts the fetch synchronously on first read, so
 *     `loading: true` is observable in the same render that triggered
 *     it. Subsequent renders for the same key receive the same
 *     snapshot identity until the store mutates it.
 *   * Subscription cleanup happens via the returned unsubscribe so
 *     React Strict-Mode double-mount works correctly (resubscribing
 *     hits the existing module-level cache; data is preserved).
 *
 * Why hooks at all
 * ----------------
 * Components could call `getTree` / `getFile` directly, but they
 * wouldn't re-render when the data lands. The hook drives that.
 *
 * Why `useSyncExternalStore` and not `useEffect` + `useState`
 * -----------------------------------------------------------
 * `useSyncExternalStore` is React's officially-supported way to read
 * from an external mutable source: it handles tearing during
 * concurrent rendering, runs the snapshot reader synchronously, and
 * preserves identity when nothing changed. With `useEffect` we'd be
 * back to the same "mount A starts fetch, mount B never sees the
 * result" failure mode this whole refactor is trying to eliminate.
 */

import { useSyncExternalStore } from "react"

import {
  type Snapshot,
  type TreeResponse,
  type FileResponse,
  getTree as storeGetTree,
  getFile as storeGetFile,
  subscribe as storeSubscribe,
} from "./workspace-store"

// SSR snapshot: workspace data is always client-only (we never want
// to hit the local FS during a server render), so the empty snapshot
// is the only honest answer. The store's getters return EMPTY when
// asked with falsy keys, so no special-casing is needed beyond the
// argument check here.
const EMPTY_TREE_SERVER: Snapshot<TreeResponse> = {
  data: null,
  error: null,
  loading: false,
  version: 0,
}
const EMPTY_FILE_SERVER: Snapshot<FileResponse> = {
  data: null,
  error: null,
  loading: false,
  version: 0,
}

/**
 * Read the workspace store's snapshot for a directory listing.
 * Triggers a fetch the first time a given (`root`, `relPath`) is
 * read, then serves from cache.
 *
 * Passing an empty `root` short-circuits to the empty snapshot —
 * callers don't have to gate the hook behind a conditional.
 */
export function useTree(root: string, relPath: string): Snapshot<TreeResponse> {
  return useSyncExternalStore(
    storeSubscribe,
    () => storeGetTree(root, relPath),
    () => EMPTY_TREE_SERVER,
  )
}

/**
 * Read the workspace store's snapshot for a single file. Triggers a
 * fetch on first read of a (`root`, `relPath`) pair. Empty `root` or
 * empty `relPath` returns the empty snapshot — used by the editor
 * pane before a file has been chosen.
 */
export function useFile(root: string, relPath: string): Snapshot<FileResponse> {
  return useSyncExternalStore(
    storeSubscribe,
    () => storeGetFile(root, relPath),
    () => EMPTY_FILE_SERVER,
  )
}
