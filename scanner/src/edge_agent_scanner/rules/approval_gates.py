"""Flag missing human-approval context near dangerous tool usage."""

from __future__ import annotations

import uuid

from edge_agent_scanner.config import APPROVAL_CONTEXT_LINES
from edge_agent_scanner.report import Finding
from edge_agent_scanner.rules.dangerous_tools import iter_dangerous_hits
from edge_agent_scanner.walker import ScannedFile

_APPROVAL_MARKERS = (
    "approval_required",
    "human_review",
    "manual_gate",
    "confirm_before_execute",
    "require_confirmation",
    "admin_approval",
    "permission_required",
    "human_in_the_loop",
    "interrupt",
)


def _window_contains_approval(lines: list[str], center_idx: int) -> bool:
    """center_idx is 0-based line index."""
    start = max(0, center_idx - APPROVAL_CONTEXT_LINES)
    end = min(len(lines), center_idx + APPROVAL_CONTEXT_LINES + 1)
    blob = "\n".join(lines[start:end]).lower()
    return any(m in blob for m in _APPROVAL_MARKERS)


def run_approval_gate_rule(files: list[ScannedFile]) -> list[Finding]:
    findings: list[Finding] = []
    for sf in files:
        for i, line in enumerate(sf.lines):
            line_no = i + 1
            if not any(True for _ in iter_dangerous_hits(line)):
                continue
            if _window_contains_approval(sf.lines, i):
                continue
            findings.append(
                Finding(
                    id=str(uuid.uuid4()),
                    rule_id="human-approval",
                    severity="high",
                    category="Missing approval gate",
                    title="Dangerous capability without nearby approval / human-review signal",
                    file=sf.rel_path,
                    line=line_no,
                    agent="unknown",
                    reason=(
                        "A potentially dangerous tool or side-effect pattern appears, but the surrounding "
                        f"code ({APPROVAL_CONTEXT_LINES} lines) lacks common approval / HITL markers."
                    ),
                    suggestedFix=(
                        "Add explicit human-in-the-loop approval (e.g. interrupt, confirmation step, or "
                        "policy gate) before executing this capability."
                    ),
                    evidence=f"No marker from: {', '.join(_APPROVAL_MARKERS)}",
                    code=line.strip()[:500],
                    confidence=0.72,
                )
            )
    return findings
