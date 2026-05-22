from __future__ import annotations

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_finding
from edge_agent_scanner.ir.graph import reachable_set
from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.ir.sinks import highest_impact, impact_for_effect
from edge_agent_scanner.report import EvidencePathNode
from edge_agent_scanner.walker import ScannedFile

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

        f = make_finding(
                rule_id="dangerous-tools",
                severity=_tool_severity(tool),
                category="Dangerous tool / side effect",
                title=f"Agent-callable tool has side effects: {tool.name}",
                location=tool.location,
                reason=(
                    "This is not a keyword-only match. The capability is represented as an "
                    "agent-callable tool and the side-effect ontology classified it as mutating, "
                    "external, privileged, or otherwise high-impact."
                ),
                suggested_fix=(
                    "Restrict tool permissions, narrow its input schema, add approval gates for "
                    "high-impact actions, and document expected safe usage."
                ),
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

        base_severity = str(sink.impact or impact_for_effect(sink.kind)).lower()
        if base_severity not in _VALID_SEVERITIES:
            base_severity = "medium"
        downgraded = _STANDALONE_SEVERITY_DOWNGRADE.get(base_severity, "low")

        # `code_execution` is the only sink kind we keep at medium in the
        # standalone bucket; everything else compresses to "low" so the
        # bucket doesn't drown the report.
        if sink.kind != "code_execution" and downgraded != "low":
            downgraded = "low"

        key = (sink.location.file, sink.location.start_line, sink.kind)
        if key in seen:
            continue
        seen.add(key)

        f = make_finding(
            rule_id="dangerous-tools",
            severity=downgraded,
            category="Dangerous code present",
            title=f"Dangerous {sink.kind.replace('_', ' ')} call: {sink.label}",
            location=sink.location,
            reason=(
                "A dangerous sink was detected in source code but no agent in the IR is "
                "currently known to reach it. Treated as a presence signal (low/medium) "
                "rather than an active risk — promote it to high/critical if the call "
                "later becomes agent-callable."
            ),
            suggested_fix=(
                "Audit the call site. If it is genuinely required, validate its inputs, "
                "drop privileges, and add explicit approval/policy gates before any "
                "agent or untrusted input can reach it."
            ),
            evidence=f"sink={sink.kind} label={sink.label}",
            code=sink.label,
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
