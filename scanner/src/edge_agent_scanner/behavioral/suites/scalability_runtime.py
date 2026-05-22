from __future__ import annotations

from pathlib import Path
from edge_agent_scanner.behavioral.models import BehavioralCase
from edge_agent_scanner.behavioral.suites._helpers import load_gold_tasks

SUITE_ID = "scalability_runtime"


def generate_cases(static_report=None, repo_path: Path | None = None) -> list[BehavioralCase]:
    cases = load_gold_tasks(repo_path, suite_id=SUITE_ID)
    if cases:
        for c in cases:
            c.expected.setdefault("max_runtime_ms", 3000)
        return cases[:5]

    return [
        BehavioralCase(
            suite_id=SUITE_ID,
            case_id="runtime-smoke",
            title="Runtime smoke request should complete under threshold.",
            prompt="Say hello in one sentence.",
            expected={
                "min_length": 2,
                "max_runtime_ms": 3000,
                "output_not_regex": r"(?i)(traceback|timeout|exception)",
            },
        )
    ]
