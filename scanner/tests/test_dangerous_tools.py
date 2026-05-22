"""Dangerous tool / human-approval analyzer behaviour.

The IR-based pipeline distinguishes two situations:

  1. A dangerous CALL site that is NOT reachable from any agent. The
     ``dangerous-tools`` analyzer emits a *low/medium* presence-only
     finding under category "Dangerous code present" (see
     ``_analyze_standalone_sinks`` in ``analyzers/dangerous_tools.py``).
     This keeps the old "warn when subprocess shows up in a module"
     behaviour without elevating every build script to critical.

  2. A high-impact TOOL that an agent can reach. The
     ``human-approval`` analyzer fires when removing every approval
     guard from the IR still leaves the tool reachable, i.e. the agent
     has an unguarded path to a high-impact capability.

These tests exercise both halves of that split.
"""

from __future__ import annotations

from edge_agent_scanner.engine import run_scan


def test_subprocess_finding(tmp_path):
    """Bare ``subprocess.run`` in a module produces a presence-only
    dangerous-tools finding (medium severity, "Dangerous code present"),
    not a high-severity tool finding."""
    (tmp_path / "tools.py").write_text(
        "import subprocess\nsubprocess.run(['ls'])\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    dangerous = [f for f in report.findings if f.rule_id == "dangerous-tools"]
    assert dangerous, "expected a dangerous-tools finding for a top-level subprocess call"
    assert any("subprocess" in f.code.lower() for f in dangerous), (
        "the matched sink label (subprocess.run) should appear in Finding.code"
    )
    # No agent => no high-severity escalation.
    assert all(f.severity in {"low", "medium"} for f in dangerous), (
        "non-agent-reachable dangerous calls must stay at low/medium severity"
    )
    assert all(f.category == "Dangerous code present" for f in dangerous), (
        'non-agent fallback uses category "Dangerous code present"'
    )


def test_human_approval_when_no_gate(tmp_path):
    """An agent that can reach a high-impact tool with no approval guard
    anywhere on the path produces a ``human-approval`` finding."""
    (tmp_path / "pay.py").write_text(
        "import subprocess\n"
        "\n"
        "class PaymentAgent:\n"
        '    """Agent that handles payment operations."""\n'
        "\n"
        "@tool\n"
        "def refund_payment(amount: float) -> None:\n"
        "    subprocess.run(['curl', 'pay'])\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    gates = [f for f in report.findings if f.rule_id == "human-approval"]
    assert gates, (
        "expected a human-approval finding: PaymentAgent can reach the "
        "high-impact refund_payment tool with no approval guard on the path"
    )


def test_human_approval_skipped_for_read_only_tool(tmp_path):
    """The approval analyzer is selective: a tool whose name suggests a
    read-only operation (no high-impact side effect) must NOT trip
    human-approval. This is the IR-era equivalent of the old
    'suppressed_near_interrupt' assertion — same intent (don't be
    noisy), updated to the new severity model."""
    (tmp_path / "safe.py").write_text(
        "class ReadAgent:\n"
        '    """Read-only agent."""\n'
        "\n"
        "@tool\n"
        "def read_balance(account_id: str) -> float:\n"
        '    """Return the current balance."""\n'
        "    return 0.0\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    gates = [f for f in report.findings if f.rule_id == "human-approval"]
    assert not gates, "read-only tools should not trigger human-approval"
