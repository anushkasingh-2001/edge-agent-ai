"""End-to-end scan on bundled fixture repo."""

from __future__ import annotations

from pathlib import Path

from edge_agent_scanner.engine import run_scan

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "minimal_langchain"


def test_minimal_langchain_fixture_detects_frameworks() -> None:
    report = run_scan(FIXTURE)
    names = {f.name for f in report.frameworks_detected}
    assert "LangChain" in names
    assert "LangGraph" in names


def test_check_filter_limits_rule_ids() -> None:
    full = run_scan(FIXTURE)
    secrets_only = run_scan(FIXTURE, enabled_rule_ids=frozenset({"secrets"}))
    assert full.summary.total >= secrets_only.summary.total
    assert all(f.rule_id == "secrets" for f in secrets_only.findings)
