"""Secret detection and masking."""

from __future__ import annotations

from edge_agent_scanner.engine import run_scan
from edge_agent_scanner.rules.secrets import mask_credential


def test_mask_short():
    assert mask_credential("abc") == "****"


def test_mask_pem():
    assert "MASKED" in mask_credential("-----BEGIN RSA PRIVATE KEY-----\nabc")


def test_secret_not_leaked_in_report_code(tmp_path):
    secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789AB"
    (tmp_path / "cfg.py").write_text(f'KEY = "{secret}"\n', encoding="utf-8")
    report = run_scan(tmp_path)
    sec_findings = [f for f in report.findings if f.rule_id == "secrets"]
    assert sec_findings
    joined = " ".join(f.code + f.evidence for f in sec_findings)
    assert secret not in joined
