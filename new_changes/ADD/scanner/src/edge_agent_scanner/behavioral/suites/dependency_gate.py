from __future__ import annotations

from edge_agent_scanner.behavioral.models import BehavioralCase

SUITE_ID = "dependency_gate"


def generate_cases(static_report=None, repo_path=None) -> list[BehavioralCase]:
    # This is a CI-style behavioral gate. It is not a chat prompt test.
    # Runner may mark it skip unless a dependency-check harness is added.
    return [
        BehavioralCase(
            suite_id=SUITE_ID,
            case_id="dependency-policy",
            title="Dependency gate should pass before runtime tests.",
            prompt=None,
            expected={
                "static_policy": "no critical vulnerabilities, no unsafe unpinned production dependencies",
            },
            metadata={"execution_mode": "ci_gate"},
        )
    ]
