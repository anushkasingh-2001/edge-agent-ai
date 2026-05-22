from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = "2.0"

Severity = Literal["critical", "high", "medium", "low"]

RuleId = Literal[
    "dangerous-tools",
    "human-approval",
    "prompt-injection",
    "prompt-contract",
    "secrets",
    "mcp-security",
    "openapi-schema",
    "auth-checks",
    "dependency-risks",
    "user-input-dangerous-code",
    "accuracy-regression-risk",
]

ALL_RULE_IDS: frozenset[str] = frozenset(
    [
        "dangerous-tools",
        "human-approval",
        "prompt-injection",
        "prompt-contract",
        "secrets",
        "mcp-security",
        "openapi-schema",
        "auth-checks",
        "dependency-risks",
        "user-input-dangerous-code",
        "accuracy-regression-risk",
    ]
)


class Location(BaseModel):
    file: str
    start_line: int
    end_line: int
    symbol: str | None = None


class EvidencePathNode(BaseModel):
    kind: str
    label: str
    file: str | None = None
    line: int | None = None


class SuggestedPatch(BaseModel):
    file: str
    unified_diff: str
    explanation: str


class FrameworkHit(BaseModel):
    name: str
    evidence: list[str] = Field(default_factory=list)


class ToolHit(BaseModel):
    name: str
    file: str
    line: int
    kind: Literal["decorator", "class", "filename", "directory", "schema", "openapi", "mcp"]
    framework: str | None = None
    agent: str | None = None
    side_effects: list[str] = Field(default_factory=list)
    callable_from_agent: bool = False


class AgentHit(BaseModel):
    name: str
    file: str
    line: int
    kind: Literal["agent_class", "compiled_graph", "agent_executor", "agent_factory", "agent_file"]
    framework: str | None = None


class ModelHit(BaseModel):
    provider: str | None = None
    model: str
    file: str
    line: int
    agent: str | None = None
    purpose: str | None = None


class PromptHit(BaseModel):
    name: str
    file: str
    line: int
    agent: str | None = None
    used_by_model: str | None = None
    text_preview: str = ""


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

    primary_location: Location | None = None
    related_locations: list[Location] = Field(default_factory=list)
    evidence_path: list[EvidencePathNode] = Field(default_factory=list)
    suggested_patch: SuggestedPatch | None = None
    verifier: dict[str, Any] = Field(default_factory=dict)

    # Tier 2 (optional, backward compatible): deterministic confidence band and
    # escalation recommendation. Old reports without these still validate.
    confidence_band: str | None = None
    escalation: str | None = None
    confidence_features: dict[str, Any] = Field(default_factory=dict)


class ScanReport(BaseModel):
    schema_version: str = SCHEMA_VERSION
    scan_root: str
    generated_at: str
    frameworks_detected: list[FrameworkHit] = Field(default_factory=list)
    agents_detected: list[AgentHit] = Field(default_factory=list)
    tools_detected: list[ToolHit] = Field(default_factory=list)
    models_detected: list[ModelHit] = Field(default_factory=list)
    prompts_detected: list[PromptHit] = Field(default_factory=list)
    summary: Summary = Field(default_factory=Summary)
    risk_score: int = Field(ge=0, le=100)
    findings: list[Finding] = Field(default_factory=list)
    files_scanned: int = 0
    files_scanned_by_ext: dict[str, int] = Field(default_factory=dict)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
