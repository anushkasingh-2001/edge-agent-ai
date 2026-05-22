from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_finding
from edge_agent_scanner.ir.graph import reachable_set
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

    # Reachability gate: when the IR has agent entries, only flag tools that are
    # actually reachable from one of them in the call graph. A side-effecting
    # tool that no agent can reach is not an agent risk and should not be flagged.
    # When there are no agent entries at all (sparse IR), fall back to the
    # callable_from_agent signal so we don't silently stop flagging.
    agent_ids = [a.id for a in ir.agents]
    reach_normal = reachable_set(ir, agent_ids) if agent_ids else None

    for tool in ir.tools:
        if not tool.callable_from_agent or not tool.side_effects:
            continue

        if reach_normal is not None and tool.id not in reach_normal:
            # Agents exist but none can reach this tool in the graph.
            continue

        f = make_finding(
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
        # Side-effect matches come from the IR ontology; exact match means a
        # concrete pattern matched rather than a broad fallback.
        matches = tool.metadata.get("side_effect_matches") or []
        annotate_finding(
            f,
            ConfidenceFeatures(
                sink_impact=_tool_severity(tool),
                source_untrusted=False,
                unguarded_path_exists=reach_normal is None or tool.id in reach_normal,
                path_length=1,
                partial_guard=False,
                ir_evidence=bool(matches),
                exact_sink_match=bool(matches),
                prod_file=is_prod_file(tool.location.file),
            ),
        )
        findings.append(f)
    return findings
