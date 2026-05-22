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
from edge_agent_scanner.report import EvidencePathNode
from edge_agent_scanner.walker import ScannedFile

# For untrusted-input -> dangerous-sink flow, any of these guards on the path
# neutralizes the taint: input validation/sanitizer, an auth check, or an
# explicit approval gate.
TAINT_GUARD_KINDS = {"validation", "auth", "approval"}


def _evidence_path(ir: AgentIR, path: list[str]) -> list[EvidencePathNode]:
    idx = node_label_index(ir)
    nodes: list[EvidencePathNode] = []
    for nid in path:
        kind, label, file, line = idx.get(nid, ("node", nid, "", 0))
        nodes.append(EvidencePathNode(kind=kind, label=label, file=file or None, line=line or None))
    return nodes


def analyze_user_input_to_dangerous_code(ir: AgentIR, files: list[ScannedFile]):
    """Flag untrusted input that can reach a high-impact sink along an
    *unguarded* path (cut-set semantics).

    A guard-removed reachability set is computed once from all untrusted
    sources. Because the guard-removed graph is a subgraph of the full graph,
    "reachable after removing guards" already implies "reachable" (step 1) AND
    "an unguarded path exists" (step 4) — so a single set membership test gives
    the finding condition. Paths sanitized/authorized/approved by *different*
    guards are all correctly treated as safe; no single dominator is required.
    """
    findings = []
    sources = [s.id for s in ir.sources if not s.trusted]
    if not sources:
        return findings

    dangerous_sinks = [s for s in ir.sinks if s.impact in {"high", "critical"}]
    if not dangerous_sinks:
        return findings

    cut = guard_cut_ids(ir, TAINT_GUARD_KINDS)
    reach_unguarded = reachable_set(ir, sources, cut)

    for sink in dangerous_sinks:
        if sink.id not in reach_unguarded:
            continue  # unreachable, or every path passes a sanitizer/auth/approval guard

        path = shortest_unguarded_path(ir, sources, sink.id, cut) or [sink.id]
        f = make_finding(
                rule_id="user-input-dangerous-code",
                severity=sink.impact,
                category="Data flow",
                title=f"Untrusted input can reach dangerous sink: {sink.label}",
                location=sink.location,
                reason=(
                    "Guard-removed IR reachability found untrusted input flowing to a high-impact "
                    "sink along a path with no sanitizer, auth check, or approval gate. This is a "
                    "cut-set result, so flows guarded by different sanitizers on different paths "
                    "are not false-flagged."
                ),
                suggested_fix=(
                    "Validate or allowlist input before the sink; use safe APIs such as "
                    "parameterized SQL or safe path joins; require authorization/approval for "
                    "high-impact actions."
                ),
                evidence="unguarded_path=" + " -> ".join(path),
                confidence=0.82,
                evidence_path=_evidence_path(ir, path),
        )
        annotate_finding(
            f,
            ConfidenceFeatures(
                sink_impact=sink.impact,
                source_untrusted=True,
                unguarded_path_exists=True,
                path_length=len(path),
                partial_guard=bool(cut),
                ir_evidence=True,
                exact_sink_match=True,
                prod_file=is_prod_file(sink.location.file),
            ),
        )
        findings.append(f)
    return findings
