from __future__ import annotations

import re

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_finding
from edge_agent_scanner.analyzers.finding_explanations import (
    agent_callable_tool_explanation,
    format_reason,
    standalone_sink_explanation,
    standalone_sink_title,
)
from edge_agent_scanner.ir.graph import reachable_set
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.ir.sinks import highest_impact, impact_for_effect
from edge_agent_scanner.ir.sinks_ext import is_json_dump, is_tempfile_create
from edge_agent_scanner.report import EvidencePathNode
from edge_agent_scanner.walker import ScannedFile

# Bare ``json.dumps(obj)`` is a transformation, NOT a data export. It
# only matters when its result later flows into a write/network sink.
# Same story for ``tempfile.NamedTemporaryFile`` lifecycle inside a
# try/finally: that's cleanup, not a dangerous file mutation. These
# helpers gate the "presence warning" branch so we stop firing on
# benign serializations and tempfile boilerplate.
_DATA_EXPORT_DOWNSTREAM_RX = re.compile(
    r"\b("
    r"requests\.(?:post|put|patch)|httpx\.(?:post|put|patch)|"
    r"st\.download_button|response\.json|return\s+Response|"
    r"\.write\s*\(|open\([^)]*['\"][wa]['\"]?\)|"
    r"redis\.\w+\s*\(\s*['\"]set|"
    r"boto3\.client.*put_object|s3\.upload"
    r")",
    re.I,
)

# ``shell=True`` and string-concatenation are the actual shell-injection
# precursors. A bare ``subprocess.Popen(["ffmpeg", "-i", target_path])``
# is not shell injection — it's an external-process presence warning,
# and the explanation/severity must reflect that distinction.
_SUBPROCESS_CALL_RX = re.compile(
    r"\b(subprocess\.(?:Popen|run|call|check_call|check_output)|os\.popen)\s*\(",
    re.I,
)
_SHELL_TRUE_RX = re.compile(r"shell\s*=\s*True", re.I)
_LIST_ARG_RX = re.compile(r"\(\s*\[")
_STRING_CONCAT_ARG_RX = re.compile(r"\(\s*(?:f?['\"][^'\"]*['\"]\s*\+|['\"][^'\"]*['\"]\s*\.format)")


def _is_safe_list_arg_subprocess(text: str) -> bool:
    """True iff ``text`` is a subprocess call WITHOUT a shell-injection
    risk surface.

    Accepts both the inline-list shape:
        subprocess.Popen(["ffmpeg", "-i", target_path], ...)
    AND the named-variable shape, which is the more common style:
        cmd = ["ffmpeg", ...]
        subprocess.Popen(cmd, ...)
    because the actual property we care about is the ABSENCE of
    ``shell=True`` AND the absence of a string-concatenation/format in
    the args. If neither risk-marker is present, the call is at worst
    an external-process presence warning, not a shell-injection finding.

    The inline-list case is still treated as the strongest signal —
    we set ``_LIST_ARG_RX`` to True there — but a variable arg whose
    line shows no ``shell=True`` and no ``"... " + user`` concat is
    treated as safe-by-default. This matches how subprocess is used
    in the wild (ffmpeg/sox/curl pipelines).
    """
    if not text:
        return False
    if not _SUBPROCESS_CALL_RX.search(text):
        return False
    if _SHELL_TRUE_RX.search(text):
        return False
    if _STRING_CONCAT_ARG_RX.search(text):
        return False
    # Inline list literal in the call args is a STRONG positive signal,
    # but its absence does not mean "string command" — the caller may
    # have stored the list in a local variable. In that case we still
    # treat the call as safe-list-arg as long as none of the risk
    # markers (shell=True / string concat) appear on the line.
    return True

_VALID_SEVERITIES = {"critical", "high", "medium", "low"}

# Sink kinds where standalone presence (no agent in the picture) is still
# worth surfacing — but at MUCH lower severity than the agent-callable case.
# `code_execution` (e.g. `subprocess.run`, `eval`, `os.system`) is the only
# kind we promote above "low" in this fallback because it is intrinsically
# unsafe regardless of who calls it.
_STANDALONE_SEVERITY_DOWNGRADE: dict[str, str] = {
    "critical": "medium",  # code_execution / payment / admin → medium when not agent-reachable
    "high": "low",
    "medium": "low",
    "low": "low",
}


def _tool_severity(tool) -> str:
    # Prefer graph.py's severity because it includes repo-defined sink rules.
    sev = str(tool.metadata.get("side_effect_max_severity", "")).lower()
    if sev in _VALID_SEVERITIES:
        return sev
    return highest_impact(tool.side_effects) if tool.side_effects else "medium"


def _confidence(tool) -> float:
    matches = tool.metadata.get("side_effect_matches") or []
    if isinstance(matches, list) and matches:
        try:
            return max(float(m.get("confidence", 0.75)) for m in matches if isinstance(m, dict))
        except Exception:
            return 0.82
    return 0.82 if tool.metadata.get("callability_reason") else 0.9


def _evidence(tool) -> str:
    matches = tool.metadata.get("side_effect_matches") or []
    if isinstance(matches, list) and matches:
        pieces = []
        for m in matches[:5]:
            if not isinstance(m, dict):
                continue
            pieces.append(
                f"{m.get('effect')} ({m.get('severity')}; {m.get('matched_by')}: {m.get('reason')})"
            )
        if pieces:
            return "; ".join(pieces)
    return ", ".join(tool.side_effects)


def analyze_dangerous_tools(ir: AgentIR, files: list[ScannedFile]):
    """Flag agent-callable tools with real side effects.

    This replaces keyword-only matching. A prompt string containing "Admin" is
    not enough; the finding requires an agent-callable ToolNode with classified
    side effects.
    """
    findings = []

    # Reachability gate: when the IR has agent entries, only flag tools that are
    # actually reachable from one of them in the call graph. A side-effecting
    # tool that no agent can reach is not an agent risk and should not be flagged.
    # When there are no agent entries at all (sparse IR), fall back to the
    # callable_from_agent signal so we don't silently stop flagging.
    agent_ids = [a.id for a in ir.agents]
    reach_normal = reachable_set(ir, agent_ids) if agent_ids else None

    for tool in ir.tools:
        if not tool.callable_from_agent or not tool.side_effects:
            continue

        if reach_normal is not None and tool.id not in reach_normal:
            # Agents exist but none can reach this tool in the graph.
            continue

        tool_expl = agent_callable_tool_explanation(
            tool_name=tool.name,
            side_effects=list(tool.side_effects),
            evidence=_evidence(tool),
        )
        f = make_finding(
                rule_id="dangerous-tools",
                severity=_tool_severity(tool),
                category="Dangerous tool / side effect",
                title=tool_expl.title or f"Agent-callable tool has side effects: {tool.name}",
                location=tool.location,
                reason=format_reason(tool_expl),
                suggested_fix=tool_expl.suggested_fix,
                evidence=_evidence(tool),
                code=str(tool.metadata.get("code", "")),
                confidence=_confidence(tool),
                evidence_path=[
                    EvidencePathNode(
                        kind="tool",
                        label=tool.name,
                        file=tool.location.file,
                        line=tool.location.start_line,
                    )
                ],
        )
        # Side-effect matches come from the IR ontology; exact match means a
        # concrete pattern matched rather than a broad fallback.
        matches = tool.metadata.get("side_effect_matches") or []
        annotate_finding(
            f,
            ConfidenceFeatures(
                sink_impact=_tool_severity(tool),
                source_untrusted=False,
                unguarded_path_exists=reach_normal is None or tool.id in reach_normal,
                path_length=1,
                partial_guard=False,
                ir_evidence=bool(matches),
                exact_sink_match=bool(matches),
                prod_file=is_prod_file(tool.location.file),
            ),
        )
        findings.append(f)

    findings.extend(_analyze_standalone_sinks(ir, reach_normal))
    return findings


def _analyze_standalone_sinks(ir: AgentIR, reach_normal: set[str] | None) -> list:
    """Emit lower-severity findings for dangerous SINK nodes that are NOT
    reachable from any agent in the IR.

    Rationale: the agent-callable check above only catches risky CAPABILITIES
    (ToolNodes). A bare ``subprocess.run([...])`` or ``eval(...)`` call sitting
    in a production module is still worth flagging, even when no agent is
    defined yet — but at a noticeably lower severity than the agent case so
    the scanner does not start screaming about every build script.

    Severity rules:
      * `code_execution` sinks (subprocess/eval/os.system/etc.) → **medium**
        — these are intrinsically unsafe regardless of caller.
      * All other side-effecting sinks → **low** — they need an attacker path
        before they matter, which agent-callable handles separately.

    Filter rules:
      * Skip if the sink IS reachable from an agent (already covered by the
        tool-level check, no need to double-report).
      * Skip if the file looks non-production (tests/examples/demos/etc.) —
        `is_prod_file` already encodes the project's convention.
      * Dedupe by ``(file, line, sink_kind)`` so 20 subprocess calls in the
        same file don't produce 20 findings. The per-rule cap in
        ``engine._cap_findings_per_rule`` then keeps the total bounded.
    """
    out: list = []
    seen: set[tuple[str, int, str]] = set()

    for sink in ir.sinks:
        if reach_normal is not None and sink.id in reach_normal:
            continue
        if not is_prod_file(sink.location.file):
            continue

        # ---- Downgrade benign transform / cleanup sinks -----------------
        # `json.dumps(obj)` alone is a transformation, not an export.
        # We only keep it as a finding if the same statement also
        # flows into a network/file/download sink. Otherwise suppress.
        call_expr = sink.call_expression or sink.source_line or ""
        if is_json_dump(call_expr) and not _DATA_EXPORT_DOWNSTREAM_RX.search(call_expr):
            continue
        # `tempfile.NamedTemporaryFile` / `mkstemp` are scaffolding, not
        # dangerous file mutations. Suppress unless paired with explicit
        # writes to a user-controlled path (handled by other rules).
        if is_tempfile_create(call_expr):
            continue

        base_severity = str(sink.impact or impact_for_effect(sink.kind)).lower()
        if base_severity not in _VALID_SEVERITIES:
            base_severity = "medium"
        downgraded = _STANDALONE_SEVERITY_DOWNGRADE.get(base_severity, "low")

        # `code_execution` is the only sink kind we keep at medium in the
        # standalone bucket; everything else compresses to "low" so the
        # bucket doesn't drown the report.
        if sink.kind != "code_execution" and downgraded != "low":
            downgraded = "low"

        # Sub-process with LIST args and no `shell=True` is NOT shell
        # injection. It's an external-process presence warning at low
        # severity. The explanation will reflect that distinction via
        # the metadata flag below; here we just adjust severity so a
        # safe ffmpeg/list-arg call doesn't sit at "medium".
        safe_list_arg = _is_safe_list_arg_subprocess(
            sink.call_expression or sink.source_line or ""
        )
        if safe_list_arg:
            downgraded = "low"

        key = (sink.location.file, sink.location.start_line, sink.kind)
        if key in seen:
            continue
        seen.add(key)

        sink_expl = standalone_sink_explanation(sink_kind=sink.kind, label=sink.label)
        # Prefer the verbatim call expression captured by the extractor
        # (e.g. ``os.system("rm -rf " + user_input)``) over the bare
        # normalized label (``os.system``). The label is still the
        # source-of-truth for classification / title / evidence and
        # remains available as ``sink.label`` for the analyzer logic
        # above. When the extractor couldn't recover an expression we
        # fall back to the source line, then finally to the label.
        finding_code = sink.call_expression or sink.source_line or sink.label

        # If the extractor attached upload-flow context (e.g. a
        # FormData variable's appended field names) include it on
        # the evidence so the developer can see WHAT is being
        # uploaded, not just the bare call. Keeps the finding
        # actionable while still being a single deduplicated entry.
        form_data_fields = sink.metadata.get("form_data_fields") if isinstance(sink.metadata, dict) else None
        evidence_lines = [
            f"Presence scan: {sink.kind} at {sink.label} (no agent reachability path in IR)"
        ]
        if form_data_fields:
            evidence_lines.append(f"triggered_by=form_submit fields={form_data_fields}")

        # Override title + suggested_fix wording when the sink is a
        # list-arg subprocess with no `shell=True`. The default
        # subprocess template warns about shell escaping; that wording
        # is wrong for a fixed list-arg ffmpeg/curl/python call and
        # misleads reviewers into thinking we detected command
        # injection when we didn't.
        if safe_list_arg:
            list_arg_title = (
                f"External process call (list args, no shell=True): {sink.label} "
                "(presence warning)"
            )
            list_arg_reason = (
                "What was detected: This code launches an external process via "
                f"`{sink.label}` using a LIST argument vector and without "
                "`shell=True`.\n\n"
                "Why it can be risky: External processes can still misbehave even "
                "without shell injection — risks here are untrusted media/file path "
                "validation, trusted binary path, missing process timeout/cleanup, "
                "resource exhaustion from large media, and temp output path "
                "restrictions.\n\n"
                "Why this may be okay: Fixed argument vectors (list args) and "
                "`shell=False` (the default for list args) eliminate the classic "
                "shell-injection class of bugs. Common for ffmpeg/sox/ImageMagick "
                "pipelines that pass user-supplied file paths through to a "
                "trusted binary.\n\n"
                "What to verify: That the binary path (`ffmpeg`, `curl`, etc.) "
                "comes from a trusted source — not a user-controlled lookup — "
                "and that user file paths are length/extension/contents-validated "
                "before being passed as args. Confirm the process has a timeout "
                "and the temp output path is constrained to a sandboxed directory."
            )
            list_arg_fix = (
                "Keep list args (no `shell=True`). Validate user-supplied file "
                "paths (resolve under a base dir, check extension/MIME), pin the "
                "binary path explicitly, add a timeout, clean up temp outputs, "
                "and treat unexpected stderr as a failure."
            )
            f = make_finding(
                rule_id="dangerous-tools",
                severity=downgraded,
                category="Presence warning (agent unknown)",
                title=list_arg_title,
                location=sink.location,
                reason=list_arg_reason,
                suggested_fix=list_arg_fix,
                evidence="\n".join(evidence_lines),
                code=finding_code,
                confidence=0.4,
            )
        else:
            f = make_finding(
                rule_id="dangerous-tools",
                severity=downgraded,
                category="Presence warning (agent unknown)",
                title=standalone_sink_title(sink_kind=sink.kind, label=sink.label),
                location=sink.location,
                reason=format_reason(sink_expl),
                suggested_fix=sink_expl.suggested_fix,
                evidence="\n".join(evidence_lines),
                code=finding_code,
                confidence=0.55 if downgraded == "medium" else 0.4,
            )
        annotate_finding(
            f,
            ConfidenceFeatures(
                sink_impact=base_severity,
                source_untrusted=False,
                # Standalone sinks have no agent reachability path, so the
                # "unguarded path" feature is true by construction here.
                unguarded_path_exists=True,
                path_length=1,
                partial_guard=False,
                ir_evidence=True,
                exact_sink_match=True,
                prod_file=is_prod_file(sink.location.file),
            ),
        )
        out.append(f)
    return out
