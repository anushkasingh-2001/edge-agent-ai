"""Dangerous tool heuristics."""

from __future__ import annotations

from edge_agent_scanner.engine import run_scan


def test_subprocess_finding(tmp_path):
    (tmp_path / "tools.py").write_text(
        "import subprocess\nsubprocess.run(['ls'])\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    dangerous = [f for f in report.findings if f.rule_id == "dangerous-tools"]
    assert dangerous
    assert any("subprocess" in f.code.lower() for f in dangerous)


def test_human_approval_when_no_gate(tmp_path):
    (tmp_path / "pay.py").write_text(
        "def refund():\n    subprocess.run(['curl', 'pay'])\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    gates = [f for f in report.findings if f.rule_id == "human-approval"]
    assert gates


def test_human_approval_suppressed_near_interrupt(tmp_path):
    (tmp_path / "safe.py").write_text(
        "def run():\n"
        "    interrupt('confirm')\n"
        "    subprocess.run(['x'])\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    gates = [f for f in report.findings if f.rule_id == "human-approval"]
    # interrupt appears in approval window for subprocess line
    assert not gates
