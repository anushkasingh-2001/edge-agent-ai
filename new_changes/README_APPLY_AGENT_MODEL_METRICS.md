# Edge Agent AI patch: per-agent + per-model accuracy/runtime metrics

This patch adds runtime trace models, metric aggregation, auto-harness discovery scaffolding, and frontend types/components for showing:

- overall behavioral accuracy/runtime
- accuracy/runtime per agent
- runtime/cost/tool/model-call metrics per helper model inside each agent
- auto-detected run harness status when `.edgeagent/evals.yaml` is missing

## 1. MODIFY existing files

```text
MODIFY/scanner/src/edge_agent_scanner/behavioral/models.py
MODIFY/scanner/src/edge_agent_scanner/behavioral/runner.py
MODIFY/lib/behavioral-report.ts
MODIFY/components/views/evaluations.tsx
```

## 2. ADD new files

```text
ADD/scanner/src/edge_agent_scanner/behavioral/trace_models.py
ADD/scanner/src/edge_agent_scanner/behavioral/metrics.py

ADD/scanner/src/edge_agent_scanner/harness/__init__.py
ADD/scanner/src/edge_agent_scanner/harness/detector.py
ADD/scanner/src/edge_agent_scanner/harness/planner.py
ADD/scanner/src/edge_agent_scanner/harness/endpoint_probe.py
ADD/scanner/src/edge_agent_scanner/harness/config_writer.py
ADD/scanner/src/edge_agent_scanner/harness/sandbox.py

ADD/components/behavioral/agent-model-metrics-table.tsx
ADD/app/api/behavioral/auto-harness/route.ts
```

## 3. DELETE

Delete nothing immediately.

Behavioral suite files such as `accuracy.py`, `accuracy_regression.py`, and `scalability_runtime.py` should stay. They are category definitions. Later, rewrite their placeholder scoring logic after the real harness is implemented.

## Important

Static analysis can detect agents/models/tools, but real accuracy/runtime per agent/model requires runtime traces from behavioral execution.
