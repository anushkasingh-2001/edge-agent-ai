from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_existing
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.walker import ScannedFile


def analyze_auth_checks(ir: AgentIR, files: list[ScannedFile]):
    findings = []
    for route in ir.routes:
        sensitive = route.method in {"POST", "PUT", "PATCH", "DELETE"}
        if sensitive and not route.auth_guards:
            guarded_by_edge = any(e.kind == "guarded_by" and e.src == route.id for e in ir.edges)
            if guarded_by_edge:
                continue
            findings.append(
                make_finding(
                    rule_id="auth-checks",
                    severity="high",
                    category="Auth",
                    title=f"Sensitive route has no detected auth guard: {route.method} {route.path}",
                    location=route.location,
                    reason="A mutating route was detected without an authentication/authorization guard in the Agent IR.",
                    suggested_fix="Add authentication and resource-level authorization: user identity, role/scope, tenant/owner checks.",
                    evidence=f"{route.method} {route.path}",
                    confidence=0.72,
                )
            )
    # Tier 2 (conservative): attach advisory confidence band + escalation
    # WITHOUT changing severity or the analyzer's own confidence value.
    for _f in findings:
        annotate_existing(_f, ConfidenceFeatures(sink_impact=_f.severity, prod_file=is_prod_file(_f.file)))
    return findings
