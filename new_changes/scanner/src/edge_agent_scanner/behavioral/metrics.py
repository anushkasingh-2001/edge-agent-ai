from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

from edge_agent_scanner.behavioral.trace_models import (
    AgentMetric,
    ModelMetric,
    OverallBehavioralMetrics,
    TraceEvent,
)


def _get(obj: Any, key: str, default=None):
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    k = (len(ordered) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(ordered) - 1)
    if f == c:
        return ordered[f]
    return ordered[f] + (ordered[c] - ordered[f]) * (k - f)


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def aggregate_overall(results: Iterable[Any], traces: list[TraceEvent]) -> OverallBehavioralMetrics:
    res = list(results)
    total = len(res)
    passed = sum(1 for r in res if _get(r, "status") == "pass")
    failed = sum(1 for r in res if _get(r, "status") == "fail")
    skipped = sum(1 for r in res if _get(r, "status") == "skip")

    case_latencies = [
        e.latency_ms
        for e in traces
        if e.event_type == "case_end" and e.latency_ms is not None
    ]
    errors = [e for e in traces if e.status == "error" or e.event_type == "error"]

    return OverallBehavioralMetrics(
        total_cases=total,
        passed_cases=passed,
        failed_cases=failed,
        skipped_cases=skipped,
        accuracy=(passed / (passed + failed)) if (passed + failed) else None,
        avg_runtime_ms=_mean(case_latencies),
        p95_runtime_ms=percentile(case_latencies, 95),
        p99_runtime_ms=percentile(case_latencies, 99),
        total_model_calls=sum(1 for e in traces if e.event_type == "model_call"),
        total_tool_calls=sum(1 for e in traces if e.event_type == "tool_call"),
        total_cost_usd=sum(e.cost_usd for e in traces),
        error_rate=(len(errors) / max(1, len(traces))),
    )


def aggregate_by_agent(results: Iterable[Any], traces: list[TraceEvent]) -> list[AgentMetric]:
    res = list(results)
    case_by_agent: dict[str, list[Any]] = defaultdict(list)

    for r in res:
        agent_id = _get(r, "target_agent_id") or _get(r, "agent_id")
        if agent_id:
            case_by_agent[agent_id].append(r)

    events_by_agent: dict[str, list[TraceEvent]] = defaultdict(list)
    agent_names: dict[str, str | None] = {}

    for e in traces:
        if not e.agent_id:
            continue
        events_by_agent[e.agent_id].append(e)
        if e.agent_name:
            agent_names[e.agent_id] = e.agent_name

    all_agent_ids = set(case_by_agent) | set(events_by_agent)
    out: list[AgentMetric] = []

    for agent_id in sorted(all_agent_ids):
        agent_results = case_by_agent.get(agent_id, [])
        agent_events = events_by_agent.get(agent_id, [])

        passed = sum(1 for r in agent_results if _get(r, "status") == "pass")
        failed = sum(1 for r in agent_results if _get(r, "status") == "fail")
        skipped = sum(1 for r in agent_results if _get(r, "status") == "skip")

        runtimes = [
            e.latency_ms
            for e in agent_events
            if e.event_type in {"agent_end", "case_end"} and e.latency_ms is not None
        ]
        errors = [e for e in agent_events if e.status == "error" or e.event_type == "error"]

        out.append(
            AgentMetric(
                agent_id=agent_id,
                agent_name=agent_names.get(agent_id),
                total_cases=len(agent_results),
                passed_cases=passed,
                failed_cases=failed,
                skipped_cases=skipped,
                accuracy=(passed / (passed + failed)) if (passed + failed) else None,
                avg_runtime_ms=_mean(runtimes),
                p50_runtime_ms=percentile(runtimes, 50),
                p95_runtime_ms=percentile(runtimes, 95),
                p99_runtime_ms=percentile(runtimes, 99),
                error_rate=(len(errors) / max(1, len(agent_events))),
                model_calls=sum(1 for e in agent_events if e.event_type == "model_call"),
                tool_calls=sum(1 for e in agent_events if e.event_type == "tool_call"),
                approval_events=sum(1 for e in agent_events if e.event_type == "approval"),
                input_tokens=sum(e.input_tokens for e in agent_events),
                output_tokens=sum(e.output_tokens for e in agent_events),
                total_cost_usd=sum(e.cost_usd for e in agent_events),
            )
        )

    return out


def aggregate_by_model(results: Iterable[Any], traces: list[TraceEvent]) -> list[ModelMetric]:
    events_by_model: dict[tuple[str | None, str], list[TraceEvent]] = defaultdict(list)

    for e in traces:
        if e.event_type != "model_call":
            continue
        if not e.model_id and not e.model_name:
            continue
        model_key = e.model_id or e.model_name or "unknown-model"
        events_by_model[(e.agent_id, model_key)].append(e)

    out: list[ModelMetric] = []

    for (agent_id, model_id), events in sorted(
        events_by_model.items(),
        key=lambda item: (item[0][0] or "", item[0][1]),
    ):
        latencies = [e.latency_ms for e in events if e.latency_ms is not None]
        errors = [e for e in events if e.status == "error"]
        first = events[0]

        out.append(
            ModelMetric(
                agent_id=agent_id,
                agent_name=first.agent_name,
                model_id=model_id,
                model_name=first.model_name,
                model_purpose=first.model_purpose,
                calls=len(events),
                avg_latency_ms=_mean(latencies),
                p50_latency_ms=percentile(latencies, 50),
                p95_latency_ms=percentile(latencies, 95),
                p99_latency_ms=percentile(latencies, 99),
                input_tokens=sum(e.input_tokens for e in events),
                output_tokens=sum(e.output_tokens for e in events),
                total_cost_usd=sum(e.cost_usd for e in events),
                error_rate=(len(errors) / max(1, len(events))),
            )
        )

    return out
