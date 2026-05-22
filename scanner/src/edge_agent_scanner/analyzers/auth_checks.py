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
        if not sensitive or route.auth_guards:
            continue
        guarded_by_edge = any(e.kind == "guarded_by" and e.src == route.id for e in ir.edges)
        if guarded_by_edge:
            continue
        # Title falls back to the file path + line when the extractor
        # couldn't recover a literal route path (older scanners and TS
        # extractors that don't capture path arguments stored
        # ``"<unknown>"``). Showing ``POST <unknown>`` in the UI
        # confused users — surface a useful location instead.
        path_label = route.path if route.path and route.path != "<unknown>" else f"{route.location.file}:{route.location.start_line}"
        evidence_lines = [
            f"method={route.method}",
            f"path={route.path}",
            "auth_guard_detected=false",
        ]
        if route.metadata.get("decorator"):
            evidence_lines.append(f"decorator={route.metadata['decorator']}")
        findings.append(
            make_finding(
                rule_id="auth-checks",
                severity="high",
                category="Auth",
                title=f"Sensitive route has no detected auth guard: {route.method} {path_label}",
                location=route.location,
                reason="A mutating route was detected without an authentication/authorization guard in the Agent IR.",
                suggested_fix=(
                    "Add authentication and resource-level authorization to this route. "
                    "For FastAPI, attach ``user = Depends(get_current_user)`` (or equivalent) "
                    "and verify the caller is allowed to act on the requested resource "
                    "(role/scope, tenant/owner)."
                ),
                evidence="\n".join(evidence_lines),
                # Render the captured decorator + function signature so
                # the drawer's "Code involved" panel isn't empty for
                # FastAPI routes. Falls back to an empty string when
                # extraction failed — the UI gracefully handles that.
                code=route.code or "",
                confidence=0.72,
            )
        )
    # Tier 2 (conservative): attach advisory confidence band + escalation
    # WITHOUT changing severity or the analyzer's own confidence value.
    for _f in findings:
        annotate_existing(_f, ConfidenceFeatures(sink_impact=_f.severity, prod_file=is_prod_file(_f.file)))
    return findings
