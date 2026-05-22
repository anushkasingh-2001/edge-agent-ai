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
    """Project risk score in [0, 100].

    Design:
      * Critical and high agent-reachable findings dominate the score. A
        single critical finding pushes the project into the "high risk"
        band; two criticals saturate.
      * Medium and low findings contribute lightly and are individually
        capped so a long tail of advisory findings can't push the project
        to 100. A repo with 30 lows used to score 90+ under the old flat
        weights; that misled users into thinking presence warnings were
        as urgent as confirmed exploits.
      * "Soft" findings — presence warnings (no agent path) and accuracy/
        quality signals — contribute at half weight. Accuracy-regression
        findings are not security bugs and were responsible for inflating
        the score on otherwise-clean projects.
      * Hard cap: if there are 0 critical and 0 high findings, the score
        cannot exceed 39. That keeps the project below the typical
        "critical risk" threshold (>=70) when only presence warnings
        and quality signals exist.
    """

    def _is_soft(f: Finding) -> bool:
        cat = (f.category or "").lower()
        return (
            "presence warning" in cat
            or cat == "dangerous code present"
            or cat == "accuracy / quality risk"
            or cat == "accuracy risk"
            or f.rule_id == "accuracy-regression-risk"
        )

    crit_n = sum(1 for f in findings if f.severity == "critical")
    high_n = sum(1 for f in findings if f.severity == "high")
    soft_med = sum(1 for f in findings if f.severity == "medium" and _is_soft(f))
    hard_med = sum(1 for f in findings if f.severity == "medium" and not _is_soft(f))
    soft_low = sum(1 for f in findings if f.severity == "low" and _is_soft(f))
    hard_low = sum(1 for f in findings if f.severity == "low" and not _is_soft(f))

    # Per-bucket point caps prevent any single severity from saturating
    # the score on its own.
    crit_pts = min(100, crit_n * 35)
    high_pts = min(60, high_n * 18)
    med_pts = min(20, hard_med * 4 + soft_med * 2)
    low_pts = min(10, hard_low * 1 + soft_low * 0)  # soft_low (e.g. accuracy) → 0

    score = crit_pts + high_pts + med_pts + low_pts

    # Hard cap when no confirmed high-impact agent-reachable findings exist:
    # presence-only and quality signals must not push the project into the
    # "critical risk" band (UIs commonly treat >=70 as critical).
    if crit_n == 0 and high_n == 0:
        score = min(score, 39)

    return max(0, min(100, score))


def _framework_hits(ir, files: list) -> list[FrameworkHit]:
    """Combine framework names found by the IR extractors with the
    manifest/import-based detector from ``rules.frameworks``.

    The IR-based extractors only emit a framework name when they
    successfully attach one to an agent or tool node — they ignore
    repos that *depend on* a framework but do not yet wire it into
    a recognisable agent/tool class. The legacy
    ``rules.frameworks.detect_frameworks`` helper covers exactly that
    gap (requirements.txt / pyproject.toml / package.json / imports),
    so the union of the two sources is what surfaces to the report.

    Wrapped in a try/except so a regression in either source does not
    take down ``run_scan``.
    """
    ir_names = sorted({x.framework for x in [*ir.agents, *ir.tools] if x.framework})
    ir_hits: dict[str, FrameworkHit] = {n: FrameworkHit(name=n, evidence=[]) for n in ir_names}

    try:
        from edge_agent_scanner.rules.frameworks import detect_frameworks  # local import: legacy helper
    except Exception:
        detect_frameworks = None  # type: ignore[assignment]

    if detect_frameworks is not None:
        try:
            for hit in detect_frameworks(files):
                existing = ir_hits.get(hit.name)
                if existing is None:
                    ir_hits[hit.name] = hit
                else:
                    # Merge evidence lists, preserving order/uniqueness.
                    merged = list(dict.fromkeys([*existing.evidence, *hit.evidence]))
                    ir_hits[hit.name] = FrameworkHit(name=hit.name, evidence=merged)
        except Exception:
            # Detector should never crash the scan — skip on error.
            pass

    return [ir_hits[k] for k in sorted(ir_hits.keys())]


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


def _attribute_findings_to_agents(findings: list[Finding], ir) -> list[Finding]:
    """Fill in ``Finding.agent`` for findings that the analyzer left as
    ``"unknown"``.

    Most analyzers operate file-by-line (e.g. accuracy_regression,
    secrets, openapi_quality) and have no way to know which Agent in
    the IR "owns" the line they flagged. That made the Findings table
    show a column full of em-dashes for every Low / Medium severity
    coming out of those analyzers, even when the file clearly belonged
    to a specific agent.

    Heuristic, in order of preference:
      1. If exactly one agent is declared in the same file, attribute
         to it.
      2. If multiple agents are declared in the same file, pick the
         closest one whose declaration starts at or before the
         finding's line (the enclosing one). If none qualifies, fall
         back to the closest by absolute line distance.
      3. Otherwise leave ``"unknown"`` so the UI can render a sentinel
         (em-dash). We intentionally do NOT guess across files — a
         finding in ``utils/helpers.py`` shouldn't be blamed on an
         agent declared in ``agents/router.py``.

    Pure helper; no IO. Safe to run before dedupe so we don't drop a
    "better-attributed" duplicate.
    """
    if not ir.agents:
        return findings
    by_file: dict[str, list] = {}
    for a in ir.agents:
        by_file.setdefault(a.location.file, []).append(a)

    for f in findings:
        if f.agent and f.agent != "unknown":
            continue
        candidates = by_file.get(f.file)
        if not candidates:
            continue
        if len(candidates) == 1:
            f.agent = candidates[0].name
            continue
        enclosing = [a for a in candidates if a.location.start_line <= f.line]
        if enclosing:
            best = max(enclosing, key=lambda a: a.location.start_line)
        else:
            best = min(candidates, key=lambda a: abs(a.location.start_line - f.line))
        f.agent = best.name
    return findings


def run_scan(
    repo_path: Path,
    enabled_rule_ids: frozenset[str] | None = None,
    exclude_rel_paths: frozenset[str] | None = None,
) -> ScanReport:
    root = repo_path.resolve()
    files = iter_scanned_files(root, exclude_rel_paths=exclude_rel_paths)
    ir = build_agent_ir(files, repo_root=root)

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
    findings = _attribute_findings_to_agents(findings, ir)
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
        frameworks_detected=_framework_hits(ir, files),
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
