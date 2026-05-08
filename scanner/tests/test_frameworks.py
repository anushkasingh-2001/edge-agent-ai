"""Framework detection from manifests."""

from __future__ import annotations

from edge_agent_scanner.engine import run_scan


def test_langchain_from_requirements(tmp_path):
    (tmp_path / "requirements.txt").write_text("langchain>=0.2\nlanggraph\n", encoding="utf-8")
    report = run_scan(tmp_path)
    names = {f.name for f in report.frameworks_detected}
    assert "LangChain" in names
    assert "LangGraph" in names


def test_llamaindex_from_pyproject(tmp_path):
    (tmp_path / "pyproject.toml").write_text(
        '[project]\ndependencies = ["llama-index-core"]\n',
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    names = {f.name for f in report.frameworks_detected}
    assert "LlamaIndex" in names


def test_import_detection_in_python(tmp_path):
    (tmp_path / "agent.py").write_text("from pydantic_ai import Agent\n", encoding="utf-8")
    report = run_scan(tmp_path)
    names = {f.name for f in report.frameworks_detected}
    assert "Pydantic AI" in names
