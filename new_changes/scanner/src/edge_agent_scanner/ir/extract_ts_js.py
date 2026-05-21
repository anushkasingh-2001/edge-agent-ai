from __future__ import annotations

import hashlib
import re

from edge_agent_scanner.ir.guards import classify_guard
from edge_agent_scanner.ir.models import AgentIR, AgentNode, CodeLocation, GuardNode, ModelNode, RouteNode, SinkNode, SourceNode, ToolNode
from edge_agent_scanner.ir.sinks import classify_side_effect, impact_for_effect
from edge_agent_scanner.ir.sources import classify_source
from edge_agent_scanner.walker import ScannedFile

try:
    from tree_sitter_language_pack import get_parser
except Exception:  # optional in dev environments
    get_parser = None


def _id(prefix: str, file: str, line: int, name: str) -> str:
    return f"{prefix}:{hashlib.sha1(f'{prefix}:{file}:{line}:{name}'.encode()).hexdigest()[:12]}"


def _loc(file: str, line: int, symbol: str | None = None) -> CodeLocation:
    return CodeLocation(file=file, start_line=line, end_line=line, symbol=symbol)


def _parse_with_tree_sitter(sf: ScannedFile):
    if get_parser is None:
        return None
    lang = "typescript" if sf.rel_path.endswith((".ts", ".tsx")) else "javascript"
    try:
        parser = get_parser(lang)
        return parser.parse("\n".join(sf.lines).encode("utf-8"))
    except Exception:
        return None


TOOL_PATTERNS = [
    re.compile(r"\btool\s*\("),
    re.compile(r"\bnew\s+(StructuredTool|DynamicTool|Tool)\b"),
    re.compile(r"\b(\w+Tool)\b"),
]

MODEL_PATTERNS = [
    re.compile(r"\bnew\s+(OpenAI|Anthropic|ChatOpenAI|ChatAnthropic|GoogleGenerativeAI|Ollama)\b"),
    re.compile(r"\b(model|modelName)\s*:\s*['\"]([^'\"]+)['\"]"),
    re.compile(r"\blitellm\.completion\s*\("),
]

ROUTE_PATTERNS = [
    re.compile(r"\b(app|router)\.(get|post|put|patch|delete)\s*\(\s*['\"]([^'\"]+)['\"]", re.I),
]

AGENT_PATTERNS = [
    re.compile(r"\b(createReactAgent|AgentExecutor|StateGraph|createAgent|RunnableSequence)\b"),
]


def extract_ts_js_ir(sf: ScannedFile, ir: AgentIR) -> None:
    # Tree-sitter is used to validate/parse robustly. The first extractor pass is
    # still pattern-driven because framework-specific semantics are custom.
    _parse_with_tree_sitter(sf)

    for line_no, line in enumerate(sf.lines, start=1):
        if any(rx.search(line) for rx in AGENT_PATTERNS):
            name = "agent"
            m = re.search(r"(const|let|var)\s+(\w+)", line)
            if m:
                name = m.group(2)
            ir.agents.append(
                AgentNode(
                    id=_id("agent", sf.rel_path, line_no, name),
                    name=name,
                    framework="JS/TS Agent",
                    location=_loc(sf.rel_path, line_no, name),
                )
            )

        if any(rx.search(line) for rx in TOOL_PATTERNS):
            m = re.search(r"(const|let|var|function|class)\s+(\w+)", line)
            name = m.group(2) if m else f"tool_line_{line_no}"
            ir.tools.append(
                ToolNode(
                    id=_id("tool", sf.rel_path, line_no, name),
                    name=name,
                    location=_loc(sf.rel_path, line_no, name),
                    framework="JS/TS",
                    side_effects=classify_side_effect(line),
                    metadata={"code": line.strip()},
                )
            )

        for rx in ROUTE_PATTERNS:
            m = rx.search(line)
            if m:
                ir.routes.append(
                    RouteNode(
                        id=_id("route", sf.rel_path, line_no, f"{m.group(2)}:{m.group(3)}"),
                        method=m.group(2).upper(),
                        path=m.group(3),
                        location=_loc(sf.rel_path, line_no, m.group(3)),
                    )
                )

        for rx in MODEL_PATTERNS:
            m = rx.search(line)
            if m:
                model = m.group(2) if m.lastindex and m.lastindex >= 2 and m.group(2) else m.group(1)
                ir.models.append(
                    ModelNode(
                        id=_id("model", sf.rel_path, line_no, model),
                        provider=None,
                        model_name=model,
                        purpose="unknown",
                        location=_loc(sf.rel_path, line_no, model),
                    )
                )

        src_kind = classify_source(line)
        if src_kind:
            ir.sources.append(
                SourceNode(
                    id=_id("source", sf.rel_path, line_no, line[:40]),
                    kind=src_kind,
                    label=line.strip()[:120],
                    location=_loc(sf.rel_path, line_no),
                )
            )

        for effect in classify_side_effect(line):
            ir.sinks.append(
                SinkNode(
                    id=_id("sink", sf.rel_path, line_no, effect),
                    kind=effect,
                    label=line.strip()[:120],
                    location=_loc(sf.rel_path, line_no),
                    impact=impact_for_effect(effect),  # type: ignore[arg-type]
                )
            )

        for kind in classify_guard(line):
            ir.guards.append(
                GuardNode(
                    id=_id("guard", sf.rel_path, line_no, f"{kind}:{line[:30]}"),
                    kind=kind,
                    label=line.strip()[:120],
                    location=_loc(sf.rel_path, line_no),
                )
            )
