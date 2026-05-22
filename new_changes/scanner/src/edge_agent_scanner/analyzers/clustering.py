"""Finding clustering (Tier 4, OPTIONAL / INACTIVE helper).

STATUS: future-ready helper. NOT wired into engine.py and NOT used by any scan
path. The engine still dedupes by (rule_id, file, line, title); this extra
consolidation only happens if a caller explicitly invokes `cluster_findings`.
Leaving it inactive guarantees it cannot change current scan output.

Reduce duplicate findings that describe the *same* underlying problem — e.g. the
same dangerous sink reached by several sources, or the same tool reported by
overlapping rules — into a single finding that carries all the evidence paths.

This is intentionally a pure, standalone helper. It is NOT wired into the engine
by default (the engine still dedupes by (rule_id, file, line, title)); call
`cluster_findings(...)` explicitly if you want this extra consolidation. Runtime
is O(n) over findings.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

_SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _evidence_signature(finding: Any) -> str:
    """A stable signature for the sink + path this finding describes.

    Uses the last node of the evidence path (the sink/target) plus the rule, so
    two findings hitting the same sink — even via different sources — cluster
    together. Falls back to (file, line) when there is no evidence path.
    """
    path = getattr(finding, "evidence_path", None) or []
    if path:
        last = path[-1]
        label = getattr(last, "label", None) or ""
        file = getattr(last, "file", None) or getattr(finding, "file", "")
        line = getattr(last, "line", None) or getattr(finding, "line", 0)
        return f"{getattr(finding, 'rule_id', '')}|{label}|{file}|{line}"
    return f"{getattr(finding, 'rule_id', '')}|{getattr(finding, 'file', '')}|{getattr(finding, 'line', 0)}"


def _is_more_severe(a: Any, b: Any) -> bool:
    ra = _SEVERITY_RANK.get(getattr(a, "severity", "low"), 9)
    rb = _SEVERITY_RANK.get(getattr(b, "severity", "low"), 9)
    if ra != rb:
        return ra < rb
    # tie-break on confidence
    return float(getattr(a, "confidence", 0.0) or 0.0) >= float(getattr(b, "confidence", 0.0) or 0.0)


def cluster_findings(findings: list[Any]) -> list[Any]:
    """Cluster by (rule, sink, evidence path). Returns one representative per
    cluster — the most severe / most confident — with the other members'
    evidence paths merged into `related_locations` and a `clustered_count`
    recorded in `verifier`. Order is preserved by first appearance."""
    clusters: "OrderedDict[str, Any]" = OrderedDict()
    members: dict[str, int] = {}

    for f in findings:
        sig = _evidence_signature(f)
        if sig not in clusters:
            clusters[sig] = f
            members[sig] = 1
            continue

        members[sig] += 1
        rep = clusters[sig]
        # Merge this finding's evidence into the representative.
        try:
            rep_locs = list(getattr(rep, "related_locations", []) or [])
            prim = getattr(f, "primary_location", None)
            if prim is not None:
                rep_locs.append(prim)
            rep.related_locations = rep_locs
        except Exception:
            pass
        # Keep the stronger finding as representative.
        if _is_more_severe(f, rep):
            # carry forward merged locations + count onto the new representative
            try:
                f.related_locations = list(getattr(f, "related_locations", []) or []) + list(
                    getattr(rep, "related_locations", []) or []
                )
            except Exception:
                pass
            clusters[sig] = f

    out = []
    for sig, rep in clusters.items():
        try:
            if members[sig] > 1 and hasattr(rep, "verifier"):
                rep.verifier = {**(rep.verifier or {}), "clustered_count": members[sig]}
        except Exception:
            pass
        out.append(rep)
    return out
