"""Detect likely secrets and emit masked findings."""

from __future__ import annotations

import re
import uuid

from edge_agent_scanner.report import Finding
from edge_agent_scanner.walker import ScannedFile


def mask_credential(value: str) -> str:
    """Never return full secret; keep prefix/suffix hints for debugging."""
    v = value.strip()
    if len(v) <= 6:
        return "****"
    if "BEGIN" in v and "PRIVATE KEY" in v:
        return "-----BEGIN ***MASKED PRIVATE KEY-----"
    return f"{v[:4]}****{v[-2:]}"


# (regex, title_suffix, severity, confidence) — order matters (specific before broad)
_SECRET_PATTERNS: list[tuple[re.Pattern[str], str, str, float]] = [
    (
        re.compile(r"\b(sk_live_[0-9a-zA-Z]{10,}|sk_test_[0-9a-zA-Z]{10,})\b"),
        "Stripe API key",
        "critical",
        0.88,
    ),
    (
        re.compile(r"\bsk-ant-[a-zA-Z0-9\-_]{10,}", re.I),
        "Anthropic-style API key",
        "critical",
        0.9,
    ),
    (
        re.compile(r"\bsk-(proj|svcacct)-[a-zA-Z0-9\-]{10,}", re.I),
        "OpenAI-style project/service API key",
        "critical",
        0.88,
    ),
    (
        re.compile(r"\bsk-[a-zA-Z0-9]{20,}", re.I),
        "OpenAI-style API key (generic)",
        "critical",
        0.82,
    ),
    (
        re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
        "AWS access key id",
        "critical",
        0.85,
    ),
    (
        re.compile(r"\bASIA[0-9A-Z]{16}\b"),
        "AWS temporary access key id",
        "high",
        0.8,
    ),
    (
        re.compile(r"\bghp_[0-9a-zA-Z]{20,}\b"),
        "GitHub personal access token",
        "critical",
        0.9,
    ),
    (
        re.compile(r"\bgithub_pat_[0-9a-zA-Z_]{20,}\b", re.I),
        "GitHub fine-grained PAT",
        "critical",
        0.9,
    ),
    (
        re.compile(
            r"\b(postgresql|postgres|mysql|mongodb(\+srv)?)://[^\s'\"]+:[^\s'\"]+@[^\s'\"]+",
            re.I,
        ),
        "Database URL with credentials",
        "critical",
        0.82,
    ),
    (
        re.compile(r"-----BEGIN [A-Z ]+PRIVATE KEY-----"),
        "PEM private key block",
        "critical",
        0.95,
    ),
]


def _redact_line(line: str, match: re.Match[str]) -> str:
    raw = match.group(0)
    masked = mask_credential(raw)
    s, e = match.span()
    return (line[:s] + masked + line[e:]).strip()[:500]


def run_secrets_rule(files: list[ScannedFile]) -> list[Finding]:
    findings: list[Finding] = []
    for sf in files:
        for i, line in enumerate(sf.lines, start=1):
            for rx, label, sev, conf in _SECRET_PATTERNS:
                m = rx.search(line)
                if not m:
                    continue
                masked = mask_credential(m.group(0))
                findings.append(
                    Finding(
                        id=str(uuid.uuid4()),
                        rule_id="secrets",
                        severity=sev,  # type: ignore[arg-type]
                        category="Hardcoded secret",
                        title=f"Possible secret: {label}",
                        file=sf.rel_path,
                        line=i,
                        agent="unknown",
                        reason="A string resembling a credential or private key was found in source.",
                        suggestedFix=(
                            "Rotate the credential, remove it from the repo, and load from a secret manager "
                            "or environment variable."
                        ),
                        evidence=f"Masked match: {masked}",
                        code=_redact_line(line, m),
                        confidence=conf,
                    )
                )
    return findings
