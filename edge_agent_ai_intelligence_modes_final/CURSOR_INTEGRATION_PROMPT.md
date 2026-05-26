# Cursor Integration Prompt — Edge Agent AI Intelligence Modes

You are working on my repo:
https://github.com/anushkasingh-2001/edge-agent-ai

I have a separate implementation pack folder named:

`edge_agent_ai_intelligence_modes_final/`

This pack was generated from research for the five-tier Edge Agent AI intelligence-mode architecture. Your job is to integrate it into the real repo safely and production-quality. Do **not** blindly overwrite files. Inspect the existing repo first, compare with the pack, then merge carefully.

## Main goal

Add and wire these five modes:

1. **Save / Deterministic+Explain**
2. **Auto / Smart Routing**
3. **Pro / High Accuracy**
4. **Max / Deep Review**
5. **Manual / Select Model**

Core principle: the deterministic scanner remains the only source of truth for finding existence, severity, category, file, line, evidence, and reachability. LLMs are only for explanation, root-cause reasoning, suggestions, patch plans, and patch generation. A re-scan decides whether something is actually fixed.

## Critical context from previous testing

In OneKE and Sales-dev-assistant testing, Edge Agent AI had these issues:

- It found useful issues but also produced too many noisy/duplicate findings.
- It overestimated weak signals like `json.dumps`, temp-file cleanup, every ranged dependency, and every prompt template.
- It under-described or missed important root causes like:
  - prompt injection through user-controlled instruction/text/schema placeholders
  - unsafe Cypher/Neo4j query generation from user/model output
  - config-controlled arbitrary file reads
  - insecure default database credentials
  - user/config-controlled global `os.environ` mutation
  - LLM-generated code flowing into `exec`/`eval`
- It inserted TODO/comment-only “Edge Agent fix” markers, but those are not real fixes and must never cause findings to disappear.

## First: inspect existing repo

Before copying anything, inspect these files if present:

- `lib/model-catalog.ts`
- `lib/model-keys.ts`
- `lib/server-finding-explanations.ts`
- `lib/server-finding-fixes.ts`
- `lib/server-model-router.ts`
- `lib/server-llm-client.ts`
- `lib/server-patch-pipeline.ts`
- `lib/server-fix-clustering.ts`
- `lib/fix-cache.ts`
- `lib/patch-confidence.ts`
- `app/api/finding/explain/route.ts`
- `app/api/finding/patch/route.ts`
- `app/api/findings/fix/route.ts`
- `app/api/findings/fix-filtered/route.ts`
- `scanner/src/edge_agent_scanner/ir/models.py`
- `scanner/src/edge_agent_scanner/ir/graph.py`
- `scanner/src/edge_agent_scanner/ir/sinks.py`
- `scanner/src/edge_agent_scanner/ir/sources.py`
- `scanner/src/edge_agent_scanner/ir/guards.py`
- `scanner/src/edge_agent_scanner/ir/redact.py`
- `scanner/src/edge_agent_scanner/report.py`
- `scanner/src/edge_agent_scanner/analyzers/*`
- `scanner/src/edge_agent_scanner/remediation/*`
- `scanner/src/edge_agent_scanner/harness/*`
- `tests/*`

## Apply pack files carefully

The pack includes:

- `lib/context-bundle.ts`
- `lib/server-context-bundle.ts`
- `lib/intelligence-mode.ts`
- `lib/server-model-router-ext.ts`
- `lib/server-cost-controller.ts`
- `lib/patch-confidence-realfix.ts`
- `app/api/finding/patch/route.ts`
- `app/api/findings/fix-filtered/route.ts`
- `app/api/scan/estimate/route.ts`
- `components/intelligence-mode-toggle.tsx`
- `components/model-selector.tsx`
- `scanner/src/edge_agent_scanner/analyzers/root_causes.py`
- `scanner/src/edge_agent_scanner/analyzers/finding_grouping.py`
- `scanner/src/edge_agent_scanner/ir/sinks_ext.py`
- `scanner/src/edge_agent_scanner/ir/sources_ext.py`
- `scanner/src/edge_agent_scanner/remediation/validators.py`
- `scanner/src/edge_agent_scanner/remediation/patches.py`
- `scanner/src/edge_agent_scanner/data/default_credentials.json`
- tests for scanner and TypeScript
- `scanner/PATCH_engine_report.diff`

Preserve relative paths. If the repo has newer versions of files, merge by intent rather than overwriting.

## Required behavior after integration

### 1. Save / Deterministic+Explain mode

- Scanner runs deterministically.
- LLM can be used only when user opens a finding to explain it.
- Cheap explainer model by default.
- No LLM patch generation by default.
- Deterministic fix templates allowed, but only real code/config/dependency changes can be fix candidates.

### 2. Auto / Smart Routing

- Default recommended mode.
- Scanner runs first.
- Use graph-bounded `ContextBundle`, not full files.
- Cheap model for simple explanations.
- Stronger model for high-risk or ambiguous root causes.
- Strong model for actual patch generation.
- Escalate only if validation fails.

### 3. Pro / High Accuracy

- Use stronger model directly.
- Include larger graph neighborhood: source→sink path, callers/callees, prompt/model/route/tool nodes, config slices, and tests when relevant.
- Good for high/critical findings.

### 4. Max / Deep Review

- Use best available model.
- Plan first with JSON PatchPlan.
- Validate plan.
- Generate unified diff.
- Apply in temp workspace.
- Parse/lint/test/re-scan.
- If validation fails, return suggestion only.

### 5. Manual / Select Model

- User can select separate models for explanation, root-cause, suggestion, patch generation, bulk fix, and verifier.
- Still enforce: no whole repo, redaction, token caps, caching, cost estimate, validation, no auto-apply.

## ContextBundle requirement

All LLM tasks should use `ContextBundle` where possible:

- finding metadata
- primary code slice
- surrounding slice
- source→sink path
- guards present/missing
- related route/prompt/model/tool nodes
- callers/callees according to mode
- related config/test slices according to mode
- budget/token cap
- redaction metadata

Do not send whole repo. Do not send unrelated files. Do not send secrets.

## Scanner rule improvements required

Add or wire these root-cause rules:

1. `prompt-injection-placeholder`
2. `cypher-injection-from-llm-or-user`
3. `config-controlled-file-read`
4. `default-db-credentials`
5. `env-proxy-mutation`
6. `llm-codegen-to-exec`

Also reduce noisy rules:

- `json.dumps` alone is not data export.
- Tempfile create/use/delete flow should be suppressed or info/low when cleanup is safe.
- Dependency risks should be grouped per manifest.
- Prompt-contract should be context-aware:
  - extraction/schema prompts need output format, uncertainty, hallucination guards
  - tool/action prompts need tool policy, approval, role, task boundary
- Output-schema findings should be grouped.
- Edge Agent TODO/comment markers must never suppress findings.

## Patch/fix validation requirement

Integrate `is_real_fix()` into both Python and TypeScript patch confidence flow.

Reject as real fixes:

- no net change
- only comments
- TODO/FIXME/NOTE markers
- only whitespace
- only docstring
- AST-equivalent
- only Edge Agent marker block

Comment-only results may be shown as **Suggestion only**, never **Fixed**.

A real fix candidate must pass:

1. path safety
2. diff applies
3. real-fix check
4. code parses
5. lint/format if available
6. tests if available
7. Edge Agent re-scan
8. original finding disappears
9. no new high/critical finding appears

## Bulk Fix requirement

`Fix filtered` must cluster first. Never one LLM call per finding.

Cluster by:

- rule_id
- sink kind
- fix template id
- missing guards
- taint path signature
- file/function
- route/prompt/model/tool node
- dependency manifest

Deterministic clusters should use zero LLM. LLM clusters should use one representative finding and one model call per cluster.

## UI requirements

Add mode selector in findings toolbar/settings:

- Save / Deterministic+Explain
- Auto / Smart Routing
- Pro / High Accuracy
- Max / Deep Review
- Manual / Select Model

Show badges:

- Deterministic scanner truth
- AI explanation
- Auto-selected model
- Manual model
- Graph-bounded context
- Cached
- Suggestion only
- Real fix candidate
- Re-scan validated
- More resources used
- Cost estimate

Wire `components/intelligence-mode-toggle.tsx` and `components/model-selector.tsx` into the existing UI, but keep UI consistent with the app style.

## Commands to run

After integration, run:

```bash
python -m compileall scanner/src
cd scanner && pytest -q && cd ..
pnpm test
pnpm test:explain
node --import tsx/esm --test tests/intelligence-modes.test.ts
pnpm build
```

If tests fail because of existing unrelated repo issues, clearly separate:

- pre-existing failures
- failures introduced by integration
- remaining TODOs

## Final response format

When done, report:

A. Files copied/modified
B. Existing files reused or merged
C. Intelligence modes implemented
D. Scanner improvements wired
E. ContextBundle integration
F. Model routing and cost behavior
G. Patch validation behavior
H. Bulk fix clustering behavior
I. UI changes
J. Test/build results
K. Remaining TODOs

Do not commit. Do not push. Keep changes local on a branch.
