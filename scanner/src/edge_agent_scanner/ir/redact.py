"""Lightweight secret redactor used by the IR extractors.

The IR layer captures call expressions and source-line snippets verbatim
so the UI and the AI explainer can show *exactly* what the developer
wrote. That snippet may incidentally contain a credential
(``OPENAI_API_KEY = "sk-..."`` on the line above, an inline URL with
embedded ``user:password@host``, …) so we MUST scrub it before it lands
in ``SinkNode.call_expression`` / ``SinkNode.source_line`` (and from
there into ``Finding.code`` and the AI prompt).

Why this lives in ``ir/`` rather than reusing
``analyzers.secrets.SECRET_PATTERNS``: ``analyzers/secrets.py`` already
imports from ``ir.models`` (it emits ``Finding`` objects whose
``location`` is a ``CodeLocation``). Reaching back from ``ir.*`` into
``analyzers.*`` would create a circular import the first time
``extract_python.py`` is loaded. Keeping a tiny pattern list here is the
simpler, layering-clean answer; the patterns mirror the ones in
``analyzers/secrets.py`` so detection findings and the redacted snippets
stay in sync.
"""

from __future__ import annotations

import re

# (regex, label) — order matters: vendor-specific patterns BEFORE the
# generic ``api_key = "..."`` fallback so the most informative
# placeholder wins. The negative lookahead on the fallback prevents it
# from clobbering a vendor placeholder that was already inserted
# upstream (otherwise ``OPENAI_API_KEY = '<REDACTED_OPENAI_KEY>'``
# would degrade to ``<REDACTED_SECRET>``).
_SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bsk-(?:proj|svcacct)-[A-Za-z0-9_\-]{10,}", re.I), "<REDACTED_OPENAI_KEY>"),
    (re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"), "<REDACTED_OPENAI_KEY>"),
    (re.compile(r"\bsk-ant-(?:api03-)?[A-Za-z0-9_\-]{10,}", re.I), "<REDACTED_ANTHROPIC_KEY>"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "<REDACTED_GITHUB_TOKEN>"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", re.I), "<REDACTED_GITHUB_PAT>"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "<REDACTED_AWS_KEY>"),
    (re.compile(r"\bASIA[0-9A-Z]{16}\b"), "<REDACTED_AWS_TEMP_KEY>"),
    (re.compile(r"\bsk_live_[A-Za-z0-9]{10,}\b"), "<REDACTED_STRIPE_KEY>"),
    (re.compile(r"\bpk_live_[A-Za-z0-9]{10,}\b"), "<REDACTED_STRIPE_KEY>"),
    (re.compile(r"\bsk_test_[A-Za-z0-9]{10,}\b"), "<REDACTED_STRIPE_KEY>"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b"), "<REDACTED_SLACK_TOKEN>"),
    (
        re.compile(
            r"\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|amqps)://[^:\s/\"'<>]+:[^@\s/\"'<>]+@[^\s\"'<>]+",
            re.I,
        ),
        "<REDACTED_DB_URL>",
    ),
    (re.compile(r"-----BEGIN [A-Z ]+PRIVATE KEY-----"), "<REDACTED_PRIVATE_KEY_BEGIN>"),
    (re.compile(r"-----END [A-Z ]+PRIVATE KEY-----"), "<REDACTED_PRIVATE_KEY_END>"),
]

_ASSIGNMENT_RE = re.compile(
    r"((?:password|passwd|pwd|api[_-]?key|access[_-]?key|secret[_-]?key|secret|token|auth[_-]?token|bearer)\s*[:=]\s*[\"'])"
    r"(?!<REDACTED_)[^\"'\n]{4,}"
    r"([\"'])",
    re.I,
)


def redact_secrets(text: str) -> str:
    """Replace credential-shaped substrings inside ``text`` with labelled
    placeholders.

    Safe to apply to arbitrary code. Only literal-looking secrets get
    replaced; ordinary identifiers (``apiKeyVar``, ``process.env.API_KEY``,
    function names) survive untouched.

    The function is idempotent — the assignment fallback's negative
    lookahead means a second pass doesn't degrade vendor-specific
    placeholders.
    """
    if not text:
        return text
    out = text
    for rx, replacement in _SECRET_PATTERNS:
        out = rx.sub(replacement, out)
    out = _ASSIGNMENT_RE.sub(r"\1<REDACTED_SECRET>\2", out)
    return out
