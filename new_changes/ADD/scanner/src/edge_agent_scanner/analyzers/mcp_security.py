from __future__ import annotations

import re

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.walker import ScannedFile


def analyze_mcp_security(ir: AgentIR, files: list[ScannedFile]):
    findings = []
    for tool in ir.tools:
        if tool.framework != "MCP":
            continue
        cmd = str(tool.metadata.get("mcp_command", ""))
        if any(e in tool.side_effects for e in ["code_execution", "file_mutation"]):
            findings.append(
                make_finding(
                    rule_id="mcp-security",
                    severity="high",
                    category="MCP configuration",
                    title=f"MCP server exposes risky capability: {tool.name}",
                    location=tool.location,
                    reason="This MCP server/tool appears to expose shell/filesystem or other high-impact capabilities.",
                    suggested_fix="Restrict MCP roots, remove shell passthrough, require auth/scopes for remote servers, and hide dangerous tools by default.",
                    evidence=cmd,
                    code=cmd,
                    confidence=0.82,
                )
            )
        if re.search(r"\b(npx|http://|0\.0\.0\.0)\b", cmd, re.I):
            findings.append(
                make_finding(
                    rule_id="mcp-security",
                    severity="medium",
                    category="MCP configuration",
                    title=f"MCP server should be reviewed for trust and transport safety: {tool.name}",
                    location=tool.location,
                    reason="The MCP server command/transport pattern can create trust or network exposure risks.",
                    suggested_fix="Pin server packages, avoid untrusted remote MCP endpoints, bind local servers to localhost, and require explicit approval before enabling new servers.",
                    evidence=cmd,
                    code=cmd,
                    confidence=0.66,
                )
            )
    return findings
