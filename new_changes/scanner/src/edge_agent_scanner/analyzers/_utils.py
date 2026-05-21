from __future__ import annotations

import uuid

from edge_agent_scanner.ir.models import CodeLocation
from edge_agent_scanner.report import EvidencePathNode, Finding, Location


def loc_to_report(loc: CodeLocation) -> Location:
    return Location(file=loc.file, start_line=loc.start_line, end_line=loc.end_line, symbol=loc.symbol)


def make_finding(
    *,
    rule_id,
    severity,
    category,
    title,
    location: CodeLocation,
    reason: str,
    suggested_fix: str,
    evidence: str,
    code: str = "",
    confidence: float = 0.7,
    agent: str = "unknown",
    evidence_path: list[EvidencePathNode] | None = None,
    related_locations=None,
) -> Finding:
    return Finding(
        id=str(uuid.uuid4()),
        rule_id=rule_id,
        severity=severity,
        category=category,
        title=title,
        file=location.file,
        line=location.start_line,
        agent=agent,
        reason=reason,
        suggestedFix=suggested_fix,
        evidence=evidence,
        code=code[:500],
        confidence=max(0.0, min(1.0, confidence)),
        primary_location=loc_to_report(location),
        related_locations=related_locations or [],
        evidence_path=evidence_path or [],
    )
