from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_existing
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.walker import ScannedFile

REQUIRED_CONCEPTS = {
    "role": ["you are", "role"],
    "tool_policy": ["tool", "function", "call"],
    "approval": ["approval", "confirm", "human", "permission"],
    "output_schema": ["json", "schema", "format", "return"],
    "uncertainty": ["uncertain", "ask", "clarify", "do not guess"],
}


def analyze_prompt_contract(ir: AgentIR, files: list[ScannedFile]):
    findings = []
    for p in ir.prompts:
        text = p.text_preview.lower()
        missing = [name for name, words in REQUIRED_CONCEPTS.items() if not any(w in text for w in words)]
        if len(missing) >= 3:
            findings.append(
                make_finding(
                    rule_id="prompt-contract",
                    severity="medium",
                    category="Prompt contract",
                    title=f"Prompt contract is underspecified: {p.name}",
                    location=p.location,
                    reason="The prompt is attached to agent/model logic but lacks several operational constraints.",
                    suggested_fix="Add role, task boundary, tool-use policy, approval behavior, output schema, and uncertainty/clarification rules.",
                    evidence="missing=" + ",".join(missing),
                    code=p.text_preview,
                    confidence=0.68,
                )
            )
    # Tier 2 (conservative): attach advisory confidence band + escalation
    # WITHOUT changing severity or the analyzer's own confidence value.
    for _f in findings:
        annotate_existing(_f, ConfidenceFeatures(sink_impact=_f.severity, prod_file=is_prod_file(_f.file)))
    return findings
