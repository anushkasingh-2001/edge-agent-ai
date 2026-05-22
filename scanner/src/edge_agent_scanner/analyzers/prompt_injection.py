from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_existing
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.report import EvidencePathNode
from edge_agent_scanner.walker import ScannedFile


def analyze_prompt_injection(ir: AgentIR, files: list[ScannedFile]):
    findings = []
    # Conservative static signal: untrusted sources and operational prompts exist,
    # but no validation/boundary guard is found in the repo graph.
    has_boundary_guard = any(g.kind in {"validation", "auth"} for g in ir.guards)
    if not ir.sources or not ir.prompts or has_boundary_guard:
        return findings

    for p in ir.prompts[:20]:
        findings.append(
            make_finding(
                rule_id="prompt-injection",
                severity="medium",
                category="Prompt injection",
                title=f"Prompt may consume untrusted content without clear boundary handling: {p.name}",
                location=p.location,
                reason="The repo contains untrusted input sources and operational prompts, but no schema/boundary/sanitization guard was detected in the Agent IR.",
                suggested_fix="Keep untrusted data outside system/developer prompts; quote or tag it as data-only; validate extracted fields before tool use.",
                evidence=p.text_preview[:200],
                code=p.text_preview,
                confidence=0.62,
                evidence_path=[
                    EvidencePathNode(kind="prompt", label=p.name, file=p.location.file, line=p.location.start_line)
                ],
            )
        )
    # Tier 2 (conservative): attach advisory confidence band + escalation
    # WITHOUT changing severity or the analyzer's own confidence value.
    for _f in findings:
        annotate_existing(_f, ConfidenceFeatures(sink_impact=_f.severity, prod_file=is_prod_file(_f.file)))
    return findings
