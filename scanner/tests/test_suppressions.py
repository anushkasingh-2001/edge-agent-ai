"""Suppression-marker behaviour.

Hard rule: ONLY an explicit human-typed `# edge-agent: noqa <rule>`
opt-out suppresses a finding. Anything auto-inserted by the fix
engine (the `=== Edge Agent fix [rule] ===` fence block) is ordinary
code — it does NOT silence the analyzer. This file pins that
contract down so a future refactor can't quietly reintroduce the
"clicking Apply auto-launders vulnerable code" bug.

Companion tests live in `test_no_silent_laundering.py`
(integration-level: TODO marker near vulnerable code never hides
the finding) and `test_real_fixes_clear_findings.py` (positive
side: changing the actual code makes the analyzer stop firing).
"""

from __future__ import annotations

from pathlib import Path

from edge_agent_scanner.engine import run_scan


def _write_prompt_file(
    tmp_path: Path, preface_lines: list[str] | None = None
) -> Path:
    """Create a `.py` file with a prompt string that lacks 3+
    REQUIRED_CONCEPTS — so `analyze_prompt_contract` flags it. The
    optional `preface_lines` sit IMMEDIATELY above the prompt
    assignment, simulating a planted suppression marker."""
    body = preface_lines or []
    fp = tmp_path / "agent.py"
    contents = (
        "SYSTEM = '''Greet the user politely.'''\n"
        "AGENT_NAME = 'demo'\n"
        "\n"
        + "\n".join(body)
        + ("\n" if body else "")
        + "PROMPT = '''Greet the user politely.'''\n"
    )
    fp.write_text(contents, encoding="utf-8")
    return fp


def _prompt_contract_findings(report) -> list:
    return [f for f in report.findings if f.rule_id == "prompt-contract"]


def test_no_marker_finding_is_kept(tmp_path: Path) -> None:
    _write_prompt_file(tmp_path)
    r = run_scan(tmp_path)
    assert len(_prompt_contract_findings(r)) >= 1
    assert r.suppressions.total == 0
    assert r.suppressions.entries == []


def test_noqa_one_liner_suppresses(tmp_path: Path) -> None:
    _write_prompt_file(
        tmp_path,
        preface_lines=["# edge-agent: noqa prompt-contract"],
    )
    r = run_scan(tmp_path)
    assert r.suppressions.total >= 1
    assert any(
        e.marker_kind == "noqa" and e.rule_id == "prompt-contract"
        for e in r.suppressions.entries
    )


def test_noqa_wildcard_suppresses_and_is_tagged(tmp_path: Path) -> None:
    _write_prompt_file(
        tmp_path,
        preface_lines=["# edge-agent: noqa"],
    )
    r = run_scan(tmp_path)
    assert r.suppressions.total >= 1
    assert any(
        e.marker_kind == "noqa_wildcard" for e in r.suppressions.entries
    )


def test_noqa_for_a_different_rule_is_ignored(tmp_path: Path) -> None:
    _write_prompt_file(
        tmp_path,
        preface_lines=["# edge-agent: noqa dangerous-tools"],
    )
    r = run_scan(tmp_path)
    pc = _prompt_contract_findings(r)
    assert any("agent.py" in f.file for f in pc), (
        "noqa for a different rule must NOT suppress prompt-contract"
    )


def test_noqa_separated_by_real_code_does_not_suppress(tmp_path: Path) -> None:
    fp = tmp_path / "agent.py"
    fp.write_text(
        "# edge-agent: noqa prompt-contract\n"
        "x = 1  # ordinary code, breaks the contiguous comment region\n"
        "PROMPT = '''Greet the user politely.'''\n",
        encoding="utf-8",
    )
    r = run_scan(tmp_path)
    assert all(e.file != "agent.py" for e in r.suppressions.entries)
