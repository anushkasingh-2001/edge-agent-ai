from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


TraceEventType = Literal[
    "run_start",
    "run_end",
    "case_start",
    "case_end",
    "agent_start",
    "agent_end",
    "model_call",
    "tool_call",
    "approval",
    "guard",
    "error",
]


class TraceEvent(BaseModel):
    """One runtime event captured during a behavioral run.

    Framework-neutral: LangGraph, LangChain, LlamaIndex, custom agents,
    HTTP harnesses, and CLI harnesses can all emit this shape.
    """

    run_id: str
    case_id: str | None = None
    suite_id: str | None = None

    agent_id: str | None = None
    agent_name: str | None = None

    model_id: str | None = None
    model_name: str | None = None
    model_purpose: str | None = None

    tool_id: str | None = None
    tool_name: str | None = None

    event_type: TraceEventType
    start_ms: float
    end_ms: float | None = None
    latency_ms: float | None = None

    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0

    status: Literal["ok", "pass", "fail", "skip", "error"] = "ok"
    error: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentMetric(BaseModel):
    agent_id: str
    agent_name: str | None = None

    total_cases: int = 0
    passed_cases: int = 0
    failed_cases: int = 0
    skipped_cases: int = 0
    accuracy: float | None = None

    avg_runtime_ms: float | None = None
    p50_runtime_ms: float | None = None
    p95_runtime_ms: float | None = None
    p99_runtime_ms: float | None = None

    error_rate: float = 0.0
    model_calls: int = 0
    tool_calls: int = 0
    approval_events: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_cost_usd: float = 0.0


class ModelMetric(BaseModel):
    agent_id: str | None = None
    agent_name: str | None = None

    model_id: str
    model_name: str | None = None
    model_purpose: str | None = None

    calls: int = 0
    avg_latency_ms: float | None = None
    p50_latency_ms: float | None = None
    p95_latency_ms: float | None = None
    p99_latency_ms: float | None = None

    input_tokens: int = 0
    output_tokens: int = 0
    total_cost_usd: float = 0.0
    error_rate: float = 0.0

    quality_score: float | None = None
    quality_label: str | None = None


class OverallBehavioralMetrics(BaseModel):
    total_cases: int = 0
    passed_cases: int = 0
    failed_cases: int = 0
    skipped_cases: int = 0
    accuracy: float | None = None

    avg_runtime_ms: float | None = None
    p95_runtime_ms: float | None = None
    p99_runtime_ms: float | None = None

    total_model_calls: int = 0
    total_tool_calls: int = 0
    total_cost_usd: float = 0.0
    error_rate: float = 0.0
