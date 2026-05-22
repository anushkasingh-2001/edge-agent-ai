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


def test_no_raw_secret_anywhere_in_report_json(tmp_path):
    """Defence-in-depth: serialize the full report and assert no raw
    credential survives in *any* field (code, evidence, reason, title,
    suggested_patch, etc.) — not just in the two we have historically
    asserted on."""
    cases = {
        "anthropic.py": ("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789AB",),
        "openai_proj.py": ("sk-proj-aaaabbbbccccddddeeeeffff",),
        "openai_generic.py": ("sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",),
        "stripe.py": ("sk_live_aaaabbbbccccdddd",),
        "aws.py": ("AKIAABCDEFGHIJKLMNOP",),
        "github.py": ("ghp_aaaabbbbccccddddeeeeffffgggghhhh",),
        "dburl.py": ("postgres://user:supersecretpassword@db.example.com/app",),
    }
    for filename, (secret,) in cases.items():
        (tmp_path / filename).write_text(f'KEY = "{secret}"\n', encoding="utf-8")

    report = run_scan(tmp_path)
    raw_json = report.model_dump_json()
    sec_findings = [f for f in report.findings if f.rule_id == "secrets"]
    assert sec_findings, "expected at least one secret finding across the planted credentials"

    for _filename, (secret,) in cases.items():
        # Whatever the path the analyzer took (gitleaks vs. regex fallback),
        # the raw secret must NEVER appear in the serialised report.
        assert secret not in raw_json, f"raw secret {secret!r} leaked into report JSON"
