"""Detect agent "tools" in a repo for the UI inventory.

A "tool" here is whatever a developer would point at and say "this is one of
my agent's callable abilities". We try three orthogonal signals so we can
recognise the common patterns in real codebases:

1. Decorator-based (most reliable): ``@tool``, ``@function_tool``,
   ``@<x>.tool(...)``, ``@server.tool()``, etc. — used by LangChain,
   LangGraph, Pydantic AI, MCP, Agno.
2. Class-based: ``class Foo(BaseTool)`` / ``class Foo(StructuredTool)`` /
   ``class FooTool:`` — common in projects that don't use decorators (e.g.
   the Sales-dev-assistant repo where each tool is a plain ``class XxxTool``).
3. Convention-based: files inside a ``tools/`` directory, or whose name ends
   in ``_tool.py`` / ``_tool.ts`` etc. Catches projects that don't use any
   framework's decorator/base-class but still organise tools by folder.

Output is a flat list of ``ToolHit`` objects. The UI groups by ``framework``
(falling back to a "Project tools" bucket when we can't pin down a framework
from the file's imports).

Heuristic, not exhaustive — intentionally bounded with per-file and
per-project caps so a 4k-file repo can't blow up the JSON payload.
"""

from __future__ import annotations

import re
from typing import Literal

from edge_agent_scanner.report import ToolHit
from edge_agent_scanner.walker import ScannedFile

# Per-file and per-project safety caps. The UI shows hundreds without issue;
# beyond that you've got something more like a code search tool.
_MAX_HITS_PER_FILE = 64
_MAX_TOTAL_HITS = 2000

# A Python decorator that looks like a tool registration. Covers:
#   @tool                          (langchain.tools.tool, agno.tools.tool)
#   @tool(...)
#   @function_tool                 (openai-agents-style)
#   @function_tool(...)
#   @<x>.tool / @<x>.tool(...)     (mcp: @server.tool, @app.tool, @mcp.tool)
_PY_TOOL_DECORATOR = re.compile(
    r"^\s*@\s*(?:tool|function_tool|\w+\.tool)\s*(?:\(|$|\s)"
)
_PY_DEF = re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(")
_PY_CLASS = re.compile(r"^\s*class\s+([A-Za-z_]\w*)\s*[\(:]")

# A Python class whose base list contains a recognised tool base class.
_PY_BASE_TOOL_CLASS = re.compile(
    r"^\s*class\s+([A-Za-z_]\w*)\s*\(\s*[^)]*\b(?:BaseTool|StructuredTool|FunctionTool|Tool)\b"
)
# A Python class whose name ends in "Tool" (e.g. AddContactsToCadenceTool).
# We require the suffix capitalization plus a non-trivial prefix to avoid
# matching `class Tool:` itself.
_PY_TOOL_SUFFIX_CLASS = re.compile(r"^\s*class\s+([A-Za-z_]\w*Tool)\s*[\(:]")

# TS/JS heuristics, lighter touch.
_TS_TOOL_DECORATOR = re.compile(r"^\s*@\s*(?:tool|Tool|FunctionTool|McpTool)\s*\(")
_TS_TOOL_CALL = re.compile(
    r"\b(?:export\s+const|const|let|export\s+let)\s+(\w+)\s*=\s*tool\s*\("
)
_TS_BASE_TOOL_CLASS = re.compile(
    r"\bclass\s+(\w+)\s+extends\s+(?:BaseTool|StructuredTool|Tool)\b"
)
_TS_NAMED_TOOL_CLASS = re.compile(r"\bclass\s+(\w+Tool)\b(?:\s+extends|\s*\{)")

# Filename / path conventions.
_TOOL_FILENAME_SUFFIXES = (
    "_tool.py",
    "_tools.py",
    "_tool.ts",
    "_tool.tsx",
    "_tool.js",
    "_tool.jsx",
)

# Files inside any directory called "tools" (case-sensitive: the convention).
_TOOL_DIR_NAME = "tools"

# Framework attribution from imports in the same file. Order matters: we
# return the first match.
_FRAMEWORK_HINTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\blanggraph\b", re.I), "LangGraph"),
    (re.compile(r"\blangchain\b", re.I), "LangChain"),
    (re.compile(r"\bllama_index\b|\bllama-index\b", re.I), "LlamaIndex"),
    (re.compile(r"\bpydantic_ai\b", re.I), "Pydantic AI"),
    (re.compile(r"^\s*(?:from|import)\s+agno\b", re.I | re.M), "Agno"),
    (re.compile(r"\bmodelcontextprotocol\b|\bmcp\.server\b|\bmcp\.tool\b", re.I), "MCP"),
]

ToolKind = Literal["decorator", "class", "filename", "directory"]


def _attribute_framework(lines: list[str]) -> str | None:
    """Look at the first ~80 lines for an import that maps to a framework."""
    head = "\n".join(lines[:80])
    for rx, name in _FRAMEWORK_HINTS:
        if rx.search(head):
            return name
    return None


def _stem_name(rel_path: str) -> str:
    """Derive a tool-ish name from a file path. Strips extension and a
    trailing ``_tool``/``_tools`` suffix; falls back to the full base name."""
    base = rel_path.rsplit("/", 1)[-1]
    for ext in (".tsx", ".jsx"):
        if base.endswith(ext):
            base = base[: -len(ext)]
            break
    else:
        if "." in base:
            base = base.rsplit(".", 1)[0]
    if base.endswith("_tools"):
        base = base[: -len("_tools")]
    elif base.endswith("_tool"):
        base = base[: -len("_tool")]
    return base or rel_path


def _lookahead_name(lines: list[str], start_idx: int) -> str | None:
    """Find the function/class name on or just after a decorator line."""
    end = min(start_idx + 6, len(lines))
    for j in range(start_idx, end):
        m = _PY_DEF.match(lines[j])
        if m:
            return m.group(1)
        m = _PY_CLASS.match(lines[j])
        if m:
            return m.group(1)
    return None


def detect_tools(files: list[ScannedFile]) -> list[ToolHit]:
    """Return a deduped, capped list of tools detected across the project."""
    hits: list[ToolHit] = []
    # Dedupe key: (file, name, line) so we don't double-count when two
    # signals (e.g. classname suffix + tools/ directory) fire on the same row.
    seen: set[tuple[str, str, int]] = set()

    def _add(hit: ToolHit) -> bool:
        key = (hit.file, hit.name, hit.line)
        if key in seen:
            return False
        seen.add(key)
        hits.append(hit)
        return True

    for sf in files:
        if len(hits) >= _MAX_TOTAL_HITS:
            break
        rel = sf.rel_path
        framework = _attribute_framework(sf.lines)
        per_file = 0

        path_parts = rel.split("/")
        # In a tools/ directory anywhere except as the leaf filename itself.
        in_tools_dir = _TOOL_DIR_NAME in path_parts[:-1]
        suffix_match = any(rel.endswith(s) for s in _TOOL_FILENAME_SUFFIXES)
        is_python = rel.endswith(".py")
        is_ts_js = rel.endswith((".ts", ".tsx", ".js", ".jsx"))
        # TS/JS class-suffix matches (`class XxxTool`) are noisy in app code
        # (UI components, modals, etc.). Only trust them when the file lives
        # in a `tools/` directory or the file imports a recognised framework
        # — i.e. when there's some independent evidence the symbol is a tool.
        ts_class_suffix_trusted = is_ts_js and (in_tools_dir or framework is not None)

        # Pass 1 — decorator + class signals (rich detail per row).
        if is_python:
            for i, line in enumerate(sf.lines, start=1):
                if per_file >= _MAX_HITS_PER_FILE:
                    break

                if _PY_TOOL_DECORATOR.match(line):
                    name = _lookahead_name(sf.lines, i)  # i is 1-based; lines is 0-based but i indexes correctly
                    if name and _add(
                        ToolHit(name=name, file=rel, line=i, kind="decorator", framework=framework)
                    ):
                        per_file += 1
                    continue

                m = _PY_BASE_TOOL_CLASS.match(line)
                if m and _add(
                    ToolHit(name=m.group(1), file=rel, line=i, kind="class", framework=framework)
                ):
                    per_file += 1
                    continue

                m = _PY_TOOL_SUFFIX_CLASS.match(line)
                if m:
                    candidate = m.group(1)
                    # Skip the bare "Tool" base class.
                    if candidate != "Tool" and _add(
                        ToolHit(name=candidate, file=rel, line=i, kind="class", framework=framework)
                    ):
                        per_file += 1
                    continue

        elif is_ts_js:
            for i, line in enumerate(sf.lines, start=1):
                if per_file >= _MAX_HITS_PER_FILE:
                    break
                if _TS_TOOL_DECORATOR.match(line):
                    # Find a class declaration that follows.
                    end = min(i + 6, len(sf.lines))
                    for j in range(i, end):
                        cls = _TS_BASE_TOOL_CLASS.search(sf.lines[j]) or _TS_NAMED_TOOL_CLASS.search(sf.lines[j])
                        if cls:
                            if _add(
                                ToolHit(
                                    name=cls.group(1),
                                    file=rel,
                                    line=i,
                                    kind="decorator",
                                    framework=framework,
                                )
                            ):
                                per_file += 1
                            break
                    continue

                tcall = _TS_TOOL_CALL.search(line)
                if tcall and _add(
                    ToolHit(name=tcall.group(1), file=rel, line=i, kind="decorator", framework=framework)
                ):
                    per_file += 1
                    continue

                # A known base-class extends is always trusted.
                cls = _TS_BASE_TOOL_CLASS.search(line)
                if cls:
                    candidate = cls.group(1)
                    if candidate not in {"Tool", "BaseTool", "StructuredTool"} and _add(
                        ToolHit(name=candidate, file=rel, line=i, kind="class", framework=framework)
                    ):
                        per_file += 1
                    continue
                # Plain `class XxxTool` only counts when we have independent
                # evidence (tools/ dir or framework import) — otherwise UI
                # components like `class CadenceTool` in a tsx file create
                # noise.
                if ts_class_suffix_trusted:
                    cls = _TS_NAMED_TOOL_CLASS.search(line)
                    if cls:
                        candidate = cls.group(1)
                        if candidate not in {"Tool", "BaseTool", "StructuredTool"} and _add(
                            ToolHit(name=candidate, file=rel, line=i, kind="class", framework=framework)
                        ):
                            per_file += 1
                        continue

        # Pass 2 — convention fallback. Only if we didn't pick up any specific
        # symbol from this file and the file looks like a tool by name/dir.
        if per_file == 0 and (suffix_match or in_tools_dir):
            kind: ToolKind = "filename" if suffix_match else "directory"
            name = _stem_name(rel)
            _add(ToolHit(name=name, file=rel, line=1, kind=kind, framework=framework))

    # Stable sort: framework (None last), then file, then line.
    hits.sort(key=lambda t: (t.framework or "~", t.file, t.line, t.name))
    return hits
