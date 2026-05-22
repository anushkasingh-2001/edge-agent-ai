from __future__ import annotations

import hashlib
import re

from edge_agent_scanner.ir.guards import classify_guard
from edge_agent_scanner.ir.models import AgentIR, AgentNode, CodeLocation, GuardNode, ModelNode, RouteNode, SinkNode, SourceNode, ToolNode
from edge_agent_scanner.ir.redact import redact_secrets
from edge_agent_scanner.ir.sinks import classify_side_effect, impact_for_effect
from edge_agent_scanner.ir.sources import classify_source
from edge_agent_scanner.walker import ScannedFile

try:
    from tree_sitter_language_pack import get_parser
except Exception:  # optional in dev environments
    get_parser = None


def _id(prefix: str, file: str, line: int, name: str) -> str:
    return f"{prefix}:{hashlib.sha1(f'{prefix}:{file}:{line}:{name}'.encode()).hexdigest()[:12]}"


def _loc(file: str, line: int, symbol: str | None = None) -> CodeLocation:
    return CodeLocation(file=file, start_line=line, end_line=line, symbol=symbol)


def _parse_with_tree_sitter(sf: ScannedFile):
    if get_parser is None:
        return None
    lang = "typescript" if sf.rel_path.endswith((".ts", ".tsx")) else "javascript"
    try:
        parser = get_parser(lang)
        return parser.parse("\n".join(sf.lines).encode("utf-8"))
    except Exception:
        return None


# Tool detection patterns. Each must indicate an actual runtime
# *construction* of a tool (a call, a `new` expression, or a
# decorator-style ``tool(...)`` call). The historic ``\b(\w+Tool)\b``
# pattern matched bare identifiers — including type aliases, class
# names referenced in JSX, and ``import { FooTool } from "..."`` — and
# was the main reason a generic ``MessageList`` / ``RetrievalTool``
# identifier in a comment or import turned into a tool finding. We now
# require either a call paren, ``new ...Tool(``, or a tool decorator
# construction so declarations alone never trip the detector.
TOOL_PATTERNS = [
    re.compile(r"\btool\s*\("),
    re.compile(r"\bnew\s+(StructuredTool|DynamicTool|Tool)\b"),
    re.compile(r"\bnew\s+\w+Tool\s*\("),
    re.compile(r"\b\w+Tool\s*\(\s*\{"),
]

MODEL_PATTERNS = [
    re.compile(r"\bnew\s+(OpenAI|Anthropic|ChatOpenAI|ChatAnthropic|GoogleGenerativeAI|Ollama)\b"),
    re.compile(r"\b(model|modelName)\s*:\s*['\"]([^'\"]+)['\"]"),
    re.compile(r"\blitellm\.completion\s*\("),
]

ROUTE_PATTERNS = [
    re.compile(r"\b(app|router)\.(get|post|put|patch|delete)\s*\(\s*['\"]([^'\"]+)['\"]", re.I),
]

AGENT_PATTERNS = [
    re.compile(r"\b(createReactAgent|AgentExecutor|StateGraph|createAgent|RunnableSequence)\b"),
]


# Lines that are purely TypeScript/JavaScript module syntax — not a runtime
# call — must not produce sink/source/guard findings. Without this filter,
# the side-effect classifier reads `export type { Foo }` as "export + type"
# verbs and emits bogus data-export / browser-control findings, and React
# component names like `MessageList` get flagged as outbound message calls.
#
# The patterns intentionally only cover syntax that is NEVER a runtime call:
# `export type`, `export interface`, `export default <Identifier>`,
# `import …`, top-level `type X =`, top-level `interface X`, JSX element
# usage `<MessageList />` / `<MessageList ... />` with no surrounding call.
#
# Anything that DOES have an opening paren (`)` is still treated as a
# possible call and runs through the full classifier — that's how
# `export default sendEmail(...)` keeps producing a finding.
_DECLARATION_ONLY_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\s*export\s+(type|interface|enum|namespace)\b"),
    re.compile(r"^\s*export\s+default\s+[A-Za-z_$][\w$]*\s*;?\s*$"),
    re.compile(r"^\s*export\s+default\s+function\s+[A-Za-z_$][\w$]*\s*\("),  # fall-through allowed; classifier still sees the call
    re.compile(r"^\s*export\s*\{[^}]*\}\s*(from\s+['\"][^'\"]+['\"])?\s*;?\s*$"),
    re.compile(r"^\s*export\s+\*\s+(as\s+\w+\s+)?from\b"),
    re.compile(r"^\s*import\s+(type\s+)?[\w*{}\s,]+\s+from\s+['\"]"),
    re.compile(r"^\s*import\s+['\"][^'\"]+['\"]\s*;?\s*$"),
    re.compile(r"^\s*(type|interface)\s+[A-Za-z_$][\w$]*\b"),
    re.compile(r"^\s*declare\s+(module|namespace|global|const|let|var|function|class|enum|type|interface)\b"),
    # Variable bound to an arrow function or function expression — this is
    # a function *definition*, not a runtime call:
    #   const handleSubmit = async (e: React.FormEvent) => { ... }
    #   export const ChatBox: React.FC = () => { ... }
    # The body still classifies on its own lines; only the declaration
    # head is short-circuited so the type annotation or parameter list
    # ((``React.FormEvent``, ``React.FC``)) doesn't spuriously trip
    # verb_target via tokens like ``form``/``submit``.
    re.compile(
        r"^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*"
        r"(\s*:\s*[\w.<>,\s|&\[\]?]+)?"
        r"\s*=\s*(async\s+)?\("
    ),
    re.compile(
        r"^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*"
        r"(\s*:\s*[\w.<>,\s|&\[\]?]+)?"
        r"\s*=\s*(async\s+)?function\b"
    ),
    # FormData / URLSearchParams constructor binding (no side effect on
    # its own — only the eventual upload call matters).
    re.compile(
        r"^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*"
        r"\s*=\s*new\s+(FormData|URLSearchParams|Headers|AbortController)\b"
    ),
)

# Pure JSX element usage with no JS call syntax: `<MessageList />`, `<Foo bar />`.
# A `(` anywhere on the line disables this short-circuit so embedded calls
# (like `onClick={() => sendMessage()}`) still run through classification.
_JSX_ONLY = re.compile(r"^\s*<\s*[A-Za-z][\w.]*[^>(]*/?>\s*;?\s*$")

# Comment-only lines must never classify as side effects. A keyword like
# "upload" inside a `// Create a type for the API response data` comment
# was triggering a `data_export_or_sharing` sink finding under the old
# verb/target classifier. Matches:
#   * line starts with ``//`` (single-line comment)
#   * line starts with ``/*`` or ``*`` (block-comment body line, JSDoc)
#   * trailing-only ``//`` after whitespace
# We do not strip inline trailing comments — only lines whose ENTIRE
# meaningful content is comment text are short-circuited.
_COMMENT_ONLY_RX = re.compile(r"^\s*(//|/\*|\*[^/]?|\*/)")

# Object/JSX-attribute property assignments with a non-call right-hand
# side: ``message: msg.content``, ``mt: 0.1``, ``padding: 16``, ``sx={
# mt: 1 }``. The classifier would otherwise see ``message`` + ``content``
# tokens and emit an outbound-message finding from MUI sx props, JSX
# attribute objects, and React state slices. Only lines whose RHS
# clearly is NOT a call (no opening paren, no ``new`` keyword) trip
# this filter — a real call like ``onClick: () => sendEmail()`` still
# classifies because of the embedded ``(``.
_OBJECT_PROPERTY_LINE_RX = re.compile(
    r"^\s*[A-Za-z_$][\w$]*\s*:\s*[^(){};\n]+,?\s*$"
)

# JSX attribute event-binding lines: ``onClick={() => setIsOpen(true)}``,
# ``onSubmit={handleSubmit}``, ``<button onClick={() => onSubmit(input)}>send</button>``.
#
# A line that contains ``on[A-Z]\w*=\{`` is a JSX event-handler
# binding. The HANDLER itself is a runtime call when the user
# interacts, but its body is also defined elsewhere in the file
# (``const handleSubmit = async (e) => { ... }``) and that body is
# what will classify when it actually performs a side effect.
#
# Treating the BINDING line as a sink produces a duplicate, less
# specific finding (``onClick={() => onSubmit(input)}`` flagged as
# ``browser_or_desktop_control`` because of "submit" verb + "button"
# target). The user's precision spec calls this "trigger context only,
# not a side effect by itself", so the extractor suppresses it.
_JSX_EVENT_BINDING_RX = re.compile(r"\bon[A-Z]\w*\s*=\s*\{")

# React useState destructuring patterns. We track the setter names
# (``setX``) so subsequent ``setX(...)`` invocations on their own line
# are recognised as local UI state updates rather than outbound message
# / CRM / browser-control sinks. The classifier's verb/target ontology
# treats ``setMessages`` as verb=set + target=messages → CRM write.
_USE_STATE_RX = re.compile(
    r"\b(?:const|let|var)\s*\[\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*(?:React\.)?useState\b"
)

# React useReducer dispatch patterns — same suppression target as setters.
_USE_REDUCER_RX = re.compile(
    r"\b(?:const|let|var)\s*\[\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*(?:React\.)?useReducer\b"
)

# FormData / URLSearchParams variable assignments. We collect the
# variable names and any ``.append(field, value)`` calls so we can:
#   1. Suppress the ``formData.append(...)`` calls as separate sinks
#      (they are upload-flow preparation, not standalone side effects).
#   2. Attach the collected fields as evidence on the actual upload
#      sink (``axios.post(..., formData)`` or
#      ``fetch(..., { body: formData })``).
_FORM_DATA_DECL_RX = re.compile(
    r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(FormData|URLSearchParams)\b"
)
_FORM_DATA_APPEND_RX = re.compile(
    r"\b([A-Za-z_$][\w$]*)\s*\.\s*append\s*\(\s*['\"]([^'\"]+)['\"]"
)

# Standalone state setter call on a line (entire line is ``setX(...)``
# or ``await setX(...)``). Once a name is in
# ``ScanState.react_setters`` we drop sink findings for it.
_BARE_SETTER_CALL_RX = re.compile(r"^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(")

# Recognised React state-setter naming pattern. Even when we haven't
# explicitly seen ``const [_, setX] = useState(...)`` (e.g. when
# `useState` lives in a parent hook file), a bare ``setSomething(...)``
# call followed by a simple literal/identifier argument is overwhelmingly
# a React state update. The classifier alone would otherwise flag
# ``setMessages(prev => [...prev, m])`` as CRM write.
_REACT_SETTER_NAME_RX = re.compile(r"^set[A-Z][\w$]*$")

# JSX text-content lines: a JSX child expression that is just a quoted
# string literal (``"Upload audio or video file"``) or template literal.
# These ARE callable when combined with a function call elsewhere, but
# a line whose whole meaningful body is a string literal can never be
# a side effect on its own.
_JSX_TEXT_LINE_RX = re.compile(r"^\s*['\"`][^'\"`]*['\"`]\s*,?\s*$")


def _strip_line_comment(line: str) -> str:
    """Return ``line`` with a trailing ``//...`` comment removed.

    Keeps any leading code (so ``axios.post(url) // upload`` still
    classifies). Does not handle quoted ``//`` literals — those are
    treated as comments here and pruned. That's intentional: a string
    literal containing ``//`` is JSX text or a URL and we don't want
    the URL's path slashes to alter classification anyway.
    """
    idx = line.find("//")
    return line[:idx] if idx >= 0 else line


def _is_declaration_only_line(line: str) -> bool:
    """Return True for TS/JS lines that are pure module syntax / type
    declarations / JSX element references / arrow-function definitions
    / pure-data property assignments — i.e. lines that are not
    themselves runtime calls and therefore should not produce sink
    findings.

    Three categories short-circuit even when the line contains ``(``:
      * comments (``// ...``)
      * JSX text literals (``"label"`` standing alone)
      * explicit declaration patterns whose regex anchors a ``(`` of
        their own (arrow-function/function expression bindings,
        FormData / URLSearchParams constructor bindings).
    Everything else with a paren falls through to classification so
    embedded calls (``onClick={() => sendEmail()}``) keep firing.
    """
    if _COMMENT_ONLY_RX.match(line):
        return True
    if _JSX_TEXT_LINE_RX.match(line):
        return True
    # Patterns whose own regex includes ``(`` must be checked first;
    # the legacy ``if "(" in line: return False`` would otherwise
    # short-circuit before these matched.
    for rx in _DECLARATION_ONLY_PATTERNS:
        if rx.search(line):
            return True
    if "(" in line:
        return False
    if _JSX_ONLY.match(line):
        return True
    # Property assignment with non-call RHS (sx style, JSX props,
    # plain object literal members). Only fires when there is also
    # no ``=>`` arrow or backtick, so callbacks / template-literal
    # tags still classify.
    if _OBJECT_PROPERTY_LINE_RX.match(line) and "=>" not in line and "`" not in line:
        return True
    return False


def _is_jsx_event_binding_line(line: str) -> bool:
    """True if the line contains a JSX event-handler attribute
    (``onClick={...}``, ``onSubmit={...}``, ``onChange={...}``).

    The handler body is a runtime call but it's already defined and
    classified at the handler's declaration site
    (``const handleSubmit = async () => { ... }``). Flagging the
    binding line too produces a less-specific duplicate and a
    `<button onClick={() => onSubmit(input)}>send</button>` line
    triggered ``browser_or_desktop_control`` (verb=submit +
    target=button) without representing an actual side effect.
    """
    return bool(_JSX_EVENT_BINDING_RX.search(line))


def _is_state_setter_call(line: str, react_setters: set[str]) -> bool:
    """True if the line is a standalone React useState/useReducer
    setter invocation (``setMessages(...)``, ``setIsOpen(false)``)
    that should NOT produce a sink finding.

    A setter is recognised when EITHER:
      * its name was seen in a ``const [_, setX] = useState(...)``
        binding in this file (``react_setters``), OR
      * the call's leading identifier matches the conventional React
        setter pattern (``set[A-Z]\\w*``) — covers callbacks passed in
        from props / parent components.
    """
    m = _BARE_SETTER_CALL_RX.match(line.strip())
    if not m:
        return False
    callee = m.group(1)
    return callee in react_setters or bool(_REACT_SETTER_NAME_RX.match(callee))


def _is_form_data_prep_call(line: str, form_data_vars: set[str]) -> bool:
    """True if the line is a ``formDataVar.append(...)`` call on a
    tracked FormData/URLSearchParams variable. Those calls are upload
    *preparation*, not side effects themselves — the real network call
    (``axios.post``, ``fetch``) is where the actual outbound finding
    should appear.
    """
    m = _FORM_DATA_APPEND_RX.search(line)
    if not m:
        return False
    return m.group(1) in form_data_vars


# Map a sink effect to its normalised, scoring-friendly callee label.
# The extractor stores both the full ``source_line`` (for "Code
# involved" / AI prompt context) and a normalised ``label`` (used in
# titles and the dedup key). Without normalisation the label was the
# entire raw line, which produced unreadable titles like
# ``const formData = new FormData(); // ... — side-effect call``.
_CALLEE_RX = re.compile(
    r"\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|new\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*\("
)


def _normalize_label(line: str, fallback: str) -> str:
    """Pull the first call expression's callee out of ``line`` for use
    as the sink's normalised label. Falls back to a bounded snippet of
    ``fallback`` (typically ``line.strip()``) so we never emit a blank
    label.
    """
    cleaned = _strip_line_comment(line).strip()
    m = _CALLEE_RX.search(cleaned)
    if m:
        callee = m.group(1).strip()
        # `new FormData` → `FormData`; normalise whitespace.
        callee = re.sub(r"^new\s+", "", callee)
        return callee[:120]
    return fallback[:120]


def _collect_local_state(sf: ScannedFile) -> tuple[set[str], set[str]]:
    """First pass over the file collecting React useState setter
    names and FormData / URLSearchParams variable names.

    Both sets are file-local — we never carry tracking across files
    because variable names are not unique across a project and we'd
    risk silently suppressing real cross-file sinks.
    """
    react_setters: set[str] = set()
    form_data_vars: set[str] = set()
    for raw_line in sf.lines:
        for m in _USE_STATE_RX.finditer(raw_line):
            react_setters.add(m.group(1))
        for m in _USE_REDUCER_RX.finditer(raw_line):
            react_setters.add(m.group(1))
        for m in _FORM_DATA_DECL_RX.finditer(raw_line):
            form_data_vars.add(m.group(1))
    return react_setters, form_data_vars


def _collect_form_data_fields(sf: ScannedFile, form_data_vars: set[str]) -> dict[str, list[str]]:
    """For each tracked FormData variable, list the field names that
    are appended to it. Used as evidence on the eventual upload sink
    (``axios.post(..., formData)`` → ``fields: file, language, ...``).
    """
    out: dict[str, list[str]] = {v: [] for v in form_data_vars}
    for raw_line in sf.lines:
        m = _FORM_DATA_APPEND_RX.search(raw_line)
        if not m:
            continue
        var, field = m.group(1), m.group(2)
        if var in form_data_vars and field not in out[var]:
            out[var].append(field)
    return out


def extract_ts_js_ir(sf: ScannedFile, ir: AgentIR) -> None:
    # Tree-sitter is used to validate/parse robustly. The first extractor pass is
    # still pattern-driven because framework-specific semantics are custom.
    _parse_with_tree_sitter(sf)

    # Cheap first pass: collect React useState setters and FormData
    # variable names so the main classification pass can suppress their
    # follow-up calls (setX / formData.append) without losing them as
    # context for upload sinks.
    react_setters, form_data_vars = _collect_local_state(sf)
    form_data_fields = _collect_form_data_fields(sf, form_data_vars)

    for line_no, line in enumerate(sf.lines, start=1):
        # Pre-filter: declaration-only lines (export type / import / etc.)
        # can never produce a runtime side effect, so they short-circuit
        # before reaching the side-effect/source/guard classifiers below.
        # Tool/agent/route/model patterns above this check are framework
        # detectors that we intentionally still want to run.
        declaration_only = _is_declaration_only_line(line)

        if any(rx.search(line) for rx in AGENT_PATTERNS):
            name = "agent"
            m = re.search(r"(const|let|var)\s+(\w+)", line)
            if m:
                name = m.group(2)
            ir.agents.append(
                AgentNode(
                    id=_id("agent", sf.rel_path, line_no, name),
                    name=name,
                    framework="JS/TS Agent",
                    location=_loc(sf.rel_path, line_no, name),
                )
            )

        # Tool construction patterns must include call syntax (see
        # TOOL_PATTERNS docstring). Declaration-only lines never get a
        # tool emission, which protects against ``import { FooTool }``
        # and JSX usage of identifiers ending in ``Tool``.
        if not declaration_only and any(rx.search(line) for rx in TOOL_PATTERNS):
            m = re.search(r"(const|let|var|function|class)\s+(\w+)", line)
            name = m.group(2) if m else f"tool_line_{line_no}"
            ir.tools.append(
                ToolNode(
                    id=_id("tool", sf.rel_path, line_no, name),
                    name=name,
                    location=_loc(sf.rel_path, line_no, name),
                    framework="JS/TS",
                    side_effects=classify_side_effect(line),
                    metadata={"code": line.strip()},
                )
            )

        for rx in ROUTE_PATTERNS:
            m = rx.search(line)
            if m:
                ir.routes.append(
                    RouteNode(
                        id=_id("route", sf.rel_path, line_no, f"{m.group(2)}:{m.group(3)}"),
                        method=m.group(2).upper(),
                        path=m.group(3),
                        location=_loc(sf.rel_path, line_no, m.group(3)),
                    )
                )

        for rx in MODEL_PATTERNS:
            m = rx.search(line)
            if m:
                model = m.group(2) if m.lastindex and m.lastindex >= 2 and m.group(2) else m.group(1)
                ir.models.append(
                    ModelNode(
                        id=_id("model", sf.rel_path, line_no, model),
                        provider=None,
                        model_name=model,
                        purpose="unknown",
                        location=_loc(sf.rel_path, line_no, model),
                    )
                )

        if declaration_only:
            # Skip source/sink/guard emission for `export type`, `import …`,
            # bare JSX element usage etc. — these aren't runtime operations.
            continue

        # Suppress JSX event-handler bindings, React state setter
        # calls, and FormData append calls. See the helpers'
        # docstrings for the semantic rationale — these are local
        # UI/upload-prep operations, not outbound side effects, and
        # emitting them produces unactionable noise on every
        # React/Next.js project.
        if _is_jsx_event_binding_line(line):
            continue
        if _is_state_setter_call(line, react_setters):
            continue
        if _is_form_data_prep_call(line, form_data_vars):
            continue

        src_kind = classify_source(line)
        if src_kind:
            ir.sources.append(
                SourceNode(
                    id=_id("source", sf.rel_path, line_no, line[:40]),
                    kind=src_kind,
                    label=line.strip()[:120],
                    location=_loc(sf.rel_path, line_no),
                )
            )

        effects = classify_side_effect(line)
        if effects:
            stripped = line.strip()
            # ``label`` is the *normalised callee* (e.g. ``axios.post``)
            # used in titles and dedup. ``call_expression`` and
            # ``source_line`` keep the full (redacted) line so the UI
            # and AI prompt still see exactly what the user wrote.
            normalised_label = _normalize_label(line, stripped)
            full_line = redact_secrets(stripped)

            # Build optional FormData / URLSearchParams field hint.
            # When the line passes a tracked form-data variable to the
            # call we attach the collected field names so the upload
            # finding can show ``fields: file, language, category``.
            fields_hint: str | None = None
            for var, fields in form_data_fields.items():
                if not fields:
                    continue
                if re.search(rf"\b{re.escape(var)}\b", line):
                    fields_hint = ", ".join(fields)
                    break

            for effect in effects:
                sink = SinkNode(
                    id=_id("sink", sf.rel_path, line_no, effect),
                    kind=effect,
                    label=normalised_label,
                    location=_loc(sf.rel_path, line_no),
                    impact=impact_for_effect(effect),  # type: ignore[arg-type]
                    call_expression=full_line or None,
                    source_line=full_line or None,
                )
                if fields_hint:
                    sink.metadata["form_data_fields"] = fields_hint
                ir.sinks.append(sink)

        for kind in classify_guard(line):
            ir.guards.append(
                GuardNode(
                    id=_id("guard", sf.rel_path, line_no, f"{kind}:{line[:30]}"),
                    kind=kind,
                    label=line.strip()[:120],
                    location=_loc(sf.rel_path, line_no),
                )
            )
