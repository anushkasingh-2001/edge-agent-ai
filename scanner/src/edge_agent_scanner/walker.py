"""Walk a repository root and load text files with safety limits."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from edge_agent_scanner.config import MAX_FILE_BYTES, SKIP_DIR_NAMES, TEXT_EXTENSIONS


@dataclass(frozen=True)
class ScannedFile:
    """One text file under the scan root."""

    rel_path: str  # posix-style relative path
    lines: list[str]
    full_path: Path


def _is_probably_binary(sample: bytes) -> bool:
    if not sample:
        return False
    if b"\x00" in sample:
        return True
    # High ratio of non-text bytes
    text_chars = sum(1 for b in sample if 32 <= b < 127 or b in (9, 10, 13))
    return text_chars / max(len(sample), 1) < 0.7


def iter_scanned_files(root: Path, max_bytes: int = MAX_FILE_BYTES) -> list[ScannedFile]:
    """
    Recursively collect readable text files under root.
    Skips configured directories, non-extensions, binaries, and oversized files.
    """
    root = root.resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"Not a directory: {root}")

    results: list[ScannedFile] = []

    for path in root.rglob("*"):
        try:
            rel = path.relative_to(root)
        except ValueError:
            continue

        parts = rel.parts
        if any(p in SKIP_DIR_NAMES for p in parts):
            continue

        if path.is_dir():
            continue

        if path.suffix.lower() not in TEXT_EXTENSIONS:
            continue

        try:
            stat = path.stat()
        except OSError:
            continue

        if stat.st_size > max_bytes:
            continue

        try:
            raw = path.read_bytes()
        except OSError:
            continue

        peek = raw[:8192]
        if _is_probably_binary(peek):
            continue

        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            try:
                text = raw.decode("utf-8", errors="replace")
            except Exception:
                continue

        lines = text.splitlines()
        rel_str = rel.as_posix()
        results.append(ScannedFile(rel_path=rel_str, lines=lines, full_path=path))

    results.sort(key=lambda f: f.rel_path)
    return results
