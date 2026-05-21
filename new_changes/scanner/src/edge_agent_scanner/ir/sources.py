from __future__ import annotations

import re

USER_INPUT_PATTERNS = [
    re.compile(r"request\.(args|json|form|body|data|files)", re.I),
    re.compile(r"\.get\(\s*['\"](q|query|input|message|prompt|cmd|command)['\"]", re.I),
    re.compile(r"(user_message|user_input|human_input|uploaded_file|webhook_payload)", re.I),
    re.compile(r"(retrieved_doc|rag_context|document_text|webpage_text|email_body|tool_output|mcp_resource)", re.I),
]


def classify_source(label: str) -> str | None:
    for rx in USER_INPUT_PATTERNS:
        if rx.search(label):
            return "untrusted_input"
    return None
