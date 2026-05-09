"""Pydantic models for scan report JSON."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0"

Severity = Literal["critical", "high", "medium", "low"]

RuleId = Literal[
    "dangerous-tools",
    "human-approval",
    "prompt-injection",
    "vague-prompts",
    "secrets",
    "mcp-security",
    "openapi-schema",
    "dependency-risks",
    "user-input-dangerous-code",
]

ALL_RULE_IDS: frozenset[str] = frozenset(
    [
        "dangerous-tools",
        "human-approval",
        "prompt-injection",
        "vague-prompts",
        "secrets",
        "mcp-security",
        "openapi-schema",
        "dependency-risks",
        "user-input-dangerous-code",
    ]
)


class FrameworkHit(BaseModel):
    name: str
    evidence: list[str] = Field(default_factory=list)


class ToolHit(BaseModel):
    """One tool detected in the project. Surfaced in the UI's Tools picker.

    ``framework`` is None when we couldn't pin down which framework the tool
    belongs to from its file imports (e.g. plain ``class FooTool`` in a
    ``tools/`` folder with no langchain/agno import). The UI buckets those
    under "Project tools" when ``agent`` is also unattributed.

    ``agent`` is the name of the detected agent that owns this tool (filled
    in by ``attribute_tools_to_agents``). When the project has exactly one
    agent, every unattributed tool gets pinned to it; multi-agent projects
    fall back to directory-proximity matching.
    """

    name: str
    file: str
    line: int
    kind: Literal["decorator", "class", "filename", "directory"]
    framework: str | None = None
    agent: str | None = None


class AgentHit(BaseModel):
    """One real agent detected in the project (not a framework).

    Examples:
      - ``class LangGraphSalesAgent`` -> kind="agent_class", framework="LangGraph"
      - ``app = workflow.compile()`` after ``StateGraph(...)`` -> kind="compiled_graph"
      - ``agent = AgentExecutor(...)`` -> kind="agent_executor"
      - file ``agents/support.py`` with no symbol match -> kind="agent_file"
    """

    name: str
    file: str
    line: int
    kind: Literal[
        "agent_class",
        "compiled_graph",
        "agent_executor",
        "agent_factory",
        "agent_file",
    ]
    framework: str | None = None


class Summary(BaseModel):
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0
    total: int = 0


class Finding(BaseModel):
    id: str
    rule_id: RuleId
    severity: Severity
    category: str
    title: str
    file: str
    line: int
    agent: str = "unknown"
    reason: str
    suggestedFix: str
    evidence: str
    code: str
    confidence: float = Field(ge=0.0, le=1.0)


class ScanReport(BaseModel):
    schema_version: str = SCHEMA_VERSION
    scan_root: str
    generated_at: str
    frameworks_detected: list[FrameworkHit] = Field(default_factory=list)
    agents_detected: list[AgentHit] = Field(default_factory=list)
    tools_detected: list[ToolHit] = Field(default_factory=list)
    summary: Summary = Field(default_factory=Summary)
    risk_score: int = Field(ge=0, le=100)
    findings: list[Finding] = Field(default_factory=list)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
