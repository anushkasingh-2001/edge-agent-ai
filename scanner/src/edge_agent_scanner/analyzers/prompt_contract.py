from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_existing
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.walker import ScannedFile

REQUIRED_CONCEPTS = {
    "role": ["you are", "role"],
    "tool_policy": ["tool", "function", "call"],
    "approval": ["approval", "confirm", "human", "permission"],
    "output_schema": ["json", "schema", "format", "return"],
    "uncertainty": ["uncertain", "ask", "clarify", "do not guess"],
}

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


def analyze_prompt_contract(ir: AgentIR, files: list[ScannedFile]):
    findings = []
    for p in ir.prompts:
        text = p.text_preview.lower()
        missing = [name for name, words in REQUIRED_CONCEPTS.items() if not any(w in text for w in words)]
        # Action-taking prompts get a sharper, more honest title so
        # users can tell at a glance that the prompt mentions tools
        # that mutate external state but has no approval boundary.
        is_action_prompt = _is_action_taking_prompt(text) and "approval" in missing
        # Fire when:
        #   * 3+ concepts missing (generic underspecified contract), OR
        #   * the prompt references action-taking tools and explicitly
        #     lacks an approval policy — that alone is worth surfacing
        #     even when role / output_schema / etc. are present.
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
            "Add an explicit approval policy: enumerate which tool calls require human "
            "confirmation before execution, document the approval channel, and reference "
            "those rules in the prompt body. Combine with an output schema so the model "
            "surfaces the intended action before performing it."
            if is_action_prompt
            else "Add role, task boundary, tool-use policy, approval behavior, output schema, and uncertainty/clarification rules."
        )
        findings.append(
            make_finding(
                rule_id="prompt-contract",
                severity="medium",
                category="Prompt contract",
                title=title,
                location=p.location,
                reason=reason,
                suggested_fix=suggested_fix,
                evidence="missing=" + ",".join(missing),
                code=p.text_preview,
                confidence=0.68,
            )
        )
    # Tier 2 (conservative): attach advisory confidence band + escalation
    # WITHOUT changing severity or the analyzer's own confidence value.
    for _f in findings:
        annotate_existing(_f, ConfidenceFeatures(sink_impact=_f.severity, prod_file=is_prod_file(_f.file)))
    return findings
