"use client"

/**
 * Lazy, keyboard-friendly file tree for the workspace view.
 *
 * Loads the immediate children of a directory the first time the user
 * expands it, then caches per-folder (in the module-level
 * `workspace-store`, *not* component state) so re-expansion is instant
 * and survives any React Strict-Mode double-mount or parent re-render
 * that would otherwise tear the tree subtree down mid-fetch.
 *
 * The tree is intentionally dumb about the workspace API surface — it
 * accepts a workspace `root` and emits `onSelectFile(path)` when the
 * user clicks a leaf. That keeps it reusable for future panels (diff
 * view, git status, etc.) without owning state about the active
 * workspace.
 *
 * What lives in this component (and what doesn't)
 * -----------------------------------------------
 *   Local (per-mount):  `expanded` set, `errors` cache, `refreshNonce`
 *   Module store:       directory listings (entries, loading, error)
 *
 * Directory listings live in the store on purpose: if a parent
 * remounts this component (Strict Mode, parent re-render, route
 * change), the next mount instantly sees the cached entries instead
 * of re-issuing every request.
 */

import type { JSX } from "react"
import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw } from "lucide-react"

import { useTree } from "@/lib/use-workspace"
import { invalidate as invalidateWorkspace, type TreeEntry } from "@/lib/workspace-store"
import { cn } from "@/lib/utils"

export type { TreeEntry }

export interface FileTreeProps {
  /** Workspace root that the tree is scoped to. */
  root: string
  /** Display label for the root row (usually the basename of `root`). */
  rootLabel: string
  /** Path of the currently-open file (relative to workspace root). */
  selectedPath: string | null
  onSelectFile: (relPath: string) => void
  /** Refresh: invalidate the store entry for this root and re-fetch.
   *  Bumped from the parent after Re-run Scan / Save so the tree picks
   *  up new files. */
  refreshKey?: number
}

function ancestorPaths(p: string): string[] {
  // ["src/components/views/findings.tsx"] →
  //   ["src", "src/components", "src/components/views"]
  if (!p) return []
  const parts = p.split("/")
  parts.pop() // drop the file itself
  const out: string[] = []
  let acc = ""
  for (const seg of parts) {
    acc = acc ? `${acc}/${seg}` : seg
    out.push(acc)
  }
  return out
}

export function FileTree(props: FileTreeProps): JSX.Element {
  const { root, rootLabel, selectedPath, onSelectFile, refreshKey } = props

  // Local UI state only — the actual entry caches live in the store.
  // `expanded` is intentionally per-mount: collapsing/expanding folders
  // is a UI concern and shouldn't persist across workspace switches.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]))

  // Auto-expand any ancestor folders of the active selection so the
  // tree highlights the open file even if the user hasn't manually
  // expanded the path down to it. Runs only on `selectedPath` change.
  useEffect(() => {
    if (!selectedPath) return
    const toOpen = ancestorPaths(selectedPath)
    if (toOpen.length === 0) return
    setExpanded((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const p of toOpen) {
        if (!next.has(p)) {
          next.add(p)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [selectedPath])

  // Forward Refresh / Re-run-scan signals into the shared store so
  // every consumer (tree + editor + side panel) drops its cached view
  // in lockstep. Skip on first mount (refreshKey defaults to 0/undef).
  const initialRefresh = useState(refreshKey ?? 0)[0]
  useEffect(() => {
    if (refreshKey == null) return
    if (refreshKey === initialRefresh) return
    invalidateWorkspace(root)
  }, [refreshKey, initialRefresh, root])

  const toggle = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      return next
    })
  }, [])

  return (
    <div className="flex flex-col h-full bg-card border-r border-border min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
        <span className="truncate" title={rootLabel}>
          {rootLabel}
        </span>
        <button
          type="button"
          aria-label="Refresh file tree"
          className="ml-2 inline-flex items-center justify-center rounded p-1 hover:bg-secondary/60"
          onClick={() => invalidateWorkspace(root)}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1 text-sm font-mono">
        <TreeChildren
          root={root}
          dirPath=""
          depth={0}
          expanded={expanded}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onToggleDir={toggle}
        />
      </div>
    </div>
  )
}

interface TreeChildrenProps {
  root: string
  dirPath: string
  depth: number
  expanded: Set<string>
  selectedPath: string | null
  onSelectFile: (relPath: string) => void
  onToggleDir: (dirPath: string) => void
}

function TreeChildren(props: TreeChildrenProps): JSX.Element | null {
  const { root, dirPath, depth } = props
  // Each rendered TreeChildren subscribes to its own directory key.
  // Listings, loading, and error state all come from the store, so a
  // remount transparently re-uses any data that's already there.
  const snap = useTree(root, dirPath)
  const entries = snap.data?.entries

  if (entries === undefined) {
    if (snap.loading) {
      return <div className="px-3 py-1 text-xs text-muted-foreground">Loading…</div>
    }
    if (snap.error) {
      return <div className="px-3 py-1 text-xs text-destructive">{snap.error}</div>
    }
    return null
  }
  if (entries.length === 0) {
    return (
      <div
        className="px-3 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: 12 + depth * 12 }}
      >
        (empty)
      </div>
    )
  }
  return (
    <ul className="flex flex-col">
      {entries.map((entry) => (
        <TreeNode key={entry.path} entry={entry} {...props} />
      ))}
    </ul>
  )
}

function TreeNode(
  props: TreeChildrenProps & { entry: TreeEntry },
): JSX.Element {
  const { root, entry, depth, expanded, selectedPath, onSelectFile, onToggleDir } = props
  const isDir = entry.type === "dir"
  const isExpanded = isDir && expanded.has(entry.path)
  const isSelected = !isDir && selectedPath === entry.path
  const indent = 8 + depth * 12

  return (
    <li className="flex flex-col">
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-secondary/50",
          isSelected && "bg-secondary text-foreground",
        )}
        style={{ paddingLeft: indent }}
        onClick={() => (isDir ? onToggleDir(entry.path) : onSelectFile(entry.path))}
        title={entry.path}
      >
        {isDir ? (
          isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {isDir ? (
          isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          )
        ) : (
          <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {isDir && isExpanded && (
        <TreeChildren
          root={root}
          dirPath={entry.path}
          depth={depth + 1}
          expanded={expanded}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onToggleDir={onToggleDir}
        />
      )}
    </li>
  )
}
