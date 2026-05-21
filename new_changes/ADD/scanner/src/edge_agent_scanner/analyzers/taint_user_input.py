from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.ir.graph import find_paths, path_has_guard
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.report import EvidencePathNode
from edge_agent_scanner.walker import ScannedFile


def analyze_user_input_to_dangerous_code(ir: AgentIR, files: list[ScannedFile]):
    findings = []
    sources = [s.id for s in ir.sources if not s.trusted]
    dangerous_sinks = {s.id for s in ir.sinks if s.impact in {"high", "critical"}}
    for path in find_paths(ir, sources, dangerous_sinks, max_depth=8):
        if path_has_guard(ir, path, {"validation", "auth", "approval"}):
            continue
        sink_id = path[-1]
        sink = next((s for s in ir.sinks if s.id == sink_id), None)
        if not sink:
            continue
        findings.append(
            make_finding(
                rule_id="user-input-dangerous-code",
                severity=sink.impact,
                category="Data flow",
                title=f"Untrusted input can reach dangerous sink: {sink.label}",
                location=sink.location,
                reason="CodeQL-style IR path found untrusted input flowing to a high-impact sink without a detected sanitizer or guard.",
                suggested_fix="Validate or allowlist input before the sink; use safe APIs such as parameterized SQL/safe path join; require authorization/approval for high-impact actions.",
                evidence=" -> ".join(path),
                confidence=0.82,
                evidence_path=[EvidencePathNode(kind="node", label=n) for n in path],
            )
        )
    return findings
