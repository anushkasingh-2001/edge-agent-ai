from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.ir.sinks import highest_impact
from edge_agent_scanner.report import EvidencePathNode
from edge_agent_scanner.walker import ScannedFile

_VALID_SEVERITIES = {"critical", "high", "medium", "low"}


def _tool_severity(tool) -> str:
    # Prefer graph.py's severity because it includes repo-defined sink rules.
    sev = str(tool.metadata.get("side_effect_max_severity", "")).lower()
    if sev in _VALID_SEVERITIES:
        return sev
    return highest_impact(tool.side_effects) if tool.side_effects else "medium"


def _confidence(tool) -> float:
    matches = tool.metadata.get("side_effect_matches") or []
    if isinstance(matches, list) and matches:
        try:
            return max(float(m.get("confidence", 0.75)) for m in matches if isinstance(m, dict))
        except Exception:
            return 0.82
    return 0.82 if tool.metadata.get("callability_reason") else 0.9


def _evidence(tool) -> str:
    matches = tool.metadata.get("side_effect_matches") or []
    if isinstance(matches, list) and matches:
        pieces = []
        for m in matches[:5]:
            if not isinstance(m, dict):
                continue
            pieces.append(
                f"{m.get('effect')} ({m.get('severity')}; {m.get('matched_by')}: {m.get('reason')})"
            )
        if pieces:
            return "; ".join(pieces)
    return ", ".join(tool.side_effects)


def analyze_dangerous_tools(ir: AgentIR, files: list[ScannedFile]):
    """Flag agent-callable tools with real side effects.

    This replaces keyword-only matching. A prompt string containing "Admin" is
    not enough; the finding requires an agent-callable ToolNode with classified
    side effects.
    """
    findings = []
    for tool in ir.tools:
        if not tool.callable_from_agent or not tool.side_effects:
            continue

        findings.append(
            make_finding(
                rule_id="dangerous-tools",
                severity=_tool_severity(tool),
                category="Dangerous tool / side effect",
                title=f"Agent-callable tool has side effects: {tool.name}",
                location=tool.location,
                reason=(
                    "This is not a keyword-only match. The capability is represented as an "
                    "agent-callable tool and the side-effect ontology classified it as mutating, "
                    "external, privileged, or otherwise high-impact."
                ),
                suggested_fix=(
                    "Restrict tool permissions, narrow its input schema, add approval gates for "
                    "high-impact actions, and document expected safe usage."
                ),
                evidence=_evidence(tool),
                code=str(tool.metadata.get("code", "")),
                confidence=_confidence(tool),
                evidence_path=[
                    EvidencePathNode(
                        kind="tool",
                        label=tool.name,
                        file=tool.location.file,
                        line=tool.location.start_line,
                    )
                ],
            )
        )
    return findings
