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
    """
    Keep at most `max_per_rule` findings per rule_id. The selection has to
    be **deterministic and content-stable** — otherwise a tree change in
    one branch reshuffles the cap survivors and the branch-compare endpoint
    sees identical findings as "fixed in base / introduced in target",
    producing fake churn (the "150 → 150 with 147 fixed · 147 introduced"
    artefact). Sort by (severity rank, file, line, title) before capping so
    the kept set is purely a function of the report's content, not walk
    order.
    """
    limit = max_per_rule if max_per_rule is not None else scanner_config.MAX_FINDINGS_PER_RULE
    severity_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    ordered = sorted(
        findings,
        key=lambda f: (
            f.rule_id,
            severity_rank.get(f.severity, 9),
            f.file,
            f.line,
            f.title,
        ),
    )
    counts: dict[str, int] = {}
    out: list[Finding] = []
    for f in ordered:
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
    exclude_rel_paths: frozenset[str] | None = None,
) -> ScanReport:
    """
    `exclude_rel_paths` lets the caller skip specific files entirely. The
    /api/scan route uses this to drop untracked files (`git ls-files
    --others --exclude-standard`) so a scan of `main` doesn't get inflated
    by stray files left behind from a feature branch the user just
    switched away from.
    """
    root = repo_path.resolve()
    files = iter_scanned_files(root, exclude_rel_paths=exclude_rel_paths)

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

    # Per-extension tally of files the walker handed to the rules. This
    # is the proof-of-coverage metric the UI surfaces so the user can
    # tell when "0 issues" means "scanner saw your file, no patterns
    # matched" vs. "scanner skipped your file (wrong extension, too
    # large, etc.)". Built post-hoc to avoid touching the walker.
    by_ext: dict[str, int] = {}
    for sf in files:
        ext = Path(sf.rel_path).suffix.lower() or "(no-ext)"
        by_ext[ext] = by_ext.get(ext, 0) + 1

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
        files_scanned=len(files),
        files_scanned_by_ext=by_ext,
    )
