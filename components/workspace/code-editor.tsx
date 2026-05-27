"use client"

/**
 * CodeMirror 6 backed code editor for the workspace view.
 *
 * Replaces the earlier Monaco wrapper because Monaco's first-load
 * bundle (~5MB compiled by Turbopack on first hit) blocked the main
 * thread long enough that Chrome surfaced a "Page Unresponsive"
 * dialog. CodeMirror 6 is ~10× lighter, ships as small per-language
 * extensions, and mounts in tens of milliseconds — the editor is
 * effectively instant in dev mode.
 *
 * Features kept identical from the Monaco version:
 *   * scroll-to-line + line decoration when a finding is pinned
 *   * dirty-state tracking against the original content
 *   * Cmd/Ctrl+S save shortcut wired to the parent's onSave
 *   * read-only mode (binary / too-large / remote)
 *   * language hint → syntax highlighting (TS, JS, Python, JSON,
 *     Markdown, CSS, HTML, YAML; everything else is plaintext)
 */

import type { JSX } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import type {
  ReactCodeMirrorRef,
  Extension,
  ViewUpdate,
} from "@uiw/react-codemirror"
import { EditorView, Decoration, DecorationSet, keymap } from "@codemirror/view"
import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { yaml } from "@codemirror/lang-yaml"
import { oneDark } from "@codemirror/theme-one-dark"

import { cn } from "@/lib/utils"

// CodeMirror itself is small but the React wrapper still pulls in
// `@codemirror/view`, which we don't want during SSR. `next/dynamic`
// with `ssr: false` keeps it client-only and lets us render a tiny
// placeholder during hydration.
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      Loading editor…
    </div>
  ),
})

export interface CodeEditorProps {
  /** Relative path shown in the tab header. Empty = no file open. */
  filePath: string | null
  /** Authoritative source from the API. The editor re-baselines its
   *  dirty state every time this changes (e.g. after a successful
   *  save or a file switch). */
  value: string
  /** Optional language hint from the API. Falls back to plaintext. */
  language?: string | null
  /** Highlight + reveal this line (1-based) on mount and whenever it
   *  changes. Used to point at the finding. */
  highlightLine?: number | null
  /** Optional inclusive end-line for range highlight. */
  highlightEndLine?: number | null
  /** Read-only mode (no edits, no save). */
  readOnly?: boolean
  /** Notifies the parent of in-editor edits so it can mark dirty,
   *  trigger autosave, etc. */
  onChange?: (next: string) => void
  /** Persists the current buffer. Awaited so the editor can hide the
   *  dirty indicator only after the write succeeds. */
  onSave?: (content: string) => Promise<void> | void
  /** Optional banner above the editor (e.g. "Binary file"). */
  placeholder?: string | null
}

// ---------------------------------------------------------------------------
// Line-highlight extension
// ---------------------------------------------------------------------------

/** Effect we dispatch when the active finding line changes — the
 *  state field below converts it into a Decoration set. */
const setHighlightedLines = StateEffect.define<{ start: number; end: number } | null>()

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setHighlightedLines)) continue
      if (effect.value == null) {
        next = Decoration.none
        continue
      }
      const { start, end } = effect.value
      const builder = new RangeSetBuilder<Decoration>()
      const docLines = tr.state.doc.lines
      const safeStart = Math.max(1, Math.min(docLines, start))
      const safeEnd = Math.max(safeStart, Math.min(docLines, end))
      for (let line = safeStart; line <= safeEnd; line++) {
        const lineObj = tr.state.doc.line(line)
        builder.add(lineObj.from, lineObj.from, Decoration.line({ class: "cm-edge-agent-finding-line" }))
      }
      next = builder.finish()
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

function languageExtension(lang: string | null | undefined): Extension[] {
  switch (lang) {
    case "typescript":
      return [javascript({ typescript: true, jsx: true })]
    case "javascript":
      return [javascript({ jsx: true })]
    case "python":
      return [python()]
    case "json":
      return [json()]
    case "markdown":
      return [markdown()]
    case "css":
    case "scss":
      return [css()]
    case "html":
    case "xml":
      return [html()]
    case "yaml":
      return [yaml()]
    default:
      return []
  }
}

export function CodeEditor(props: CodeEditorProps): JSX.Element {
  const {
    filePath,
    value,
    language,
    highlightLine,
    highlightEndLine,
    readOnly = false,
    onChange,
    onSave,
    placeholder,
  } = props

  const editorRef = useRef<ReactCodeMirrorRef | null>(null)
  // Track the most recent baseline so dirty state survives parent
  // re-renders that simply pass the same `value` again.
  const [baseline, setBaseline] = useState<string>(value)
  const [draft, setDraft] = useState<string>(value)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // New file (or save returned fresh content) → re-baseline so the
    // dirty indicator flips back off.
    setBaseline(value)
    setDraft(value)
  }, [value, filePath])

  const dirty = !readOnly && draft !== baseline

  // Stable ref for handleSave so the keymap closure isn't rebuilt on
  // every render (would invalidate the extension and remount the
  // editor's keymap).
  const saveRef = useRef<() => Promise<void>>(async () => {})
  saveRef.current = async () => {
    if (!onSave || readOnly || saving) return
    setSaving(true)
    try {
      await onSave(draft)
      setBaseline(draft)
    } finally {
      setSaving(false)
    }
  }

  const extensions = useMemo<Extension[]>(() => {
    const base: Extension[] = [
      highlightField,
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void saveRef.current()
            return true
          },
        },
      ]),
      EditorView.lineWrapping,
    ]
    return [...base, ...languageExtension(language ?? null)]
  }, [language])

  // Single source of truth for "highlight + reveal line N". Lives in
  // a ref so both the `onCreateEditor` callback (fired exactly once
  // when CodeMirror finishes mounting) and the `useEffect` below
  // (fires on every later change) can call it with the latest target
  // line without re-creating the closure.
  const applyHighlightRef = useRef<(view: EditorView) => void>(() => {})
  applyHighlightRef.current = (view: EditorView) => {
    const start = highlightLine && highlightLine > 0 ? highlightLine : null
    if (!start) {
      view.dispatch({ effects: setHighlightedLines.of(null) })
      return
    }
    const end = highlightEndLine && highlightEndLine >= start ? highlightEndLine : start
    view.dispatch({ effects: setHighlightedLines.of({ start, end }) })
    try {
      const docLines = view.state.doc.lines
      const safeStart = Math.max(1, Math.min(docLines, start))
      const lineObj = view.state.doc.line(safeStart)
      view.dispatch({
        effects: EditorView.scrollIntoView(lineObj.from, { y: "center" }),
      })
    } catch {
      // Out-of-range line → ignore; the decoration field has its own
      // bounds check above.
    }
  }

  // Subsequent changes (different finding, file reload, etc.) — only
  // fires if `editorRef.current?.view` already exists. The first-mount
  // path is owned by `onCreateEditor` below because the React ref
  // isn't attached yet when this effect first runs.
  useEffect(() => {
    const view = editorRef.current?.view
    if (!view) return
    applyHighlightRef.current(view)
  }, [highlightLine, highlightEndLine, value, filePath])

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex items-center justify-between border-b border-border bg-card px-3 py-1.5 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground" title={filePath ?? ""}>
            {filePath ?? "no file open"}
          </span>
          {dirty && (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
              aria-label="unsaved changes"
              title="Unsaved changes"
            />
          )}
          {readOnly && filePath && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
              Read-only
            </span>
          )}
        </div>
        {onSave && !readOnly && (
          <button
            type="button"
            className={cn(
              "rounded border border-border px-2 py-0.5 text-xs",
              dirty
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "bg-card text-muted-foreground cursor-not-allowed",
            )}
            disabled={!dirty || saving}
            onClick={() => void saveRef.current()}
            title="Save (Cmd/Ctrl+S)"
          >
            {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
        )}
      </div>
      {placeholder && (
        <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          {placeholder}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden">
        {filePath ? (
          <CodeMirror
            ref={editorRef}
            value={draft}
            theme={oneDark}
            extensions={extensions}
            readOnly={readOnly}
            height="100%"
            style={{ height: "100%" }}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              foldGutter: true,
              autocompletion: false,
            }}
            onCreateEditor={(view) => {
              // First successful mount: ref.current was null when
              // our highlight effect first ran, so this is the only
              // chance to reveal the finding line on initial open.
              // Defer one paint so CodeMirror has measured layout
              // before we ask it to scrollIntoView.
              requestAnimationFrame(() => applyHighlightRef.current(view))
            }}
            onChange={(next: string, _v: ViewUpdate) => {
              setDraft(next)
              onChange?.(next)
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            Select a file from the tree to view or edit.
          </div>
        )}
      </div>
      <style jsx global>{`
        .cm-editor {
          height: 100%;
          font-size: 13px;
        }
        /* Highlighted finding line (yellow background tint + left bar). */
        .cm-edge-agent-finding-line {
          background: rgba(250, 204, 21, 0.22) !important;
          box-shadow: inset 3px 0 0 rgba(250, 204, 21, 0.9);
        }
        /* Force an always-visible scrollbar on the editor's scroller
         * so users can scroll up to see code from the start of the
         * file even when we auto-revealed a finding far down. macOS
         * hides "overlay" scrollbars by default and that made the
         * editor feel un-scrollable. */
        .cm-editor .cm-scroller {
          overflow-y: scroll !important;
        }
        .cm-editor .cm-scroller::-webkit-scrollbar {
          width: 12px;
          height: 12px;
        }
        .cm-editor .cm-scroller::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.03);
        }
        .cm-editor .cm-scroller::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.18);
          border-radius: 6px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        .cm-editor .cm-scroller::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.32);
          background-clip: padding-box;
          border: 2px solid transparent;
        }
        /* Firefox */
        .cm-editor .cm-scroller {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
        }
      `}</style>
    </div>
  )
}
