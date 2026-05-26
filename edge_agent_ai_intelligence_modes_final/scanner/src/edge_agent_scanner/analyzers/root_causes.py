"""Root-cause analyzers for the OneKE-class issues the scanner missed.

Each detector here addresses a specific gap the builder reported:

  1. prompt-injection-placeholder    user/config/LLM text -> prompt template
  2. cypher-injection-from-llm-or-user  model/user output -> Cypher exec
  3. config-controlled-file-read      config/env path -> file read
  4. default-db-credentials           hardcoded weak DB creds
  5. env-proxy-mutation               user/config -> os.environ proxy keys
  6. llm-codegen-to-exec              model output -> exec/eval/compile

Design
------
These run as a single analyzer (one ``analyze_root_causes(ir, files)``
entry, matching the existing analyzer signature) so ``engine.py`` adds
exactly one line. Detection is line-oriented over ``ScannedFile`` with a
bounded look-back window to connect a source assignment to a sink use —
the same pragmatic style the existing analyzers use, but enriched with
the IR sink/source classifiers so confidence reflects real evidence.

All findings use the shared ``make_finding`` + ``annotate_finding`` so
they get the same confidence band / escalation treatment as the rest of
the scanner. Severity and rule_id are deterministic; the LLM never sees
these until a user opens the finding.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_finding
from edge_agent_scanner.ir.models import AgentIR, CodeLocation
from edge_agent_scanner.ir.redact import redact_secrets
from edge_agent_scanner.ir.sinks_ext import (
    classify_sink_ext,
    env_key_in_expression,
    is_cypher_parameterized,
)
from edge_agent_scanner.ir.sources_ext import (
    classify_config_source,
    classify_framework_user_input,
    classify_llm_output_source,
)
from edge_agent_scanner.walker import ScannedFile

# How many lines to look back to connect a tainted assignment to a sink.
_WINDOW = 25

# New rule ids emitted by this analyzer. Mirrored in report.ALL_RULE_IDS
# (see IMPLEMENTATION_NOTES — the engine patch adds these) and in the TS
# SCANNER_RULE_IDS set.
RULE_PROMPT_INJECTION_PLACEHOLDER = "prompt-injection-placeholder"
RULE_CYPHER_INJECTION = "cypher-injection-from-llm-or-user"
RULE_CONFIG_FILE_READ = "config-controlled-file-read"
RULE_DEFAULT_DB_CREDS = "default-db-credentials"
RULE_ENV_PROXY_MUTATION = "env-proxy-mutation"
RULE_LLM_CODEGEN_EXEC = "llm-codegen-to-exec"

# Guard tokens that neutralize each rule on a path (used to suppress).
_PROMPT_SANITIZERS = re.compile(
    r"(escape_braces|sanitize_prompt|escape\(|re\.escape|bleach\.|html\.escape|"
    r"strip_injection|allowlist)", re.I
)
_PATH_GUARDS = re.compile(
    r"(\.resolve\(\)|is_relative_to|realpath|safe_join|secure_filename|allowlist|"
    r"startswith\()", re.I
)
_CODEGEN_GUARDS = re.compile(
    r"(RestrictedPython|asteval|ast\.literal_eval|ast\.parse|allow_?list|sandbox)", re.I
)

# Default / weak DB credential pairs. Kept inline + extensible via
# data/default_credentials.json (loaded if present).
_DEFAULT_CRED_PAIRS = {
    ("neo4j", "neo4j"), ("neo4j", "password"), ("root", "root"),
    ("admin", "admin"), ("postgres", "postgres"), ("sa", "sa"),
    ("root", ""), ("admin", ""), ("user", "password"),
}
_WEAK_PASSWORDS = {"", "password", "changeme", "admin", "root", "123456",
                   "postgres", "neo4j", "secret", "test"}

_DRIVER_CTOR_RX = re.compile(
    r"(GraphDatabase\.driver|psycopg2\.connect|pymongo\.MongoClient|redis\.Redis|"
    r"create_engine|MongoClient|connect)\s*\(", re.I
)
_AUTH_TUPLE_RX = re.compile(r"""auth\s*=\s*\(\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]\s*\)""")
_PASSWORD_KW_RX = re.compile(r"""(password|passwd|pwd)\s*=\s*['"]([^'"]*)['"]""", re.I)

# Prompt construction patterns (where a tainted value could be injected).
_PROMPT_BUILD_RX = re.compile(
    r"(f['\"].*\{.*\}.*['\"]|\.format\s*\(|PromptTemplate|ChatPromptTemplate|"
    r"\.from_template\s*\(|render\s*\(|Template\s*\()", re.I
)


@dataclass
class _Line:
    no: int
    text: str


def _loc(sf: ScannedFile, line_no: int, symbol: str | None = None) -> CodeLocation:
    return CodeLocation(
        file=sf.rel_path, start_line=line_no, end_line=line_no, symbol=symbol
    )


def _window_before(lines: list[str], idx: int, n: int = _WINDOW) -> str:
    start = max(0, idx - n)
    return "\n".join(lines[start:idx])


def _emit(
    *, rule_id, severity, category, title, sf, line_no, reason, fix, evidence,
    code, confidence, source_untrusted=True, unguarded=True, path_len=2,
    partial_guard=False,
):
    f = make_finding(
        rule_id=rule_id,
        severity=severity,
        category=category,
        title=title,
        location=_loc(sf, line_no),
        reason=reason,
        suggested_fix=fix,
        evidence=evidence,
        code=redact_secrets(code) if code else "",
        confidence=confidence,
    )
    annotate_finding(
        f,
        ConfidenceFeatures(
            sink_impact=severity,
            source_untrusted=source_untrusted,
            unguarded_path_exists=unguarded,
            path_length=path_len,
            partial_guard=partial_guard,
            ir_evidence=True,
            exact_sink_match=True,
            prod_file=is_prod_file(sf.rel_path),
        ),
    )
    return f


# --------------------------------------------------------------------------- #
# 1. Prompt injection via user/config/LLM-controlled placeholder
# --------------------------------------------------------------------------- #
def _detect_prompt_injection_placeholder(sf: ScannedFile) -> list:
    out = []
    lines = sf.lines
    for i, raw in enumerate(lines):
        if not _PROMPT_BUILD_RX.search(raw):
            continue
        window = _window_before(lines, i) + "\n" + raw
        tainted = (
            classify_framework_user_input(window)
            or classify_config_source(window)
            or classify_llm_output_source(window)
        )
        if not tainted:
            continue
        guarded = bool(_PROMPT_SANITIZERS.search(window))
        out.append(
            _emit(
                rule_id=RULE_PROMPT_INJECTION_PLACEHOLDER,
                severity="high" if not guarded else "medium",
                category="Prompt security",
                title="User/config-controlled value enters an LLM prompt template",
                sf=sf,
                line_no=i + 1,
                reason=(
                    "An untrusted value (request/config/model output) is interpolated "
                    "into a prompt via f-string/.format()/PromptTemplate without an "
                    "injection guard. An attacker can override the system instruction "
                    "(prompt injection)."
                ),
                fix=(
                    "Separate untrusted data from instructions: pass user text as a "
                    "distinct message/variable, escape template braces, and add an "
                    "injection allowlist/sanitizer before rendering."
                ),
                evidence=raw.strip()[:200],
                code=raw,
                confidence=0.86 if not guarded else 0.6,
                partial_guard=guarded,
            )
        )
    return out


# --------------------------------------------------------------------------- #
# 2. Unsafe Cypher / Neo4j from model/user output
# --------------------------------------------------------------------------- #
def _detect_cypher_injection(sf: ScannedFile) -> list:
    out = []
    lines = sf.lines
    for i, raw in enumerate(lines):
        sink = classify_sink_ext(raw)
        if not sink or sink.kind != "cypher":
            continue
        if is_cypher_parameterized(raw):
            continue  # safe: parameter binding
        window = _window_before(lines, i) + "\n" + raw
        tainted_llm = classify_llm_output_source(window)
        tainted_user = classify_framework_user_input(window)
        # Only flag when the query is built dynamically AND fed by a
        # model/user source — a static query string is fine.
        dynamic = bool(re.search(r"f['\"]|\.format\(|\+\s*\w+|%\s", raw)) or bool(
            re.search(r"query\s*=\s*f|cypher\s*=\s*f", window)
        )
        if not dynamic:
            continue
        if not (tainted_llm or tainted_user):
            # still suspicious (dynamic cypher) but lower confidence
            conf, sev, src = 0.55, "medium", False
        else:
            conf, sev, src = 0.9, "high", True
        out.append(
            _emit(
                rule_id=RULE_CYPHER_INJECTION,
                severity=sev,
                category="Injection",
                title="Cypher query built from untrusted/model output without parameter binding",
                sf=sf,
                line_no=i + 1,
                reason=(
                    "A Neo4j/Cypher query is assembled with string interpolation from "
                    "model extraction output or user input and executed via session.run/"
                    "tx.run/execute_query. This is a graph-injection sink equivalent to "
                    "SQL injection."
                ),
                fix=(
                    "Use parameterized Cypher: session.run('MATCH (n) WHERE n.name=$name', "
                    "name=value). Never f-string user/model text into the query."
                ),
                evidence=raw.strip()[:200],
                code=raw,
                confidence=conf,
                source_untrusted=src,
            )
        )
    return out


# --------------------------------------------------------------------------- #
# 3. Config-controlled arbitrary file read
# --------------------------------------------------------------------------- #
def _detect_config_file_read(sf: ScannedFile) -> list:
    out = []
    lines = sf.lines
    for i, raw in enumerate(lines):
        sink = classify_sink_ext(raw)
        if not sink or sink.kind != "file_read":
            continue
        window = _window_before(lines, i) + "\n" + raw
        tainted = classify_config_source(window) or classify_framework_user_input(window)
        if not tainted:
            continue
        if _PATH_GUARDS.search(window):
            continue  # path is resolved/checked
        out.append(
            _emit(
                rule_id=RULE_CONFIG_FILE_READ,
                severity="high",
                category="Path traversal",
                title="File read from a config/request-controlled path without restriction",
                sf=sf,
                line_no=i + 1,
                reason=(
                    "A filesystem read uses a path that originates from config/env/request "
                    "data with no canonicalization or base-directory check. An attacker who "
                    "controls the config can read arbitrary files (e.g. /etc/passwd)."
                ),
                fix=(
                    "Resolve the path and assert it stays under an allowed base dir: "
                    "p = (BASE / user_path).resolve(); assert p.is_relative_to(BASE)."
                ),
                evidence=raw.strip()[:200],
                code=raw,
                confidence=0.84,
            )
        )
    return out


# --------------------------------------------------------------------------- #
# 4. Insecure default database credentials
# --------------------------------------------------------------------------- #
def _detect_default_db_credentials(sf: ScannedFile, extra_pairs=None) -> list:
    out = []
    pairs = set(_DEFAULT_CRED_PAIRS)
    if extra_pairs:
        pairs |= extra_pairs
    lines = sf.lines
    for i, raw in enumerate(lines):
        if not _DRIVER_CTOR_RX.search(raw):
            continue
        window = raw + "\n" + "\n".join(lines[i + 1 : i + 4])  # ctor may span lines
        hit_user = hit_pw = None
        m = _AUTH_TUPLE_RX.search(window)
        if m:
            hit_user, hit_pw = m.group(1), m.group(2)
        else:
            mp = _PASSWORD_KW_RX.search(window)
            if mp:
                hit_pw = mp.group(2)
        is_default = False
        if hit_user is not None and (hit_user, hit_pw) in pairs:
            is_default = True
        elif hit_pw is not None and hit_pw.lower() in _WEAK_PASSWORDS:
            is_default = True
        if not is_default:
            continue
        out.append(
            _emit(
                rule_id=RULE_DEFAULT_DB_CREDS,
                severity="high",
                category="Secrets",
                title="Insecure default/weak database credentials",
                sf=sf,
                line_no=i + 1,
                reason=(
                    "A database driver is constructed with default or trivially weak "
                    "credentials (e.g. neo4j/neo4j, root/root, empty password). These are "
                    "well-known and trivially brute-forced."
                ),
                fix=(
                    "Load credentials from environment/secret store: "
                    "auth=(os.environ['DB_USER'], os.environ['DB_PASSWORD']); rotate the "
                    "default password."
                ),
                evidence=(raw.strip()[:120]),
                code=raw,
                confidence=0.9,
                source_untrusted=False,
            )
        )
    return out


# --------------------------------------------------------------------------- #
# 5. Global os.environ proxy/base-url mutation from user/config
# --------------------------------------------------------------------------- #
def _detect_env_proxy_mutation(sf: ScannedFile) -> list:
    out = []
    lines = sf.lines
    for i, raw in enumerate(lines):
        sink = classify_sink_ext(raw)
        if not sink or sink.kind != "env_mutation":
            continue
        key = env_key_in_expression(raw)
        if not key:
            continue
        window = _window_before(lines, i) + "\n" + raw
        tainted = classify_config_source(window) or classify_framework_user_input(window)
        # Even a hardcoded mutation of PROXY/BASE_URL is worth flagging at
        # medium; config/user-controlled bumps it to high.
        sev = "high" if tainted else "medium"
        out.append(
            _emit(
                rule_id=RULE_ENV_PROXY_MUTATION,
                severity=sev,
                category="Configuration",
                title=f"Global environment mutation of sensitive key {key}",
                sf=sf,
                line_no=i + 1,
                reason=(
                    f"The process-global environment variable {key} is mutated at runtime"
                    + (" from config/request data" if tainted else "")
                    + ". Redirecting a proxy or API base URL can route every outbound "
                    "model/API call through an attacker-controlled endpoint."
                ),
                fix=(
                    "Avoid mutating os.environ for network routing. Pass an explicit, "
                    "validated client config (base_url, proxies) to the SDK instead, and "
                    "allowlist permitted hosts."
                ),
                evidence=raw.strip()[:200],
                code=raw,
                confidence=0.8 if tainted else 0.6,
                source_untrusted=bool(tainted),
            )
        )
    return out


# --------------------------------------------------------------------------- #
# 6. LLM-generated code -> exec/eval chain
# --------------------------------------------------------------------------- #
def _detect_llm_codegen_to_exec(sf: ScannedFile) -> list:
    out = []
    lines = sf.lines
    for i, raw in enumerate(lines):
        sink = classify_sink_ext(raw)
        if not sink or sink.kind != "code_exec":
            continue
        window = _window_before(lines, i) + "\n" + raw
        tainted = classify_llm_output_source(window)
        if not tainted:
            continue
        if _CODEGEN_GUARDS.search(window):
            continue  # RestrictedPython / asteval / allowlist present
        out.append(
            _emit(
                rule_id=RULE_LLM_CODEGEN_EXEC,
                severity="critical",
                category="Code execution",
                title="LLM-generated code is executed dynamically",
                sf=sf,
                line_no=i + 1,
                reason=(
                    "Model output (generated code / extracted snippet) flows into "
                    "exec/eval/compile/subprocess without a sandbox or allowlist. A prompt "
                    "injection that influences the generated code becomes remote code "
                    "execution."
                ),
                fix=(
                    "Do not exec model output. If dynamic evaluation is unavoidable, use a "
                    "sandbox (RestrictedPython/asteval) with an allowlist of operations, or "
                    "constrain the model to emit data (JSON) you interpret yourself."
                ),
                evidence=raw.strip()[:200],
                code=raw,
                confidence=0.95,
                path_len=2,
            )
        )
    return out


def _load_extra_cred_pairs(repo_root=None) -> set:
    """Optionally load data/default_credentials.json from the package."""
    try:
        import json
        from importlib import resources

        with resources.files("edge_agent_scanner.data").joinpath(
            "default_credentials.json"
        ).open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return {(p["user"], p["password"]) for p in data.get("pairs", [])}
    except Exception:
        return set()


def analyze_root_causes(ir: AgentIR, files: list[ScannedFile]) -> list:
    """Single analyzer entry point wired into ``engine.run_scan``."""
    findings: list = []
    extra_pairs = _load_extra_cred_pairs()
    for sf in files:
        # Only scan source-like files; skip obviously irrelevant text.
        lower = sf.rel_path.lower()
        if lower.endswith((".md", ".txt", ".lock", ".json")) and "config" not in lower:
            continue
        findings.extend(_detect_prompt_injection_placeholder(sf))
        findings.extend(_detect_cypher_injection(sf))
        findings.extend(_detect_config_file_read(sf))
        findings.extend(_detect_default_db_credentials(sf, extra_pairs))
        findings.extend(_detect_env_proxy_mutation(sf))
        findings.extend(_detect_llm_codegen_to_exec(sf))
    return findings
