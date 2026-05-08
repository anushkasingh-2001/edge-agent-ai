"""Repository walker skips and limits."""

from __future__ import annotations

from pathlib import Path

from edge_agent_scanner.walker import iter_scanned_files


def test_skips_node_modules(tmp_path: Path) -> None:
    (tmp_path / "ok.py").write_text("x=1\n", encoding="utf-8")
    nm = tmp_path / "node_modules" / "pkg" / "bad.js"
    nm.parent.mkdir(parents=True)
    nm.write_text("evil", encoding="utf-8")

    files = iter_scanned_files(tmp_path)
    rels = {f.rel_path for f in files}
    assert "ok.py" in rels
    assert not any("node_modules" in r for r in rels)


def test_skips_binary(tmp_path: Path) -> None:
    p = tmp_path / "blob.bin"
    p.write_bytes(b"\x00\x01\x02\xff")
    files = iter_scanned_files(tmp_path)
    assert not files
