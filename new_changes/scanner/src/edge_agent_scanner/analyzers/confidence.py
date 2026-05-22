"""Deterministic, feature-based confidence scoring for findings (Tier 2).

This module turns a small set of *observable* features into a calibrated
confidence score and a coarse band. It is pure and deterministic — no LLM, no
network, no randomness — so the same finding always scores the same way and
branch-compare stays stable.

Confidence is intentionally a function of evidence quality, not of how scary the
keyword sounds. A side-effecting tool reached by an untrusted source along an
unguarded path with IR (parser) evidence in a production file scores high; a
fuzzy keyword match in a test fixture scores low.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

# ---------------------------------------------------------------------------
# Bands
# ---------------------------------------------------------------------------
HIGH_CONFIDENCE = "high_confidence"
MEDIUM_CONFIDENCE = "medium_confidence"
LOW_CONFIDENCE = "low_confidence"

_HIGH_BAND_MIN = 0.72
_MEDIUM_BAND_MIN = 0.45

_IMPACT_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1}

# File-path markers that indicate non-production code (lowers confidence that a
# finding is a real, shippable risk).
_NONPROD_RE = re.compile(
    r"(^|/)(tests?|test|__tests__|examples?|example|demos?|demo|samples?|sample|"
    r"fixtures?|mocks?|sandbox|playground|scratch)(/|$)|"
    r"(_test\.|\.test\.|\.spec\.|_spec\.|conftest)",
    re.I,
)


def is_prod_file(path: str | None) -> bool:
    """True when the path looks like production source, not test/example/demo."""
    if not path:
        return True
    return not bool(_NONPROD_RE.search(path))


@dataclass
class ConfidenceFeatures:
    """Observable features used to score a finding. All optional with safe
    defaults so analyzers can fill in only what they actually know."""

    sink_impact: str = "medium"          # low | medium | high | critical
    source_untrusted: bool = False       # an untrusted source is involved
    unguarded_path_exists: bool = False  # a guard-free path to the sink exists
    path_length: int = 1                 # nodes on the evidence path
    partial_guard: bool = False          # guard on SOME but not all paths (ambiguous)
    ir_evidence: bool = True             # parser/IR evidence (vs regex/keyword fallback)
    exact_sink_match: bool = True        # exact sink match (vs fuzzy/semantic)
    prod_file: bool = True               # production file (vs test/example/demo)

    def as_dict(self) -> dict:
        return asdict(self)


def compute_confidence(feats: ConfidenceFeatures) -> tuple[float, str]:
    """Return (score in [0,1], band). Deterministic weighted sum."""
    score = 0.5

    impact = _IMPACT_RANK.get(str(feats.sink_impact).lower(), 2)
    score += {4: 0.20, 3: 0.12, 2: 0.0, 1: -0.10}.get(impact, 0.0)

    if feats.source_untrusted:
        score += 0.10
    if feats.unguarded_path_exists:
        score += 0.12
    if feats.partial_guard:
        # Some paths are guarded — genuinely ambiguous, pull toward the middle.
        score -= 0.08

    score += 0.10 if feats.ir_evidence else -0.15
    score += 0.08 if feats.exact_sink_match else -0.12
    score += 0.05 if feats.prod_file else -0.20

    # Longer paths are slightly less certain (more inference between source/sink).
    if feats.path_length > 1:
        score -= min(0.10, 0.02 * (feats.path_length - 1))

    score = max(0.0, min(1.0, round(score, 4)))
    return score, band_for(score)


def band_for(score: float) -> str:
    if score >= _HIGH_BAND_MIN:
        return HIGH_CONFIDENCE
    if score >= _MEDIUM_BAND_MIN:
        return MEDIUM_CONFIDENCE
    return LOW_CONFIDENCE
