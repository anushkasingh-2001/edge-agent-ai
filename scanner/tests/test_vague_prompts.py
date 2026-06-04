"""Tests for the ``vague-prompts`` hybrid check.

Two layers:
  * Full-scan tests (``run_scan``) exercise vague-phrase detection, the
    missing-contract-part scoring bands, prompt/config-file scanning, and the
    noise guards — end to end through the real pipeline.
  * Unit tests call ``analyze_vague_prompts`` directly with a hand-built IR to
    pin the critical-escalation logic (vague + risky surface + no
    approval/tool/output policy) without depending on sink-extractor wiring.

The deterministic analyzer is the only thing that can CREATE a vague-prompts
finding; the scan-time LLM verifier (lib/scan-intelligence) only ever
upgrades/downgrades or marks them likely_false_positive, so these tests fully
cover what becomes a finding.
"""

from __future__ import annotations

from pathlib import Path

from edge_agent_scanner.analyzers.vague_prompts import analyze_vague_prompts
from edge_agent_scanner.engine import run_scan
from edge_agent_scanner.ir.models import AgentIR, CodeLocation, PromptNode, SinkNode, ToolNode
from edge_agent_scanner.report import Finding, ScanReport


def _vague(report: ScanReport) -> list[Finding]:
    return [f for f in report.findings if f.rule_id == "vague-prompts"]


# ---------------------------------------------------------------------------
# Full-scan: phrase detection + scoring bands
# ---------------------------------------------------------------------------

def test_vague_phrase_missing_everything_is_high(tmp_path: Path) -> None:
    (tmp_path / "agent.py").write_text(
        'SYSTEM_PROMPT = "Handle this and do the needful."\n',
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    vague = _vague(report)
    assert vague, "a vague prompt missing all contract parts should be flagged"
    f = vague[0]
    assert f.severity == "high", f"all 8 parts missing => high, got {f.severity}"
    assert f.category == "Vague prompt"
    # Deterministic evidence must name the matched phrase + missing parts.
    assert "handle this" in f.evidence.lower()
    assert "missing=" in f.evidence


def test_medium_band_is_borderline_confidence(tmp_path: Path) -> None:
    """5–7 missing parts => medium, and confidence is set < 0.6 so the
    scan-time verifier treats it as a borderline case to review."""
    (tmp_path / "agent.py").write_text(
        'SYSTEM_PROMPT = "You are a support agent. Your task is to help the user. '
        'Use your judgment."\n',
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    vague = _vague(report)
    assert vague, "expected a medium vague-prompt finding"
    f = vague[0]
    assert f.severity == "medium", f"expected medium, got {f.severity}"
    assert f.confidence < 0.6, (
        "medium findings must sit below the 0.6 weak-confidence line so the "
        f"verifier reviews them as borderline (got {f.confidence})"
    )


def test_low_band_when_most_parts_present(tmp_path: Path) -> None:
    """3–4 missing parts => low, and confidence stays >= 0.6 so Balanced mode
    skips it (clear, low-risk) for cost control."""
    (tmp_path / "agent.py").write_text(
        'SYSTEM_PROMPT = "You are a billing assistant. Your task is to issue '
        'refunds within limits as appropriate. Return JSON only. Ask the user if '
        'unclear. Do not guess."\n',
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    vague = _vague(report)
    assert vague, "expected a low vague-prompt finding (vague phrase present)"
    f = vague[0]
    assert f.severity == "low", f"expected low, got {f.severity}"
    assert f.confidence >= 0.6


def test_well_specified_prompt_is_not_flagged(tmp_path: Path) -> None:
    """No vague phrase => no vague-prompts finding, even if terse. The check
    is defined by vague phrasing, which keeps it distinct from prompt-contract
    and guarantees every finding has a concrete matched phrase."""
    (tmp_path / "agent.py").write_text(
        'SYSTEM_PROMPT = "You are a support agent. Your task is to answer '
        'questions. Return JSON. Do not call tools. Ask the user when unclear."\n',
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    assert _vague(report) == [], "a prompt with no vague phrase must not fire"


# ---------------------------------------------------------------------------
# Full-scan: prompt/config FILE scanning + noise guards
# ---------------------------------------------------------------------------

def test_markdown_prompt_file_is_flagged(tmp_path: Path) -> None:
    prompts = tmp_path / "prompts"
    prompts.mkdir()
    (prompts / "system_prompt.md").write_text(
        "You are an assistant.\nHandle this and do the needful for the user.\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    vague = _vague(report)
    assert any(f.file.endswith("system_prompt.md") for f in vague), (
        "a prompt-like .md file with a vague phrase should be flagged"
    )


def test_ordinary_docs_are_not_flagged(tmp_path: Path) -> None:
    """A docs file that merely contains 'handle this' in prose — no prompt
    filename, no instruction cue — must NOT be flagged (noise guard)."""
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "notes.md").write_text(
        "Here is how we handle this migration step by step.\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    assert _vague(report) == [], "ordinary prose must not trip the file scan"


# ---------------------------------------------------------------------------
# Full-scan: rule is enabled / selectable end to end
# ---------------------------------------------------------------------------

def test_vague_prompts_respects_rule_filter(tmp_path: Path) -> None:
    (tmp_path / "agent.py").write_text(
        'SYSTEM_PROMPT = "Handle this and do the needful."\n',
        encoding="utf-8",
    )
    # Only the vague-prompts rule enabled => still produced.
    report = run_scan(tmp_path, enabled_rule_ids=frozenset({"vague-prompts"}))
    assert _vague(report), "vague-prompts must run when explicitly selected"
    assert all(f.rule_id == "vague-prompts" for f in report.findings)


# ---------------------------------------------------------------------------
# Unit: critical escalation logic
# ---------------------------------------------------------------------------

def _prompt(text: str, file: str = "agent.py", line: int = 2) -> PromptNode:
    return PromptNode(
        id="p1",
        name="SYSTEM_PROMPT",
        text_preview=text,
        location=CodeLocation(file=file, start_line=line, end_line=line),
    )


def test_critical_when_vague_action_prompt_meets_dangerous_sink() -> None:
    """vague + a high-impact sink in the SAME file + no approval/tool/output
    policy => critical."""
    ir = AgentIR(
        prompts=[_prompt("Handle this. Take action and do the needful.")],
        sinks=[
            SinkNode(
                id="s1",
                kind="command_exec",
                label="os.system",
                location=CodeLocation(file="agent.py", start_line=10, end_line=10),
                impact="critical",
            )
        ],
    )
    findings = analyze_vague_prompts(ir, [])
    assert findings, "expected a vague-prompt finding"
    assert findings[0].severity == "critical", findings[0].severity


def test_critical_when_agent_callable_tool_has_side_effects() -> None:
    """An agent-callable tool with side effects anywhere in the repo also
    counts as a risky surface for escalation."""
    ir = AgentIR(
        prompts=[_prompt("Handle this. Take action and do the needful.")],
        tools=[
            ToolNode(
                id="t1",
                name="send_email",
                location=CodeLocation(file="tools.py", start_line=5, end_line=5),
                callable_from_agent=True,
                side_effects=["network.send"],
            )
        ],
    )
    findings = analyze_vague_prompts(ir, [])
    assert findings and findings[0].severity == "critical"


def test_no_escalation_without_risky_surface() -> None:
    """Same vague action prompt but no risky tool/sink => stays high (8 parts
    missing), NOT critical."""
    ir = AgentIR(prompts=[_prompt("Handle this. Take action and do the needful.")])
    findings = analyze_vague_prompts(ir, [])
    assert findings and findings[0].severity == "high"
