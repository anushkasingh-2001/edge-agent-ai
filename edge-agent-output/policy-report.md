# Edge Agent AI — Policy Gate

## Summary

- **Project:** edge-agent-recovered
- **Decision:** **⚠️ WARN**
- **Policy mode:** `warn`
- **Policy file:** `.edgeagent/policy.yaml`
- **Timestamp:** 2026-05-16T03:25:30.621Z

## Compared States

### Base
- **Branch:** —
- **Commit:** —

### Target
- **Branch:** `main`
- **Commit:** `9864516`

## Risk and Severity Delta

| Metric | Base | Target | Delta |
| --- | ---: | ---: | ---: |
| Risk Score | — | 100 | — |
| Critical | — | 3 | — |
| High | — | 450 | — |
| Medium | — | 11 | — |
| Low | — | 3 | — |

## Decision

**⚠️ WARN**

## Failed Conditions

- `security.block_if_critical` — Warning: target scan has 3 critical findings.
- `security.max_risk_score` — Warning: risk score 100 exceeds policy ceiling 70.
- `security.max_critical_findings` — Warning: 3 critical findings exceed ceiling 0.
- `security.max_high_findings` — Warning: 450 high findings exceed ceiling 0.
- `security.block_if_secrets_found` — Warning: secret-like values were detected in source.
- `security.block_if_user_input_to_dangerous_code` — Warning: user input can flow into dangerous code paths.
- `security.block_if_schema_auth_gap` — Warning: OpenAPI / auth / schema quality issues were found.

## Passed Conditions

- `security.block_if_unsafe_mcp`
- `security.block_if_dangerous_tool_without_approval`

## Skipped (no baseline / metrics)

- `security.max_risk_score_increase`
- `agents.SalesAgent.accuracy.min_absolute`
- `agents.SalesAgent.accuracy.require_delta_gte`
- `agents.SalesAgent.runtime_ms.max_absolute`
- `agents.SalesAgent.runtime_ms.require_delta_lte`
- `agents.SalesAgent.tool_selection.min_pass_rate`
- `evals.block_if_accuracy_drops`
- `evals.min_accuracy`
- `evals.block_if_runtime_increases`
- `evals.max_runtime_p95_ms`
- `evals.block_if_tool_selection_drops`
- `evals.min_tool_selection_pass_rate`
- `evals.block_if_tests_fail`

## Top Findings

| Severity | Rule | File | Line | Title |
| --- | --- | --- | ---: | --- |
| critical | `secrets` | `scanner/tests/fixtures/minimal_langchain/agent.py` | 10 | Possible secret: Anthropic-style API key |
| critical | `secrets` | `scanner/tests/test_secrets.py` | 14 | Possible secret: PEM private key block |
| critical | `secrets` | `scanner/tests/test_secrets.py` | 18 | Possible secret: Anthropic-style API key |
| high | `human-approval` | `app/api/git/compare-scan/route.ts` | 543 | Dangerous capability without nearby approval / human-review signal |
| high | `human-approval` | `app/api/git/compare-scan/route.ts` | 550 | Dangerous capability without nearby approval / human-review signal |
| high | `human-approval` | `app/api/git/compare-scan/route.ts` | 574 | Dangerous capability without nearby approval / human-review signal |
| high | `human-approval` | `app/api/git/compare-scan/route.ts` | 580 | Dangerous capability without nearby approval / human-review signal |
| high | `prompt-injection` | `app/api/git/push/route.ts` | 227 | Possible prompt injection pattern: Prompt asks to reveal secrets |
| high | `prompt-injection` | `app/api/github/pr/create/route.ts` | 40 | Possible prompt injection pattern: Prompt asks to reveal secrets |
| high | `prompt-injection` | `app/api/playground/run/route.ts` | 9 | Possible prompt injection pattern: Prompt asks to reveal secrets |

## Recommended Next Actions

- The gate did not block the PR, but at least one rule reported a regression. Review the **Failed Conditions** list above before merging.
