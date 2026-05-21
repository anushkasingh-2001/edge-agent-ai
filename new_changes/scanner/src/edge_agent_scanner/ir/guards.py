from __future__ import annotations

import re

APPROVAL_PATTERNS = [
    re.compile(r"(confirm_before_execute|requires_approval|human_review|manual_gate|human_in_the_loop|interrupt)", re.I),
    re.compile(r"(approval_required|require_confirmation|approve_before|approval_gate)", re.I),
]

AUTH_PATTERNS = [
    re.compile(r"(get_current_user|require_auth|requireAuth|authMiddleware|login_required|jwt\.verify|session)", re.I),
    re.compile(r"(permission|authorize|policy\.|role|scope|tenant|owner)", re.I),
]

VALIDATION_PATTERNS = [
    re.compile(r"(pydantic|BaseModel|zod|joi|schema\.validate|validate_|allowlist|whitelist)", re.I),
    re.compile(r"(parameterized|bindparam|safe_path|shlex\.quote|sanitize|escape)", re.I),
]


def classify_guard(label: str) -> list[str]:
    guards: list[str] = []
    if any(rx.search(label) for rx in APPROVAL_PATTERNS):
        guards.append("approval")
    if any(rx.search(label) for rx in AUTH_PATTERNS):
        guards.append("auth")
    if any(rx.search(label) for rx in VALIDATION_PATTERNS):
        guards.append("validation")
    return sorted(set(guards))
