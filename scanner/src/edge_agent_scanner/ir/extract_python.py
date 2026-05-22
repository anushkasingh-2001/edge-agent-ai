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
from edge_agent_scanner.ir.redact import redact_secrets
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


#: HTTP verbs recognised on FastAPI / Flask-style decorators.
_HTTP_METHOD_DECORATORS = ("get", "post", "put", "patch", "delete", "head", "options")


def _route_method_from_callee(callee: str) -> str | None:
    """Return the HTTP method (``"POST"``) when ``callee`` (the dotted
    name of a decorator expression's function) looks like a route
    binder — e.g. ``app.post``, ``router.delete``, bare ``post``.

    Returns ``None`` for anything that isn't a route registration so
    the caller can keep iterating decorators.
    """
    low = callee.lower()
    for method in _HTTP_METHOD_DECORATORS:
        if low.endswith(f".{method}") or low == method:
            return method.upper()
    return None


def _decorator_route_path(deco: cst.Decorator) -> str | None:
    """Pull the literal first argument of a route decorator —
    ``@app.post("/chat")`` → ``"/chat"``. Returns ``None`` if the
    decorator has no arguments or the first arg isn't a string
    literal (e.g. dynamically built path).
    """
    expr = deco.decorator
    if not isinstance(expr, cst.Call):
        return None
    if not expr.args:
        return None
    return _safe_literal_string(expr.args[0].value)


def _detect_route_auth_guards(node: cst.FunctionDef) -> list[str]:
    """Return a list of auth-guard names visible on the function
    signature (``user: User = Depends(get_current_user)``,
    ``creds: HTTPAuthorizationCredentials = Depends(security)``).

    The auth-checks analyzer treats a non-empty result as "this route
    has an authentication path the IR can see" and skips the
    missing-auth finding. We intentionally only recognise call
    patterns whose callee name strongly suggests auth — that keeps
    the heuristic deterministic and avoids whitelisting routes that
    just happen to have a ``Depends(get_db)`` plumbing dependency.
    """
    guards: list[str] = []
    auth_keywords = (
        "current_user", "current-user", "authenticated_user", "auth_user",
        "verify_token", "get_user", "require_auth", "require_login",
        "authenticate", "authorize", "permission", "security", "bearer",
        "api_key", "apikey", "access_token", "jwt",
    )
    for param in node.params.params:
        default = param.default
        if default is None:
            continue
        if isinstance(default, cst.Call):
            callee = _name_of_expr(default.func).lower()
            if callee in {"depends", "security", "header", "cookie", "oauth2_password_bearer"} or "depends" in callee:
                # Inspect Depends(...) inner callable name.
                inner = default.args[0].value if default.args else None
                if inner is not None:
                    inner_name = _name_of_expr(inner).lower()
                    if any(k in inner_name for k in auth_keywords):
                        guards.append(inner_name or callee)
                        continue
            if any(k in callee for k in auth_keywords):
                guards.append(callee)
    return guards


def _capture_route_code(module: cst.Module, node: cst.FunctionDef) -> str:
    """Return ``decorator(s) + function signature`` as a single string
    so the auth analyzer has something meaningful to render under
    "Code involved". Falls back to ``node.name`` if the round-trip
    fails (e.g. detached subtree).
    """
    parts: list[str] = []
    try:
        for d in node.decorators:
            text = module.code_for_node(d).strip()
            if text:
                parts.append(text)
    except Exception:
        pass
    # Build a parameter-only header (drop the body) so the snippet
    # stays short and free of secret-bearing function internals.
    try:
        header_node = node.with_changes(
            body=cst.IndentedBlock(body=[cst.SimpleStatementLine(body=[cst.Pass()])]),
            decorators=(),
        )
        sig = module.code_for_node(header_node).strip()
        # ``code_for_node`` of a function def includes the trailing
        # ``pass``; drop the body lines so we only keep the signature.
        sig = sig.splitlines()[0] if sig else ""
        if sig:
            parts.append(sig.rstrip(":") + ":")
    except Exception:
        parts.append(f"def {node.name.value}(...):")
    return "\n".join(parts)


def _loc(file: str, pos, symbol: str | None = None) -> CodeLocation:
    return CodeLocation(
        file=file,
        start_line=pos.start.line,
        end_line=pos.end.line,
        symbol=symbol,
    )


#: Hard cap on the verbatim call expression we store on a ``SinkNode``.
#: Anything longer is truncated with a marker so the UI / AI prompt
#: still get the leading arguments without an unbounded payload. Chosen
#: to fit comfortably inside ``Finding.code``'s 500-char budget after
#: redaction overhead.
_CALL_EXPRESSION_MAX = 400


def _slice_source(lines: list[str], start_line: int, start_col: int, end_line: int, end_col: int) -> str:
    """Return the verbatim source slice ``[start_line:start_col,
    end_line:end_col]`` from a ``ScannedFile.lines`` list.

    Used as a defensive fallback when LibCST's
    ``Module.code_for_node`` is unavailable (e.g. older LibCST or a
    detached node). The result matches what the user typed including
    whitespace inside the call. Out-of-range positions degrade to a
    safe empty string rather than raising.
    """
    if start_line < 1 or end_line < 1 or start_line > len(lines) or end_line > len(lines):
        return ""
    if start_line == end_line:
        return lines[start_line - 1][start_col:end_col]
    parts: list[str] = [lines[start_line - 1][start_col:]]
    for i in range(start_line, end_line - 1):
        parts.append(lines[i])
    parts.append(lines[end_line - 1][:end_col])
    return "\n".join(parts)


def _capture_call_text(module: cst.Module, node: cst.Call, pos, sf: ScannedFile) -> tuple[str | None, str | None]:
    """Return ``(call_expression, source_line)`` for a ``cst.Call``.

    Preferred path uses LibCST's
    :py:meth:`libcst.Module.code_for_node` which round-trips the
    original tokens including whitespace. We fall back to slicing
    ``ScannedFile.lines`` using ``PositionProvider`` if that fails. As
    a last resort the source line at ``pos.start.line`` is returned.

    Secrets are redacted by the caller — the raw value never leaks
    further than this function.
    """
    raw: str | None = None
    try:
        raw = module.code_for_node(node)
    except Exception:
        try:
            raw = _slice_source(
                sf.lines,
                pos.start.line,
                pos.start.column,
                pos.end.line,
                pos.end.column,
            )
        except Exception:
            raw = None
    if raw is not None:
        raw = raw.strip()
        if not raw:
            raw = None
        elif len(raw) > _CALL_EXPRESSION_MAX:
            # Truncate AFTER the opening paren so the callee name +
            # leading args are always visible. Reserve room for the
            # marker so total stays ≤ _CALL_EXPRESSION_MAX.
            raw = raw[: _CALL_EXPRESSION_MAX - len(" /*…*/)") ] + " /*…*/)"
    src_line: str | None = None
    if 1 <= pos.start.line <= len(sf.lines):
        src_line = sf.lines[pos.start.line - 1].strip()
        if not src_line:
            src_line = None
    return raw, src_line


class PythonIRVisitor(cst.CSTVisitor):
    METADATA_DEPENDENCIES = (PositionProvider,)

    def __init__(self, sf: ScannedFile, ir: AgentIR, module: cst.Module) -> None:
        self.sf = sf
        self.ir = ir
        # Hold the parsed module so we can ask LibCST for the verbatim
        # source of any node we care about (``module.code_for_node``).
        # This is what gives sinks their full call expression, not just
        # the dotted callee name.
        self.module = module
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

        # Route detection: iterate the actual cst.Decorator nodes so we
        # can pull both the HTTP method (from the callee name) AND the
        # route path (from the first string argument). The legacy
        # implementation only looked at decorator NAMES and always
        # produced ``path="<unknown>"``, which left the auth-checks
        # finding showing "POST <unknown>" with a blank Code involved.
        route_method: str | None = None
        route_path: str | None = None
        chosen_deco: cst.Decorator | None = None
        for deco in node.decorators:
            callee = _name_of_expr(deco.decorator if not isinstance(deco.decorator, cst.Call) else deco.decorator.func)
            method = _route_method_from_callee(callee)
            if not method:
                continue
            route_method = method
            chosen_deco = deco
            literal_path = _decorator_route_path(deco)
            if literal_path:
                route_path = literal_path
                break  # Prefer the first decorator with an explicit path.
            route_path = route_path or "<unknown>"
        if route_method:
            route_code = _capture_route_code(self.module, node)
            auth_guards = _detect_route_auth_guards(node)
            route = RouteNode(
                id=_id("route", self.sf.rel_path, pos.start.line, name),
                method=route_method,
                path=route_path or "<unknown>",
                location=_loc(self.sf.rel_path, pos, name),
                auth_guards=auth_guards,
                code=route_code,
                metadata={"decorator": chosen_deco and _name_of_expr(
                    chosen_deco.decorator if not isinstance(chosen_deco.decorator, cst.Call)
                    else chosen_deco.decorator.func
                )},
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
        # Most patterns in the side-effect ontology are anchored to a literal
        # opening paren (e.g. r"\bsubprocess\.(run|popen|...)\s*\(") because
        # they were originally written against raw source text. The CST visitor
        # only sees the dotted callee here ("subprocess.run") so we append the
        # synthetic "(" — both forms classify identically for paren-less
        # patterns, but paren-anchored patterns now match bare calls too. This
        # is what lets the new IR flag a standalone `subprocess.run(['ls'])`
        # at parse time without needing a regex pass over raw source.
        call_text = f"{callee}("
        effects = classify_side_effect(call_text)
        if effects:
            # Capture the verbatim, redacted call expression once per
            # call. This is what the UI and the AI explainer will show
            # in "Code involved" — e.g.
            # ``os.system("rm -rf " + user_input)`` rather than the
            # bare normalized label ``os.system``.
            raw_expr, raw_line = _capture_call_text(self.module, node, pos, self.sf)
            call_expression = redact_secrets(raw_expr) if raw_expr else None
            source_line = redact_secrets(raw_line) if raw_line else None
            for effect in effects:
                sink = SinkNode(
                    id=_id("sink", self.sf.rel_path, pos.start.line, f"{effect}:{callee}"),
                    kind=effect,
                    label=callee,
                    location=_loc(self.sf.rel_path, pos, callee),
                    impact=impact_for_effect(effect),  # type: ignore[arg-type]
                    call_expression=call_expression,
                    source_line=source_line,
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
        # Pass the (unwrapped) module so the visitor can recover the
        # verbatim source of any node via ``module.code_for_node``.
        wrapper.visit(PythonIRVisitor(sf, ir, module))
    except Exception:
        # Do not fail the whole scan on one broken Python file. Future fallback:
        # parso or Tree-sitter Python grammar.
        return
