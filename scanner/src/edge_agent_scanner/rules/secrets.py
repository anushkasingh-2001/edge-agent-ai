"""Legacy helper exports for backward compatibility.

The secret-detection logic moved to ``edge_agent_scanner.analyzers.secrets``
which uses ``gitleaks`` when available and a small built-in regex fallback
otherwise. This module is retained only because external callers and tests
still import ``mask_credential`` from here.
"""

from __future__ import annotations


def mask_credential(value: str) -> str:
    """Never return the full secret; keep small prefix/suffix hints.

    The IR-based analyzer does not embed raw secrets into Finding.evidence or
    Finding.code by default — but historical callers (and the legacy report
    code) rely on this helper, so it stays exported.
    """
    v = value.strip()
    if len(v) <= 6:
        return "****"
    if "BEGIN" in v and "PRIVATE KEY" in v:
        return "-----BEGIN ***MASKED PRIVATE KEY-----"
    return f"{v[:4]}****{v[-2:]}"


__all__ = ["mask_credential"]
