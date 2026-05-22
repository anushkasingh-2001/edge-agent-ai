from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_existing
from edge_agent_scanner.ir.models import CodeLocation
from edge_agent_scanner.rules.secrets import mask_credential
from edge_agent_scanner.walker import ScannedFile

# (regex, title_suffix, severity, confidence) — order matters: specific
# patterns before broad ones so the redaction picks the most informative
# label for the masked match. The list mirrors the historical rule that
# `rules/secrets.py::run_secrets_rule` shipped before the IR refactor,
# rebuilt here so the IR-era analyzer detects (and masks) the same set
# of credential shapes: Stripe, Anthropic, OpenAI project/service keys,
# AWS access keys, GitHub PATs, DB URLs with embedded credentials,
# generic OpenAI-style `sk-...`, and PEM private key blocks.
SECRET_PATTERNS: list[tuple[re.Pattern[str], str, str, float]] = [
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
    """Return ``line`` with the matched secret span replaced by a masked
    placeholder so the raw credential never reaches Finding.code.

    Defence in depth: every other regex in :data:`SECRET_PATTERNS` is also
    applied so that if a single line happens to contain more than one
    credential shape, none of them survive into the report.
    """
    masked = mask_credential(match.group(0))
    s, e = match.span()
    out = (line[:s] + masked + line[e:]).strip()[:500]
    for rx, *_ in SECRET_PATTERNS:
        out = rx.sub(lambda m: mask_credential(m.group(0)), out)
    return out


def _run_gitleaks(repo_root: Path):
    if not shutil.which("gitleaks"):
        return []
    try:
        # `--redact` makes gitleaks itself elide the raw secret from
        # `Match`/`Secret` fields; combined with us never reading those
        # fields below, the raw credential cannot escape into the report.
        proc = subprocess.run(
            ["gitleaks", "detect", "--source", str(repo_root), "--no-git", "--report-format", "json", "--redact"],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        return json.loads(proc.stdout or "[]")
    except Exception:
        return []


def analyze_secrets(repo_root: Path, files: list[ScannedFile]):
    findings = []
    for item in _run_gitleaks(repo_root):
        file = item.get("File") or item.get("file") or "unknown"
        line = int(item.get("StartLine") or item.get("line") or 1)
        rule = item.get("RuleID") or item.get("Description") or "secret"
        # We deliberately ignore the `Match`/`Secret` fields gitleaks returns
        # even though `--redact` already masks them — the rule label is the
        # only thing that goes into the report.
        findings.append(
            make_finding(
                rule_id="secrets",
                severity="high",
                category="Hardcoded secret",
                title=f"Secret detected by external scanner: {rule}",
                location=CodeLocation(file=file, start_line=line, end_line=line, symbol=str(rule)),
                reason="External secret scanner detected a credential-like value.",
                suggested_fix=(
                    "Remove the secret, rotate it, and move configuration into a secrets "
                    "manager or environment variable."
                ),
                evidence=f"gitleaks rule: {rule}",
                confidence=0.9,
            )
        )
    if findings:
        for _f in findings:
            annotate_existing(_f, ConfidenceFeatures(sink_impact=_f.severity, prod_file=is_prod_file(_f.file)))
        return findings

    for sf in files:
        for i, line in enumerate(sf.lines, start=1):
            for rx, label, sev, conf in SECRET_PATTERNS:
                m = rx.search(line)
                if not m:
                    continue
                masked = mask_credential(m.group(0))
                findings.append(
                    make_finding(
                        rule_id="secrets",
                        severity=sev,
                        category="Hardcoded secret",
                        title=f"Possible secret: {label}",
                        location=CodeLocation(file=sf.rel_path, start_line=i, end_line=i),
                        reason=(
                            "Fallback pattern scanner detected a credential-like value. "
                            "Match span has been redacted before storage."
                        ),
                        suggested_fix=(
                            "Remove the secret, rotate it if real, and use a secret manager "
                            "or environment variable."
                        ),
                        # `evidence` carries the masked match label only — never the raw
                        # secret. `code` is the source line with the matched span (and
                        # any other secret shapes on the same line) redacted via
                        # _redact_line so the raw credential cannot leak through it.
                        evidence=f"Masked match: {masked}",
                        code=_redact_line(line, m),
                        confidence=conf,
                    )
                )
                # Stop at the first match per (line, pattern) — the next pattern
                # in the list still gets a chance via the outer loop, but we
                # don't double-report the same span under the same pattern.
                break

    # Tier 2 (conservative): attach advisory confidence band + escalation
    # WITHOUT changing severity or the analyzer's own confidence value.
    for _f in findings:
        annotate_existing(_f, ConfidenceFeatures(sink_impact=_f.severity, prod_file=is_prod_file(_f.file)))
    return findings
