"""Finding cap per rule."""

from __future__ import annotations

from pathlib import Path

from edge_agent_scanner.engine import run_scan


def test_cap_limits_per_rule(monkeypatch: object, tmp_path: Path) -> None:
    from edge_agent_scanner import config

    monkeypatch.setattr(config, "MAX_FINDINGS_PER_RULE", 2)
    # Many subprocess lines
    lines = "\n".join([f"subprocess.run([{i!r}])" for i in range(20)])
    (tmp_path / "many.py").write_text(lines, encoding="utf-8")
    report = run_scan(tmp_path)
    dt = [f for f in report.findings if f.rule_id == "dangerous-tools"]
    assert len(dt) <= 2
