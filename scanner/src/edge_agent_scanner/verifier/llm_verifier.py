from __future__ import annotations

import os

from edge_agent_scanner.report import Finding
from edge_agent_scanner.walker import ScannedFile


def verify_findings_if_enabled(findings: list[Finding], ir, files: list[ScannedFile]) -> list[Finding]:
    """Optional AI verification hook.

    Keep this disabled by default. Use it only for high-impact or ambiguous
    candidates. Wire your OpenAI/Anthropic/local model client here later.
    """
    if os.getenv("EDGE_AGENT_LLM_VERIFIER", "0") != "1":
        return findings

    # Placeholder: keep findings unchanged unless an actual model client is wired.
    for f in findings:
        f.verifier.setdefault("status", "not_configured")
    return findings
