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


GUARD_KINDS_ALL: set[str] = {"approval", "auth", "validation"}


def _adjacency(ir: AgentIR) -> dict[str, list[str]]:
    """Build a forward adjacency map once. O(E)."""
    adj: dict[str, list[str]] = {}
    for e in ir.edges:
        adj.setdefault(e.src, []).append(e.dst)
    return adj


def guard_cut_ids(ir: AgentIR, guard_kinds: set[str] | None = None) -> set[str]:
    """Node ids to delete to test for an *unguarded bypass* path.

    Two ways a guard appears in this IR:
      (a) an inline guard node sitting on a path (source -> guard -> sink) — the
          guard's own id is removed, which cuts that path; and
      (b) a `guarded_by` edge annotating some checkpoint node with a guard (the
          guard is an attribute, not a traversal node) — we remove the *annotated*
          node, because traversing that checkpoint counts as passing a guard.

    Removing both means: any path that still reaches the sink after the cut is a
    genuinely unguarded path. This is the cut-set test, NOT single-node
    dominance — so `src -> guard_A -> sink` and `src -> guard_B -> sink` (two
    different valid guards, no single dominator) is correctly treated as safe.
    """
    guard_kinds = guard_kinds or GUARD_KINDS_ALL
    guard_ids = {g.id for g in ir.guards if g.kind in guard_kinds}
    cut: set[str] = set(guard_ids)
    for e in ir.edges:
        if e.kind == "guarded_by" and e.dst in guard_ids:
            cut.add(e.src)
    return cut


def reachable_set(ir: AgentIR, start_ids: list[str], blocked_ids: set[str] | None = None) -> set[str]:
    """Multi-source forward reachability. O(V + E).

    `blocked_ids` are treated as removed from the graph (used to model
    guard removal). A blocked start is dropped; a blocked destination is
    never traversed and never marked reachable.
    """
    blocked = blocked_ids or set()
    adj = _adjacency(ir)
    seen: set[str] = set()
    stack = [s for s in start_ids if s not in blocked]
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        for dst in adj.get(n, ()):
            if dst in blocked or dst in seen:
                continue
            stack.append(dst)
    return seen


def is_reachable(ir: AgentIR, start_ids: list[str], target_id: str, blocked_ids: set[str] | None = None) -> bool:
    if not start_ids:
        return False
    return target_id in reachable_set(ir, start_ids, blocked_ids)


def shortest_unguarded_path(
    ir: AgentIR,
    start_ids: list[str],
    target_id: str,
    blocked_ids: set[str] | None = None,
) -> list[str] | None:
    """Shortest path to `target_id` in the (optionally guard-removed) graph.

    BFS, O(V + E). Used ONLY to build evidence after a finding is already
    confirmed — never to decide whether a finding exists.
    """
    blocked = blocked_ids or set()
    adj = _adjacency(ir)
    prev: dict[str, str | None] = {}
    q: deque[str] = deque()
    for s in start_ids:
        if s in blocked or s in prev:
            continue
        prev[s] = None
        q.append(s)
    while q:
        n = q.popleft()
        if n == target_id:
            path: list[str] = []
            cur: str | None = n
            while cur is not None:
                path.append(cur)
                cur = prev[cur]
            return list(reversed(path))
        for dst in adj.get(n, ()):
            if dst in blocked or dst in prev:
                continue
            prev[dst] = n
            q.append(dst)
    return None


def node_label_index(ir: AgentIR) -> dict[str, tuple[str, str, str, int]]:
    """Map node id -> (kind, label, file, line) for human-readable evidence paths."""
    idx: dict[str, tuple[str, str, str, int]] = {}
    for a in ir.agents:
        idx[a.id] = ("agent", a.name, a.location.file, a.location.start_line)
    for t in ir.tools:
        idx[t.id] = ("tool", t.name, t.location.file, t.location.start_line)
    for g in ir.guards:
        idx[g.id] = ("guard", g.label, g.location.file, g.location.start_line)
    for s in ir.sources:
        idx[s.id] = ("source", s.label, s.location.file, s.location.start_line)
    for s in ir.sinks:
        idx[s.id] = ("sink", s.label, s.location.file, s.location.start_line)
    for m in ir.models:
        idx[m.id] = ("model", m.model_name or "model", m.location.file, m.location.start_line)
    for p in ir.prompts:
        idx[p.id] = ("prompt", p.name, p.location.file, p.location.start_line)
    for r in ir.routes:
        idx[r.id] = ("route", r.path, r.location.file, r.location.start_line)
    return idx


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
