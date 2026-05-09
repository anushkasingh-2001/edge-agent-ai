"""Orchestrate rules, dedupe findings, compute summary and risk score."""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from edge_agent_scanner import config as scanner_config
from edge_agent_scanner.report import (
    AgentHit,
    ALL_RULE_IDS,
    Finding,
    FrameworkHit,
    ScanReport,
    Summary,
    SCHEMA_VERSION,
    ToolHit,
    utc_now_iso,
)
from edge_agent_scanner.rules import (
    attribute_tools_to_agents,
    detect_agents,
    detect_frameworks,
    detect_tools,
    run_approval_gate_rule,
    run_dangerous_tools_rule,
    run_mcp_openapi_rules,
    run_prompt_injection_rule,
    run_secrets_rule,
    run_vague_prompts_rule,
)
from edge_agent_scanner.walker import iter_scanned_files


def _cap_findings_per_rule(findings: list[Finding], max_per_rule: int | None = None) -> list[Finding]:
    limit = max_per_rule if max_per_rule is not None else scanner_config.MAX_FINDINGS_PER_RULE
    counts: dict[str, int] = {}
    out: list[Finding] = []
    for f in findings:
        rid = f.rule_id
        n = counts.get(rid, 0)
        if n >= limit:
            continue
        counts[rid] = n + 1
        out.append(f)
    return out


def _filter_by_rules(findings: list[Finding], enabled: frozenset[str] | None) -> list[Finding]:
    if enabled is None:
        return findings
    return [f for f in findings if f.rule_id in enabled]


def _dedupe_findings(findings: list[Finding]) -> list[Finding]:
    seen: set[tuple[str, str, int, str]] = set()
    out: list[Finding] = []
    for f in findings:
        key = (f.rule_id, f.file, f.line, f.title)
        if key in seen:
            continue
        seen.add(key)
        out.append(f)
    return out


def _compute_summary(findings: list[Finding]) -> Summary:
    s = Summary()
    for f in findings:
        if f.severity == "critical":
            s.critical += 1
        elif f.severity == "high":
            s.high += 1
        elif f.severity == "medium":
            s.medium += 1
        else:
            s.low += 1
    s.total = len(findings)
    return s


def _compute_risk_score(findings: list[Finding]) -> int:
    weights = {"critical": 25, "high": 15, "medium": 7, "low": 3}
    total = sum(weights.get(f.severity, 0) for f in findings)
    return min(100, total)


def _run_dependency_risks(files: list) -> list[Finding]:
    findings: list[Finding] = []
    for sf in files:
        if not sf.rel_path.lower().endswith("requirements.txt"):
            continue
        for i, line in enumerate(sf.lines, start=1):
            raw = line.strip()
            if not raw or raw.startswith("#") or raw.startswith("-r"):
                continue
            name_part = raw.split("[", 1)[0].split(";", 1)[0].strip()
            if "==" in name_part:
                continue
            if re.match(r"^[a-zA-Z0-9_.-]+\s*(>=|<=|~=|!=|>|<)", name_part):
                continue
            if re.match(r"^[a-zA-Z0-9_.-]+$", name_part):
                findings.append(
                    Finding(
                        id=str(uuid.uuid4()),
                        rule_id="dependency-risks",
                        severity="low",
                        category="Dependencies",
                        title=f"Unpinned dependency: {name_part.split()[0]}",
                        file=sf.rel_path,
                        line=i,
                        agent="unknown",
                        reason="Requirement line has no == pin or compatible-release constraint.",
                        suggestedFix="Pin versions or use lockfiles for reproducible, auditable builds.",
                        evidence=name_part[:120],
                        code=raw[:500],
                        confidence=0.48,
                    )
                )
    return findings


def _run_user_input_dangerous(files: list) -> list[Finding]:
    findings: list[Finding] = []
    for sf in files:
        if not sf.rel_path.endswith((".py", ".ts", ".tsx", ".js", ".jsx")):
            continue
        blob = "\n".join(sf.lines)
        user_src = re.search(
            r"request\.(body|json|form|args)|\.get\([\"'](query|q|input|message)",
            blob,
            re.I,
        )
        dangerous = re.search(r"eval\s*\(|exec\s*\(|subprocess\.|os\.system\s*\(", blob)
        if user_src and dangerous:
            line_no = blob[: dangerous.start()].count("\n") + 1
            findings.append(
                Finding(
                    id=str(uuid.uuid4()),
                    rule_id="user-input-dangerous-code",
                    severity="high",
                    category="Data flow",
                    title="User-influenced input and dangerous execution in same module",
                    file=sf.rel_path,
                    line=line_no,
                    agent="unknown",
                    reason="Heuristic: HTTP/query-style accessors and eval/exec/subprocess coexist.",
                    suggestedFix="Treat input as untrusted; avoid dynamic execution; validate and sandbox.",
                    evidence="user_input_plus_dangerous_exec_heuristic",
                    code=sf.lines[line_no - 1].strip()[:500] if 0 < line_no <= len(sf.lines) else "",
                    confidence=0.58,
                )
            )
    return findings


def run_scan(
    repo_path: Path,
    enabled_rule_ids: frozenset[str] | None = None,
) -> ScanReport:
    root = repo_path.resolve()
    files = iter_scanned_files(root)

    frameworks: list[FrameworkHit] = detect_frameworks(files)
    agents: list[AgentHit] = detect_agents(files)
    tools: list[ToolHit] = detect_tools(files)
    # Pin tools to their owning agent (single-agent: all unattributed go to
    # it; multi-agent: directory-proximity match).
    attribute_tools_to_agents(tools, agents)

    findings: list[Finding] = []
    # Deterministic order — always run all rules; filter by enabled_rule_ids after
    findings.extend(run_dangerous_tools_rule(files))
    findings.extend(run_approval_gate_rule(files))
    findings.extend(run_secrets_rule(files))
    findings.extend(run_prompt_injection_rule(files))
    findings.extend(run_vague_prompts_rule(files))
    findings.extend(run_mcp_openapi_rules(files))
    findings.extend(_run_dependency_risks(files))
    findings.extend(_run_user_input_dangerous(files))

    findings = _dedupe_findings(findings)
    findings = _filter_by_rules(findings, enabled_rule_ids)
    findings = _cap_findings_per_rule(findings)
    summary = _compute_summary(findings)
    risk = _compute_risk_score(findings)

    return ScanReport(
        schema_version=SCHEMA_VERSION,
        scan_root=str(root),
        generated_at=utc_now_iso(),
        frameworks_detected=frameworks,
        agents_detected=agents,
        tools_detected=tools,
        summary=summary,
        risk_score=risk,
        findings=findings,
    )
