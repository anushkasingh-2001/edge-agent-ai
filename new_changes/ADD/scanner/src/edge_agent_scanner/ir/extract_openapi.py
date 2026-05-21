from __future__ import annotations

import hashlib
import json
from typing import Any

import yaml

from edge_agent_scanner.ir.models import AgentIR, CodeLocation, GuardNode, SinkNode, ToolNode
from edge_agent_scanner.ir.sinks import impact_for_effect
from edge_agent_scanner.walker import ScannedFile

try:
    from openapi_spec_validator import validate_spec
except Exception:
    validate_spec = None


def _id(prefix: str, file: str, line: int, name: str) -> str:
    return f"{prefix}:{hashlib.sha1(f'{prefix}:{file}:{line}:{name}'.encode()).hexdigest()[:12]}"


def _load(sf: ScannedFile) -> dict[str, Any] | None:
    text = "\n".join(sf.lines)
    try:
        if sf.rel_path.endswith(".json"):
            data = json.loads(text)
        else:
            data = yaml.safe_load(text)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _is_openapi(data: dict[str, Any]) -> bool:
    return "openapi" in data or "swagger" in data or ("paths" in data and "info" in data)


def extract_openapi_ir(sf: ScannedFile, ir: AgentIR) -> None:
    data = _load(sf)
    if not data or not _is_openapi(data):
        return

    if validate_spec is not None:
        try:
            validate_spec(data)
        except Exception:
            # Validation errors are handled by analyzer, not fatal here.
            pass

    paths = data.get("paths") or {}
    root_sec = bool(data.get("security"))
    schemes = bool(((data.get("components") or {}).get("securitySchemes")) or data.get("securityDefinitions"))

    for path, ops in paths.items():
        if not isinstance(ops, dict):
            continue
        for method, op in ops.items():
            method_l = method.lower()
            if method_l not in {"get", "post", "put", "patch", "delete"} or not isinstance(op, dict):
                continue
            op_id = op.get("operationId") or f"{method_l}_{path}"
            line = 1
            loc = CodeLocation(file=sf.rel_path, start_line=line, end_line=line, symbol=op_id)
            tool = ToolNode(
                id=_id("tool", sf.rel_path, line, op_id),
                name=str(op_id),
                location=loc,
                framework="OpenAPI",
                callable_from_agent=True,
                side_effects=["external_mutation_api"] if method_l in {"post", "put", "patch", "delete"} else [],
                metadata={"method": method_l.upper(), "path": path, "has_security": bool(op.get("security")) or root_sec, "has_security_schemes": schemes, "operation": op},
            )
            ir.tools.append(tool)
            if tool.side_effects:
                sink = SinkNode(
                    id=_id("sink", sf.rel_path, line, f"{method_l}:{path}"),
                    kind="external_mutation_api",
                    label=f"{method_l.upper()} {path}",
                    location=loc,
                    impact=impact_for_effect("external_mutation_api"),  # type: ignore[arg-type]
                )
                ir.sinks.append(sink)
                ir.add_edge(tool.id, sink.id, "writes", loc)
            if bool(op.get("security")) or root_sec:
                guard = GuardNode(
                    id=_id("guard", sf.rel_path, line, f"security:{op_id}"),
                    kind="auth",
                    label=f"OpenAPI security for {op_id}",
                    location=loc,
                )
                ir.guards.append(guard)
                ir.add_edge(tool.id, guard.id, "guarded_by", loc)
