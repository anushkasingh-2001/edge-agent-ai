"""Report schema validates after scan."""

from __future__ import annotations

from edge_agent_scanner.engine import run_scan
from edge_agent_scanner.report import ScanReport


def test_scan_report_validates_with_pydantic(empty_repo):
    (empty_repo / "module.py").write_text("print('hello')\n", encoding="utf-8")
    report = run_scan(empty_repo)

    data = report.model_dump()
    again = ScanReport.model_validate(data)

    assert again.schema_version
    assert again.scan_root
    assert again.generated_at
    assert isinstance(again.frameworks_detected, list)
    assert again.summary.total == len(again.findings)
    assert 0 <= again.risk_score <= 100
    for f in again.findings:
        assert f.id
        assert f.rule_id
        assert f.severity in ("critical", "high", "medium", "low")
        assert f.confidence >= 0.0
        assert f.confidence <= 1.0


def test_required_top_level_fields_in_json(empty_repo):
    (empty_repo / "x.txt").write_text("hello", encoding="utf-8")
    report = run_scan(empty_repo)
    raw = report.model_dump_json()
    assert "schema_version" in raw
    assert "frameworks_detected" in raw
    assert "risk_score" in raw
