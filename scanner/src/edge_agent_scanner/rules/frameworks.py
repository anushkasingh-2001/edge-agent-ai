"""Detect AI/agent frameworks from manifests and source imports."""

from __future__ import annotations

import re
from collections import defaultdict

from edge_agent_scanner.report import FrameworkHit
from edge_agent_scanner.walker import ScannedFile

# requirement / package name substring -> canonical framework name
_DEP_KEYWORDS: list[tuple[str, str]] = [
    ("langgraph", "LangGraph"),
    ("langchain", "LangChain"),
    ("llama-index", "LlamaIndex"),
    ("llama_index", "LlamaIndex"),
    ("pydantic-ai", "Pydantic AI"),
    ("pydantic_ai", "Pydantic AI"),
    ("agno", "Agno"),
    ("@modelcontextprotocol", "MCP"),
    ("mcp-", "MCP"),
    ("openapi", "OpenAPI"),
]

_IMPORT_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\blanggraph\b", re.I), "LangGraph"),
    (re.compile(r"\blangchain\b", re.I), "LangChain"),
    (re.compile(r"\bllama_index\b|\bllama-index\b", re.I), "LlamaIndex"),
    (re.compile(r"\bpydantic_ai\b|\bpydantic-ai\b", re.I), "Pydantic AI"),
    # Require import syntax so UI strings like "Agno" in mock data are not counted as the Agno framework
    (re.compile(r"^\s*(from|import)\s+agno\b", re.I), "Agno"),
    (re.compile(r"\bmcp\b|modelcontextprotocol|ModelContextProtocol", re.I), "MCP"),
    (re.compile(r"openapi|swagger", re.I), "OpenAPI"),
]


def _scan_manifest_line(line: str, rel_path: str, evidence: dict[str, set[str]]) -> None:
    low = line.lower().strip()
    if not low or low.startswith("#"):
        return
    for key, name in _DEP_KEYWORDS:
        if key in low:
            evidence[name].add(rel_path)


def detect_frameworks(files: list[ScannedFile]) -> list[FrameworkHit]:
    evidence: dict[str, set[str]] = defaultdict(set)

    for sf in files:
        name_lower = sf.rel_path.lower()
        if name_lower.endswith(("requirements.txt", "requirements-dev.txt")):
            for line in sf.lines:
                _scan_manifest_line(line, sf.rel_path, evidence)
        elif name_lower.endswith("pyproject.toml") or name_lower.endswith("poetry.lock"):
            blob = "\n".join(sf.lines)
            low = blob.lower()
            for key, fname in _DEP_KEYWORDS:
                if key in low:
                    evidence[fname].add(sf.rel_path)
        elif name_lower.endswith("package.json"):
            blob = "\n".join(sf.lines)
            low = blob.lower()
            for key, fname in _DEP_KEYWORDS:
                if key in low:
                    evidence[fname].add(sf.rel_path)

        if sf.rel_path.endswith((".py", ".ts", ".tsx", ".js", ".jsx")):
            for line in sf.lines:
                for rx, fname in _IMPORT_PATTERNS:
                    if rx.search(line):
                        evidence[fname].add(sf.rel_path)

    hits = [FrameworkHit(name=k, evidence=sorted(v)) for k, v in sorted(evidence.items())]
    return hits
