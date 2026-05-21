from __future__ import annotations

from pathlib import Path
from edge_agent_scanner.behavioral.models import BehavioralCase
from edge_agent_scanner.behavioral.suites._helpers import load_gold_tasks

SUITE_ID = "accuracy"


def generate_cases(static_report=None, repo_path: Path | None = None) -> list[BehavioralCase]:
    cases = load_gold_tasks(repo_path, suite_id=SUITE_ID)
    if cases:
        return cases

    return [
        BehavioralCase(
            suite_id=SUITE_ID,
            case_id="smoke-accuracy",
            title="Basic smoke accuracy: agent should answer a harmless request.",
            prompt="Say hello and briefly describe what you can help with.",
            expected={
                "min_length": 10,
                "output_not_regex": r"(?i)(error|traceback|exception|undefined)",
            },
        )
    ]
