from __future__ import annotations

import re

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_existing
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.walker import ScannedFile

# Concept dictionaries are split by prompt FAMILY because the operational
# expectations differ substantially:
#   * extraction/schema prompts (JSON output, classification, NER) should
#     have output-format + uncertainty/null handling. They do NOT need a
#     tool-use or approval policy because they don't drive actions.
#   * action/tool/agent prompts (function-calling agents, autopilots,
#     code execution) need role, tool boundary, approval rules, output
#     schema, and uncertainty handling. The expensive check belongs here.
EXTRACTION_REQUIRED = {
    "output_schema": ["json", "schema", "format", "return", "fields"],
    "uncertainty": ["uncertain", "null", "unknown", "n/a", "ask", "do not guess"],
    "hallucination_guard": [
        "only", "exactly", "verbatim", "do not invent", "do not make up",
        "do not hallucinate", "as written",
    ],
}
ACTION_REQUIRED = {
    "role": ["you are", "role", "act as", "your job"],
    "task_boundary": ["task", "goal", "objective", "scope", "must not", "do not"],
    "tool_policy": ["tool", "function", "call", "api"],
    "approval": ["approval", "confirm", "human", "permission", "ask before"],
    "output_schema": ["json", "schema", "format", "return"],
    "uncertainty": ["uncertain", "ask", "clarify", "do not guess"],
    "unsafe_action_boundary": [
        "do not delete", "do not send", "do not pay", "do not transfer",
        "without confirmation", "without approval", "must not modify",
    ],
}

# Backwards-compat: some external callers/tests import the legacy
# combined dict. Keep it as a derived view of the union so behaviour
# stays identical when the family classifier hasn't run.
REQUIRED_CONCEPTS = {**EXTRACTION_REQUIRED, **ACTION_REQUIRED}

# Cues that strongly suggest an extraction/schema prompt.
_EXTRACTION_CUES_RX = re.compile(
    r"\b(extract|classify|categorize|tag|annotate|parse|"
    r"return\s+(?:a\s+)?json|output\s+json|"
    r"schema|fields|entities|relations|"
    r"\"type\"\s*:|\"properties\"\s*:|"
    r"ner|named\s*entity|sentiment|intent)\b",
    re.I,
)

# Cues that strongly suggest an action/tool/agent prompt.
_ACTION_CUES_RX = re.compile(
    r"\b(call\s+the?\s*(?:tool|function|api)|"
    r"use\s+the?\s*(?:tool|function|api)|"
    r"invoke|execute|run\s+(?:the|this)?\s*(?:command|script)|"
    r"send\s+an?\s*email|create\s+a?\s*meeting|"
    r"approve|deploy|rollback|refund|charge|"
    r"agent|autopilot|tool_calls?\b)",
    re.I,
)


def _classify_prompt_family(text: str) -> str:
    """Return ``"extraction"``, ``"action"``, or ``"general"``.

    The classifier picks the family with more cue hits, falling back
    to ``"general"`` when both are zero. A prompt that names a known
    action-taking tool (``_is_action_taking_prompt``) is always
    classified as ``"action"`` regardless of how many extraction cues
    fire alongside it — the presence of a CRM/payment/campaign tool
    name is the strongest signal a prompt actually drives actions.
    """
    low = (text or "").lower()
    extract = len(_EXTRACTION_CUES_RX.findall(low))
    act = len(_ACTION_CUES_RX.findall(low))
    # Explicit action-tool name beats everything: `create_cadence`,
    # `send_email`, etc. are unambiguous action-taking calls and we
    # want the approval-policy check to fire even when the prompt
    # also asks for a JSON status output.
    if _is_action_taking_prompt(low):
        return "action"
    if extract == 0 and act == 0:
        return "general"
    if act > extract:
        return "action"
    if extract > act:
        return "extraction"
    # Tie → action wins (higher stakes).
    return "action"

#: Tool names whose presence in a prompt strongly suggests the model
#: can take real-world ACTIONS (create/launch outreach, modify CRM
#: state, schedule jobs). When these names appear *and* the prompt
#: lacks an explicit approval policy, we surface a more specific
#: title than the generic "underspecified" so users see WHY the
#: prompt is risky (action-taking without approval boundary).
_ACTION_TOOL_NAMES = (
    "create_cadence",
    "add_contacts_to_cadence",
    "launchcampaign", "launch_campaign",
    "create_campaign",
    "send_email", "sendemail",
    "send_sms", "sendsms",
    "create_meeting", "schedule_meeting",
    "delete_", "remove_",
    "refund_", "charge_",
    "deploy_", "rollback_",
)


def _is_action_taking_prompt(text: str) -> bool:
    low = text.lower()
    return any(name in low for name in _ACTION_TOOL_NAMES)


def _missing_concepts(text: str, concepts: dict[str, list[str]]) -> list[str]:
    low = text.lower()
    return [name for name, words in concepts.items() if not any(w in low for w in words)]


def analyze_prompt_contract(ir: AgentIR, files: list[ScannedFile]):
    """Surface prompts whose contract is missing the concepts that
    actually matter for their FAMILY.

    Why family-aware?
    -----------------
    A pure extraction prompt ("Return JSON with these fields…") does not
    need a tool-use policy because it doesn't invoke tools. Firing
    "missing tool policy" on such prompts is the kind of generic noise
    that erodes trust in the scanner. Conversely, an action-taking
    agent prompt without an approval boundary is a real finding even
    when role + schema are present.

    The classifier picks ``extraction`` / ``action`` / ``general`` from
    prompt text cues and applies a different concept set per family.
    Per-file grouping (one representative per prompt file/family) is
    handled later in ``analyzers.finding_grouping``.
    """
    findings = []
    for p in ir.prompts:
        text = p.text_preview
        family = _classify_prompt_family(text)

        if family == "extraction":
            missing = _missing_concepts(text, EXTRACTION_REQUIRED)
            # Extraction prompts need ALL three of:
            #   output_schema, uncertainty handling, hallucination guard.
            # Even missing one is worth surfacing — these are cheap
            # additions and high impact on extraction quality.
            if not missing:
                continue
            title = (
                f"Extraction prompt missing output/uncertainty contract: {p.name}"
            )
            reason = (
                "This prompt drives information extraction (JSON/schema/classification) "
                "but does not specify "
                + ", ".join(missing)
                + ". Without an explicit output schema, null/uncertainty handling, and "
                "a hallucination guard, the model is free to invent fields or guess "
                "when the source text doesn't contain the requested information."
            )
            suggested_fix = (
                "Pin an output schema (JSON Schema / TypedDict / Pydantic), define "
                "exactly how to represent unknown/uncertain values (use null, not "
                "'unknown'), and add an instruction like 'Only extract values that "
                "appear verbatim in the source; otherwise return null.'"
            )
            sev = "medium" if len(missing) >= 2 else "low"
            conf = 0.7
            family_tag = "extraction"

        elif family == "action":
            missing = _missing_concepts(text, ACTION_REQUIRED)
            # Action prompts: fire if any of the high-stakes concepts
            # are missing (approval, unsafe_action_boundary, tool_policy).
            # Or if 3+ general concepts are missing.
            critical_missing = {"approval", "unsafe_action_boundary"} & set(missing)
            if not critical_missing and len(missing) < 3:
                continue
            title = (
                f"Prompt lacks explicit approval policy for action tools: {p.name}"
                if "approval" in critical_missing
                else f"Prompt drives tools/agent actions but is underspecified: {p.name}"
            )
            reason = (
                "This prompt references tools/agent actions that can mutate external "
                "state (send/create/delete/deploy) but does not specify "
                + ", ".join(missing)
                + ". A prompt-injection or model hallucination here can cause "
                "real-world side effects without a human in the loop."
            )
            suggested_fix = (
                "Add: (1) a role + task scope, (2) an enumerated tool-use policy, "
                "(3) explicit approval rules ('ask before sending/deleting/deploying'), "
                "(4) unsafe action boundaries ('never charge/refund/transfer without "
                "explicit confirmation'), and (5) an output schema so the model has "
                "to surface intended actions before executing them."
            )
            sev = "high" if "approval" in critical_missing else "medium"
            conf = 0.78 if "approval" in critical_missing else 0.68
            family_tag = "action"

        else:
            # ``general`` — keep legacy 3-missing threshold and the
            # action-tool heuristic for backwards compatibility with
            # the existing test corpus.
            missing = _missing_concepts(text, REQUIRED_CONCEPTS)
            is_action_prompt = _is_action_taking_prompt(text) and "approval" in missing
            if len(missing) < 3 and not is_action_prompt:
                continue
            title = (
                f"Prompt lacks explicit approval policy for action tools: {p.name}"
                if is_action_prompt
                else f"Prompt contract is underspecified: {p.name}"
            )
            reason = (
                "The prompt references tools that can mutate external state "
                "(outreach, CRM, payments, deployments) but does not define an "
                "approval/confirmation step."
                if is_action_prompt
                else "The prompt is attached to agent/model logic but lacks several operational constraints."
            )
            suggested_fix = (
                "Add an explicit approval policy: enumerate which tool calls require "
                "human confirmation before execution, document the approval channel, "
                "and reference those rules in the prompt body."
                if is_action_prompt
                else "Add role, task boundary, tool-use policy, approval behavior, output schema, and uncertainty/clarification rules."
            )
            sev = "medium"
            conf = 0.68
            family_tag = "general"

        f = make_finding(
            rule_id="prompt-contract",
            severity=sev,
            category="Prompt contract",
            title=title,
            location=p.location,
            reason=reason,
            suggested_fix=suggested_fix,
            evidence=f"family={family_tag}; missing=" + ",".join(missing),
            code=p.text_preview,
            confidence=conf,
        )
        try:
            f.confidence_features = {
                **(f.confidence_features or {}),
                "prompt_family": family_tag,
                "prompt_missing": missing,
            }
        except Exception:
            pass
        findings.append(f)

    # Tier 2 (conservative): attach advisory confidence band + escalation
    # WITHOUT changing severity or the analyzer's own confidence value.
    for _f in findings:
        annotate_existing(_f, ConfidenceFeatures(sink_impact=_f.severity, prod_file=is_prod_file(_f.file)))
    return findings
