"""Human-readable finding explanations for scanner output and UI.

Each explanation has five parts. ``format_reason`` joins them with stable
section headers so the frontend can parse and render structured panels.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class FindingExplanation:
    what_detected: str
    why_risky: str
    why_may_be_ok: str
    what_to_verify: str
    suggested_fix: str
    title: str | None = None


SECTION_WHAT = "What was detected"
SECTION_RISKY = "Why it can be risky"
SECTION_OK = "Why this may be okay"
SECTION_VERIFY = "What to verify"


def format_reason(explanation: FindingExplanation) -> str:
    return (
        f"{SECTION_WHAT}: {explanation.what_detected}\n\n"
        f"{SECTION_RISKY}: {explanation.why_risky}\n\n"
        f"{SECTION_OK}: {explanation.why_may_be_ok}\n\n"
        f"{SECTION_VERIFY}: {explanation.what_to_verify}"
    )


# ---------------------------------------------------------------------------
# Standalone sink explanations (no agent path in IR)
# ---------------------------------------------------------------------------

_PRESENCE_PREFIX = (
    "The scanner did not find an agent path to this call, so this is a "
    "presence warning, not a confirmed exploit. Risk increases mainly if "
    "user input, agent tool calls, or untrusted data can reach this code later."
)


def _label_lower(label: str) -> str:
    return (label or "").lower()


def _is_subprocess_like(label: str) -> bool:
    low = _label_lower(label)
    return any(
        x in low
        for x in (
            "subprocess.",
            "os.system",
            "os.popen",
            "check_output",
            "check_call",
            "popen",
            "child_process",
            "execsync",
            "runtime.getruntime",
        )
    )


def _is_eval_exec(label: str) -> bool:
    low = _label_lower(label)
    return bool(re.search(r"\b(eval|exec)\s*\(", low)) or low in {"eval", "exec"}


def _is_audio_or_media_export(label: str) -> bool:
    low = _label_lower(label)
    return "audio.export" in low or "video.export" in low or ".export(" in low and any(
        m in low for m in ("audio", "video", "segment", "wave", "mp3", "wav")
    )


def standalone_sink_explanation(*, sink_kind: str, label: str) -> FindingExplanation:
    """Pick an explanation template for a sink not reachable from any agent."""
    kind = (sink_kind or "").lower()
    lab = label or "unknown call"

    if kind == "code_execution" or _is_subprocess_like(lab) or _is_eval_exec(lab):
        return _standalone_subprocess_explanation(lab)
    if kind == "data_export_or_sharing" or _is_audio_or_media_export(lab):
        return _standalone_data_export_explanation(lab)
    if kind == "file_mutation":
        return _standalone_file_mutation_explanation(lab)
    if kind == "database_mutation":
        return _standalone_database_mutation_explanation(lab)
    if kind in {"external_communication", "crm_or_campaign_write"}:
        return _standalone_email_crm_explanation(lab, kind)
    if kind == "payment_or_money_movement":
        return _standalone_payment_explanation(lab)
    return _standalone_generic_explanation(lab, kind)


def standalone_sink_title(*, sink_kind: str, label: str) -> str:
    """Short, non-alarming title for presence-warning findings.

    The ``label`` argument is the normalised callee (``axios.post``,
    ``os.system``) extracted by the IR layer. Specific shapes get
    more descriptive titles so the findings list reads as a real
    description of what's happening, not a wall of generic
    "side-effect call" entries.
    """
    kind = (sink_kind or "").lower()
    lab = label or "call"

    # Outbound HTTP shapes: ``axios.post``, ``fetch``, ``client.post``.
    if _is_outbound_http_call(lab):
        verb = _http_method_from_label(lab)
        return f"Outbound HTTP {verb} call: {lab} (presence warning)"
    if kind == "code_execution" or _is_subprocess_like(lab):
        return f"OS command call: {lab} (presence warning)"
    if _is_eval_exec(lab):
        return f"Dynamic code execution: {lab} (presence warning)"
    if kind == "data_export_or_sharing" or _is_audio_or_media_export(lab):
        return f"Data export call: {lab} (presence warning)"
    if kind == "file_mutation":
        return f"File write/delete call: {lab} (presence warning)"
    if kind == "database_mutation":
        return f"Database write call: {lab} (presence warning)"
    if kind in {"external_communication", "crm_or_campaign_write"}:
        return f"Outbound message/CRM call: {lab} (presence warning)"
    if kind == "payment_or_money_movement":
        return f"Payment/billing call: {lab} (presence warning)"
    return f"{lab} — side-effect call (presence warning)"


def _is_outbound_http_call(label: str) -> bool:
    """True if ``label`` is recognisably an HTTP client call shape.

    Matches:
      * ``axios.post`` / ``axios.put`` / ``axios.delete`` / ``axios.patch``
      * bare ``fetch``
      * ``client.post`` / ``api.post`` / ``http.post`` etc.
      * ``requests.post`` / ``httpx.post``

    Used to give upload/outbound findings a clearer title than the
    generic "side-effect call" wording.
    """
    low = label.lower()
    return bool(re.match(r"^(axios|fetch|requests|httpx|superagent|api|client|http)\.(get|post|put|patch|delete)\b", low) or low == "fetch")


def _http_method_from_label(label: str) -> str:
    m = re.search(r"\.(get|post|put|patch|delete)\b", label.lower())
    return m.group(1).upper() if m else "POST"


def _standalone_subprocess_explanation(label: str) -> FindingExplanation:
    return FindingExplanation(
        what_detected=f"This code runs an operating-system command (`{label}`).",
        why_risky=(
            "Shell and process execution can run arbitrary commands on the host. "
            "That becomes dangerous when user-controlled filenames, paths, URLs, "
            "or transcript text can influence the command or its arguments."
        ),
        why_may_be_ok=(
            "This pattern is common and often expected for audio/video processing, "
            "format conversion (ffmpeg), packaging, or trusted batch jobs with fixed "
            "arguments and no agent involvement."
        ),
        what_to_verify=(
            f"{_PRESENCE_PREFIX} Verify `shell=True` is not used, paths and filenames "
            "are validated or allowlisted, and list-style subprocess arguments are used "
            "instead of string-concatenated shell commands."
        ),
        suggested_fix=(
            "Prefer fixed argument lists, avoid `shell=True`, validate paths, run with "
            "least privilege, and add approval gates if an agent or user input can ever "
            "reach this call."
        ),
    )


def _standalone_data_export_explanation(label: str) -> FindingExplanation:
    if _is_audio_or_media_export(label):
        what = f"This code exports audio or media data (`{label}`)."
        ok = (
            "Exporting segments or wave files is normal in transcription and "
            "minutes-generation workflows when output stays inside a controlled temp "
            "directory."
        )
        verify_extra = (
            "Verify output path control (no writes to shared/public folders), "
            "retention/cleanup of temporary audio, and that files are not uploaded "
            "or shared externally without intent."
        )
    else:
        what = f"This code exports, uploads, or shares data (`{label}`)."
        ok = (
            "Export helpers are normal for reports, backups, and ETL when the dataset "
            "and destination are fixed and access-controlled."
        )
        verify_extra = (
            "Verify who can trigger the export, where files land (S3 path, share link), "
            "and whether PII leaves the trust boundary."
        )

    return FindingExplanation(
        what_detected=what,
        why_risky=(
            "Exports can leak private lecture audio, meeting transcripts, customer "
            "records, or other sensitive data if paths, retention, or sharing are wrong."
        ),
        why_may_be_ok=ok,
        what_to_verify=f"{_PRESENCE_PREFIX} {verify_extra}",
        suggested_fix=(
            "Scope exports to least data, use safe default paths, enforce retention "
            "cleanup, and block agent-driven exports without explicit policy."
        ),
    )


def _standalone_file_mutation_explanation(label: str) -> FindingExplanation:
    return FindingExplanation(
        what_detected=f"This code writes, deletes, or renames files on disk (`{label}`).",
        why_risky=(
            "File mutations can destroy data, overwrite configs, or plant files in "
            "sensitive locations if paths come from users or agents."
        ),
        why_may_be_ok=(
            "Writing logs, caches, generated minutes, or temp artifacts is expected in "
            "many apps when paths are constructed internally."
        ),
        what_to_verify=(
            f"{_PRESENCE_PREFIX} Verify paths are not taken raw from user/agent input, "
            "symlinks are handled safely, and delete operations target intended files only."
        ),
        suggested_fix=(
            "Resolve paths under a known base directory, avoid world-writable locations, "
            "and require confirmation before destructive deletes on agent-driven paths."
        ),
    )


def _standalone_database_mutation_explanation(label: str) -> FindingExplanation:
    return FindingExplanation(
        what_detected=f"This code mutates persistent database state (`{label}`).",
        why_risky=(
            "Inserts, updates, and deletes can corrupt records, bypass business rules, "
            "or exfiltrate data when query parameters or IDs are attacker-controlled."
        ),
        why_may_be_ok=(
            "Normal ORM saves and migrations in application services are fine when "
            "only trusted server code performs them."
        ),
        what_to_verify=(
            f"{_PRESENCE_PREFIX} Verify parameterized queries, tenant scoping, and that "
            "agents cannot supply arbitrary table/column/filter values."
        ),
        suggested_fix=(
            "Use parameterized queries, enforce authorization per row/tenant, and gate "
            "high-impact mutations behind human approval when agents are involved."
        ),
    )


def _standalone_email_crm_explanation(label: str, kind: str) -> FindingExplanation:
    channel = "email/SMS/chat notification" if kind == "external_communication" else "CRM or campaign"
    return FindingExplanation(
        what_detected=f"This code triggers outbound {channel} actions (`{label}`).",
        why_risky=(
            "Automated messages and CRM updates can spam users, leak data to the wrong "
            "recipient, or change sales records at scale."
        ),
        why_may_be_ok=(
            "Transactional email, internal alerts, and CRM sync from trusted cron jobs "
            "are common when recipients and payloads are fixed."
        ),
        what_to_verify=(
            f"{_PRESENCE_PREFIX} Verify recipient lists, template content, and rate limits "
            "cannot be overridden by agent or end-user input without review."
        ),
        suggested_fix=(
            "Add approval for bulk sends, validate recipients against allowlists, and "
            "log every external message for audit."
        ),
    )


def _standalone_payment_explanation(label: str) -> FindingExplanation:
    return FindingExplanation(
        what_detected=f"This code touches payments, billing, or money movement (`{label}`).",
        why_risky=(
            "Charges, refunds, and payouts have direct financial impact and are high-value "
            "targets for prompt injection or tool abuse."
        ),
        why_may_be_ok=(
            "Server-side billing webhooks and admin-only refund tools may be intentional "
            "when not exposed to agents."
        ),
        what_to_verify=(
            f"{_PRESENCE_PREFIX} Verify amounts and customer IDs cannot be set by agents "
            "without human approval and idempotency keys are used."
        ),
        suggested_fix=(
            "Require human-in-the-loop for money movement, use Stripe/dashboard controls, "
            "and never pass raw agent output into payment APIs."
        ),
    )


def _standalone_generic_explanation(label: str, kind: str) -> FindingExplanation:
    kind_readable = (kind or "side effect").replace("_", " ")
    return FindingExplanation(
        what_detected=f"This code performs a `{kind_readable}` operation (`{label}`).",
        why_risky=(
            "Capabilities with real-world side effects can cause harm when reachable from "
            "untrusted input or autonomous agents."
        ),
        why_may_be_ok=(
            "Many side-effecting calls are part of normal application logic when only "
            "trusted code paths invoke them."
        ),
        what_to_verify=_PRESENCE_PREFIX,
        suggested_fix=(
            "Document why this call exists, restrict who can trigger it, and add policy "
            "gates before any agent or user input can reach it."
        ),
    )


# ---------------------------------------------------------------------------
# Agent-callable tool explanations
# ---------------------------------------------------------------------------

def agent_callable_tool_explanation(*, tool_name: str, side_effects: list[str], evidence: str) -> FindingExplanation:
    effects = ", ".join(side_effects) if side_effects else "high-impact side effects"
    primary = (side_effects[0] if side_effects else "").lower()

    if primary == "code_execution" or "code_execution" in side_effects:
        return FindingExplanation(
            what_detected=(
                f"Agent-callable tool `{tool_name}` is classified as OS/code execution ({effects})."
            ),
            why_risky=(
                "An agent that invokes this tool can run shell commands or processes on the host. "
                "Prompt injection or malicious user input may influence arguments."
            ),
            why_may_be_ok=(
                "Safe when the tool wraps a fixed, audited command with no user-controlled "
                "strings and strong sandboxing."
            ),
            what_to_verify=(
                "Confirm which agents can call this tool, whether inputs are validated, and "
                "whether human approval runs before execution."
            ),
            suggested_fix=(
                "Narrow the tool schema, disallow shell=True, add approval gates, and log "
                "every invocation with arguments redacted."
            ),
            title=f"Agent tool runs OS commands: {tool_name}",
        )

    if primary in {"data_export_or_sharing", "file_mutation", "database_mutation"}:
        return FindingExplanation(
            what_detected=f"Agent-callable tool `{tool_name}` can mutate or export data ({effects}).",
            why_risky="Agents may exfiltrate or overwrite sensitive lecture, meeting, or customer data.",
            why_may_be_ok="Acceptable when exports are scoped, audited, and limited to authorized tenants.",
            what_to_verify="Review agent permissions, output paths, and retention for this tool.",
            suggested_fix="Restrict tool permissions, add approval for exports/deletes, and monitor usage.",
            title=f"Agent tool with data side effect: {tool_name}",
        )

    if primary in {"external_communication", "crm_or_campaign_write", "payment_or_money_movement"}:
        return FindingExplanation(
            what_detected=f"Agent-callable tool `{tool_name}` triggers external impact ({effects}).",
            why_risky="Agents could send messages, change CRM records, or move money without human review.",
            why_may_be_ok="Fine for internal ops tools with fixed templates and admin-only agents.",
            what_to_verify="Check approval workflow, recipient validation, and financial limits.",
            suggested_fix="Add human-in-the-loop, rate limits, and least-privilege tool scopes.",
            title=f"Agent tool with external side effect: {tool_name}",
        )

    return FindingExplanation(
        what_detected=f"Agent-callable tool `{tool_name}` has classified side effects: {effects}.",
        why_risky=(
            "The IR shows this capability is reachable from an agent and can cause real-world "
            f"impact. Evidence: {evidence or 'side-effect ontology match'}."
        ),
        why_may_be_ok="May be intentional when the tool is tightly scoped and guarded by policy.",
        what_to_verify="Trace which agents call this tool and whether guards block unapproved use.",
        suggested_fix=(
            "Restrict tool permissions, narrow its input schema, add approval gates for "
            "high-impact actions, and document expected safe usage."
        ),
        title=f"Agent-callable tool has side effects: {tool_name}",
    )


# ---------------------------------------------------------------------------
# Accuracy / model configuration
# ---------------------------------------------------------------------------

def accuracy_regression_explanation(*, signal: str, code_line: str) -> FindingExplanation:
    low = (signal or "").lower()
    line_preview = (code_line or "").strip()[:120]

    if "model" in low:
        return FindingExplanation(
            what_detected=f"This code configures the LLM model (`{line_preview}`).",
            why_risky=(
                "This is not a security bug. It is a quality-risk signal: model or "
                "provider changes can shift translation, summarization, action-item extraction, "
                "and formatting behavior."
            ),
            why_may_be_ok=(
                "Upgrading models or tuning parameters is normal during development when you "
                "plan to re-run evals."
            ),
            what_to_verify=(
                "Add regression examples for expected lecture/minutes outputs. Compare before/after "
                "on representative multilingual transcripts."
            ),
            suggested_fix=(
                "Run accuracy and regression behavioral suites. Pin model version in config and "
                "record gold outputs for critical workflows."
            ),
            # The static analyzer is single-shot — it sees the current
            # config but has no baseline to compare against. Saying
            # "changed" implies a diff that doesn't exist. The
            # ``analyzers/accuracy_regression.py`` baseline-aware path
            # is what swaps this to "Model configuration changed" once
            # an old/new model pair is observed.
            title="Model configuration detected",
        )

    if "temperature" in low:
        return FindingExplanation(
            what_detected=f"Sampling temperature is set in agent/model code (`{line_preview}`).",
            why_risky=(
                "Higher temperature increases randomness and can reduce consistency of summaries, "
                "minutes, and structured outputs."
            ),
            why_may_be_ok="Low temperature on extraction steps, or intentional creativity on draft text.",
            what_to_verify="Confirm temperature matches the task (low for facts, higher only for brainstorming).",
            suggested_fix="Add behavioral tests that assert stable JSON/section structure on fixed inputs.",
            title="Temperature configured on model call",
        )

    if "top_k" in low or "retriever" in low:
        return FindingExplanation(
            what_detected=f"Retriever top_k (or similar) is configured (`{line_preview}`).",
            why_risky="Changing retrieval breadth can add noise or drop relevant lecture context.",
            why_may_be_ok="Tuning retrieval is expected when improving RAG quality with measured evals.",
            what_to_verify="Re-run retrieval QA cases and check citation coverage on sample lectures.",
            suggested_fix="Snapshot top_k in config docs and add eval cases for recall/precision.",
            title="Retriever top_k detected",
        )

    if "schema" in low or "output" in low:
        return FindingExplanation(
            what_detected=f"Structured output schema or response format is configured (`{line_preview}`).",
            why_risky="Schema changes can break downstream parsers for minutes, action items, or UI.",
            why_may_be_ok="Intentional API contract upgrades with versioned consumers.",
            what_to_verify="Validate JSON/schema against golden files and API clients.",
            suggested_fix="Add contract tests and behavioral checks for required fields.",
            title="Output schema or format detected",
        )

    return FindingExplanation(
        what_detected=f"Static accuracy-risk signal: {signal} (`{line_preview}`).",
        why_risky="Configuration drift can change agent outputs without a compile-time error.",
        why_may_be_ok="Benign refactors that do not affect user-visible behavior.",
        what_to_verify="Run behavioral evals on representative inputs before release.",
        suggested_fix="Run accuracy and regression behavioral suites for this workflow.",
        title=signal,
    )
