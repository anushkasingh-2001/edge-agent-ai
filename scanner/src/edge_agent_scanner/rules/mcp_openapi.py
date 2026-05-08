"""Light MCP config and OpenAPI surface checks."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from edge_agent_scanner.report import Finding
from edge_agent_scanner.walker import ScannedFile


def _try_json_object(blob: str) -> Any | None:
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        return None


def _inspect_mcp_server_entry(key: str, cfg: dict[str, Any], rel_path: str) -> list[Finding]:
    findings: list[Finding] = []
    cmd = str(cfg.get("command", "") or "").lower()
    args = " ".join(str(a) for a in (cfg.get("args") or [])).lower()
    blob = f"{cmd} {args}"
    if any(x in blob for x in ("powershell", "bash", "sh ", "cmd", "/bin/sh", "shell")):
        findings.append(
            Finding(
                id=str(uuid.uuid4()),
                rule_id="mcp-security",
                severity="high",
                category="MCP configuration",
                title="MCP server invokes shell-like command",
                file=rel_path,
                line=1,
                agent="unknown",
                reason="MCP config references a shell or shell-like invocation.",
                suggestedFix="Prefer explicit MCP transports; avoid arbitrary shell wrappers.",
                evidence=f"server={key}",
                code=str(cfg)[:500],
                confidence=0.68,
            )
        )
    if "filesystem" in blob or "npx" in cmd:
        findings.append(
            Finding(
                id=str(uuid.uuid4()),
                rule_id="mcp-security",
                severity="medium",
                category="MCP configuration",
                title="MCP server may expose filesystem or dynamic package install",
                file=rel_path,
                line=1,
                agent="unknown",
                reason="Filesystem or npx-style MCP tooling increases attack surface.",
                suggestedFix="Review server scope, read-only roots, and supply-chain risk.",
                evidence=f"server={key}",
                code=str(cfg)[:500],
                confidence=0.55,
            )
        )
    return findings


def _extract_mcp_findings(data: Any, rel_path: str) -> list[Finding]:
    findings: list[Finding] = []
    if not isinstance(data, dict):
        return findings
    mcp_block: dict[str, Any] | None = None
    for k, v in data.items():
        if k.lower() == "mcpservers" and isinstance(v, dict):
            mcp_block = v
            break
    if mcp_block is None:
        return findings
    for key, val in mcp_block.items():
        if isinstance(val, dict):
            findings.extend(_inspect_mcp_server_entry(str(key), val, rel_path))
    return findings


def _openapi_blob_checks(blob: str, rel_path: str) -> list[Finding]:
    findings: list[Finding] = []
    low = blob.lower()
    if "openapi" not in low and "swagger" not in low:
        return findings

    if "securityschemes" not in low and "security_definitions" not in low:
        findings.append(
            Finding(
                id=str(uuid.uuid4()),
                rule_id="openapi-schema",
                severity="medium",
                category="OpenAPI",
                title="OpenAPI document may be missing securitySchemes",
                file=rel_path,
                line=1,
                agent="unknown",
                reason="No securitySchemes block detected in spec text.",
                suggestedFix="Define securitySchemes and apply security globally or per operation.",
                evidence="missing_securitySchemes_heuristic",
                code=blob[:400],
                confidence=0.52,
            )
        )

    for m in re.finditer(r"^\s*(post|delete)\s*:\s*$", blob, re.I | re.MULTILINE):
        start = m.start()
        window = blob[start : start + 400].lower()
        if "security" not in window and "401" not in window and "403" not in window:
            line_no = blob[: start].count("\n") + 1
            findings.append(
                Finding(
                    id=str(uuid.uuid4()),
                    rule_id="openapi-schema",
                    severity="low",
                    category="OpenAPI",
                    title=f"HTTP {m.group(1).upper()} operation with no obvious security annotation nearby",
                    file=rel_path,
                    line=line_no,
                    agent="unknown",
                    reason="Heuristic: POST/DELETE path may lack documented auth.",
                    suggestedFix="Document auth requirements and approval for mutating routes.",
                    evidence="post_delete_auth_heuristic",
                    code=blob[start : start + 200],
                    confidence=0.42,
                )
            )

    return findings


def run_mcp_openapi_rules(files: list[ScannedFile]) -> list[Finding]:
    findings: list[Finding] = []
    for sf in files:
        blob = "\n".join(sf.lines)
        if sf.rel_path.endswith(".json"):
            data = _try_json_object(blob)
            if data is not None:
                findings.extend(_extract_mcp_findings(data, sf.rel_path))

        low_name = sf.rel_path.lower()
        if sf.rel_path.endswith((".yaml", ".yml", ".json")):
            if "openapi" in low_name or "swagger" in low_name or "openapi" in blob.lower():
                findings.extend(_openapi_blob_checks(blob, sf.rel_path))
            if re.search(r"mcpServers|mcp_servers", blob, re.I):
                if re.search(r"command\s*:\s*.*(npx|shell|bash|sh|powershell|cmd)", blob, re.I):
                    findings.append(
                        Finding(
                            id=str(uuid.uuid4()),
                            rule_id="mcp-security",
                            severity="high",
                            category="MCP configuration",
                            title="YAML MCP config references shell or npx command",
                            file=sf.rel_path,
                            line=1,
                            agent="unknown",
                            reason="Shell or npx invocation in MCP YAML.",
                            suggestedFix="Validate MCP server source and minimize shell indirection.",
                            evidence="yaml_mcp_shell",
                            code=blob[:500],
                            confidence=0.62,
                        )
                    )

    return findings
