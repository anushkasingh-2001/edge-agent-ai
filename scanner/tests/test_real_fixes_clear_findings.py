"""Positive companion to `test_no_silent_laundering.py`.

The anti-laundering tests prove that a TODO comment alone never
suppresses a finding. This file proves the inverse: when the
underlying CODE is changed in a way the analyzer recognises, the
finding stops firing. That's the only legitimate way a finding
should disappear.

Without these tests we'd be over-rotated on "scanner must never
suppress" and could ship analyzers that refuse to acknowledge
any fix.
"""

from __future__ import annotations

from pathlib import Path

from edge_agent_scanner.analyzers.approval_gates import analyze_missing_approval
from edge_agent_scanner.engine import run_scan
from edge_agent_scanner.ir.models import (
    AgentIR,
    AgentNode,
    CodeLocation,
    DataFlowEdge,
    ToolNode,
)


def test_real_depends_get_current_user_suppresses_auth_checks(
    tmp_path: Path,
) -> None:
    """The `auth-checks` analyzer skips a route whose handler has
    ``user = Depends(get_current_user)`` in the signature — see
    `ir/extract_python.py::_detect_route_auth_guards`. Verifies that
    the analyzer respects a REAL fix end-to-end through `run_scan`."""
    fp = tmp_path / "api.py"
    fp.write_text(
        "from fastapi import FastAPI, Depends\n"
        "\n"
        "def get_current_user():\n"
        "    return {'id': 'u1'}\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        "@app.post('/transfer')\n"
        "def transfer(amount: float, user = Depends(get_current_user)):\n"
        "    return {'ok': True, 'user': user}\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    auth = [f for f in report.findings if f.rule_id == "auth-checks"]
    assert not auth, (
        "auth-checks must not fire when the handler has a real "
        "Depends(get_current_user) — the analyzer's IR extractor "
        "picks it up via _detect_route_auth_guards. If this test "
        "fails, either the extractor regressed or the analyzer is "
        "ignoring its own auth_guards signal."
    )


def test_real_depends_get_db_does_not_count_as_auth(tmp_path: Path) -> None:
    """Counter-test: a non-auth Depends (e.g. a DB session injection)
    must NOT count as an auth guard, otherwise the analyzer is too
    permissive. Pinned so a careless edit to the keyword list in
    `_detect_route_auth_guards` doesn't silently whitelist plumbing
    dependencies as authentication."""
    fp = tmp_path / "api.py"
    fp.write_text(
        "from fastapi import FastAPI, Depends\n"
        "\n"
        "def get_db():\n"
        "    return object()\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        "@app.post('/transfer')\n"
        "def transfer(amount: float, db = Depends(get_db)):\n"
        "    return {'ok': True}\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    auth = [f for f in report.findings if f.rule_id == "auth-checks"]
    assert auth, (
        "auth-checks SHOULD fire for a route whose only Depends() is a "
        "DB-session injection — that isn't authentication"
    )


def test_real_requires_approval_suppresses_human_approval() -> None:
    """The `human-approval` analyzer treats a tool whose IR has
    ``requires_approval=True`` as already gated and skips it (see
    `analyzers/approval_gates.py::analyze_missing_approval`). This is
    a unit-level test against a hand-built IR so the assertion is
    independent of the Python extractor's evolving decorator-recognition
    rules — what we're proving is that the analyzer respects the
    `requires_approval` flag once it IS set."""
    loc = CodeLocation(file="pay.py", start_line=1, end_line=1)
    agent = AgentNode(id="agent:demo", name="PaymentAgent", framework="custom", location=loc)
    # A high-impact tool the agent can call. WITHOUT approval the
    # analyzer should fire; WITH approval it should not.
    tool_unguarded = ToolNode(
        id="tool:refund_unguarded",
        name="refund_payment",
        location=loc,
        callable_from_agent=True,
        side_effects=["money_movement"],
        requires_approval=False,
        metadata={"side_effect_max_severity": "high"},
    )
    tool_guarded = ToolNode(
        id="tool:refund_guarded",
        name="refund_payment_guarded",
        location=loc,
        callable_from_agent=True,
        side_effects=["money_movement"],
        # The real fix the analyzer recognises — the tool declares
        # it requires approval before being called.
        requires_approval=True,
        metadata={"side_effect_max_severity": "high"},
    )

    # Unguarded case: must produce a human-approval finding.
    ir_no_gate = AgentIR(
        agents=[agent],
        tools=[tool_unguarded],
        edges=[
            DataFlowEdge(
                src=agent.id,
                dst=tool_unguarded.id,
                kind="uses_tool",
                location=loc,
            )
        ],
    )
    no_gate_findings = analyze_missing_approval(ir_no_gate, files=[])
    assert any(f.rule_id == "human-approval" for f in no_gate_findings), (
        "control case failed: unguarded high-impact tool must produce a "
        "human-approval finding"
    )

    # Guarded case: must NOT produce a human-approval finding.
    ir_gated = AgentIR(
        agents=[agent],
        tools=[tool_guarded],
        edges=[
            DataFlowEdge(
                src=agent.id,
                dst=tool_guarded.id,
                kind="uses_tool",
                location=loc,
            )
        ],
    )
    gated_findings = analyze_missing_approval(ir_gated, files=[])
    assert not any(f.rule_id == "human-approval" for f in gated_findings), (
        "real fix failed: a tool that declares requires_approval=True must "
        "NOT trigger human-approval — the analyzer is supposed to honour "
        "the tool's own declaration"
    )
