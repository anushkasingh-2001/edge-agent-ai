from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.walker import ScannedFile


def analyze_openapi_quality(ir: AgentIR, files: list[ScannedFile]):
    findings = []
    for tool in ir.tools:
        if tool.framework != "OpenAPI":
            continue
        op = tool.metadata.get("operation", {})
        method = tool.metadata.get("method", "")
        if method in {"POST", "PUT", "PATCH", "DELETE"} and not tool.metadata.get("has_security"):
            findings.append(
                make_finding(
                    rule_id="openapi-schema",
                    severity="high",
                    category="OpenAPI",
                    title=f"Mutating OpenAPI operation lacks security: {tool.name}",
                    location=tool.location,
                    reason="A mutating endpoint exposed as an agent tool has no root or operation-level security.",
                    suggested_fix="Add securitySchemes and operation-level security requirements; include 401/403 responses.",
                    evidence=f"{method} {tool.metadata.get('path')}",
                    confidence=0.87,
                )
            )
        if not op.get("operationId") or not op.get("requestBody") and method in {"POST", "PUT", "PATCH"}:
            findings.append(
                make_finding(
                    rule_id="openapi-schema",
                    severity="medium",
                    category="OpenAPI",
                    title=f"OpenAPI operation may be too vague for safe tool use: {tool.name}",
                    location=tool.location,
                    reason="Agent tools need precise operationIds and typed request schemas to reduce incorrect tool calls.",
                    suggested_fix="Use a unique operationId, strict request/response schemas, required fields, enums, and examples.",
                    evidence=f"{method} {tool.metadata.get('path')}",
                    confidence=0.65,
                )
            )
    return findings
