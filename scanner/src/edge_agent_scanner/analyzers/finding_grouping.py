"""Finding fingerprinting, deduplication, and grouping.

Addresses the "too many noisy/duplicate findings" problem by giving
every finding a *structural* fingerprint (rule + sink kind + guards +
taint-path signature) rather than a line-text signature. Findings that
share a fingerprint are the same root cause and collapse into one
representative with a ``dup_count``.

It also provides the weak-signal grouping the builder asked for:
  * dependencies grouped per manifest (one finding per manifest+severity
    bucket, not one per package) unless high/critical CVE data exists.
  * output-schema / config findings grouped per (rule, file).

This module is pure and deterministic. ``engine.py`` calls
``apply_intelligence_grouping(findings)`` just before the existing
``_dedupe_findings`` so the two cooperate (fingerprint dedup is a
superset of the line-based dedup).
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from typing import Any

# Rules whose repeated emission across a file/manifest is almost always
# the same root cause and should be collapsed.
_GROUP_PER_FILE_RULES = {
    "openapi-schema",
    "prompt-contract",
}
_GROUP_PER_MANIFEST_RULES = {
    "dependency-risks",
}


def _sink_kind_of(finding: Any) -> str:
    """Best-effort sink kind from the finding's evidence_path / rule."""
    # If an evidence_path node carries a sink kind, prefer it.
    for node in getattr(finding, "evidence_path", []) or []:
        kind = getattr(node, "kind", "")
        if kind in {
            "cypher", "file_read", "env_mutation", "code_exec",
            "network", "prompt", "sink",
        }:
            return kind
    return finding.rule_id


def _path_signature(finding: Any) -> str:
    """Stable signature of the taint path: the sequence of node kinds.

    Uses node *kinds* (not labels/line text) so two structurally
    identical flows in different files/lines share a signature.
    """
    kinds = [
        getattr(n, "kind", "node")
        for n in (getattr(finding, "evidence_path", []) or [])
    ]
    return ">".join(kinds) if kinds else "direct"


def _guard_signature(finding: Any) -> str:
    feats = getattr(finding, "confidence_features", {}) or {}
    return f"pg={int(bool(feats.get('partial_guard')))}"


def compute_fingerprint(finding: Any) -> str:
    """sha1(rule_id | sink_kind | guard_sig | path_sig).

    Deliberately excludes file/line so identical flows collapse. The
    representative keeps its own file/line; siblings are counted.
    """
    payload = "|".join(
        [
            finding.rule_id,
            _sink_kind_of(finding),
            _guard_signature(finding),
            _path_signature(finding),
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _severity_rank(sev: str) -> int:
    return {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(sev, 4)


def apply_intelligence_grouping(findings: list[Any]) -> list[Any]:
    """Collapse duplicate/noisy findings; stamp fingerprint + dup_count.

    Steps:
      1. Stamp every finding with its structural fingerprint.
      2. Group per-file rules (openapi-schema, prompt-contract) so a
         file with 20 schema findings yields 1 with dup_count=20.
      3. Group dependency-risks per manifest + severity bucket UNLESS
         the finding is high/critical (real CVE data) — those stay
         per-package.
      4. Collapse any remaining identical fingerprints, keeping the
         most severe / lowest-line representative.
    """
    for f in findings:
        try:
            f.fingerprint = compute_fingerprint(f)
        except Exception:
            f.fingerprint = None

    kept: list[Any] = []
    consumed: set[int] = set()

    # ---- 2 & 3: rule-specific grouping -------------------------------------
    grouped_keys: dict[tuple, list[Any]] = defaultdict(list)
    for idx, f in enumerate(findings):
        if f.rule_id in _GROUP_PER_FILE_RULES:
            grouped_keys[("file", f.rule_id, f.file)].append(f)
            consumed.add(idx)
        elif f.rule_id in _GROUP_PER_MANIFEST_RULES and f.severity in {"low", "medium"}:
            grouped_keys[("manifest", f.rule_id, f.file, f.severity)].append(f)
            consumed.add(idx)

    for key, members in grouped_keys.items():
        members.sort(key=lambda m: (_severity_rank(m.severity), m.line))
        rep = members[0]
        rep.dup_count = len(members)
        if len(members) > 1:
            kind = key[0]
            if kind == "manifest":
                rep.title = (
                    f"{len(members)} {rep.severity} dependency risks in {rep.file}"
                )
            else:
                rep.title = f"{rep.title} (+{len(members) - 1} more in this file)"
        kept.append(rep)

    # ---- 4: fingerprint collapse for everything else -----------------------
    by_fp: dict[str, list[Any]] = defaultdict(list)
    singletons: list[Any] = []
    for idx, f in enumerate(findings):
        if idx in consumed:
            continue
        if f.fingerprint:
            by_fp[f.fingerprint].append(f)
        else:
            singletons.append(f)

    for fp, members in by_fp.items():
        members.sort(key=lambda m: (_severity_rank(m.severity), m.file, m.line))
        rep = members[0]
        rep.dup_count = len(members)
        if len(members) > 1:
            rep.related_locations = list(rep.related_locations) + [
                m.primary_location for m in members[1:] if m.primary_location
            ]
        kept.append(rep)

    kept.extend(singletons)
    kept.sort(key=lambda m: (_severity_rank(m.severity), m.file, m.line))
    return kept
