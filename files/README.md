# Edge Agent AI — Fix System Implementation

These files implement the locked architecture:
**deterministic-first · graph-bounded · cluster-aware · plan-before-patch · AST-applies-when-possible · re-scan-validated · cache-everything.**

The folder mirrors your repo paths. Copy each file to the matching location.

---

## File map (NEW vs MODIFY)

| This file | → Destination in repo | Status |
|---|---|---|
| `lib/server-llm-client.ts` | `lib/server-llm-client.ts` | **NEW** — shared OpenAI-compatible caller (extracted from the pattern in `server-finding-explanations.ts`) |
| `lib/fix-planner.ts` | `lib/fix-planner.ts` | **NEW** — classifies findings before routing |
| `lib/server-model-router.ts` | `lib/server-model-router.ts` | **NEW** — generalizes `pickModel` to tasks + tiers + escalation |
| `lib/server-fix-clustering.ts` | `lib/server-fix-clustering.ts` | **NEW** — root-cause clustering for bulk fix |
| `lib/patch-confidence.ts` | `lib/patch-confidence.ts` | **NEW** — objective confidence score + UI band |
| `lib/fix-cache.ts` | `lib/fix-cache.ts` | **NEW** — 4-namespace cache extending `.edgeagent/cache/` |
| `lib/server-patch-pipeline.ts` | `lib/server-patch-pipeline.ts` | **NEW** — orchestrator (plan→diff→temp→validate→re-scan→score) |
| `app/api/finding/patch/route.ts` | `app/api/finding/patch/route.ts` | **MODIFY** — replaces the not-implemented scaffold |
| `app/api/findings/fix-filtered/route.ts` | `app/api/findings/fix-filtered/route.ts` | **NEW** — bulk "Fix filtered" endpoint |

**Reused unchanged** (no edits needed): `lib/server-finding-fixes.ts`, `lib/server-path-utils.ts`, `scanner/.../remediation/*`, `lib/model-keys.ts`, `lib/model-catalog.ts`, the IR, and the existing `finding/explain` flow.

---

## How the pieces connect

```
finding(s)
  → fix-planner.planFix()            classify (no AI)
  → [bulk] server-fix-clustering     group by root cause (no AI)
  → server-model-router.routeModel() pick tier/model (only if needs_llm)
  → server-patch-pipeline            generate + validate + score
        ├─ deterministic → server-finding-fixes (REUSED)
        └─ llm → server-llm-client → temp workspace → delta re-scan → patch-confidence
  → fix-cache                        cache validated preview
  → route returns PatchPreview       UI shows diff + confidence badges
  → user clicks Apply                server-finding-fixes writes + backs up (REUSED)
```

The **planner** is the accuracy gate (AI only when needed). The **router** is the cost gate (cheap tier first, escalate on validation failure). The **re-scan inside the pipeline** is the source-of-truth arbiter. The **confidence score** is trust UX, built only from objective signals — the LLM never rates itself.

---

## Integration seams (search for `TODO(integration)`)

These are the only places the code stubs real subprocess calls. Everything else is working logic. Wire them to your existing binaries:

1. **`server-patch-pipeline.ts → deltaReScan()`** — shell out to your scanner CLI scoped to the changed files, diff against pre-patch findings. Until wired, the pipeline reports `findingResolved=false`, so confidence can never falsely show "strong". **This is the highest-priority wire-up** — it activates the arbiter.
2. **`server-patch-pipeline.ts → parsesOk()`** — replace the bracket-balance heuristic with a real LibCST (Python) / TS parse via subprocess.
3. **`server-patch-pipeline.ts`** — `testsPassed` / `buildPassed` are `null` (not run). Add affected-test + typecheck runs in the temp workspace when a target is discoverable.
4. **`server-patch-pipeline.ts → applyUnifiedDiffToContent()`** — the built-in applier handles single-file clean diffs. For multi-file / fuzzy diffs, swap to `git apply --3way` against the temp workspace.
5. **`fix-filtered/route.ts` → suppress_batch** — persist a suppression rule to `.edgeagent/suppressions.json` so future scans skip the FP class.
6. **AST patcher (optional, accuracy upgrade)** — for known rules, have the LLM emit only a structured intent and let a deterministic AST transform apply it. The planner already routes these as `llm_simple_patch`; add the AST-apply branch in the pipeline before falling back to LLM-emits-diff.

---

## Build order (matches the locked plan)

1. Drop in `fix-planner.ts` + `server-model-router.ts` + `server-llm-client.ts` (no external deps).
2. Replace `app/api/finding/patch/route.ts` and add `server-patch-pipeline.ts` + `patch-confidence.ts` + `fix-cache.ts`. Wire `deltaReScan` (seam #1).
3. Add `server-fix-clustering.ts` + `fix-filtered/route.ts`.
4. Add tests/build runs (seam #3) and the AST patcher (seam #6) as accuracy upgrades.

---

## Request/response shapes (for the frontend)

**Single fix — `POST /api/finding/patch`**
```jsonc
// request (suggest)
{ "projectPath": "...", "mode": "suggest", "scannerVersion": "1.x",
  "finding": { "id","rule_id","severity","category","file","line","evidence","code",
               "confidence","has_suggested_patch","evidence_path_files","evidence_path_len" },
  "context": { /* GraphContext, only for LLM classes */ },
  "provider": "openai", "apiKey": "...", "baseUrl": null, "privateCodeMode": false }

// response
{ "status": "ok", "cached": false,
  "preview": { "source","diff","before","after","confidence": {...}, "applicable", "model_used" } }
// or for unfixable:
{ "status": "cannot_fix_safely" | "needs_user_decision", "applicable": false, "reason": "..." }
```

**Bulk — `POST /api/findings/fix-filtered`**
```jsonc
{ "projectPath":"...", "scannerVersion":"1.x", "findings":[ ClusterableFinding... ],
  "contextBySignature": { "<sig>": GraphContext }, "provider":"openai", "apiKey":"...", "concurrency":4 }

// response
{ "status":"ok", "total_findings":100, "cluster_count":6, "llm_call_estimate":3,
  "clusters":[ { "signature","label","strategy","member_ids":[...],"previews":[...] } ] }
```

`llm_call_estimate` lets the UI warn "this will make N model calls" before the user commits — the visible payoff of clustering.
