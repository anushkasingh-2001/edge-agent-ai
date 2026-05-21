from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

from edge_agent_scanner.behavioral.trace_models import (
    AgentMetric,
    ModelMetric,
    OverallBehavioralMetrics,
    TraceEvent,
)


BehavioralStatus = Literal["pass", "fail", "skip", "error"]


class BehavioralCase(BaseModel):
    suite_id: str
    case_id: str
    title: str
    prompt: str | None = None
    expected: dict[str, Any] = Field(default_factory=dict)

    target_agent_id: str | None = None
    target_agent_name: str | None = None

    target_model_id: str | None = None
    target_model_name: str | None = None
    target_model_purpose: str | None = None

    metadata: dict[str, Any] = Field(default_factory=dict)


class BehavioralResult(BaseModel):
    suite_id: str
    case_id: str
    status: BehavioralStatus
    title: str
    reason: str

    target_agent_id: str | None = None
    target_agent_name: str | None = None
    target_model_id: str | None = None
    target_model_name: str | None = None

    score: float | None = None
    runtime_ms: float | None = None
    error: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class BehavioralReport(BaseModel):
    run_id: str
    generated_at: str

    cases: list[BehavioralCase] = Field(default_factory=list)
    results: list[BehavioralResult] = Field(default_factory=list)
    trace_events: list[TraceEvent] = Field(default_factory=list)

    overall_metrics: OverallBehavioralMetrics = Field(default_factory=OverallBehavioralMetrics)
    agent_metrics: list[AgentMetric] = Field(default_factory=list)
    model_metrics: list[ModelMetric] = Field(default_factory=list)

    harness_status: Literal["configured", "auto_detected", "not_configured", "failed"] = "not_configured"
    harness_message: str | None = None
    harness_config_path: str | None = None
