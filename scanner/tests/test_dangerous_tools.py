"""Dangerous tool / human-approval analyzer behaviour.

The IR-based pipeline distinguishes two situations:

  1. A dangerous CALL site that is NOT reachable from any agent. The
     ``dangerous-tools`` analyzer emits a *low/medium* presence-only
     finding under a presence-warning category (see
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
    assert all("presence warning" in f.category.lower() for f in dangerous), (
        'non-agent fallback uses a presence-warning category (not agent-confirmed)'
    )
    assert any("What was detected:" in f.reason for f in dangerous), (
        "standalone findings should use structured explanations"
    )


def test_finding_code_carries_full_os_system_call_expression(tmp_path):
    """``Finding.code`` should be the verbatim call expression
    (``os.system("rm -rf " + user_input)``) rather than just the
    normalized callee (``os.system``). The standalone-sink title still
    uses the bare label, but the developer-facing code block now
    surfaces exactly what was written.
    """
    (tmp_path / "danger.py").write_text(
        "import os\n"
        "\n"
        "def delete_all_meeting_records(user_input):\n"
        "    os.system(\"rm -rf \" + user_input)\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    dangerous = [
        f for f in report.findings
        if f.rule_id == "dangerous-tools" and "os.system" in f.title
    ]
    assert dangerous, "expected a dangerous-tools finding for the os.system call"
    f = dangerous[0]
    # The title still carries the normalized callee for classification
    # / scoring; this is the value standalone_sink_title() builds.
    assert "os.system" in f.title
    # The code field carries the VERBATIM expression — the whole
    # ``os.system("rm -rf " + user_input)`` slice.
    assert "os.system(" in f.code, f"expected full os.system(...) in Finding.code, got: {f.code!r}"
    assert "rm -rf" in f.code, f"argument literal must survive into Finding.code, got: {f.code!r}"
    assert "user_input" in f.code, (
        "the user-controlled variable name must appear in Finding.code so the "
        f"developer can see the data flow; got: {f.code!r}"
    )
    # Evidence still names the sink label (unchanged behaviour).
    assert "label=" in f.evidence.lower() or "at os.system" in f.evidence


def test_finding_code_carries_full_subprocess_check_output_call(tmp_path):
    """``subprocess.check_output(["ffmpeg", "-i", input_path, out])``
    should round-trip into ``Finding.code`` verbatim, so the AI
    explainer (and the UI) can see that this is an ffmpeg invocation
    rather than a generic OS command.
    """
    (tmp_path / "transcribe.py").write_text(
        "import subprocess\n"
        "\n"
        "def encode(input_path, output_path):\n"
        "    subprocess.check_output([\"ffmpeg\", \"-i\", input_path, output_path])\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    dangerous = [
        f for f in report.findings
        if f.rule_id == "dangerous-tools" and "subprocess.check_output" in f.title
    ]
    assert dangerous, "expected a dangerous-tools finding for subprocess.check_output"
    f = dangerous[0]
    assert "subprocess.check_output(" in f.code
    assert "ffmpeg" in f.code, f"ffmpeg arg must survive into Finding.code, got: {f.code!r}"
    assert "input_path" in f.code
    assert "output_path" in f.code


def test_finding_code_redacts_inline_secrets(tmp_path):
    """If the verbatim call expression happens to contain a credential
    (an OpenAI key, Stripe key, GitHub PAT, …), it must be replaced
    with a placeholder before storage in ``Finding.code``. The raw
    secret never leaves the extractor.
    """
    (tmp_path / "leak.py").write_text(
        "import os\n"
        "\n"
        "def call_with_key():\n"
        "    os.system(\"curl -H 'Authorization: Bearer sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG' https://x\")\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    sink_findings = [
        f for f in report.findings
        if f.rule_id == "dangerous-tools" and "os.system" in f.title
    ]
    assert sink_findings, "expected the os.system call to be flagged"
    f = sink_findings[0]
    assert "sk-proj-AAAAbbbbCCCCddddEEEEffffGGGG" not in f.code, (
        "raw OpenAI project key must not appear in Finding.code"
    )
    assert "REDACTED_OPENAI_KEY" in f.code or "REDACTED" in f.code, (
        f"redacted placeholder should be visible instead, got: {f.code!r}"
    )
    # The normalized sink label is unaffected — analyzers still group
    # by `os.system`.
    assert "os.system" in f.title


def test_sink_node_label_preserved_even_when_call_expression_present(tmp_path):
    """The IR-level normalized label must remain ``os.system`` (or the
    equivalent for other sinks) even after we add ``call_expression``.
    Analyzers / scoring / fingerprinting key off it.
    """
    from edge_agent_scanner.ir.extract_python import extract_python_ir
    from edge_agent_scanner.ir.models import AgentIR
    from edge_agent_scanner.walker import ScannedFile

    src = "import os\n\ndef f():\n    os.system(\"rm -rf /tmp/x\")\n"
    sf = ScannedFile(rel_path="t.py", lines=src.splitlines(), full_path=tmp_path / "t.py")
    ir = AgentIR()
    extract_python_ir(sf, ir)
    os_sinks = [s for s in ir.sinks if s.label == "os.system"]
    assert os_sinks, "normalized label `os.system` should still be present on SinkNode"
    s = os_sinks[0]
    assert s.call_expression is not None
    assert "os.system(" in s.call_expression
    assert "rm -rf" in s.call_expression


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
