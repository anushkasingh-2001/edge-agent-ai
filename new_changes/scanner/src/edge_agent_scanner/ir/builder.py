from __future__ import annotations

from pathlib import Path

from edge_agent_scanner.ir.extract_mcp import extract_mcp_ir
from edge_agent_scanner.ir.extract_openapi import extract_openapi_ir
from edge_agent_scanner.ir.extract_python import extract_python_ir
from edge_agent_scanner.ir.extract_ts_js import extract_ts_js_ir
from edge_agent_scanner.ir.graph import infer_tool_side_effects, link_agents_to_tools
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.walker import ScannedFile


def build_agent_ir(files: list[ScannedFile], repo_root: str | Path | None = None) -> AgentIR:
    """Build a language-agnostic Agent IR from scanned files.

    The builder stays intentionally small. Accuracy comes from the extractor
    modules and from the post-processing passes below:
      - extract_python.py: LibCST-based Python structure extraction
      - extract_ts_js.py: Tree-sitter-based JS/TS extraction
      - extract_openapi.py: OpenAPI schema extraction/validation
      - extract_mcp.py: MCP config/server extraction

    `repo_root` is passed to side-effect inference so `.edgeagent/config.yaml`
    can extend the default sink ontology without hardcoding app-specific tools.
    """
    ir = AgentIR()

    for sf in files:
        rel = sf.rel_path.lower()
        if rel.endswith(".py"):
            extract_python_ir(sf, ir)
        elif rel.endswith((".ts", ".tsx", ".js", ".jsx")):
            extract_ts_js_ir(sf, ir)
        elif rel.endswith((".json", ".yaml", ".yml")):
            extract_openapi_ir(sf, ir)
            extract_mcp_ir(sf, ir)

    link_agents_to_tools(ir)
    infer_tool_side_effects(ir, repo_root=repo_root)
    return ir
