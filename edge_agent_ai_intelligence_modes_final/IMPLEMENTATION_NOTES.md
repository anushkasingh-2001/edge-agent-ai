# Implementation Notes

This document maps every file in the pack to what it does, how it
integrates with your existing code, and where the *minimal integration
points* are (marked **[INTEGRATE]**).

## Repo files inspected (grounding)

All design decisions below are grounded in reading these actual files in
`anushkasingh-2001/edge-agent-ai@main`:

- `lib/model-catalog.ts` (OpenAI/Anthropic/Google/custom slots),
  `lib/model-keys.ts` (`LlmSlot`, `ProviderType`, slot meta)
- `lib/server-model-router.ts` (`routeModel`, tiers, `escalateTier`,
  env overrides, `_resolveModelForTests`)
- `lib/server-llm-client.ts` (`callLlm`, `assertOpenAICompatible`,
  `parseJsonReply`, OpenAI-compatible-only contract)
- `lib/server-patch-pipeline.ts` (`generatePatchPreview`, `applyPatch`,
  temp-workspace validation, `redactSecrets` reuse, re-scan arbiter)
- `lib/patch-confidence.ts` (`scorePatch`, `ValidationSignals`)
- `lib/fix-planner.ts` (`planFix`, `FixClass`, `TEMPLATE_COVERED_RULES`)
- `lib/server-fix-clustering.ts` (`clusterFindings`, cluster kinds)
- `lib/fix-cache.ts` (`buildCacheKey`, namespaces, `hashFileContents`)
- `lib/server-finding-explanations.ts` (`redactSecrets`, `pickModel`)
- `app/api/finding/patch/route.ts` (was a scaffold), `.../explain/route.ts`,
  `app/api/findings/fix-filtered/route.ts`, `app/api/findings/fix/route.ts`
- `scanner/.../report.py` (`RuleId` Literal, `ALL_RULE_IDS`, `Finding`,
  `EvidencePathNode`, `SCHEMA_VERSION="2.0"`)
- `scanner/.../engine.py` (`run_scan`, analyzer wiring, dedupe/cap)
- `scanner/.../ir/{models,sources,sinks,guards,redact}.py`,
  `scanner/.../analyzers/{taint_user_input,dangerous_tools,dependencies,confidence,clustering,_utils}.py`
- `scanner/.../remediation/{patches,templates,validators}.py`
- `scanner/tests/*` (conventions: tmp_path fixtures, direct analyzer calls)

## New / changed files

### Scanner (Python)

| Path | New/Change | Purpose |
|---|---|---|
| `scanner/src/edge_agent_scanner/analyzers/root_causes.py` | **new** | Six missed root causes. Single `analyze_root_causes(ir, files)` entry. |
| `scanner/src/edge_agent_scanner/analyzers/finding_grouping.py` | **new** | `apply_intelligence_grouping(findings)` — fingerprint + per-file/per-manifest collapse. |
| `scanner/src/edge_agent_scanner/ir/sinks_ext.py` | **new** | Cypher/file-read/env-mutation/code-exec/network/prompt sink classifiers + json.dumps/tempfile downgraders. |
| `scanner/src/edge_agent_scanner/ir/sources_ext.py` | **new** | config / llm_output / framework-user-input source classifiers. |
| `scanner/src/edge_agent_scanner/remediation/validators.py` | **change** (superset) | Adds `is_real_fix`, `guard_added`; preserves `validates_python_syntax`. |
| `scanner/src/edge_agent_scanner/remediation/patches.py` | **change** (superset) | Adds `build_patch_proposal` (fix vs suggestion), `comment_only_suggestion`; preserves `make_unified_diff`. |
| `scanner/src/edge_agent_scanner/data/default_credentials.json` | **new** | Default/weak credential pairs (extensible). |
| `scanner/PATCH_engine_report.diff` | **diff** | The minimal edits to `engine.py` + `report.py` (apply with `git apply`). |

**[INTEGRATE] `engine.py` + `report.py`:** apply `scanner/PATCH_engine_report.diff`.
It (a) adds the six rule ids to the `RuleId` Literal and `ALL_RULE_IDS`,
(b) adds `fingerprint`/`cluster_id`/`dup_count` to `Finding` (additive,
backward compatible), (c) wires `analyze_root_causes` into `run_scan`,
and (d) calls `apply_intelligence_grouping` just before the existing
`_dedupe_findings`. Verified: scan runs end-to-end, all six rules fire,
no regression in the 93 passing existing tests.

> **Why a diff for these two and full files for the rest:** `engine.py`
> and `report.py` carry shared schema/wiring that other code depends on,
> so a surgical diff is safer than shipping a full rewrite. Everything
> else is either brand-new or a strict superset of a tiny original.

### Orchestration (TypeScript)

| Path | New/Change | Purpose |
|---|---|---|
| `lib/context-bundle.ts` | **new** | ContextBundle schema, per-mode token caps, budget helpers, full-file guard. |
| `lib/server-context-bundle.ts` | **new** | `buildContextBundle(...)` — reads bounded, redacted slices; trims to budget. |
| `lib/intelligence-mode.ts` | **new** | `MODE_POLICIES`, `scoreComplexity`, `routeTaskForMode`, `enforceGuardrails`. |
| `lib/server-model-router-ext.ts` | **new** | `routeForMode(...)`, `tierTableForProvider(...)` — delegates to existing `routeModel`. |
| `lib/server-cost-controller.ts` | **new** | Pricing table, `estimateCall`, `summarizeBatch`, `checkBudget`. |
| `lib/patch-confidence-realfix.ts` | **new** | `isRealFixDiff`, `guardAddedInDiff` — TS mirror of `is_real_fix`. |
| `app/api/finding/patch/route.ts` | **replace scaffold** | Preview + safe apply, mode-aware, real-fix gated. |
| `app/api/findings/fix-filtered/route.ts` | **change** | Mode-aware bulk; one LLM call per cluster; cost estimate + budget gate. |
| `app/api/scan/estimate/route.ts` | **new** | Pre-flight cost/latency estimate. |
| `components/intelligence-mode-toggle.tsx` | **new** | Five-mode picker. |
| `components/model-selector.tsx` | **new** | Per-task model selection (Manual). |

**[INTEGRATE] Patch pipeline (optional, recommended):** the new patch
route reuses your existing `generatePatchPreview`. To make Auto/Pro/Max
actually send a **ContextBundle instead of the full file**, replace the
`buildPatchPrompt({ fileContents: redactSecrets(original) })` call inside
`lib/server-patch-pipeline.ts` with a call that serialises a
`buildContextBundle(...)` result. The route works today either way (it
falls back to your current full-file prompt if you don't make this swap);
making the swap is what enforces the "no whole files" guarantee on the
patch path. The explanation path already clamps to 10 lines / 2 KB.

**[INTEGRATE] `patch-confidence.ts`:** `patch-confidence-realfix.ts` is a
standalone module so you don't have to edit your existing 132-line file.
If you prefer, paste its two exports into `lib/patch-confidence.ts` and
update the import in `app/api/finding/patch/route.ts`.

**[INTEGRATE] `/api/ir` neighborhood:** `buildContextBundle` accepts an
optional `neighborhood` (callers/callees/related prompt/model/route/tool
nodes, config/test slices). Wire it from your `/api/ir` route's IR data
to enrich Pro/Max bundles. Without it, bundles still work — they use the
finding's `evidence_path` + bounded file slices.

## Design rationale (grounded in research + your code)

- **Scanner-first, LLM-as-explainer** mirrors the ZeroFalse / Datadog
  SAST-then-LLM-adjudicator pattern: deterministic detection, LLM only to
  explain/triage. Your repo already enforces "zero network in scanner"
  (`test_scan_no_llm.py`); this pack keeps that invariant.
- **Graph-bounded ContextBundle over full files** follows CPG-slice
  prompting (LLMxCPG): send the taint-path neighborhood, not the file.
  Token caps per mode make the cost ceiling explicit.
- **Cheap→strong cascade in Auto** is the FrugalGPT cascade: try cheap,
  escalate only on validation failure. Two tiers capture most of the
  cost/quality frontier.
- **Plan→patch→validate in Max** is the SWE-bench-style verify loop:
  generate a patch, then let the sandbox (your `harness/docker_runner.py`
  + re-scan) be the oracle. Re-scan is the arbiter, never the model.
- **One LLM call per cluster** in bulk fix reuses your existing
  `clusterFindings`; the representative gets the call, the template
  applies to members, the batch validates together.

## Provider scope

Routing + pricing cover **all** wired providers from `model-catalog.ts`:
OpenAI (gpt-4o/4.1 family, o-series), Anthropic (Opus/Sonnet/Haiku),
Google (Gemini 2.5/2.0), and `custom` (Ollama/vLLM/LiteLLM, priced as
local/$0). Tiers are abstract (`cheap`/`mid`/`coding_flagship`/`local`)
and resolve to concrete ids via your existing
`server-model-router._resolveModelForTests`, so env overrides
(`EDGE_AGENT_FIX_MODEL`, etc.) are respected automatically.

## Known limitations / follow-ups

- TS/JS extractor parity: the new rules are strongest on Python; the
  TS extractor will need a tree-sitter upgrade for full parity. Ship
  Python-first; mark TS rules experimental.
- Indirect prompt injection (poisoned MCP tool descriptions) is not
  covered — a follow-up rule pack on `ir/extract_mcp.py`.
- The pricing table is approximate; update as providers change pricing.
- AST-equivalence in the TS real-fix mirror is whitespace-normalized
  (no TS parser); the Python side uses real `ast` equivalence.
