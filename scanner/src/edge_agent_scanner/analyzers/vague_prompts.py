"""Vague / underspecified agent-prompt analyzer (rule_id ``vague-prompts``).

This is the DETERMINISTIC half of a hybrid check. It runs as part of the
normal scan and never calls an LLM. The scan-time intelligence layer
(``lib/scan-intelligence``) decides — per scan mode and budget — whether to
send a small redacted bundle of a *borderline / high-risk* finding to an LLM
verifier that can upgrade, downgrade, or mark it ``likely_false_positive``.
Routing into that verifier is achieved purely through the severity +
confidence this analyzer assigns (high/critical = high-risk; medium with
confidence < 0.6 = borderline), so no separate LLM path exists here.

What it detects
---------------
Agent prompts that combine vague natural-language instructions
("handle this", "do the needful", "use your judgment", …) with a missing
prompt CONTRACT. The contract has eight parts the prompt should pin down:

    role / persona, clear task, input assumptions, output format/schema,
    constraints, tool-use policy, human-approval rule, and fallback
    behaviour for missing/unclear info.

Severity follows how many of those eight parts are missing (spec scoring):

    missing 3–4  -> low
    missing 5–7  -> medium
    missing 8    -> high
    vague + risky tools + no approval/tool/output policy -> critical

Where it looks
--------------
1. ``ir.prompts`` — hardcoded prompts, system/user/developer messages,
   PromptTemplate / ChatPromptTemplate, and prompts attached to
   OpenAI/Anthropic/Gemini/Ollama/Llama calls (the IR already extracts these
   from .py/.ts/.js via AST/call-site parsing).
2. Prompt / config files the IR doesn't model as prompts: ``.txt``, ``.md``,
   ``.json``, ``.yaml``, ``.yml`` — but only when the text actually looks
   like a prompt (prompt-like filename or instruction cue) AND a vague phrase
   is present, to avoid flagging ordinary documentation.

Every finding carries deterministic evidence (the matched vague phrases and
the list of missing contract parts) so the final issue is never LLM-invented.
"""

from __future__ import annotations

import re

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_existing
from edge_agent_scanner.ir.models import AgentIR, CodeLocation
from edge_agent_scanner.walker import ScannedFile

# ---------------------------------------------------------------------------
# Vague phrasing — the primary trigger for this check. These are the casual,
# underspecified instructions the spec calls out. Matched case-insensitively
# as substrings, so "Handle this." and "please handle this for me" both hit.
# ---------------------------------------------------------------------------
VAGUE_PHRASES: tuple[str, ...] = (
    "handle this",
    "do the needful",
    "process the request",
    "analyze it",
    "analyse it",
    "make it better",
    "use your judgment",
    "use your judgement",
    "as appropriate",
    "as needed",
    "whatever is needed",
    "whatever's needed",
    "whatever you think",
    "help the user",
    "take action",
    "do your best",
    "figure it out",
    "just do it",
)

# ---------------------------------------------------------------------------
# The eight prompt-contract parts. A part counts as PRESENT when any of its
# keyword cues appears in the prompt text (case-insensitive substring). These
# are intentionally broad: the goal is to avoid false "missing" calls on
# prompts that do specify the concept using ordinary wording.
# ---------------------------------------------------------------------------
CONTRACT_PARTS: dict[str, list[str]] = {
    "role": ["you are", "your role", "act as", "persona", "you're a", "you are a", "assistant that"],
    "task": ["task", "goal", "objective", "your job", "you must", "you should", "in order to", "responsible for"],
    "input_assumptions": [
        "input", "you will receive", "you'll receive", "given", "the user will",
        "assume", "expects", "provided with", "you are given",
    ],
    "output_format": [
        "json", "schema", "format", "return", "respond with", "output", "markdown",
        "yaml", "bullet", "table", "structure",
    ],
    "constraints": ["must not", "do not", "don't", "never", "only", "limit", "constraint", "restrict", "no more than"],
    "tool_policy": ["tool", "function", "call the", "api", "available tools", "may call", "you can use", "use the"],
    "approval": ["approval", "confirm", "ask before", "permission", "human", "verify with", "double-check", "sign off"],
    "fallback": [
        "if unsure", "if unclear", "if you don't know", "if you are unsure", "if missing",
        "ask for clarification", "ask the user", "otherwise", "when in doubt", "do not guess",
        "cannot", "unable", "if you can't",
    ],
}

#: Ordered, stable list of contract-part keys (for deterministic evidence).
_PART_KEYS: tuple[str, ...] = tuple(CONTRACT_PARTS.keys())

# Prompt-like cues used to decide whether a .txt/.md/.json/.yaml file is
# actually a prompt (rather than ordinary docs/config) before we flag it.
_PROMPT_CUE_RX = re.compile(
    r"\b(you are|your task|your job|respond|assistant|system\s*prompt|"
    r"instructions?|act as|persona|prompt)\b",
    re.I,
)
_PROMPT_FILE_RX = re.compile(r"(prompt|system|instruction|persona|agent|template)", re.I)

#: Extensions the IR does NOT model as prompts but which commonly hold
#: prompt/config text. Code prompts (.py/.ts/.js) come through ir.prompts.
_CONFIG_PROMPT_EXTS: tuple[str, ...] = (".txt", ".md", ".json", ".yaml", ".yml")

# Risky / action verbs and tool names whose presence IN THE PROMPT TEXT is
# concrete evidence the prompt drives real-world side effects. Used to
# escalate a vague prompt to critical even when the IR has no sink/tool node
# attached to the prompt's file (e.g. the prompt names the tool it will call).
_RISKY_ACTION_RX = re.compile(
    r"\b("
    r"send_?email|send_?sms|send_?message|email\s+the|"
    r"delete|remove|drop\s+table|truncate|"
    r"deploy|rollback|release|publish|"
    r"refund|charge|transfer|payment|pay\b|wire\b|invoice|"
    r"shell|exec|subprocess|os\.system|run\s+command|execute\s+command|"
    r"insert\s+into|update\s+\w+\s+set|delete\s+from|database\s+write|db\s+write|write\s+to\s+(?:the\s+)?(?:db|database)|"
    r"calendar|schedule_?meeting|create_?meeting|book\s+a|"
    r"github|merge\s+pr|create_?pr|open\s+a\s+pr|push\s+to|commit\s+to|"
    r"grant|revoke|provision|terminate\s+instance"
    r")\b",
    re.I,
)

# Secondary-trigger thresholds for very short underspecified prompts.
_SHORT_MAX_WORDS = 20
_SHORT_MAX_CHARS = 120
_SHORT_MIN_MISSING = 5

_SEV_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _cap_severity(sev: str, ceiling: str) -> str:
    """Clamp ``sev`` so it is no more severe than ``ceiling``."""
    return sev if _SEV_RANK.get(sev, 3) >= _SEV_RANK.get(ceiling, 3) else ceiling


def _is_short(text: str) -> bool:
    t = text.strip()
    return len(t) <= _SHORT_MAX_CHARS or len(t.split()) <= _SHORT_MAX_WORDS


def _vague_hits(text: str) -> list[str]:
    low = text.lower()
    return [p for p in VAGUE_PHRASES if p in low]


def _missing_parts(text: str) -> list[str]:
    low = text.lower()
    return [name for name in _PART_KEYS if not any(k in low for k in CONTRACT_PARTS[name])]


def _severity_for(missing_count: int) -> str:
    """Map missing-part count to severity (spec scoring bands)."""
    if missing_count >= 8:
        return "high"
    if missing_count >= 5:
        return "medium"
    # 3–4 missing, or a vague phrase with few missing parts.
    return "low"


def _confidence_for(severity: str) -> float:
    """Confidence chosen to drive scan-time LLM verification routing.

    The verifier (lib/scan-intelligence/select-clusters) reviews
    high/critical clusters (high-risk) and clusters whose representative
    confidence is < 0.6 (borderline). We therefore put MEDIUM just under
    that line so borderline mediums are verified, while keeping LOW clear
    cases above it so Balanced mode skips them for cost control. Exhaustive
    still reviews everything.
    """
    return {
        "critical": 0.80,
        "high": 0.72,
        "medium": 0.58,
        "low": 0.68,
    }.get(severity, 0.68)


def _file_has_dangerous_sink(ir: AgentIR, file: str) -> bool:
    return any(
        s.location.file == file and s.impact in ("high", "critical") for s in ir.sinks
    )


def _file_has_risky_tool(ir: AgentIR, file: str) -> bool:
    """An AGENT-CALLABLE tool with real side effects declared in the SAME file
    as the prompt (nearby tool context). All three must hold:
      * the tool lives in the prompt's file,
      * the agent can actually call it (``callable_from_agent``),
      * it has non-empty ``side_effects``.

    A same-file tool that the agent cannot call (e.g. an internal helper), or
    a risky tool elsewhere in the repo, does NOT escalate — that over-flagged
    unrelated prompts."""
    return any(
        t.location.file == file and t.callable_from_agent and t.side_effects
        for t in ir.tools
    )


def _risky_context_for(ir: AgentIR | None, file: str, text: str) -> tuple[bool, str]:
    """Return (is_risky, signal) using CLOSE evidence only:

    * a high/critical sink in the same file, OR
    * a side-effect tool declared in the same file (nearby tool context), OR
    * the prompt text itself names a risky action/tool (send_email, delete,
      deploy, refund, charge, shell, db write, calendar, github write, …).

    A risky tool that merely exists elsewhere in the repo is intentionally
    NOT sufficient — the prompt must be close to, or explicitly invoke, the
    risky surface.
    """
    if ir is not None:
        if _file_has_dangerous_sink(ir, file):
            return True, "same_file_sink"
        if _file_has_risky_tool(ir, file):
            return True, "same_file_tool"
    if _RISKY_ACTION_RX.search(text or ""):
        return True, "prompt_names_action"
    return False, ""


def _build_finding(
    *,
    name: str,
    text: str,
    location: CodeLocation,
    vague: list[str],
    missing: list[str],
    trigger: str,
    risky_context: bool,
    risky_signal: str,
):
    sev = _severity_for(len(missing))

    if trigger == "short":
        # Secondary trigger (no explicit vague phrase) is a weaker signal:
        # cap at medium and use borderline confidence so the scan-time LLM
        # verifier reviews it rather than us asserting a confident high.
        sev = _cap_severity(sev, "medium")
        conf = 0.55
    else:
        # Critical requires CLOSE evidence (same-file sink/tool, or the
        # prompt itself names a risky action) AND a vague phrase AND the
        # three safety-critical contract parts all missing.
        critical_gap = {"approval", "tool_policy", "output_format"}.issubset(set(missing))
        if vague and risky_context and critical_gap:
            sev = "critical"
        conf = _confidence_for(sev)

    missing_labels = ", ".join(missing) if missing else "none"
    vague_labels = ", ".join(f'"{v}"' for v in vague) if vague else "none"

    if sev == "critical":
        title = f"Vague action prompt with no approval/tool/output policy: {name}"
    elif trigger == "short":
        title = f"Very short, underspecified prompt: {name}"
    else:
        title = f"Vague / underspecified prompt: {name}"

    if trigger == "short":
        reason = (
            "This prompt is extremely short and underspecified — it is missing "
            + str(len(missing))
            + " of 8 prompt-contract parts ("
            + missing_labels
            + "). A bare instruction like this gives the model no role, output "
            "format, constraints, or fallback behaviour, so results are unreliable "
            "and easy to derail."
        )
    else:
        reason = (
            "This prompt uses vague, underspecified instructions ("
            + vague_labels
            + ") and is missing "
            + str(len(missing))
            + " of 8 prompt-contract parts ("
            + missing_labels
            + "). Underspecified prompts let the model improvise: it may pick the "
            "wrong action, invent output, or call tools without a human in the loop — "
            "especially dangerous when the agent can take real-world actions."
        )
        if sev == "critical":
            reason += (
                f" Escalated to critical because a risky action surface is close by "
                f"({risky_signal}) and the prompt specifies no approval, tool-use, or "
                f"output policy."
            )
    suggested_fix = (
        "Replace vague language with an explicit contract: (1) role/persona, "
        "(2) the exact task, (3) what inputs to expect, (4) the output format/schema, "
        "(5) hard constraints, (6) which tools may be used and when, (7) when human "
        "approval is required, and (8) what to do when information is missing or unclear "
        "(ask, don't guess)."
    )

    # Deterministic evidence string — also what the LLM verifier bundle
    # surfaces as "static evidence + missing parts".
    evidence = (
        f"trigger={trigger}; "
        f"vague_phrases={'|'.join(vague) if vague else 'none'}; "
        f"missing={','.join(missing) if missing else 'none'}; "
        f"missing_count={len(missing)}"
        + (f"; risky_context={risky_signal}" if risky_context else "")
    )

    f = make_finding(
        rule_id="vague-prompts",
        severity=sev,
        category="Vague prompt",
        title=title,
        location=location,
        reason=reason,
        suggested_fix=suggested_fix,
        evidence=evidence,
        code=text,
        confidence=conf,
    )
    try:
        f.confidence_features = {
            **(f.confidence_features or {}),
            "trigger": trigger,
            "vague_phrases": vague,
            "prompt_missing": missing,
            "missing_count": len(missing),
            "risky_context": risky_context,
            "risky_signal": risky_signal,
        }
    except Exception:
        pass
    return f


def _classify_trigger(text: str, vague: list[str], missing: list[str]) -> str | None:
    """Decide whether (and why) a prompt fires.

    * ``"phrase"`` — at least one vague phrase is present (primary signal).
    * ``"short"``  — no vague phrase, but the prompt is very short AND highly
      underspecified (>= 5 of 8 contract parts missing). Catches bare
      instructions like "Summarize." / "Classify this." without duplicating
      prompt-contract for ordinary-length prompts.
    * ``None``     — does not fire.
    """
    if vague:
        return "phrase"
    if _is_short(text) and len(missing) >= _SHORT_MIN_MISSING:
        return "short"
    return None


def analyze_vague_prompts(ir: AgentIR, files: list[ScannedFile]):
    """Flag vague/underspecified prompts in code and prompt/config files.

    Two deterministic triggers (see ``_classify_trigger``): an explicit vague
    phrase, or a very short + highly underspecified prompt. Severity follows
    the missing-contract-part count; criticality requires CLOSE evidence of a
    risky action surface. The scan-time LLM verifier (lib/scan-intelligence)
    only upgrades/downgrades or marks these likely false positives — it can
    never create a finding here, so every issue keeps deterministic evidence.
    """
    findings = []

    # 1) IR-modelled prompts (code-embedded, AST/call-site extracted).
    seen_prompt_files: set[str] = set()
    for p in ir.prompts:
        seen_prompt_files.add(p.location.file)
        text = p.text_preview or ""
        vague = _vague_hits(text)
        missing = _missing_parts(text)
        trigger = _classify_trigger(text, vague, missing)
        if not trigger:
            continue
        risky_context, risky_signal = _risky_context_for(ir, p.location.file, text)
        findings.append(
            _build_finding(
                name=p.name or "prompt",
                text=text,
                location=p.location,
                vague=vague,
                missing=missing,
                trigger=trigger,
                risky_context=risky_context,
                risky_signal=risky_signal,
            )
        )

    # 2) Prompt / config text files the IR doesn't model as prompts.
    for sf in files:
        rel = sf.rel_path
        dot = rel.rfind(".")
        ext = rel[dot:].lower() if dot != -1 else ""
        if ext not in _CONFIG_PROMPT_EXTS:
            continue
        # Avoid double-counting a file already represented in ir.prompts.
        if rel in seen_prompt_files:
            continue
        base = rel.rsplit("/", 1)[-1]
        # README and similar docs are not prompts — skip to avoid noise.
        if base.lower().startswith("readme") or base.lower().startswith("changelog"):
            continue

        text = "\n".join(sf.lines)
        if not text.strip():
            continue
        vague = _vague_hits(text)
        missing = _missing_parts(text)
        trigger = _classify_trigger(text, vague, missing)
        if not trigger:
            continue
        # Only treat the file as a prompt when it looks like one. This keeps
        # ordinary prose/docs that happen to contain "handle this" (or that are
        # merely short) from firing.
        looks_like_prompt = bool(_PROMPT_FILE_RX.search(rel)) or bool(_PROMPT_CUE_RX.search(text))
        if not looks_like_prompt:
            continue

        # Line of the first vague phrase (1-based) for a useful anchor.
        line = _first_vague_line(sf.lines)
        location = CodeLocation(file=rel, start_line=line, end_line=line, symbol=None)
        # No IR for plain config files, but the prompt text itself can still
        # name a risky action (handled inside _risky_context_for).
        risky_context, risky_signal = _risky_context_for(None, rel, text)
        findings.append(
            _build_finding(
                name=base,
                text=text[:500],
                location=location,
                vague=vague,
                missing=missing,
                trigger=trigger,
                risky_context=risky_context,
                risky_signal=risky_signal,
            )
        )

    # Conservative advisory confidence band + escalation hint (same Tier-2
    # annotation the other analyzers use). Does not change severity.
    for _f in findings:
        annotate_existing(
            _f, ConfidenceFeatures(sink_impact=_f.severity, prod_file=is_prod_file(_f.file))
        )
    return findings


def _first_vague_line(lines: list[str]) -> int:
    for idx, ln in enumerate(lines):
        low = ln.lower()
        if any(p in low for p in VAGUE_PHRASES):
            return idx + 1
    return 1
