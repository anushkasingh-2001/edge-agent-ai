"""Heuristics for prompt injection and instruction override risks."""

from __future__ import annotations

import re
import uuid

from edge_agent_scanner.report import Finding
from edge_agent_scanner.walker import ScannedFile

_INJECTION_REGEXES: list[tuple[re.Pattern[str], str, float]] = [
    (
        re.compile(r"ignore\s+(previous|prior|all)\s+instructions", re.I),
        "Instruction to ignore prior rules",
        0.78,
    ),
    (
        re.compile(r"reveal\s+(your\s+)?secrets|password|api\s*key", re.I),
        "Prompt asks to reveal secrets",
        0.75,
    ),
    (
        re.compile(r"bypass\s+(policy|safety|guardrails?)", re.I),
        "Bypass safety/policy wording",
        0.8,
    ),
    (
        re.compile(r"override\s+(system|developer)\s+(prompt|message)", re.I),
        "Override system/developer prompt",
        0.77,
    ),
    (
        re.compile(
            r"system_prompt\s*[=+\{]|systemPrompt\s*[=+]|\+\s*user_(input|message)|"
            r"f[\"'].*\{.*(user|input|request)",
            re.I,
        ),
        "User-controlled text may be concatenated into system prompt",
        0.65,
    ),
]


def run_prompt_injection_rule(files: list[ScannedFile]) -> list[Finding]:
    findings: list[Finding] = []
    for sf in files:
        if not sf.rel_path.endswith((".py", ".ts", ".tsx", ".js", ".jsx", ".md", ".txt")):
            continue
        for i, line in enumerate(sf.lines, start=1):
            for rx, desc, conf in _INJECTION_REGEXES:
                if rx.search(line):
                    sev = "high" if conf >= 0.75 else "medium"
                    findings.append(
                        Finding(
                            id=str(uuid.uuid4()),
                            rule_id="prompt-injection",
                            severity=sev,  # type: ignore[arg-type]
                            category="Prompt injection",
                            title=f"Possible prompt injection pattern: {desc}",
                            file=sf.rel_path,
                            line=i,
                            agent="unknown",
                            reason=desc,
                            suggestedFix=(
                                "Isolate untrusted input in user messages, sanitize templates, and enforce "
                                "immutable system instructions."
                            ),
                            evidence=rx.pattern[:120],
                            code=line.strip()[:500],
                            confidence=round(conf, 2),
                        )
                    )
    return findings
