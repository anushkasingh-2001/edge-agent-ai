from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_finding
from edge_agent_scanner.ir.graph import (
    guard_cut_ids,
    node_label_index,
    reachable_set,
    shortest_unguarded_path,
)
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.ir.sinks import is_high_impact_effect
from edge_agent_scanner.report import EvidencePathNode
from edge_agent_scanner.walker import ScannedFile

# "Missing approval" is specifically about human-in-the-loop / approval guards.
# auth and validation guards do not satisfy an *approval* requirement, so they
# are intentionally NOT part of the cut here.
APPROVAL_GUARD_KINDS = {"approval"}


def _is_high_impact_tool(tool) -> bool:
    # Prefer graph.py's side_effect_max_severity because it includes repo config.
    sev = str(tool.metadata.get("side_effect_max_severity", "")).lower()
    if sev in {"critical", "high"}:
        return True
    return any(is_high_impact_effect(e) for e in tool.side_effects)


def _finding_severity(tool) -> str:
    return "critical" if str(tool.metadata.get("side_effect_max_severity", "")).lower() == "critical" else "high"


def _evidence_path(ir: AgentIR, path: list[str]) -> list[EvidencePathNode]:
    idx = node_label_index(ir)
    nodes: list[EvidencePathNode] = []
    for nid in path:
        kind, label, file, line = idx.get(nid, ("node", nid, "", 0))
        nodes.append(EvidencePathNode(kind=kind, label=label, file=file or None, line=line or None))
    return nodes


def analyze_missing_approval(ir: AgentIR, files: list[ScannedFile]):
    """Flag a high-impact agent-callable tool when an *unguarded bypass path*
    exists from any agent entry to the tool.

    Algorithm (cut-set, not single-node dominance):
      1. Reachability: is the tool reachable from any agent entry at all?
      2. Remove every approval guard node (and any node annotated `guarded_by`
         an approval guard) from the graph.
      3. If the tool is STILL reachable after the cut, an unguarded bypass path
         exists -> finding. If it is no longer reachable, every path passed
         through some approval guard -> safe (even when the guards differ per
         path and no single guard dominates).
    The whole analysis is two graph traversals total, not one per tool.
    """
    findings = []
    agent_ids = [a.id for a in ir.agents]
    if not agent_ids:
        return findings

    cut = guard_cut_ids(ir, APPROVAL_GUARD_KINDS)
    reach_normal = reachable_set(ir, agent_ids)            # before guard removal
    reach_unguarded = reachable_set(ir, agent_ids, cut)    # after guard removal

    for tool in ir.tools:
        if not tool.callable_from_agent or not _is_high_impact_tool(tool):
            continue
        if tool.requires_approval:
            continue  # tool itself declares an approval requirement

        # Step 1/2: must be reachable from the agent graph at all.
        if tool.id not in reach_normal:
            continue
        # Step 4/5/6: still reachable with approval guards removed => bypass exists.
        if tool.id not in reach_unguarded:
            continue  # every path to the tool crosses an approval guard => safe

        # Step 7: store one shortest unguarded path as evidence.
        bypass = shortest_unguarded_path(ir, agent_ids, tool.id, cut) or [tool.id]

        # A partial guard means SOME path to the tool crossed an approval guard
        # (the tool was reachable normally, but some guarded paths existed too).
        # We detect it cheaply: the tool is reachable in the cut graph, yet at
        # least one approval guard sits upstream of it in the full graph.
        partial = bool(cut) and any(
            gid in reach_normal for gid in cut
        )

        f = make_finding(
                rule_id="human-approval",
                severity=_finding_severity(tool),
                category="Missing approval gate",
                title=f"High-impact tool can be reached without approval: {tool.name}",
                location=tool.location,
                reason=(
                    "A high-impact agent-callable tool is reachable from an agent entry along a "
                    "path that crosses no approval guard. This is a guard-removed reachability "
                    "(cut-set) result, not a single-dominator check: paths guarded by different "
                    "approval gates are correctly treated as safe."
                ),
                suggested_fix=(
                    "Insert an explicit approval gate on the unguarded path before execution, "
                    "such as confirm_before_execute(), a LangGraph interrupt(), a policy-engine "
                    "check, or a UI approval step."
                ),
                evidence="unguarded_path=" + " -> ".join(bypass) + " | side_effects=" + ",".join(tool.side_effects),
                confidence=0.86,
                evidence_path=_evidence_path(ir, bypass),
        )
        annotate_finding(
            f,
            ConfidenceFeatures(
                sink_impact=_finding_severity(tool),
                source_untrusted=False,
                unguarded_path_exists=True,
                path_length=len(bypass),
                partial_guard=partial,
                ir_evidence=True,
                exact_sink_match=True,
                prod_file=is_prod_file(tool.location.file),
            ),
        )
        findings.append(f)
    return findings
