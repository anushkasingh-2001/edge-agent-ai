"""Regression tests for sink-classifier false positives + project risk score.

These guard the fixes for the three FPs observed on real TS/React repos:

1. ``export type { ApiResponseDataSchema };`` got tagged browser/data-export.
2. ``export default App;`` got tagged data-export.
3. React component names like ``<MessageList />`` got tagged as outbound
   CRM / message sinks because the verb_target classifier saw "message"
   tokens with no call shape.

Plus a check that the new ``_compute_risk_score`` cannot reach 100 when
the report contains zero critical and zero high findings — under the old
flat weights, a long tail of presence warnings + accuracy signals would
push the score into "critical risk" territory and mislead users.
"""

from __future__ import annotations

from edge_agent_scanner.engine import _compute_risk_score, run_scan
from edge_agent_scanner.ir.sinks import classify_side_effect
from edge_agent_scanner.report import Finding, Location


def _make_finding(severity: str, *, category: str = "Dangerous tool / side effect", rule_id: str = "dangerous-tools") -> Finding:
    """Minimal Finding factory for risk-score tests. Stays in sync with
    `Finding` required fields — id / file / line / agent / reason / etc."""
    return Finding(
        id=f"fid-{severity}-{category}",
        rule_id=rule_id,  # type: ignore[arg-type]
        severity=severity,  # type: ignore[arg-type]
        category=category,
        title=f"test {severity}",
        file="x.py",
        line=1,
        agent="unknown",
        reason="r",
        suggestedFix="fix",
        evidence="e",
        code="c",
        confidence=0.5,
        primary_location=Location(file="x.py", start_line=1, end_line=1, symbol=None),
    )


# ---------------------------------------------------------------------------
# Classifier-level (cheap, no IO)
# ---------------------------------------------------------------------------

def test_classify_export_type_returns_no_effects() -> None:
    assert classify_side_effect("export type { ApiResponseDataSchema };") == []


def test_classify_export_default_identifier_returns_no_effects() -> None:
    assert classify_side_effect("export default App;") == []


def test_classify_export_braced_reexport_returns_no_effects() -> None:
    assert classify_side_effect('export { Foo, Bar } from "./mod";') == []


def test_classify_import_statement_returns_no_effects() -> None:
    assert classify_side_effect('import type { Foo } from "./types";') == []
    assert classify_side_effect('import { Foo } from "./mod";') == []


def test_classify_type_alias_returns_no_effects() -> None:
    assert classify_side_effect("type Foo = { id: string };") == []


def test_classify_jsx_element_usage_returns_no_effects() -> None:
    # Bare JSX usage with no call paren must not classify as a side effect.
    assert classify_side_effect("<MessageList />") == []
    assert classify_side_effect('<MessageInput placeholder="…" />') == []


def test_classify_bare_component_identifier_returns_no_effects() -> None:
    # React component names alone are nouns, not calls.
    assert classify_side_effect("MessageList") == []
    assert classify_side_effect("Message") == []


def test_classify_genuine_send_call_still_matches() -> None:
    # Sanity check: the fix should NOT silence real send/email calls.
    effects = classify_side_effect("await sendEmail(payload)")
    assert "external_communication" in effects


def test_classify_subprocess_still_matches() -> None:
    effects = classify_side_effect("subprocess.check_output(cmd)")
    assert "code_execution" in effects


def test_classify_audio_export_still_matches() -> None:
    # `audio.export(...)` has a paren → runs verb_target with "export"+"data"?
    # No — but the regex `\b(export|...)[_\s-]*(data|...)?\b` matches.
    effects = classify_side_effect("audio.export(out_path)")
    assert "data_export_or_sharing" in effects


# ---------------------------------------------------------------------------
# End-to-end scan: no findings for declaration-only TS files
# ---------------------------------------------------------------------------

def _ts_findings(tmp_path, filename: str, body: str):
    (tmp_path / filename).write_text(body, encoding="utf-8")
    report = run_scan(tmp_path)
    return [f for f in report.findings if f.rule_id == "dangerous-tools"]


def test_export_type_declaration_produces_no_dangerous_finding(tmp_path) -> None:
    findings = _ts_findings(
        tmp_path,
        "types.ts",
        "export type { ApiResponseDataSchema };\n",
    )
    assert findings == []


def test_export_default_app_produces_no_dangerous_finding(tmp_path) -> None:
    findings = _ts_findings(
        tmp_path,
        "App.tsx",
        "function App() { return null }\nexport default App;\n",
    )
    assert findings == []


def test_react_message_component_produces_no_crm_or_outbound_finding(tmp_path) -> None:
    body = (
        'import React from "react";\n'
        "export function Chat() {\n"
        '  return (\n'
        '    <MessageList />\n'
        '  );\n'
        "}\n"
    )
    (tmp_path / "Chat.tsx").write_text(body, encoding="utf-8")
    report = run_scan(tmp_path)
    bad = [
        f for f in report.findings
        if f.rule_id == "dangerous-tools"
        and any(s in f.evidence.lower() for s in ("external_communication", "crm_or_campaign_write"))
    ]
    assert bad == [], f"React component should not be classified as outbound message/CRM, got: {bad}"


def test_subprocess_still_emits_presence_warning(tmp_path) -> None:
    """Real dangerous code without an agent path stays a medium presence warning."""
    (tmp_path / "tools.py").write_text(
        "import subprocess\nsubprocess.check_output(['ls'])\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    findings = [f for f in report.findings if f.rule_id == "dangerous-tools"]
    assert findings, "subprocess.check_output must still produce a finding"
    assert all(f.severity in {"low", "medium"} for f in findings)
    assert all("presence warning" in f.category.lower() for f in findings)


def test_agent_reachable_dangerous_tool_stays_high_or_critical(tmp_path) -> None:
    """An agent-callable tool with high-impact side effects must still
    fire at high/critical severity — the FP fixes must not silence the
    primary signal."""
    body = (
        "import subprocess\n"
        "\n"
        "class PaymentAgent:\n"
        '    """Agent that handles payment operations."""\n'
        "\n"
        "@tool\n"
        "def refund_payment(amount: float) -> None:\n"
        "    subprocess.run(['curl', 'pay'])\n"
    )
    (tmp_path / "pay.py").write_text(body, encoding="utf-8")
    report = run_scan(tmp_path)
    confirmed = [
        f for f in report.findings
        if f.rule_id == "dangerous-tools" and f.category == "Dangerous tool / side effect"
    ]
    assert confirmed, "agent-callable dangerous tool should still fire"
    assert all(f.severity in {"high", "critical"} for f in confirmed)


# ---------------------------------------------------------------------------
# Risk-score behaviour
# ---------------------------------------------------------------------------

def test_risk_score_zero_when_no_findings() -> None:
    assert _compute_risk_score([]) == 0


def test_risk_score_capped_below_critical_when_no_high_or_critical() -> None:
    """Even a flood of presence warnings + accuracy signals must not push
    the project into the "critical risk" band (>=70)."""
    findings = [
        _make_finding("medium", category="Presence warning (agent unknown)") for _ in range(20)
    ] + [
        _make_finding("low", category="Presence warning (agent unknown)") for _ in range(20)
    ] + [
        _make_finding("low", category="Accuracy / quality risk", rule_id="accuracy-regression-risk")
        for _ in range(20)
    ]
    score = _compute_risk_score(findings)
    assert score < 70, f"presence-only / accuracy-only repo should not be critical, got {score}"
    assert score <= 39, f"hard cap when no critical/high should be <=39, got {score}"


def test_risk_score_dominated_by_critical_findings() -> None:
    score = _compute_risk_score([_make_finding("critical")])
    assert score >= 35, "a single critical should put the project at high risk"


def test_risk_score_long_tail_of_lows_cannot_saturate() -> None:
    findings = [_make_finding("low") for _ in range(200)]
    score = _compute_risk_score(findings)
    assert score <= 39
    assert score <= 10 + 0  # low bucket cap


def test_risk_score_high_findings_count_meaningfully() -> None:
    score = _compute_risk_score([_make_finding("high"), _make_finding("high")])
    # Two highs alone should be a meaningful but not maximum score.
    assert 30 <= score <= 60


def test_risk_score_accuracy_only_is_advisory() -> None:
    findings = [
        _make_finding("low", category="Accuracy / quality risk", rule_id="accuracy-regression-risk")
        for _ in range(10)
    ]
    score = _compute_risk_score(findings)
    # Accuracy-quality findings should not contribute to the security score.
    assert score == 0
