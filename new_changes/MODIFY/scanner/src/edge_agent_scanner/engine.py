from __future__ import annotations

from pathlib import Path

from edge_agent_scanner import config as scanner_config
from edge_agent_scanner.analyzers.accuracy_regression import analyze_accuracy_regression
from edge_agent_scanner.analyzers.approval_gates import analyze_missing_approval
from edge_agent_scanner.analyzers.auth_checks import analyze_auth_checks
from edge_agent_scanner.analyzers.dangerous_tools import analyze_dangerous_tools
from edge_agent_scanner.analyzers.dependencies import analyze_dependencies
from edge_agent_scanner.analyzers.mcp_security import analyze_mcp_security
from edge_agent_scanner.analyzers.openapi_quality import analyze_openapi_quality
from edge_agent_scanner.analyzers.prompt_contract import analyze_prompt_contract
from edge_agent_scanner.analyzers.prompt_injection import analyze_prompt_injection
from edge_agent_scanner.analyzers.secrets import analyze_secrets
from edge_agent_scanner.analyzers.taint_user_input import analyze_user_input_to_dangerous_code
from edge_agent_scanner.ir.builder import build_agent_ir
from edge_agent_scanner.report import (
    AgentHit,
    Finding,
    FrameworkHit,
    ModelHit,
    PromptHit,
    ScanReport,
    Summary,
    ToolHit,
    utc_now_iso,
)
from edge_agent_scanner.verifier.llm_verifier import verify_findings_if_enabled
from edge_agent_scanner.walker import iter_scanned_files


def _cap_findings_per_rule(findings: list[Finding], max_per_rule: int | None = None) -> list[Finding]:
    limit = max_per_rule if max_per_rule is not None else scanner_config.MAX_FINDINGS_PER_RULE
    severity_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    ordered = sorted(findings, key=lambda f: (f.rule_id, severity_rank.get(f.severity, 9), f.file, f.line, f.title))
    counts: dict[str, int] = {}
    out: list[Finding] = []
    for f in ordered:
        n = counts.get(f.rule_id, 0)
        if n >= limit:
            continue
        counts[f.rule_id] = n + 1
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
    return min(100, sum(weights.get(f.severity, 0) for f in findings))


def _framework_hits(ir) -> list[FrameworkHit]:
    names = sorted({x.framework for x in [*ir.agents, *ir.tools] if x.framework})
    return [FrameworkHit(name=n, evidence=[]) for n in names]


def _agent_hits(ir) -> list[AgentHit]:
    return [
        AgentHit(
            name=a.name,
            file=a.location.file,
            line=a.location.start_line,
            kind="agent_class",
            framework=a.framework,
        )
        for a in ir.agents
    ]


def _tool_hits(ir) -> list[ToolHit]:
    return [
        ToolHit(
            name=t.name,
            file=t.location.file,
            line=t.location.start_line,
            kind=(t.metadata.get("kind") or "schema"),
            framework=t.framework,
            agent=None,
            side_effects=t.side_effects,
            callable_from_agent=t.callable_from_agent,
        )
        for t in ir.tools
    ]


def _model_hits(ir) -> list[ModelHit]:
    return [
        ModelHit(
            provider=m.provider,
            model=m.model_name or "unknown",
            file=m.location.file,
            line=m.location.start_line,
            purpose=m.purpose,
        )
        for m in ir.models
    ]


def _prompt_hits(ir) -> list[PromptHit]:
    return [
        PromptHit(
            name=p.name,
            file=p.location.file,
            line=p.location.start_line,
            text_preview=p.text_preview,
        )
        for p in ir.prompts
    ]


def run_scan(
    repo_path: Path,
    enabled_rule_ids: frozenset[str] | None = None,
    exclude_rel_paths: frozenset[str] | None = None,
) -> ScanReport:
    root = repo_path.resolve()
    files = iter_scanned_files(root, exclude_rel_paths=exclude_rel_paths)
    ir = build_agent_ir(files)

    findings: list[Finding] = []
    findings.extend(analyze_dangerous_tools(ir, files))
    findings.extend(analyze_missing_approval(ir, files))
    findings.extend(analyze_prompt_injection(ir, files))
    findings.extend(analyze_prompt_contract(ir, files))
    findings.extend(analyze_mcp_security(ir, files))
    findings.extend(analyze_openapi_quality(ir, files))
    findings.extend(analyze_auth_checks(ir, files))
    findings.extend(analyze_secrets(root, files))
    findings.extend(analyze_dependencies(root, files))
    findings.extend(analyze_user_input_to_dangerous_code(ir, files))
    findings.extend(analyze_accuracy_regression(ir, files, root))

    findings = verify_findings_if_enabled(findings, ir, files)
    findings = _dedupe_findings(findings)
    findings = _filter_by_rules(findings, enabled_rule_ids)
    findings = _cap_findings_per_rule(findings)

    by_ext: dict[str, int] = {}
    for sf in files:
        ext = Path(sf.rel_path).suffix.lower() or "(no-ext)"
        by_ext[ext] = by_ext.get(ext, 0) + 1

    return ScanReport(
        scan_root=str(root),
        generated_at=utc_now_iso(),
        frameworks_detected=_framework_hits(ir),
        agents_detected=_agent_hits(ir),
        tools_detected=_tool_hits(ir),
        models_detected=_model_hits(ir),
        prompts_detected=_prompt_hits(ir),
        summary=_compute_summary(findings),
        risk_score=_compute_risk_score(findings),
        findings=findings,
        files_scanned=len(files),
        files_scanned_by_ext=by_ext,
    )
