"""Detect actual agents in a repo (not frameworks).

LangChain / LangGraph / LlamaIndex / Pydantic AI / CrewAI / Agno are
*frameworks*. The user's agents are the things they build with those
frameworks: ``class LangGraphSalesAgent``, ``app = workflow.compile()``,
``agent = AgentExecutor(...)``, files named ``support_agent.py``, etc.

We surface those separately so the top-bar agent picker stops listing
"LangChain" as an agent. Each ``AgentHit`` has a primary file location and
the framework that powers it (so the UI can still show a "LangGraph"
sub-label without confusing frameworks with agents).
"""

from __future__ import annotations

import re
from typing import Literal

from edge_agent_scanner.report import AgentHit
from edge_agent_scanner.walker import ScannedFile

# Per-project safety cap. UIs typically render <20; >50 means we're matching
# noise.
_MAX_AGENTS = 50

# ---- Class-based heuristics (Python) -----------------------------------

# `class <Name>Agent[(:]`. Matches LangGraphSalesAgent, RefundAgent, etc.
# Skips the bare base class name "Agent" so we don't promote
# `class Agent(BaseModel)` from random pydantic schemas.
_PY_AGENT_CLASS = re.compile(r"^\s*class\s+([A-Za-z_]\w*Agent)\s*[\(:]")
_PY_AGENT_BASE_CLASS = re.compile(
    r"^\s*class\s+([A-Za-z_]\w*)\s*\(\s*[^)]*\b(?:Agent|BaseAgent|AgentExecutor)\b"
)

# ---- Assignment-based heuristics (Python) ------------------------------

# Each entry: (regex matching the RHS, kind label).
_PY_ASSIGN_PATTERNS: list[tuple[re.Pattern[str], Literal["compiled_graph", "agent_executor", "agent_factory"]]] = [
    (re.compile(r"^\s*([A-Za-z_]\w*)\s*=\s*StateGraph\s*\("), "compiled_graph"),
    (re.compile(r"^\s*([A-Za-z_]\w*)\s*=\s*AgentExecutor\s*\("), "agent_executor"),
    (re.compile(r"^\s*([A-Za-z_]\w*)\s*=\s*initialize_agent\s*\("), "agent_factory"),
    (re.compile(r"^\s*([A-Za-z_]\w*)\s*=\s*create_\w*agent\s*\("), "agent_factory"),
]

# Pydantic AI / CrewAI / Agno all expose an `Agent(...)` constructor that we
# only treat as an agent when one of their imports is in scope. Otherwise
# `Agent(BaseModel)` etc. would create false positives.
_PY_AGENT_CTOR = re.compile(r"^\s*([A-Za-z_]\w*)\s*=\s*Agent\s*\(")

# ---- TS/JS heuristics (lighter touch) ----------------------------------

_TS_AGENT_CLASS = re.compile(r"\bclass\s+(\w+Agent)\b(?:\s+extends|\s*\{)")
_TS_AGENT_CONST = re.compile(
    r"\b(?:export\s+const|const|let|export\s+let)\s+(\w+(?:Agent|agent))\s*=\s*new\s+\w*Agent\s*\("
)

# ---- Filename / path conventions ---------------------------------------

_AGENT_FILENAME_SUFFIXES = ("_agent.py", "_agent.ts", "_agent.tsx")
_AGENT_DIR_NAME = "agents"

# ---- Framework attribution from imports --------------------------------

_FRAMEWORK_HINTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\blanggraph\b", re.I), "LangGraph"),
    (re.compile(r"\blangchain\b", re.I), "LangChain"),
    (re.compile(r"\bllama_index\b|\bllama-index\b", re.I), "LlamaIndex"),
    (re.compile(r"\bpydantic_ai\b", re.I), "Pydantic AI"),
    (re.compile(r"^\s*(?:from|import)\s+agno\b", re.I | re.M), "Agno"),
    (re.compile(r"\bcrewai\b", re.I), "CrewAI"),
    (re.compile(r"\bmcp\.server\b|\bmodelcontextprotocol\b", re.I), "MCP"),
]

# Frameworks whose `Agent(...)` constructor we trust as an agent declaration.
_AGENT_CTOR_FRAMEWORKS = {"Pydantic AI", "CrewAI", "Agno"}


def _attribute_framework(lines: list[str]) -> str | None:
    head = "\n".join(lines[:80])
    for rx, name in _FRAMEWORK_HINTS:
        if rx.search(head):
            return name
    return None


def _stem_name(rel_path: str) -> str:
    base = rel_path.rsplit("/", 1)[-1]
    if "." in base:
        base = base.rsplit(".", 1)[0]
    if base.endswith("_agent"):
        base = base[: -len("_agent")]
    return base or rel_path


def detect_agents(files: list[ScannedFile]) -> list[AgentHit]:
    """Return a deduped list of agents detected across the project.

    Sorted: framework first (None last), then by file. Capped at
    ``_MAX_AGENTS`` to keep payloads sane.
    """
    hits: list[AgentHit] = []
    seen: set[tuple[str, str]] = set()  # (file, name)

    def _add(hit: AgentHit) -> bool:
        key = (hit.file, hit.name)
        if key in seen:
            return False
        seen.add(key)
        hits.append(hit)
        return True

    for sf in files:
        if len(hits) >= _MAX_AGENTS:
            break
        rel = sf.rel_path
        framework = _attribute_framework(sf.lines)
        path_parts = rel.split("/")
        in_agents_dir = _AGENT_DIR_NAME in path_parts[:-1]
        suffix_match = any(rel.endswith(s) for s in _AGENT_FILENAME_SUFFIXES)
        is_python = rel.endswith(".py")
        is_ts_js = rel.endswith((".ts", ".tsx", ".js", ".jsx"))
        per_file_hits = 0

        if is_python:
            # If a class match fires anywhere in the file, we treat assignments
            # like `workflow = StateGraph(...)` later in the same file as
            # internal scaffolding of that agent, not separate agents.
            file_has_class_agent = False
            for i, line in enumerate(sf.lines, start=1):
                # `class FooAgent:` or `class FooAgent(...):` — strongest signal.
                m = _PY_AGENT_CLASS.match(line)
                if m and m.group(1) != "Agent":
                    if _add(AgentHit(name=m.group(1), file=rel, line=i, kind="agent_class", framework=framework)):
                        per_file_hits += 1
                    file_has_class_agent = True
                    continue

                # `class Foo(BaseAgent)` / inherits from Agent/AgentExecutor.
                m = _PY_AGENT_BASE_CLASS.match(line)
                if m and m.group(1) != "Agent":
                    if _add(AgentHit(name=m.group(1), file=rel, line=i, kind="agent_class", framework=framework)):
                        per_file_hits += 1
                    file_has_class_agent = True
                    continue

                # Once we've recorded an agent class in this file, skip
                # assignment-style agents (StateGraph/AgentExecutor/etc.) in
                # the same file — they're almost always internal pieces of
                # the same agent (e.g. `self.workflow = StateGraph(...)`).
                if file_has_class_agent:
                    continue

                # Assignments to known agent constructors.
                matched = False
                for rx, kind in _PY_ASSIGN_PATTERNS:
                    m = rx.match(line)
                    if m:
                        if _add(AgentHit(name=m.group(1), file=rel, line=i, kind=kind, framework=framework)):
                            per_file_hits += 1
                        matched = True
                        break
                if matched:
                    continue

                # `agent = Agent(...)` — only trust this when the file imports
                # one of the Agent-from-framework packages.
                m = _PY_AGENT_CTOR.match(line)
                if m and framework in _AGENT_CTOR_FRAMEWORKS:
                    if _add(AgentHit(name=m.group(1), file=rel, line=i, kind="agent_factory", framework=framework)):
                        per_file_hits += 1

        elif is_ts_js:
            for i, line in enumerate(sf.lines, start=1):
                cls = _TS_AGENT_CLASS.search(line)
                if cls and cls.group(1) != "Agent":
                    if _add(AgentHit(name=cls.group(1), file=rel, line=i, kind="agent_class", framework=framework)):
                        per_file_hits += 1
                    continue
                cst = _TS_AGENT_CONST.search(line)
                if cst:
                    if _add(AgentHit(name=cst.group(1), file=rel, line=i, kind="agent_factory", framework=framework)):
                        per_file_hits += 1

        # File-level fallback: nothing specific matched but the path screams
        # "this is an agent file" (e.g. agents/sales.py, support_agent.py).
        if per_file_hits == 0 and (suffix_match or in_agents_dir):
            name = _stem_name(rel)
            if name and name != "agent":
                _add(AgentHit(name=name, file=rel, line=1, kind="agent_file", framework=framework))
            elif name == "agent":
                # Plain `agent.py` at the root — give it the project-stem-y
                # generic name so the UI can still show a single agent.
                _add(AgentHit(name="agent", file=rel, line=1, kind="agent_file", framework=framework))

    # Stable sort: framework first (alphabetical, None last), then file.
    hits.sort(key=lambda a: (a.framework or "~", a.file, a.line, a.name))
    return hits


def attribute_tools_to_agents(
    tools: list,  # list[ToolHit]; avoids circular import
    agents: list[AgentHit],
) -> None:
    """Mutate ``tools`` in place: assign ``agent`` based on directory
    proximity. If the project has exactly one agent every unattributed tool
    goes to it (the common single-agent repo case like Sales-dev-assistant).
    """
    if not tools or not agents:
        return

    # Single-agent case: simple and matches user intuition.
    if len(agents) == 1:
        only = agents[0].name
        for t in tools:
            if not getattr(t, "agent", None):
                t.agent = only
        return

    # Multi-agent: walk up the tool's path and find the agent whose file
    # lives in the deepest shared ancestor directory.
    agent_dirs: list[tuple[str, str]] = []  # (dir_prefix, agent_name)
    for a in agents:
        d = "/".join(a.file.split("/")[:-1])
        agent_dirs.append((d, a.name))
    # Longer prefixes win; sort descending so we hit the most specific first.
    agent_dirs.sort(key=lambda x: len(x[0]), reverse=True)

    for t in tools:
        if getattr(t, "agent", None):
            continue
        for d, name in agent_dirs:
            if d == "" or t.file.startswith(d + "/") or t.file == d:
                t.agent = name
                break
