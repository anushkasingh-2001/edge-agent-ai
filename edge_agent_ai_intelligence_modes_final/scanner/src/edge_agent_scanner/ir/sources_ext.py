"""Extended taint *source* classification for intelligence-mode rules.

This module is ADDITIVE. The original ``ir/sources.py`` keeps its
``USER_INPUT_PATTERNS`` / ``classify_source`` API untouched; this file
adds the new source categories the OneKE-class findings need:

  * ``config``     — values loaded from YAML/JSON/env/settings. The
                     source of "config-controlled file read" and
                     "env-proxy mutation".
  * ``llm_output`` — text returned by a model call. The source of
                     "LLM-generated code -> exec" and "unsafe Cypher
                     from model output".
  * framework user-input — request params for FastAPI/Flask/Express/
                     Next.js, CLI argparse, MCP tool args.

Why a new module instead of editing sources.py: keeps the original,
well-tested patterns stable and lets the new rules import a richer
classifier without risk of regressing the existing
``user-input-dangerous-code`` analyzer. ``engine.py`` wires these in via
the new analyzers only.
"""

from __future__ import annotations

import re

# Config-derived values. Anything read from these is attacker-influenced
# in a "config controls behaviour" threat model (a poisoned config file,
# an env var set by an upstream service, a settings object built from
# request data).
CONFIG_SOURCE_PATTERNS = [
    re.compile(r"\byaml\.(safe_load|load|full_load)\s*\(", re.I),
    re.compile(r"\bjson\.load\s*\(", re.I),
    re.compile(r"\bjson\.loads\s*\(", re.I),
    re.compile(r"\bconfigparser\b", re.I),
    re.compile(r"\bdotenv\b|\bload_dotenv\b", re.I),
    re.compile(r"\bBaseSettings\b|\bpydantic_settings\b", re.I),
    re.compile(r"\bos\.environ(\.get)?\b|\bos\.getenv\s*\(", re.I),
    re.compile(r"\bprocess\.env\b", re.I),
    re.compile(r"\btoml\.(load|loads)\s*\(", re.I),
]

# Output of a model / LLM call. These names are intentionally broad —
# the IR builder normalizes call expressions, but extraction pipelines
# assign model output to many local names. We rely on (a) these tokens
# and (b) graph edges from a ModelNode for higher-confidence cases.
LLM_OUTPUT_PATTERNS = [
    re.compile(r"\.(invoke|predict|generate|complete|chat)\s*\(", re.I),
    re.compile(r"\.messages\.create\s*\(", re.I),
    re.compile(r"\.chat\.completions\.create\s*\(", re.I),
    re.compile(r"\.generate_content\s*\(", re.I),
    re.compile(r"\bcompletion\.choices\b", re.I),
    re.compile(r"\bresponse\.(content|text|output_text)\b", re.I),
    re.compile(r"\b(llm_output|model_output|completion_text|generated_code|"
               r"extraction_result|extracted|raw_completion)\b", re.I),
]

# Framework-level user input (extends the base USER_INPUT_PATTERNS).
FRAMEWORK_USER_INPUT_PATTERNS = [
    # FastAPI / Starlette
    re.compile(r"\b(Request|UploadFile)\b.*\b(body|json|form|query_params)\b", re.I),
    re.compile(r"\bawait\s+request\.(json|body|form)\s*\(", re.I),
    # Flask
    re.compile(r"\brequest\.(args|json|form|values|files|data)\b", re.I),
    # argparse / click CLI
    re.compile(r"\bargs\.\w+\b|\bparser\.parse_args\b|\bclick\.(argument|option)\b", re.I),
    # Express / Next.js
    re.compile(r"\breq\.(body|query|params)\b|\brequest\.(body|query|nextUrl)\b", re.I),
    # MCP tool argument
    re.compile(r"\b(tool_input|arguments|tool_args|mcp_args)\b", re.I),
]


def classify_config_source(label: str) -> str | None:
    """Return ``"config"`` if the label looks like a config/env read."""
    for rx in CONFIG_SOURCE_PATTERNS:
        if rx.search(label):
            return "config"
    return None


def classify_llm_output_source(label: str) -> str | None:
    """Return ``"llm_output"`` if the label looks like model output."""
    for rx in LLM_OUTPUT_PATTERNS:
        if rx.search(label):
            return "llm_output"
    return None


def classify_framework_user_input(label: str) -> str | None:
    """Return ``"untrusted_input"`` for framework request params."""
    for rx in FRAMEWORK_USER_INPUT_PATTERNS:
        if rx.search(label):
            return "untrusted_input"
    return None


def classify_extended_source(label: str) -> str | None:
    """Single entry point: try config, then llm_output, then framework
    user input. Returns the source kind or ``None``.

    Order matters: config and llm_output are more specific than the
    generic user-input fallback handled by the base ``classify_source``.
    """
    return (
        classify_config_source(label)
        or classify_llm_output_source(label)
        or classify_framework_user_input(label)
    )
