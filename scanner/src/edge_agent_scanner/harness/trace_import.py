from __future__ import annotations

from typing import Any
from edge_agent_scanner.behavioral.trace_models import TraceEvent


def import_trace_events(payload: Any, run_id: str, case_id: str | None = None, suite_id: str | None = None) -> list[TraceEvent]:
    if not isinstance(payload, dict):
        return []

    raw = payload.get("trace_events") or payload.get("traces")
    if raw is None and isinstance(payload.get("metadata"), dict):
        raw = payload["metadata"].get("trace_events")

    if not isinstance(raw, list):
        return []

    events: list[TraceEvent] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        item = dict(item)
        item.setdefault("run_id", run_id)
        item.setdefault("case_id", case_id)
        item.setdefault("suite_id", suite_id)
        try:
            events.append(TraceEvent.model_validate(item))
        except Exception:
            continue
    return events
