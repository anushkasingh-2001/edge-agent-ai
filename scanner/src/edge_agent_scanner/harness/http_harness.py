from __future__ import annotations

import json
import time
import urllib.request
from typing import Any

from edge_agent_scanner.behavioral.models import BehavioralCase, BehavioralResult
from edge_agent_scanner.behavioral.trace_models import TraceEvent
from edge_agent_scanner.harness.config import EvalHarnessConfig
from edge_agent_scanner.harness.mock_policy import (
    execution_decision,
    requires_mocking,
    requires_trace_events,
)
from edge_agent_scanner.harness.scoring import get_by_path, score_output
from edge_agent_scanner.harness.trace_import import import_trace_events


def render_template(value: Any, prompt: str) -> Any:
    if isinstance(value, str):
        return value.replace("{{prompt}}", prompt)
    if isinstance(value, list):
        return [render_template(v, prompt) for v in value]
    if isinstance(value, dict):
        return {k: render_template(v, prompt) for k, v in value.items()}
    return value


# Expectation keys that mean "we are tempting the agent to perform a destructive
# or sensitive action and checking it does NOT happen (or happens only after
# approval)". Such cases are gated by the mock policy (see harness.mock_policy):
# they only execute when the operator asserts the relevant category is mocked.


class HttpBehavioralHarness:
    def __init__(self, config: EvalHarnessConfig, chat_url: str, run_id: str | None = None):
        self.config = config
        self.chat_url = chat_url
        self.run_id = run_id or "runtime"

    def execute_case(self, case: BehavioralCase) -> tuple[BehavioralResult, list[TraceEvent]]:
        # Fail-closed: never send a destructive prompt to a live app unless the
        # operator has asserted (per category) that dangerous tools are
        # mocked/intercepted. We do NOT make the HTTP request, so no real side
        # effect can fire. The result is marked unverified (skip), never pass.
        allowed, unmocked = execution_decision(case, self.config)
        if not allowed:
            return (
                BehavioralResult(
                    suite_id=case.suite_id,
                    case_id=case.case_id,
                    status="skip",
                    title=case.title,
                    reason=(
                        "Dangerous behavioral case not executed (fail-closed): the danger "
                        f"categories {sorted(unmocked)} are not asserted as mocked. Set "
                        "sandbox.mock_dangerous_tools or sandbox.mocked_categories only after "
                        "wiring tool interception/tracing, then re-run."
                    ),
                    target_agent_id=case.target_agent_id,
                    target_agent_name=case.target_agent_name,
                    target_model_id=case.target_model_id,
                    target_model_name=case.target_model_name,
                    details={
                        "status_kind": "unverified",
                        "fail_closed": True,
                        "requires_mocking": requires_mocking(case),
                        "requires_trace_events": requires_trace_events(case),
                        "unmocked_categories": sorted(unmocked),
                    },
                ),
                [],
            )

        prompt = case.prompt or ""
        body = render_template(self.config.app.input_template, prompt)
        start = time.time() * 1000

        try:
            payload = self._request(body)
            end = time.time() * 1000
            runtime_ms = end - start

            output = get_by_path(payload, self.config.app.output_path)
            traces = import_trace_events(payload, run_id=self.run_id, case_id=case.case_id, suite_id=case.suite_id)

            status, score, reason, details = score_output(
                output,
                case.expected,
                trace_events=traces,
                runtime_ms=runtime_ms,
            )

            # Do not append case_end here. runner.py owns case lifecycle traces
            # to avoid double-counting runtime in aggregate metrics.
            return (
                BehavioralResult(
                    suite_id=case.suite_id,
                    case_id=case.case_id,
                    status=status,
                    title=case.title,
                    reason=reason,
                    score=score,
                    runtime_ms=runtime_ms,
                    target_agent_id=case.target_agent_id,
                    target_agent_name=case.target_agent_name,
                    target_model_id=case.target_model_id,
                    target_model_name=case.target_model_name,
                    details=details,
                ),
                traces,
            )
        except Exception as exc:
            end = time.time() * 1000
            runtime_ms = end - start
            return (
                BehavioralResult(
                    suite_id=case.suite_id,
                    case_id=case.case_id,
                    status="error",
                    title=case.title,
                    reason=f"HTTP harness error: {exc}",
                    error=str(exc),
                    runtime_ms=runtime_ms,
                    target_agent_id=case.target_agent_id,
                    target_agent_name=case.target_agent_name,
                    target_model_id=case.target_model_id,
                    target_model_name=case.target_model_name,
                ),
                [
                    TraceEvent(
                        run_id=self.run_id,
                        case_id=case.case_id,
                        suite_id=case.suite_id,
                        agent_id=case.target_agent_id,
                        agent_name=case.target_agent_name,
                        event_type="error",
                        start_ms=start,
                        end_ms=end,
                        latency_ms=runtime_ms,
                        status="error",
                        error=str(exc),
                    )
                ],
            )

    def _request(self, body: dict[str, Any]) -> Any:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.chat_url,
            data=data,
            headers={"Content-Type": "application/json"},
            method=self.config.app.method,
        )
        with urllib.request.urlopen(req, timeout=self.config.sandbox.timeout_seconds) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return json.loads(raw)
            except Exception:
                return {"response": raw}
