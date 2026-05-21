from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.ir.graph import find_paths, path_has_guard
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.ir.sinks import is_high_impact_effect
from edge_agent_scanner.report import EvidencePathNode
from edge_agent_scanner.walker import ScannedFile


def _is_high_impact_tool(tool) -> bool:
    # Prefer graph.py's side_effect_max_severity because it includes repo config.
    sev = str(tool.metadata.get("side_effect_max_severity", "")).lower()
    if sev in {"critical", "high"}:
        return True
    return any(is_high_impact_effect(e) for e in tool.side_effects)


def _finding_severity(tool) -> str:
    return "critical" if str(tool.metadata.get("side_effect_max_severity", "")).lower() == "critical" else "high"


def analyze_missing_approval(ir: AgentIR, files: list[ScannedFile]):
    """Flag high-impact agent-callable tools with no approval guard on path."""
    findings = []
    agent_ids = [a.id for a in ir.agents]

    for tool in ir.tools:
        if not tool.callable_from_agent or not _is_high_impact_tool(tool):
            continue

        paths = find_paths(ir, agent_ids, {tool.id}, max_depth=6)
        guarded = any(path_has_guard(ir, p, {"approval"}) for p in paths)
        if tool.requires_approval or guarded:
            continue

        findings.append(
            make_finding(
                rule_id="human-approval",
                severity=_finding_severity(tool),
                category="Missing approval gate",
                title=f"High-impact tool can be reached without approval: {tool.name}",
                location=tool.location,
                reason=(
                    "A high-impact agent-callable tool is reachable from the agent graph, "
                    "but no approval guard was found on the path. This is path-based, not "
                    "a nearby-keyword check."
                ),
                suggested_fix=(
                    "Insert an explicit approval gate before execution, such as "
                    "confirm_before_execute(), LangGraph interrupt(), a policy-engine check, "
                    "or a UI approval step."
                ),
                evidence="side_effects=" + ",".join(tool.side_effects),
                confidence=0.86,
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
