from __future__ import annotations

import ast
import hashlib
from typing import Iterable

import libcst as cst
from libcst.metadata import MetadataWrapper, PositionProvider

from edge_agent_scanner.ir.guards import classify_guard
from edge_agent_scanner.ir.models import (
    AgentIR,
    AgentNode,
    CodeLocation,
    GuardNode,
    ModelNode,
    PromptNode,
    RouteNode,
    SinkNode,
    SourceNode,
    ToolNode,
)
from edge_agent_scanner.ir.sinks import classify_side_effect, impact_for_effect
from edge_agent_scanner.ir.sources import classify_source
from edge_agent_scanner.walker import ScannedFile


def _id(prefix: str, file: str, line: int, name: str) -> str:
    raw = f"{prefix}:{file}:{line}:{name}"
    return f"{prefix}:{hashlib.sha1(raw.encode()).hexdigest()[:12]}"


def _safe_literal_string(node: cst.CSTNode) -> str | None:
    if isinstance(node, cst.SimpleString):
        try:
            v = ast.literal_eval(node.value)
            return v if isinstance(v, str) else None
        except Exception:
            return node.value.strip("'\"")
    if isinstance(node, cst.ConcatenatedString):
        left = _safe_literal_string(node.left)
        right = _safe_literal_string(node.right)
        if left is not None and right is not None:
            return left + right
    return None


def _name_of_expr(node: cst.CSTNode | None) -> str:
    if node is None:
        return ""
    if isinstance(node, cst.Name):
        return node.value
    if isinstance(node, cst.Attribute):
        base = _name_of_expr(node.value)
        attr = node.attr.value
        return f"{base}.{attr}" if base else attr
    if isinstance(node, cst.Call):
        return _name_of_expr(node.func)
    return ""


def _decorator_names(decorators: Iterable[cst.Decorator]) -> list[str]:
    return [_name_of_expr(d.decorator) for d in decorators]


def _loc(file: str, pos, symbol: str | None = None) -> CodeLocation:
    return CodeLocation(
        file=file,
        start_line=pos.start.line,
        end_line=pos.end.line,
        symbol=symbol,
    )


class PythonIRVisitor(cst.CSTVisitor):
    METADATA_DEPENDENCIES = (PositionProvider,)

    def __init__(self, sf: ScannedFile, ir: AgentIR) -> None:
        self.sf = sf
        self.ir = ir
        self.current_function: str | None = None
        self.current_class: str | None = None
        self.last_agent_id: str | None = None

    def visit_ClassDef(self, node: cst.ClassDef) -> None:
        self.current_class = node.name.value
        pos = self.get_metadata(PositionProvider, node)
        name = node.name.value
        base_names = " ".join(_name_of_expr(b.value) for b in node.bases)

        looks_agent = (
            "agent" in name.lower()
            or any(x in base_names.lower() for x in ["agent", "agentexecutor", "runnable", "stategraph"])
        )
        looks_tool = name.endswith("Tool") or any(x in base_names for x in ["BaseTool", "StructuredTool", "Tool"])

        if looks_agent:
            framework = None
            text = f"{name} {base_names}".lower()
            if "langgraph" in text or "stategraph" in text:
                framework = "LangGraph"
            elif "langchain" in text or "agentexecutor" in text:
                framework = "LangChain"
            agent = AgentNode(
                id=_id("agent", self.sf.rel_path, pos.start.line, name),
                name=name,
                framework=framework,
                location=_loc(self.sf.rel_path, pos, name),
            )
            self.ir.agents.append(agent)
            self.last_agent_id = agent.id

        if looks_tool and name != "Tool":
            tool = ToolNode(
                id=_id("tool", self.sf.rel_path, pos.start.line, name),
                name=name,
                location=_loc(self.sf.rel_path, pos, name),
                framework=None,
                callable_from_agent=False,
                side_effects=classify_side_effect(name),
                metadata={"kind": "class"},
            )
            self.ir.tools.append(tool)

    def leave_ClassDef(self, original_node: cst.ClassDef) -> None:
        self.current_class = None

    def visit_FunctionDef(self, node: cst.FunctionDef) -> None:
        self.current_function = node.name.value
        pos = self.get_metadata(PositionProvider, node)
        name = node.name.value
        decos = _decorator_names(node.decorators)
        deco_text = " ".join(decos)

        is_tool = any(
            d.endswith(".tool") or d in {"tool", "function_tool", "mcp.tool", "server.tool", "app.tool"}
            for d in decos
        ) or name.endswith("_tool")

        if is_tool:
            framework = "MCP" if "mcp" in deco_text.lower() or "server.tool" in deco_text else None
            tool = ToolNode(
                id=_id("tool", self.sf.rel_path, pos.start.line, name),
                name=name,
                location=_loc(self.sf.rel_path, pos, name),
                framework=framework,
                callable_from_agent=False,
                side_effects=classify_side_effect(name),
                metadata={"kind": "decorator", "decorators": decos},
            )
            self.ir.tools.append(tool)

        route_method = None
        route_path = None
        for d in decos:
            dl = d.lower()
            for method in ["get", "post", "put", "patch", "delete"]:
                if dl.endswith(f".{method}") or dl == method:
                    route_method = method.upper()
                    route_path = "<unknown>"
        if route_method:
            route = RouteNode(
                id=_id("route", self.sf.rel_path, pos.start.line, name),
                method=route_method,
                path=route_path or "<unknown>",
                location=_loc(self.sf.rel_path, pos, name),
            )
            self.ir.routes.append(route)

        guard_kinds = classify_guard(" ".join([name, deco_text]))
        for kind in guard_kinds:
            guard = GuardNode(
                id=_id("guard", self.sf.rel_path, pos.start.line, f"{kind}:{name}"),
                kind=kind,
                label=name,
                location=_loc(self.sf.rel_path, pos, name),
            )
            self.ir.guards.append(guard)

    def leave_FunctionDef(self, original_node: cst.FunctionDef) -> None:
        self.current_function = None

    def visit_Assign(self, node: cst.Assign) -> None:
        pos = self.get_metadata(PositionProvider, node)
        names = []
        for t in node.targets:
            n = _name_of_expr(t.target)
            if n:
                names.append(n)
        name_text = " ".join(names)
        value_text = _safe_literal_string(node.value)

        if value_text and any(k in name_text.lower() for k in ["prompt", "system", "developer", "instruction"]):
            prompt = PromptNode(
                id=_id("prompt", self.sf.rel_path, pos.start.line, name_text or "prompt"),
                name=name_text or "prompt",
                text_preview=value_text[:300],
                location=_loc(self.sf.rel_path, pos, name_text or "prompt"),
            )
            self.ir.prompts.append(prompt)

        src_kind = classify_source(name_text)
        if src_kind:
            src = SourceNode(
                id=_id("source", self.sf.rel_path, pos.start.line, name_text),
                kind=src_kind,
                label=name_text,
                location=_loc(self.sf.rel_path, pos, name_text),
            )
            self.ir.sources.append(src)

    def visit_Call(self, node: cst.Call) -> None:
        pos = self.get_metadata(PositionProvider, node)
        callee = _name_of_expr(node.func)
        callee_l = callee.lower()

        # Model calls
        if any(x in callee_l for x in ["chatopenai", "openai", "anthropic", "chatanthropic", "gemini", "ollama", "litellm.completion"]):
            provider = None
            if "anthropic" in callee_l:
                provider = "anthropic"
            elif "openai" in callee_l:
                provider = "openai"
            elif "gemini" in callee_l:
                provider = "google"
            elif "ollama" in callee_l:
                provider = "ollama"

            model_name = None
            for arg in node.args:
                if arg.keyword and arg.keyword.value in {"model", "model_name", "deployment_name"}:
                    model_name = _safe_literal_string(arg.value)

            model = ModelNode(
                id=_id("model", self.sf.rel_path, pos.start.line, model_name or callee),
                provider=provider,
                model_name=model_name or callee,
                purpose="unknown",
                location=_loc(self.sf.rel_path, pos, callee),
            )
            self.ir.models.append(model)

        # Sources
        src_kind = classify_source(callee)
        if src_kind:
            src = SourceNode(
                id=_id("source", self.sf.rel_path, pos.start.line, callee),
                kind=src_kind,
                label=callee,
                location=_loc(self.sf.rel_path, pos, callee),
            )
            self.ir.sources.append(src)

        # Sinks
        effects = classify_side_effect(callee)
        for effect in effects:
            sink = SinkNode(
                id=_id("sink", self.sf.rel_path, pos.start.line, f"{effect}:{callee}"),
                kind=effect,
                label=callee,
                location=_loc(self.sf.rel_path, pos, callee),
                impact=impact_for_effect(effect),  # type: ignore[arg-type]
            )
            self.ir.sinks.append(sink)

        # Guards
        for kind in classify_guard(callee):
            guard = GuardNode(
                id=_id("guard", self.sf.rel_path, pos.start.line, f"{kind}:{callee}"),
                kind=kind,
                label=callee,
                location=_loc(self.sf.rel_path, pos, callee),
            )
            self.ir.guards.append(guard)


def extract_python_ir(sf: ScannedFile, ir: AgentIR) -> None:
    source = "\n".join(sf.lines)
    try:
        module = cst.parse_module(source)
        wrapper = MetadataWrapper(module)
        wrapper.visit(PythonIRVisitor(sf, ir))
    except Exception:
        # Do not fail the whole scan on one broken Python file. Future fallback:
        # parso or Tree-sitter Python grammar.
        return
