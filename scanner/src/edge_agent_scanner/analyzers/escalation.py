"""Escalation recommendation (Tier 2).

Given a finding's severity, confidence band, and features, recommend the
cheapest next step that would meaningfully change our belief about the finding.
This is the "static-first, escalate-only-when-uncertain" router: most findings
need nothing further, the uncertain middle is sent to behavioral, and only
ambiguous-yet-impactful findings are flagged for the optional LLM verifier.

Crucially this does NOT run anything — it only labels findings with a
recommendation that the policy layer / UI can act on. There is no full-repo LLM
scanning here.
"""

from __future__ import annotations

from edge_agent_scanner.analyzers.confidence import (
    HIGH_CONFIDENCE,
    LOW_CONFIDENCE,
    MEDIUM_CONFIDENCE,
    ConfidenceFeatures,
    band_for,
    compute_confidence,
)

# Recommendations
NO_ESCALATION = "no_escalation"
STATIC_ONLY = "static_only"
SEMGREP_OPTIONAL = "semgrep_optional"
BEHAVIORAL_RECOMMENDED = "behavioral_recommended"
LLM_VERIFIER_OPTIONAL = "llm_verifier_optional"


def _is_impactful(severity: str, feats: ConfidenceFeatures) -> bool:
    return str(severity).lower() in {"high", "critical"} or str(feats.sink_impact).lower() in {"high", "critical"}


def _is_ambiguous(feats: ConfidenceFeatures) -> bool:
    # "Ambiguous" = weak evidence: no parser/IR backing, or a fuzzy sink match.
    return (not feats.ir_evidence) or (not feats.exact_sink_match)


def recommend_escalation(severity: str, band: str, feats: ConfidenceFeatures) -> str:
    """Deterministic escalation routing.

    Rules:
      - Behavioral is recommended mainly for high-impact OR medium-confidence.
      - LLM verifier is suggested ONLY for ambiguous, impactful findings.
      - Low-confidence, low-impact findings get no escalation (likely noise).
    """
    impactful = _is_impactful(severity, feats)

    if band == HIGH_CONFIDENCE:
        # We already believe it. Confirm impactful ones at runtime; ship the rest.
        return BEHAVIORAL_RECOMMENDED if impactful else STATIC_ONLY

    if band == MEDIUM_CONFIDENCE:
        # The uncertain middle: behavioral if it matters, cheap dataflow otherwise.
        return BEHAVIORAL_RECOMMENDED if impactful else SEMGREP_OPTIONAL

    # LOW_CONFIDENCE
    if impactful and _is_ambiguous(feats):
        return LLM_VERIFIER_OPTIONAL  # impactful but weakly evidenced -> adjudicate
    if impactful:
        return SEMGREP_OPTIONAL
    return NO_ESCALATION


def annotate_finding(finding, feats: ConfidenceFeatures) -> None:
    """Compute confidence + band + escalation from features and attach them to a
    Finding in place. Overwrites `finding.confidence` with the calibrated score
    and fills the optional `confidence_band` / `escalation` /
    `confidence_features` fields. Backward compatible: callers that never invoke
    this still get a valid Finding."""
    score, band = compute_confidence(feats)
    finding.confidence = score
    # These optional fields exist on the Finding model (defaults keep old JSON valid).
    if hasattr(finding, "confidence_band"):
        finding.confidence_band = band
    if hasattr(finding, "escalation"):
        finding.escalation = recommend_escalation(finding.severity, band, feats)
    if hasattr(finding, "confidence_features"):
        finding.confidence_features = feats.as_dict()


def annotate_existing(finding, feats: ConfidenceFeatures) -> None:
    """Conservative annotation: attach band + escalation + features WITHOUT
    recomputing or overwriting the finding's own confidence or severity.

    Used for analyzers whose confidence is already meaningful (secrets,
    dependencies, prompt rules, etc.). The band is derived from the existing
    confidence so we never *lower* a finding, and escalation is computed from
    the existing severity — so critical/high findings are never suppressed or
    downgraded by this call. It only adds advisory metadata."""
    band = band_for(float(getattr(finding, "confidence", 0.0) or 0.0))
    if hasattr(finding, "confidence_band"):
        finding.confidence_band = band
    if hasattr(finding, "escalation"):
        finding.escalation = recommend_escalation(finding.severity, band, feats)
    if hasattr(finding, "confidence_features"):
        finding.confidence_features = feats.as_dict()
