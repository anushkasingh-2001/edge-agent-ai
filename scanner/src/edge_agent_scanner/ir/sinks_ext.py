"""Extended taint *sink* classification for intelligence-mode rules.

ADDITIVE companion to ``ir/sinks.py`` (which owns the large side-effect
ruleset). This file defines the new sink categories the OneKE-class
findings need, plus a downgrade helper for the over-fired
``json.dumps``/tempfile-cleanup signals.

Sink kinds defined here:
  * ``cypher``        Neo4j / py2neo query execution.
  * ``file_read``     filesystem reads (path may be attacker-controlled).
  * ``env_mutation``  writes to the global process environment.
  * ``code_exec``     dynamic code execution (exec/eval/compile/shell).
  * ``network``       outbound network calls (the real export sink).
  * ``prompt``        text consumed by a model call as a prompt.

These are matched against a *call expression* string (the same
``SinkNode.call_expression`` / ``source_line`` the IR already captures),
so no parser change is required to start using them. The IR builder can
later attach a structured ``kind`` to each ``SinkNode``; until then the
new analyzers call ``classify_sink_ext`` on the captured expression.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# --- Cypher / graph DB execution -------------------------------------------
CYPHER_SINK_PATTERNS = [
    re.compile(r"\.(run|execute_query)\s*\(", re.I),          # session.run / driver.execute_query
    re.compile(r"\btx\.run\s*\(", re.I),                       # explicit transaction
    re.compile(r"\bGraph\(\s*\)\.run\b|\bgraph\.run\s*\(", re.I),  # py2neo
    re.compile(r"\bneo4j\b.*\.(run|execute)", re.I),
]

# --- Filesystem reads -------------------------------------------------------
FILE_READ_SINK_PATTERNS = [
    re.compile(r"\bopen\s*\(", re.I),
    re.compile(r"\bPath\([^)]*\)\.(read_text|read_bytes|open)\b", re.I),
    re.compile(r"\b(pd|pandas)\.read_csv\s*\(", re.I),
    re.compile(r"\bpdfplumber\.open\s*\(", re.I),
    re.compile(r"\bdocx\.Document\s*\(", re.I),
    re.compile(r"\bfs\.(readFile|readFileSync)\s*\(", re.I),
]

# --- Global environment mutation -------------------------------------------
ENV_MUTATION_SINK_PATTERNS = [
    re.compile(r"\bos\.environ\s*\[", re.I),                    # os.environ["X"] = ...
    re.compile(r"\bos\.environ\.(update|setdefault)\s*\(", re.I),
    re.compile(r"\bprocess\.env\.\w+\s*=", re.I),               # JS
]

# Env keys whose mutation is security-relevant (proxy/base-url/loader).
SENSITIVE_ENV_KEYS = [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "OPENAI_BASE_URL", "OPENAI_API_BASE", "ANTHROPIC_BASE_URL",
    "GOOGLE_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "PYTHONPATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
    "NODE_OPTIONS", "PATH",
]

# --- Dynamic code execution -------------------------------------------------
CODE_EXEC_SINK_PATTERNS = [
    re.compile(r"\bexec\s*\(", re.I),
    re.compile(r"\beval\s*\(", re.I),
    re.compile(r"\bcompile\s*\(", re.I),
    re.compile(r"\brunpy\.run_(path|module)\s*\(", re.I),
    re.compile(r"\bimportlib\.import_module\s*\(", re.I),
    re.compile(r"\bos\.system\s*\(", re.I),
    re.compile(r"\bsubprocess\.(Popen|run|call|check_output)\s*\([^)]*shell\s*=\s*True", re.I),
    re.compile(r"\bnew\s+Function\s*\(", re.I),                 # JS
    re.compile(r"\bchild_process\.(exec|execSync)\s*\(", re.I),  # JS
]

# --- Outbound network (the REAL export sink, not json.dumps) ---------------
NETWORK_SINK_PATTERNS = [
    re.compile(r"\brequests\.(post|put|patch|get)\s*\(", re.I),
    re.compile(r"\bhttpx\.(AsyncClient|Client)?\.?(post|put|patch|get)\s*\(", re.I),
    re.compile(r"\baiohttp\b", re.I),
    re.compile(r"\burllib\.request\.(urlopen|Request)\s*\(", re.I),
    re.compile(r"\bfetch\s*\(", re.I),
    re.compile(r"\baxios\.(post|put|patch|get)\s*\(", re.I),
]

# --- Prompt sink (text -> model) -------------------------------------------
PROMPT_SINK_PATTERNS = [
    re.compile(r"\.messages\.create\s*\(", re.I),
    re.compile(r"\.chat\.completions\.create\s*\(", re.I),
    re.compile(r"\.generate_content\s*\(", re.I),
    re.compile(r"\.(invoke|predict|run|complete)\s*\(", re.I),
    re.compile(r"\bPromptTemplate\b|\bChatPromptTemplate\b", re.I),
]

# --- Signals to DOWNGRADE (formerly over-fired) ----------------------------
# json.dumps alone is a transform, not an export. Only meaningful when its
# result reaches a NETWORK_SINK / FILE write — handled by the analyzer's
# taint check, not by flagging the call itself.
JSON_DUMP_PATTERNS = [
    re.compile(r"\bjson\.dumps\s*\(", re.I),
    re.compile(r"\bJSON\.stringify\s*\(", re.I),
]

# tempfile lifecycle: a write/delete on a tempfile-created handle inside the
# same function or try/finally is benign cleanup, not a dangerous file op.
TEMPFILE_CREATE_PATTERNS = [
    re.compile(r"\btempfile\.(NamedTemporaryFile|TemporaryDirectory|mkstemp|mkdtemp)\s*\(", re.I),
    re.compile(r"\bTemporaryDirectory\s*\(", re.I),
]


@dataclass(frozen=True)
class SinkClass:
    kind: str            # cypher | file_read | env_mutation | code_exec | network | prompt
    impact: str          # low | medium | high | critical


_SINK_TABLE: list[tuple[list[re.Pattern[str]], SinkClass]] = [
    (CODE_EXEC_SINK_PATTERNS, SinkClass("code_exec", "critical")),
    (CYPHER_SINK_PATTERNS, SinkClass("cypher", "high")),
    (ENV_MUTATION_SINK_PATTERNS, SinkClass("env_mutation", "high")),
    (FILE_READ_SINK_PATTERNS, SinkClass("file_read", "high")),
    (NETWORK_SINK_PATTERNS, SinkClass("network", "medium")),
    (PROMPT_SINK_PATTERNS, SinkClass("prompt", "medium")),
]


def classify_sink_ext(call_expression: str) -> SinkClass | None:
    """Classify a captured call expression into one of the new sink kinds.

    Returns ``None`` when no extended sink matches (the base side-effect
    ruleset in ``ir/sinks.py`` still applies). Code-exec is checked first
    because it is the most dangerous and its patterns are unambiguous.
    """
    if not call_expression:
        return None
    for patterns, sink_class in _SINK_TABLE:
        if any(rx.search(call_expression) for rx in patterns):
            return sink_class
    return None


def is_cypher_parameterized(call_expression: str) -> bool:
    """True when a Cypher call binds parameters instead of interpolating.

    ``session.run(query, {"name": name})`` or ``session.run(query, name=x)``
    is safe; ``session.run(f"... {name} ...")`` is not. Heuristic: a comma
    after the first string argument, or a ``$param`` placeholder, or a
    ``parameters=``/``params=`` kwarg, indicates binding.
    """
    if "$" in call_expression:
        return True
    if re.search(r"parameters\s*=|params\s*=", call_expression):
        return True
    # `.run(query, {...})` or `.run(query, key=val)` — a second arg present
    # and the first arg is NOT an f-string / concatenation.
    has_fstring = re.search(r'\.run\s*\(\s*f["\']', call_expression)
    has_concat = re.search(r'\.run\s*\([^)]*\+', call_expression)
    has_format = re.search(r'\.run\s*\([^)]*\.format\(', call_expression)
    if has_fstring or has_concat or has_format:
        return False
    # second positional arg → likely a params dict
    return bool(re.search(r'\.run\s*\([^,)]+,', call_expression))


def is_json_dump(call_expression: str) -> bool:
    return any(rx.search(call_expression) for rx in JSON_DUMP_PATTERNS)


def is_tempfile_create(call_expression: str) -> bool:
    return any(rx.search(call_expression) for rx in TEMPFILE_CREATE_PATTERNS)


def env_key_in_expression(call_expression: str) -> str | None:
    """Return the first sensitive env key referenced in the expression."""
    for key in SENSITIVE_ENV_KEYS:
        if key in call_expression:
            return key
    return None
