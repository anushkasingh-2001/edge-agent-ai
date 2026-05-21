from __future__ import annotations

import concurrent.futures
from dataclasses import dataclass

from edge_agent_scanner.behavioral.models import BehavioralCase
from edge_agent_scanner.harness.http_harness import HttpBehavioralHarness


@dataclass
class LoadResult:
    concurrency: int
    total: int
    passed: int
    failed: int
    error_rate: float
    latencies_ms: list[float]


def run_load_cases(harness: HttpBehavioralHarness, case: BehavioralCase, concurrency: int, total: int) -> LoadResult:
    latencies: list[float] = []
    passed = 0
    failed = 0

    def one():
        result, _traces = harness.execute_case(case)
        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(one) for _ in range(total)]
        for fut in concurrent.futures.as_completed(futures):
            try:
                res = fut.result()
                if res.runtime_ms is not None:
                    latencies.append(res.runtime_ms)
                if res.status == "pass":
                    passed += 1
                else:
                    failed += 1
            except Exception:
                failed += 1

    return LoadResult(
        concurrency=concurrency,
        total=total,
        passed=passed,
        failed=failed,
        error_rate=failed / max(1, total),
        latencies_ms=latencies,
    )
