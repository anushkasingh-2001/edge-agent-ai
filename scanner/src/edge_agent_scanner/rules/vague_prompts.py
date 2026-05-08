"""Detect weak or underspecified prompts."""

from __future__ import annotations

import re
import uuid

from edge_agent_scanner.report import Finding
from edge_agent_scanner.walker import ScannedFile

_WEAK_PHRASES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"you are a helpful assistant", re.I), "Generic 'helpful assistant' role"),
    (re.compile(r"do your best", re.I), "Vague 'do your best' instruction"),
    (re.compile(r"if possible", re.I), "Non-committal 'if possible' wording"),
    (re.compile(r"use your judgment", re.I), "Under-specified 'use your judgment'"),
]

_FORMAT_HINTS = re.compile(
    r"\b(json|yaml|xml|markdown|schema|format|structure|bullet|numbered\s+list)\b",
    re.I,
)
_TOOL_HINTS = re.compile(r"\btool|function\s*call|must\s+not\s+call|allowed\s+tools\b", re.I)
_APPROVAL_HINTS = re.compile(
    r"\bapproval|human|confirm|permission|gate|interrupt\b",
    re.I,
)


def _is_prompt_like_file(rel_path: str) -> bool:
    low = rel_path.lower()
    if any(low.endswith(ext) for ext in (".md", ".txt")):
        return True
    if "prompt" in low:
        return True
    return False


def run_vague_prompts_rule(files: list[ScannedFile]) -> list[Finding]:
    findings: list[Finding] = []
    for sf in files:
        code_like = sf.rel_path.endswith((".py", ".ts", ".tsx", ".js", ".jsx"))
        if not _is_prompt_like_file(sf.rel_path) and not code_like:
            continue

        blob = "\n".join(sf.lines)
        if len(blob.strip()) < 20:
            continue

        for i, line in enumerate(sf.lines, start=1):
            for rx, desc in _WEAK_PHRASES:
                if rx.search(line):
                    findings.append(
                        Finding(
                            id=str(uuid.uuid4()),
                            rule_id="vague-prompts",
                            severity="medium",
                            category="Weak prompt",
                            title=f"Low-specificity prompt phrase: {desc}",
                            file=sf.rel_path,
                            line=i,
                            agent="unknown",
                            reason=desc,
                            suggestedFix=(
                                "Add explicit goals, output format, tool boundaries, and safety/approval rules."
                            ),
                            evidence=desc,
                            code=line.strip()[:500],
                            confidence=0.62,
                        )
                    )

        # Whole-file heuristics only for dedicated prompt / text files (avoid noisy .py scans)
        if _is_prompt_like_file(sf.rel_path) and not sf.rel_path.endswith((".py", ".ts", ".tsx", ".js", ".jsx")):
            if len(blob) > 80 and not _FORMAT_HINTS.search(blob):
                findings.append(
                    Finding(
                        id=str(uuid.uuid4()),
                        rule_id="vague-prompts",
                        severity="low",
                        category="Weak prompt",
                        title="Prompt text lacks explicit output format / structure cues",
                        file=sf.rel_path,
                        line=1,
                        agent="unknown",
                        reason="No clear format keywords (e.g. JSON, schema, structure) detected in file.",
                        suggestedFix="Specify required output format, fields, and validation rules.",
                        evidence="missing_output_format_heuristic",
                        code=sf.lines[0][:300] if sf.lines else "",
                        confidence=0.5,
                    )
                )
            if len(blob) > 120 and not _TOOL_HINTS.search(blob):
                findings.append(
                    Finding(
                        id=str(uuid.uuid4()),
                        rule_id="vague-prompts",
                        severity="low",
                        category="Weak prompt",
                        title="Prompt lacks explicit tool-use constraints",
                        file=sf.rel_path,
                        line=1,
                        agent="unknown",
                        reason="No tool allow/deny language detected for agent prompts.",
                        suggestedFix="Document allowed tools, forbidden actions, and escalation paths.",
                        evidence="missing_tool_constraints_heuristic",
                        code=sf.lines[0][:300] if sf.lines else "",
                        confidence=0.48,
                    )
                )
            if len(blob) > 120 and not _APPROVAL_HINTS.search(blob):
                findings.append(
                    Finding(
                        id=str(uuid.uuid4()),
                        rule_id="vague-prompts",
                        severity="low",
                        category="Weak prompt",
                        title="Prompt lacks approval / human-in-the-loop guidance for dangerous actions",
                        file=sf.rel_path,
                        line=1,
                        agent="unknown",
                        reason="No approval or confirmation language found in prompt file.",
                        suggestedFix="Add when to ask for human approval before high-risk tool use.",
                        evidence="missing_approval_rule_heuristic",
                        code=sf.lines[0][:300] if sf.lines else "",
                        confidence=0.45,
                    )
                )

    return findings
