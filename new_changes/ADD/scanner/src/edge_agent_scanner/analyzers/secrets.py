from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.ir.models import CodeLocation
from edge_agent_scanner.walker import ScannedFile

SECRET_REGEXES = [
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"ghp_[A-Za-z0-9]{30,}"),
    re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]


def _run_gitleaks(repo_root: Path):
    if not shutil.which("gitleaks"):
        return []
    try:
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
        findings.append(
            make_finding(
                rule_id="secrets",
                severity="high",
                category="Hardcoded secret",
                title=f"Secret detected by external scanner: {rule}",
                location=CodeLocation(file=file, start_line=line, end_line=line, symbol=str(rule)),
                reason="External secret scanner detected a credential-like value.",
                suggested_fix="Remove the secret, rotate it, and move configuration into a secrets manager or environment variable.",
                evidence=str(rule),
                confidence=0.9,
            )
        )
    if findings:
        return findings

    for sf in files:
        for i, line in enumerate(sf.lines, start=1):
            for rx in SECRET_REGEXES:
                if rx.search(line):
                    findings.append(
                        make_finding(
                            rule_id="secrets",
                            severity="high",
                            category="Hardcoded secret",
                            title="Secret-like value detected",
                            location=CodeLocation(file=sf.rel_path, start_line=i, end_line=i),
                            reason="Fallback pattern scanner detected a credential-like value.",
                            suggested_fix="Remove the secret, rotate it if real, and use a secret manager or environment variable.",
                            evidence=rx.pattern,
                            code=line,
                            confidence=0.72,
                        )
                    )
    return findings
