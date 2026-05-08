"""Detect potentially dangerous tool / side-effect patterns."""

from __future__ import annotations

import re
import uuid
from typing import Iterable

from edge_agent_scanner.report import Finding
from edge_agent_scanner.walker import ScannedFile

# Line-level patterns (case-insensitive where noted)
_DANGEROUS_REGEXES: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"\brefund\b", re.I), "Financial/refund-related operation", 0.75),
    (re.compile(r"\btransfer\b", re.I), "Transfer/money movement pattern", 0.7),
    (re.compile(r"\bpayment\b", re.I), "Payment-related pattern", 0.72),
    (re.compile(r"\bcharge\b", re.I), "Charge/billing pattern", 0.7),
    (re.compile(r"send_email|sendEmail|send_mail|sendmail", re.I), "Outbound email capability", 0.72),
    (re.compile(r"\bemail\b.*\bsend\b|\bsend\b.*\bemail\b", re.I), "Email send pattern", 0.65),
    (re.compile(r"\badmin\b", re.I), "Administrative capability keyword", 0.55),
    (re.compile(r"update_subscription|updateSubscription", re.I), "Subscription mutation", 0.78),
    (re.compile(r"database_write|databaseWrite", re.I), "Database write operation", 0.8),
    (re.compile(r"\bwrite_file\b|writeFile\s*\(", re.I), "Arbitrary file write", 0.82),
    (re.compile(r"\bdelete_file\b|deleteFile\s*\(|unlink\s*\(", re.I), "File deletion", 0.82),
    (re.compile(r"os\.system\s*\(", re.I), "Shell via os.system", 0.9),
    (re.compile(r"subprocess\.(run|Popen|call|check_output)\s*\(", re.I), "Subprocess invocation", 0.88),
    (re.compile(r"\beval\s*\(", re.I), "eval() execution", 0.92),
    (re.compile(r"\bexec\s*\(", re.I), "exec() execution", 0.9),
    (re.compile(r"shell\s*=\s*True", re.I), "Subprocess with shell=True", 0.9),
    (re.compile(r"raw\s*sql|raw_sql|execute\s*\(\s*[\"']", re.I), "Raw SQL execution pattern", 0.85),
    (re.compile(r"\bexecute\s*\(", re.I), "Generic execute() call", 0.6),
]


def iter_dangerous_hits(line: str) -> Iterable[tuple[str, float]]:
    """Yield (description, confidence) for each pattern match on a line."""
    for rx, desc, conf in _DANGEROUS_REGEXES:
        if rx.search(line):
            yield desc, conf


def line_has_dangerous_pattern(line: str) -> bool:
    return any(True for _ in iter_dangerous_hits(line))


def run_dangerous_tools_rule(files: list[ScannedFile]) -> list[Finding]:
    findings: list[Finding] = []
    for sf in files:
        for i, line in enumerate(sf.lines, start=1):
            for desc, conf in iter_dangerous_hits(line):
                sev = "high" if conf >= 0.85 else "medium" if conf >= 0.7 else "low"
                findings.append(
                    Finding(
                        id=str(uuid.uuid4()),
                        rule_id="dangerous-tools",
                        severity=sev,  # type: ignore[arg-type]
                        category="Dangerous tool / side effect",
                        title=f"Potentially dangerous pattern: {desc}",
                        file=sf.rel_path,
                        line=i,
                        agent="unknown",
                        reason=f"The line matches a heuristic for risky agent/tool behavior: {desc}.",
                        suggestedFix="Constrain the tool, add human approval, narrow permissions, and validate inputs.",
                        evidence=desc,
                        code=line.strip()[:500],
                        confidence=round(conf, 2),
                    )
                )
    return findings
