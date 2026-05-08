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


class FrameworkHit(BaseModel):
    name: str
    evidence: list[str] = Field(default_factory=list)


class Summary(BaseModel):
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0
    total: int = 0


class Finding(BaseModel):
    id: str
    rule_id: str
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
    summary: Summary = Field(default_factory=Summary)
    risk_score: int = Field(ge=0, le=100)
    findings: list[Finding] = Field(default_factory=list)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
