from __future__ import annotations

from pathlib import Path
from edge_agent_scanner.behavioral.models import BehavioralCase
from edge_agent_scanner.behavioral.suites._helpers import load_gold_tasks

SUITE_ID = "accuracy_regression"


def generate_cases(static_report=None, repo_path: Path | None = None) -> list[BehavioralCase]:
    # Uses same gold cases as accuracy, but UI/policy should compare result against baseline.
    cases = load_gold_tasks(repo_path, suite_id="accuracy_regression")
    if cases:
        for c in cases:
            c.suite_id = SUITE_ID
            c.metadata["compare_to_baseline"] = True
        return cases

    return [
        BehavioralCase(
            suite_id=SUITE_ID,
            case_id="accuracy-regression-not-configured",
            title="Accuracy regression requires .edgeagent/gold_tasks.jsonl and baseline results.",
            prompt=None,
            expected={"requires_baseline": True},
            metadata={"execution_mode": "baseline_required"},
        )
    ]
