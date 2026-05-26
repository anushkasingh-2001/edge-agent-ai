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
    env_key_category,
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
# Notice: the bare f-string match is INTENTIONALLY broad here — it gates
# the cheap "could this even be a prompt build site?" check. The
# follow-up _PROMPT_SINK_RX requirement is what prevents diagnostic
# `print(f"...")` / logging / status messages from being labelled a
# prompt-injection sink.
_PROMPT_BUILD_RX = re.compile(
    r"(f['\"].*\{.*\}.*['\"]|\.format\s*\(|PromptTemplate|ChatPromptTemplate|"
    r"\.from_template\s*\(|render\s*\(|Template\s*\()", re.I
)

# Concrete LLM/prompt sinks. A prompt-injection finding requires the
# constructed string to FLOW INTO one of these on the same line or via
# an assignment within the local lookback window. `print(...)`,
# `logger.info(...)`, status banners, and similar diagnostic emitters
# are deliberately NOT in this set.
_PROMPT_SINK_RX = re.compile(
    r"\b("
    r"(?:client\.|openai\.|self\.client\.)?(?:chat\.completions\.create|completions\.create|responses\.create)"
    r"|\.messages\.create"
    r"|\.generate_content"
    r"|\.(?:invoke|predict|complete|chat|run|stream)\s*\("
    r"|PromptTemplate\b|ChatPromptTemplate\b|\.from_template\b"
    r"|\bSystemMessage\b|\bHumanMessage\b|\bAIMessage\b|\bChatMessage\b"
    r"|\bSystemMessagePromptTemplate\b|\bHumanMessagePromptTemplate\b"
    r"|tokenizer\.\w*encode|\.apply_chat_template"
    r"|model\.generate\s*\("
    r"|pipeline\s*\(\s*['\"](?:text-generation|text2text-generation|conversational)"
    r"|messages\s*=\s*\["
    r"|prompt\s*=\s*"
    r")",
    re.I,
)

# Callers that consume the string but DO NOT pass it to an LLM. If the
# f-string is wrapped in any of these on the same line and no LLM sink
# is reachable, the finding must be suppressed — these are diagnostic
# emitters, not prompt sinks.
_NON_LLM_CONSUMER_RX = re.compile(
    r"\b("
    r"print|sys\.stdout\.write|sys\.stderr\.write"
    r"|logger\.\w+|logging\.\w+|log\.\w+"
    r"|raise\b|warnings\.warn|warn\b"
    r"|tqdm\b|click\.echo|typer\.echo"
    r"|st\.(?:write|info|warning|error|success|text|caption|markdown|code|metric|toast)"
    r"|f-?string|assert\b"
    r")\s*\(",
    re.I,
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
# How many lines AFTER the candidate to scan when looking for the
# downstream LLM sink. Most prompts are built and then immediately
# passed into an LLM call within a few lines.
_FORWARD_WINDOW = 12


def _line_assigns_to(raw: str) -> str | None:
    """Return the bare LHS variable name if ``raw`` is a simple
    assignment like ``prompt = f"..."`` / ``messages = [...]``. None
    otherwise. Used to track whether the constructed string flows into
    a later LLM sink call.
    """
    m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*", raw)
    return m.group(1) if m else None


def _flows_to_llm_sink(
    lines: list[str], start_idx: int, var_name: str | None
) -> bool:
    """True iff the constructed string reaches an LLM/prompt sink.

    The sink can be on the same line (``client.chat.completions.create(messages=[{"role":"user","content":f"...{x}..."}])``)
    OR within ``_FORWARD_WINDOW`` lines after an assignment to
    ``var_name`` (``prompt = f"..."; client.chat.completions.create(prompt=prompt)``).

    We deliberately do NOT do full inter-procedural taint. The forward
    window catches the overwhelmingly common pattern of "build then
    immediately send to model" while keeping false-positive rate low.
    """
    same_line = lines[start_idx]
    if _PROMPT_SINK_RX.search(same_line):
        return True

    if not var_name:
        return False

    # Walk forward looking for `<var_name>` referenced near an LLM sink.
    end = min(len(lines), start_idx + 1 + _FORWARD_WINDOW)
    name_rx = re.compile(rf"\b{re.escape(var_name)}\b")
    for j in range(start_idx + 1, end):
        nxt = lines[j]
        if name_rx.search(nxt) and _PROMPT_SINK_RX.search(nxt):
            return True
    return False


def _detect_prompt_injection_placeholder(sf: ScannedFile) -> list:
    """Flag user/config/LLM-controlled values that ACTUALLY flow into
    an LLM/prompt sink.

    Why the sink requirement is non-negotiable
    ------------------------------------------
    A previous version of this rule fired on any f-string + tainted
    token in the local window. That painted diagnostic
    ``print(f"Loading models with providers={_providers}")`` as a
    prompt injection — but `_providers` is locally computed from
    platform capability checks and the string is never sent to a
    model. Without a real sink edge, the finding is a noisy false
    positive.

    This rewritten detector enforces taint → sink:
      1. The line must look like a prompt-construction site
         (f-string / .format / PromptTemplate / message dict).
      2. The same line, or a forward window after a same-name
         assignment, must contain a real LLM/prompt sink call.
      3. The window around the construction must contain an untrusted
         source (user/config/LLM output).
      4. If a non-LLM consumer (``print``/``log``/``raise``/
         ``st.write``/etc.) wraps the f-string AND no LLM sink is
         reachable, the finding is suppressed unconditionally.
    """
    out = []
    lines = sf.lines
    for i, raw in enumerate(lines):
        if not _PROMPT_BUILD_RX.search(raw):
            continue

        # Hard suppress: wrapped in a known non-LLM consumer and no
        # LLM sink on the same line.
        if (
            _NON_LLM_CONSUMER_RX.search(raw)
            and not _PROMPT_SINK_RX.search(raw)
        ):
            continue

        var = _line_assigns_to(raw)
        if not _flows_to_llm_sink(lines, i, var):
            # The constructed string never reaches an LLM. This is the
            # critical taint→sink edge; without it the finding is a
            # false positive (diagnostic print, log line, exception
            # message, UI label, etc.).
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
                    "into a prompt via f-string/.format()/PromptTemplate and the "
                    "constructed string flows into an LLM call without an injection "
                    "guard. An attacker controlling that value can override the system "
                    "instruction (prompt injection)."
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
            # No untrusted source feeds this dynamic Cypher within the
            # local window. Per the precision spec, "dynamic" alone is
            # not enough — applications often build queries from fixed
            # constants for ergonomics. Skip to avoid noisy mediums.
            continue
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
# 5. Global os.environ mutation
#    Split into three categories — each with its own threat model:
#      * network  — proxy / base-URL / API-routing override (high risk
#                   even hardcoded; can silently redirect every outbound
#                   model/API call).
#      * secret   — API key / credential overwrite (medium; can swap
#                   identity).
#      * path     — PATH / LD_LIBRARY_PATH / etc. (low/medium; mutating
#                   the binary/library search path is risky only when the
#                   destination is writable or user-controlled. The very
#                   common `sys.prefix`-derived torch/cudnn DLL prepend
#                   guarded by ``os.path.isdir`` is benign).
# --------------------------------------------------------------------------- #

# Heuristic: a PATH mutation that joins a `sys.prefix`-derived directory
# (PyTorch / cuDNN DLLs) AND is guarded by an `os.path.isdir` check is
# benign. We don't suppress it (presence is still useful info) but we
# downgrade to low + use a path-specific explanation that does NOT
# mention proxy/network routing.
_TRUSTED_PATH_SOURCE_RX = re.compile(
    r"(sys\.prefix|sys\.executable|sysconfig\.|site\.getsitepackages|__file__|"
    r"Path\(__file__\)|importlib\.resources|os\.path\.dirname\(|"
    r"appdirs\.|platformdirs\.)",
    re.I,
)
_PATH_ISDIR_GUARD_RX = re.compile(
    r"(os\.path\.isdir|os\.path\.exists|Path\([^)]+\)\.is_dir|\.exists\(\))",
    re.I,
)


def _detect_env_proxy_mutation(sf: ScannedFile) -> list:
    out: list = []
    lines = sf.lines
    for i, raw in enumerate(lines):
        sink = classify_sink_ext(raw)
        if not sink or sink.kind != "env_mutation":
            continue
        key = env_key_in_expression(raw)
        if not key:
            continue
        category = env_key_category(key)
        if category is None:
            # Mutating an unknown env var is at most informational —
            # presence-only; let the standalone-sink pass surface it.
            continue
        # Build the taint window. We need to be careful with two things:
        #   1. The env-mutation line CONTAINS ``os.environ[...]`` (it
        #      triggered the sink). That same expression is matched by
        #      the generic ``os.environ`` config-source pattern, so
        #      naively classifying the full line as a source would
        #      self-taint every PATH-prepend (``os.environ['PATH'] =
        #      ... + os.environ['PATH']``) and bump it to high.
        #   2. The line's RHS can be a REAL untrusted source — e.g.
        #      ``os.environ['HTTP_PROXY'] = request.json['proxy']``.
        #      We must preserve it.
        # Solution: keep only the substring AFTER the first ``=``
        # (the RHS) for the line itself, and combine that with the
        # lines above (which can also contain the source).
        window_above = _window_before(lines, i)
        rhs = raw.split("=", 1)[1] if "=" in raw else ""
        # Drop ``os.environ[...]`` / ``os.getenv(...)`` reads from the
        # RHS before classifying. Otherwise the very common
        # ``os.environ['PATH'] = base + os.pathsep + os.environ['PATH']``
        # idiom self-taints via its OWN PATH read, which the generic
        # config-source pattern (``os.environ\b``) matches.
        rhs_clean = re.sub(
            r"os\.environ\s*\[[^\]]+\]|os\.getenv\s*\([^)]+\)|process\.env\.\w+",
            " ",
            rhs,
        )
        taint_window = window_above + "\n" + rhs_clean
        tainted = (
            classify_framework_user_input(taint_window)
            or classify_config_source(taint_window)
        )
        # The full window is used for the trusted-source / isdir-guard
        # heuristics below (which need the LHS context too).
        window = window_above + "\n" + raw

        # ----- per-category severity + explanation ----------------------------
        if category == "network":
            sev = "high" if tainted else "medium"
            title = f"Global environment mutation of network-routing key {key}"
            reason = (
                f"The process-global environment variable {key} is mutated at runtime"
                + (" from config/request data" if tainted else "")
                + ". Redirecting a proxy or API base URL can route every outbound "
                "model/API call through an attacker-controlled endpoint."
            )
            fix = (
                "Avoid mutating os.environ for network routing. Pass an explicit, "
                "validated client config (base_url, proxies) to the SDK instead, and "
                "allowlist permitted hosts."
            )
            conf = 0.85 if tainted else 0.7

        elif category == "secret":
            sev = "high" if tainted else "medium"
            title = f"Global environment mutation of secret key {key}"
            reason = (
                f"The process-global environment variable {key} is overwritten at "
                "runtime"
                + (" from config/request data" if tainted else "")
                + ". Replacing a credential/API key can swap the process's identity "
                "for outbound calls without audit."
            )
            fix = (
                "Do not mutate credential env vars at runtime. Load secrets into a "
                "scoped client/config object, never the global environment, and "
                "fail closed if the variable is missing."
            )
            conf = 0.85 if tainted else 0.7

        else:
            # category == "path"
            trusted_source = bool(_TRUSTED_PATH_SOURCE_RX.search(window))
            guarded_isdir = bool(_PATH_ISDIR_GUARD_RX.search(window))
            if tainted:
                sev, conf = "high", 0.85
            elif trusted_source and guarded_isdir:
                sev, conf = "low", 0.5
            elif trusted_source or guarded_isdir:
                sev, conf = "low", 0.55
            else:
                sev, conf = "medium", 0.65

            title = f"Process search path mutation: {key}"
            reason = (
                f"The process-global environment variable {key} is modified at runtime"
                + (" from config/request data" if tainted else "")
                + ". This changes the DLL/binary/library search path the interpreter "
                "uses to LOAD code — not network routing. Risk is high only when the "
                "appended directory is writable or attacker-influenced; appending a "
                "library directory derived from sys.prefix and guarded by "
                "os.path.isdir (the common PyTorch/cuDNN DLL pattern on Windows) is "
                "benign."
            )
            fix = (
                "Prefer adding paths via the language's own loader API (e.g. "
                "os.add_dll_directory on Windows, ctypes preloads) over mutating "
                "os.environ['PATH']. If you must mutate PATH, restrict it to a "
                "trusted, read-only directory and document why."
            )

        out.append(
            _emit(
                rule_id=RULE_ENV_PROXY_MUTATION,
                severity=sev,
                category="Configuration",
                title=title,
                sf=sf,
                line_no=i + 1,
                reason=reason,
                fix=fix,
                evidence=raw.strip()[:200],
                code=raw,
                confidence=conf,
                source_untrusted=bool(tainted),
                partial_guard=(
                    category == "path" and not tainted
                ),
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
