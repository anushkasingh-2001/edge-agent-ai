from __future__ import annotations

import importlib
import inspect
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from edge_agent_scanner.behavioral.metrics import aggregate_by_agent, aggregate_by_model, aggregate_overall
from edge_agent_scanner.behavioral.models import BehavioralCase, BehavioralReport, BehavioralResult
from edge_agent_scanner.behavioral.trace_models import TraceEvent
from edge_agent_scanner.harness.config import load_evals_config
from edge_agent_scanner.harness.sandbox import create_harness_from_repo


SUITE_MODULES = [
    "dangerous_tools",
    "human_approval",
    "prompt_injection",
    "prompt_contract",
    "mcp_security",
    "openapi_schema",
    "auth_checks",
    "secrets_leakage",
    "dependency_gate",
    "user_input_dangerous_code",
    "accuracy_regression",
    "accuracy",
    "scalability_runtime",
]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_suite(name: str):
    return importlib.import_module(f"edge_agent_scanner.behavioral.suites.{name}")


def _collect_cases(repo_path: Path, static_report=None) -> list[BehavioralCase]:
    cases: list[BehavioralCase] = []
    for name in SUITE_MODULES:
        mod = _load_suite(name)
        if not hasattr(mod, "generate_cases"):
            continue
        fn = mod.generate_cases
        try:
            sig = inspect.signature(fn)
            if "repo_path" in sig.parameters:
                cases.extend(fn(static_report=static_report, repo_path=repo_path))
            else:
                cases.extend(fn(static_report=static_report))
        except TypeError:
            cases.extend(fn(static_report=static_report))
    return cases


def _score_case_without_harness(case: BehavioralCase) -> BehavioralResult:
    return BehavioralResult(
        suite_id=case.suite_id,
        case_id=case.case_id,
        status="skip",
        title=case.title,
        reason="Behavioral probe generated but not executed. Configure .edgeagent/evals.yaml or run Auto Harness discovery.",
        target_agent_id=case.target_agent_id,
        target_agent_name=case.target_agent_name,
        target_model_id=case.target_model_id,
        target_model_name=case.target_model_name,
    )


def run_behavioral_suites(repo_path: Path, static_report=None, harness=None, auto_harness: bool = True) -> BehavioralReport:
    if harness is None and auto_harness and load_evals_config(repo_path) is not None:
        with create_harness_from_repo(repo_path) as h:
            return run_behavioral_suites(repo_path, static_report=static_report, harness=h, auto_harness=False)

    run_id = str(uuid.uuid4())
    cases = _collect_cases(repo_path=repo_path, static_report=static_report)
    results: list[BehavioralResult] = []
    traces: list[TraceEvent] = []

    run_start = time.time() * 1000
    traces.append(TraceEvent(run_id=run_id, event_type="run_start", start_ms=run_start, status="ok", metadata={"repo_path": str(repo_path)}))

    for case in cases:
        case_start = time.time() * 1000
        traces.append(
            TraceEvent(
                run_id=run_id,
                case_id=case.case_id,
                suite_id=case.suite_id,
                agent_id=case.target_agent_id,
                agent_name=case.target_agent_name,
                model_id=case.target_model_id,
                model_name=case.target_model_name,
                model_purpose=case.target_model_purpose,
                event_type="case_start",
                start_ms=case_start,
                status="ok",
            )
        )

        if harness is None or case.prompt is None:
            result = _score_case_without_harness(case)
            if case.prompt is None:
                result.reason = "This behavioral case requires a specialized non-chat runner or baseline configuration."
            case_traces: list[TraceEvent] = []
        else:
            try:
                result, case_traces = harness.execute_case(case)
            except Exception as exc:
                result = BehavioralResult(
                    suite_id=case.suite_id,
                    case_id=case.case_id,
                    status="error",
                    title=case.title,
                    reason=f"Harness error: {exc}",
                    error=str(exc),
                    target_agent_id=case.target_agent_id,
                    target_agent_name=case.target_agent_name,
                    target_model_id=case.target_model_id,
                    target_model_name=case.target_model_name,
                )
                case_traces = [
                    TraceEvent(
                        run_id=run_id,
                        case_id=case.case_id,
                        suite_id=case.suite_id,
                        agent_id=case.target_agent_id,
                        agent_name=case.target_agent_name,
                        event_type="error",
                        start_ms=time.time() * 1000,
                        status="error",
                        error=str(exc),
                    )
                ]

        case_end = time.time() * 1000
        result.runtime_ms = result.runtime_ms or (case_end - case_start)
        results.append(result)
        traces.extend(case_traces)
        traces.append(
            TraceEvent(
                run_id=run_id,
                case_id=case.case_id,
                suite_id=case.suite_id,
                agent_id=case.target_agent_id,
                agent_name=case.target_agent_name,
                model_id=case.target_model_id,
                model_name=case.target_model_name,
                model_purpose=case.target_model_purpose,
                event_type="case_end",
                start_ms=case_start,
                end_ms=case_end,
                latency_ms=case_end - case_start,
                status=result.status,
            )
        )

    run_end = time.time() * 1000
    traces.append(TraceEvent(run_id=run_id, event_type="run_end", start_ms=run_start, end_ms=run_end, latency_ms=run_end - run_start, status="ok"))

    has_config = load_evals_config(repo_path) is not None
    return BehavioralReport(
        run_id=run_id,
        generated_at=utc_now_iso(),
        cases=cases,
        results=results,
        trace_events=traces,
        overall_metrics=aggregate_overall(results, traces),
        agent_metrics=aggregate_by_agent(results, traces),
        model_metrics=aggregate_by_model(results, traces),
        harness_status="configured" if harness is not None else ("auto_detected" if has_config else "not_configured"),
        harness_message=(
            "Behavioral probes executed with configured Docker harness."
            if harness is not None
            else "Behavioral probes were generated but skipped because no runnable harness is configured."
        ),
        harness_config_path=str(repo_path / ".edgeagent" / "evals.yaml") if has_config else None,
    )
