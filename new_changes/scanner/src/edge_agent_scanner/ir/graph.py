from __future__ import annotations

from collections import deque
from dataclasses import asdict
from pathlib import Path
from typing import Iterable

from edge_agent_scanner.ir.models import AgentIR
from edge_agent_scanner.ir.sinks import (
    SideEffectRule,
    classify_side_effect_details,
    highest_impact,
    load_repo_side_effect_rules,
)


def outgoing(ir: AgentIR, node_id: str):
    return [e for e in ir.edges if e.src == node_id]


def incoming(ir: AgentIR, node_id: str):
    return [e for e in ir.edges if e.dst == node_id]


def find_paths(
    ir: AgentIR,
    start_ids: list[str],
    target_ids: set[str],
    max_depth: int = 8,
) -> list[list[str]]:
    """Find simple paths in the lightweight Agent IR graph using BFS."""
    if not start_ids or not target_ids:
        return []

    paths: list[list[str]] = []
    q = deque([[s] for s in start_ids])

    while q:
        path = q.popleft()
        node = path[-1]

        if node in target_ids:
            paths.append(path)
            continue

        if len(path) > max_depth:
            continue

        for e in outgoing(ir, node):
            if e.dst in path:
                continue
            q.append(path + [e.dst])

    return paths


def path_has_guard(ir: AgentIR, path: list[str], guard_kinds: set[str] | None = None) -> bool:
    """Return true when the path itself or a guarded_by edge contains a guard."""
    guard_kinds = guard_kinds or {"approval", "auth", "validation"}
    guards = {g.id: g for g in ir.guards}

    for node_id in path:
        g = guards.get(node_id)
        if g and g.kind in guard_kinds:
            return True

    for e in ir.edges:
        if e.kind != "guarded_by":
            continue
        if e.src in path and e.dst in guards and guards[e.dst].kind in guard_kinds:
            return True

    return False


def link_agents_to_tools(ir: AgentIR) -> None:
    """Add conservative fallback agent→tool links.

    Precise links should be added by extractors when they see real tool lists,
    ToolNode([...]), create_react_agent(model, tools), etc. This fallback only
    prevents empty graphs in simple repos.
    """
    if not ir.agents:
        return

    if len(ir.agents) == 1:
        agent = ir.agents[0]
        for tool in ir.tools:
            if tool.callable_from_agent:
                continue
            tool.callable_from_agent = True
            tool.metadata.setdefault("callability_reason", "single_agent_repo_fallback")
            if tool.id not in agent.tools:
                agent.tools.append(tool.id)
            ir.add_edge(agent.id, tool.id, "uses_tool", tool.location)
        return

    for tool in ir.tools:
        if tool.callable_from_agent:
            continue
        tool_dir = tool.location.file.rsplit("/", 1)[0] if "/" in tool.location.file else ""
        candidates = [
            a
            for a in ir.agents
            if (a.location.file.rsplit("/", 1)[0] if "/" in a.location.file else "") == tool_dir
        ]
        if len(candidates) == 1:
            agent = candidates[0]
            tool.callable_from_agent = True
            tool.metadata.setdefault("callability_reason", "same_directory_fallback")
            if tool.id not in agent.tools:
                agent.tools.append(tool.id)
            ir.add_edge(agent.id, tool.id, "uses_tool", tool.location)


def _tool_text_for_side_effects(tool) -> str:
    """Collect all cheap evidence we have for side-effect classification."""
    chunks = [
        tool.name,
        str(tool.metadata.get("description", "")),
        str(tool.metadata.get("docstring", "")),
        str(tool.metadata.get("operation_id", "")),
        str(tool.metadata.get("route", "")),
        str(tool.metadata.get("code", "")),
    ]
    return "\n".join(x for x in chunks if x)


def infer_tool_side_effects(
    ir: AgentIR,
    repo_root: str | Path | None = None,
    extra_rules: Iterable[SideEffectRule] = (),
) -> None:
    """Infer side effects for each tool using broad built-ins + repo config.

    The repo-specific config lets users teach Edge Agent AI app-specific tools:

      .edgeagent/config.yaml
      side_effects:
        custom_campaign_action:
          severity: high
          patterns: [launch_special_campaign]
          verbs: [launch]
          targets: [campaign]
    """
    repo_rules: tuple[SideEffectRule, ...] = ()
    if repo_root is not None:
        repo_rules = load_repo_side_effect_rules(repo_root)

    rules = tuple(extra_rules) + repo_rules

    for tool in ir.tools:
        text = _tool_text_for_side_effects(tool)
        matches = classify_side_effect_details(text, extra_rules=rules)
        existing = set(tool.side_effects)
        inferred = {m.effect for m in matches}
        tool.side_effects = sorted(existing | inferred)

        if matches:
            tool.metadata["side_effect_matches"] = [asdict(m) for m in matches]
            tool.metadata["side_effect_max_severity"] = highest_impact(tool.side_effects, extra_rules=rules)
            tool.metadata["side_effect_rules_from_config"] = len(repo_rules)
