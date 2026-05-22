"""Content-addressed IR extraction cache (Tier 4, OPTIONAL / INACTIVE).

STATUS: future-ready helper. NOT wired into engine.py and NOT used by any scan
path. It cannot change scan results because nothing calls it during a scan.
Enable it deliberately, behind your own flag, only after proving incremental
extraction produces identical findings to a full scan.

A small JSON cache at `.edgeagent/cache/ir_cache.json` that lets a caller skip
re-extracting files whose content has not changed. This module only stores a
*summary* of an extraction (node/edge counts) plus the file hash and extractor
name — it deliberately does not try to serialize the full IR, so it stays small
and safe. It is NOT wired into the main scan; integrate it explicitly if you
want incremental behavior.

Cache invalidation is conservative: any mismatch in cache version or scanner
version drops the whole cache, and any file-hash mismatch drops just that entry.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

CACHE_VERSION = "1"
# Bump when extraction semantics change. Mirrors report.SCHEMA_VERSION intent.
SCANNER_VERSION = "0.2.0"

_CACHE_REL = Path(".edgeagent") / "cache" / "ir_cache.json"


def file_hash(content: str | bytes) -> str:
    """SHA-256 of file content. Accepts str or bytes."""
    if isinstance(content, str):
        content = content.encode("utf-8", errors="replace")
    return hashlib.sha256(content).hexdigest()


def file_hash_path(path: str | Path) -> str | None:
    try:
        return file_hash(Path(path).read_bytes())
    except OSError:
        return None


def cache_path(repo_root: str | Path) -> Path:
    return Path(repo_root) / _CACHE_REL


def _empty_cache() -> dict[str, Any]:
    return {
        "cache_version": CACHE_VERSION,
        "scanner_version": SCANNER_VERSION,
        "entries": {},  # rel_path -> entry
    }


def load_cache(repo_root: str | Path) -> dict[str, Any]:
    """Load the cache, returning a fresh empty cache on any problem."""
    path = cache_path(repo_root)
    if not path.exists():
        return _empty_cache()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return _empty_cache()
    if not isinstance(data, dict) or "entries" not in data:
        return _empty_cache()
    return data


def save_cache(repo_root: str | Path, cache: dict[str, Any]) -> Path:
    path = cache_path(repo_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8")
    return path


def invalidate_if_stale(cache: dict[str, Any]) -> dict[str, Any]:
    """Drop the whole cache if version markers don't match the current build."""
    if (
        cache.get("cache_version") != CACHE_VERSION
        or cache.get("scanner_version") != SCANNER_VERSION
    ):
        return _empty_cache()
    return cache


def cached_extraction(cache: dict[str, Any], rel_path: str, current_hash: str) -> dict[str, Any] | None:
    """Return the cached entry for `rel_path` iff its stored hash matches the
    current file hash; otherwise None (stale or missing)."""
    entry = cache.get("entries", {}).get(rel_path)
    if not isinstance(entry, dict):
        return None
    if entry.get("file_hash") != current_hash:
        return None
    return entry


def update_entry(
    cache: dict[str, Any],
    rel_path: str,
    current_hash: str,
    extractor: str,
    node_count: int,
    edge_count: int,
    extra: dict[str, Any] | None = None,
) -> None:
    """Record/refresh the cache entry for one file (in place)."""
    cache.setdefault("entries", {})[rel_path] = {
        "file_path": rel_path,
        "file_hash": current_hash,
        "extractor": extractor,
        "node_summary": int(node_count),
        "edge_summary": int(edge_count),
        **(extra or {}),
    }
