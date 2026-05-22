"""Regression tests for ``_attribute_findings_to_agents``.

The Findings table renders ``Finding.agent`` as a column. When an
analyzer leaves it as ``"unknown"`` (most file-level analyzers do —
accuracy_regression, secrets, openapi_quality, etc.) the column shows
``"—"`` for every row in that filter, which made the Low filter look
like every finding was orphaned.

This post-processor fills in the agent name from the IR when the IR
contains an Agent declared in the same file. These tests cover:

  * single agent in the file → all findings in that file attributed
  * multiple agents in the file → enclosing-by-line wins
  * finding above every agent declaration in the file → closest agent
  * no agent in the file → leave as ``"unknown"`` (the UI renders "—")
  * findings that already have a real agent name are not overwritten
  * cross-file leakage is forbidden (no guessing across files)
"""

from __future__ import annotations

from edge_agent_scanner.engine import _attribute_findings_to_agents
from edge_agent_scanner.ir.models import AgentIR, AgentNode, CodeLocation
from edge_agent_scanner.report import Finding, Location


def _finding(file: str, line: int, *, agent: str = "unknown") -> Finding:
    return Finding(
        id=f"f-{file}-{line}",
        rule_id="accuracy-regression-risk",  # type: ignore[arg-type]
        severity="low",  # type: ignore[arg-type]
        category="Accuracy / quality risk",
        title="t",
        file=file,
        line=line,
        agent=agent,
        reason="r",
        suggestedFix="fix",
        evidence="e",
        code="c",
        confidence=0.5,
        primary_location=Location(file=file, start_line=line, end_line=line, symbol=None),
    )


def _agent(name: str, file: str, line: int) -> AgentNode:
    return AgentNode(
        id=f"agent::{file}::{line}::{name}",
        name=name,
        framework=None,
        location=CodeLocation(file=file, start_line=line, end_line=line + 5, symbol=name),
    )


def _ir(*agents: AgentNode) -> AgentIR:
    ir = AgentIR()
    for a in agents:
        ir.agents.append(a)
    return ir


def test_single_agent_in_file_attributes_all_findings() -> None:
    ir = _ir(_agent("RouterAgent", "agent.py", 10))
    findings = [_finding("agent.py", 50), _finding("agent.py", 200)]
    out = _attribute_findings_to_agents(findings, ir)
    assert all(f.agent == "RouterAgent" for f in out)


def test_multiple_agents_picks_enclosing_by_start_line() -> None:
    ir = _ir(
        _agent("AgentA", "agent.py", 10),
        _agent("AgentB", "agent.py", 100),
        _agent("AgentC", "agent.py", 500),
    )
    findings = [
        _finding("agent.py", 25),   # after AgentA only → AgentA
        _finding("agent.py", 150),  # after AgentA and AgentB → AgentB (closest enclosing)
        _finding("agent.py", 600),  # after all → AgentC
    ]
    out = _attribute_findings_to_agents(findings, ir)
    names = [f.agent for f in out]
    assert names == ["AgentA", "AgentB", "AgentC"]


def test_finding_above_every_agent_uses_closest_by_distance() -> None:
    ir = _ir(_agent("LateAgent", "agent.py", 200))
    f = _finding("agent.py", 5)
    out = _attribute_findings_to_agents([f], ir)
    # There's no agent at or before line 5, but only one agent exists in
    # the file so the "single agent" branch wins and attributes it.
    assert out[0].agent == "LateAgent"


def test_above_all_agents_with_multiple_agents_picks_closest() -> None:
    ir = _ir(
        _agent("NearAgent", "agent.py", 50),
        _agent("FarAgent", "agent.py", 800),
    )
    f = _finding("agent.py", 5)
    out = _attribute_findings_to_agents([f], ir)
    assert out[0].agent == "NearAgent"


def test_no_agent_in_same_file_leaves_unknown() -> None:
    ir = _ir(_agent("OtherAgent", "other.py", 10))
    f = _finding("agent.py", 50)
    out = _attribute_findings_to_agents([f], ir)
    # Cross-file leakage is explicitly forbidden — the UI gets "unknown"
    # back so it can render the em-dash sentinel.
    assert out[0].agent == "unknown"


def test_already_attributed_finding_is_not_overwritten() -> None:
    ir = _ir(
        _agent("RealAgent", "agent.py", 10),
        _agent("OtherAgent", "agent.py", 100),
    )
    f = _finding("agent.py", 200, agent="ExplicitlySetAgent")
    out = _attribute_findings_to_agents([f], ir)
    assert out[0].agent == "ExplicitlySetAgent"


def test_empty_ir_is_a_noop() -> None:
    ir = _ir()  # no agents at all
    findings = [_finding("agent.py", 1)]
    out = _attribute_findings_to_agents(findings, ir)
    assert out[0].agent == "unknown"
