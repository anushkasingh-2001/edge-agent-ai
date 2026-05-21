from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
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
    return findings
