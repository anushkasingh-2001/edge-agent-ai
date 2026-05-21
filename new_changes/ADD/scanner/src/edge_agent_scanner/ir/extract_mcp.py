from __future__ import annotations

import hashlib
import json
import re
from typing import Any

import yaml

from edge_agent_scanner.ir.models import AgentIR, CodeLocation, SinkNode, ToolNode
from edge_agent_scanner.ir.sinks import classify_side_effect, impact_for_effect
from edge_agent_scanner.walker import ScannedFile


def _id(prefix: str, file: str, line: int, name: str) -> str:
    return f"{prefix}:{hashlib.sha1(f'{prefix}:{file}:{line}:{name}'.encode()).hexdigest()[:12]}"


def _load_config(sf: ScannedFile) -> dict[str, Any] | None:
    text = "\n".join(sf.lines)
    try:
        return json.loads(text) if sf.rel_path.endswith(".json") else yaml.safe_load(text)
    except Exception:
        return None


def extract_mcp_ir(sf: ScannedFile, ir: AgentIR) -> None:
    data = _load_config(sf)
    if isinstance(data, dict):
        servers = data.get("mcpServers") or data.get("mcp_servers")
        if isinstance(servers, dict):
            for name, cfg in servers.items():
                if not isinstance(cfg, dict):
                    continue
                cmd = " ".join(str(x) for x in [cfg.get("command", ""), *(cfg.get("args") or [])])
                loc = CodeLocation(file=sf.rel_path, start_line=1, end_line=1, symbol=str(name))
                effects = classify_side_effect(cmd)
                if "filesystem" in cmd.lower():
                    effects.append("file_mutation")
                if re.search(r"\b(bash|sh|cmd|powershell|python\s+-c|node\s+-e)\b", cmd, re.I):
                    effects.append("code_execution")
                tool = ToolNode(
                    id=_id("tool", sf.rel_path, 1, str(name)),
                    name=str(name),
                    location=loc,
                    framework="MCP",
                    callable_from_agent=True,
                    side_effects=sorted(set(effects)),
                    metadata={"mcp_command": cmd, "config": cfg},
                )
                ir.tools.append(tool)
                for effect in tool.side_effects:
                    sink = SinkNode(
                        id=_id("sink", sf.rel_path, 1, f"{name}:{effect}"),
                        kind=effect,
                        label=f"MCP server {name}: {cmd}",
                        location=loc,
                        impact=impact_for_effect(effect),  # type: ignore[arg-type]
                    )
                    ir.sinks.append(sink)
                    ir.add_edge(tool.id, sink.id, "writes", loc)

    # Code-based MCP tool detection in py/ts files should be handled by language extractors.
