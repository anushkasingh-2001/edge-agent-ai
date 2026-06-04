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


def _repo_has_risky_agent_tool(ir: AgentIR) -> bool:
    """True when the repo exposes an agent-callable tool with real side
    effects — the precondition for escalating a vague action prompt to
    critical."""
    return any(t.callable_from_agent and t.side_effects for t in ir.tools)


def _file_has_dangerous_sink(ir: AgentIR, file: str) -> bool:
    return any(
        s.location.file == file and s.impact in ("high", "critical") for s in ir.sinks
    )


def _build_finding(
    *,
    name: str,
    text: str,
    location: CodeLocation,
    vague: list[str],
    missing: list[str],
    risky_context: bool,
):
    sev = _severity_for(len(missing))

    # Critical: vague phrasing + a risky/action surface + none of the three
    # safety-critical contract parts (approval, tool policy, output schema).
    critical_gap = {"approval", "tool_policy", "output_format"}.issubset(set(missing))
    if vague and risky_context and critical_gap:
        sev = "critical"

    conf = _confidence_for(sev)

    missing_labels = ", ".join(missing) if missing else "none"
    vague_labels = ", ".join(f'"{v}"' for v in vague) if vague else "none"

    if sev == "critical":
        title = f"Vague action prompt with no approval/tool/output policy: {name}"
    else:
        title = f"Vague / underspecified prompt: {name}"

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
        f"vague_phrases={'|'.join(vague) if vague else 'none'}; "
        f"missing={','.join(missing) if missing else 'none'}; "
        f"missing_count={len(missing)}"
        + ("; risky_context=1" if risky_context else "")
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
            "vague_phrases": vague,
            "prompt_missing": missing,
            "missing_count": len(missing),
            "risky_context": risky_context,
        }
    except Exception:
        pass
    return f


def analyze_vague_prompts(ir: AgentIR, files: list[ScannedFile]):
    """Flag vague/underspecified prompts in code and prompt/config files.

    Trigger is a vague phrase (the defining signal of this check, which keeps
    it distinct from the broader ``prompt-contract`` analyzer); severity is
    driven by how many of the eight contract parts are missing. The LLM
    verifier — when the scan mode allows it — only ever upgrades/downgrades or
    marks these as likely false positives; it cannot create a finding here
    because every finding requires a real matched phrase.
    """
    findings = []
    risky_repo = _repo_has_risky_agent_tool(ir)

    # 1) IR-modelled prompts (code-embedded, AST/call-site extracted).
    seen_prompt_files: set[str] = set()
    for p in ir.prompts:
        seen_prompt_files.add(p.location.file)
        text = p.text_preview or ""
        vague = _vague_hits(text)
        if not vague:
            continue
        missing = _missing_parts(text)
        risky_context = risky_repo or _file_has_dangerous_sink(ir, p.location.file)
        findings.append(
            _build_finding(
                name=p.name or "prompt",
                text=text,
                location=p.location,
                vague=vague,
                missing=missing,
                risky_context=risky_context,
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
        if not vague:
            continue
        # Only treat the file as a prompt when it looks like one. This keeps
        # ordinary prose that happens to contain "handle this" from firing.
        looks_like_prompt = bool(_PROMPT_FILE_RX.search(rel)) or bool(_PROMPT_CUE_RX.search(text))
        if not looks_like_prompt:
            continue

        missing = _missing_parts(text)
        # Line of the first vague phrase (1-based) for a useful anchor.
        line = _first_vague_line(sf.lines)
        location = CodeLocation(file=rel, start_line=line, end_line=line, symbol=None)
        # No IR for plain config files → can't prove a risky action surface,
        # so these never escalate to critical on their own.
        findings.append(
            _build_finding(
                name=base,
                text=text[:500],
                location=location,
                vague=vague,
                missing=missing,
                risky_context=False,
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
