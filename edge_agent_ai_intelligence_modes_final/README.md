# Edge Agent AI — Intelligence Modes Patch Pack

A drop-in implementation pack that adds a **five-tier intelligence-mode
system** to `edge-agent-ai`, fixes the OneKE-class noise/precision
problems, and makes **re-scan the arbiter of "fixed"** so TODO/comment
markers can never count as real fixes.

> This pack lives in its own folder. It does **not** modify your repo.
> Copy files in (or apply the included diff) when you're ready — see
> `apply_instructions.md`.

## The five modes

| Mode | LLM use | Context | Model tier | Validation |
|---|---|---|---|---|
| **Save / Deterministic+Explain** | explanation only, on open | tiny slice (≤1.5k) | cheap | re-scan |
| **Auto / Smart Routing** *(default)* | only when it helps; cheap→strong cascade | graph-bounded (≤4–12k) | complexity-routed | re-scan, escalate on fail |
| **Pro / High Accuracy** | yes | larger neighborhood (≤12k) | strong | re-scan |
| **Max / Deep Review** | yes | full neighborhood + config/tests (≤24k) | best | plan→patch→parse→test→re-scan |
| **Manual / Select Model** | yes | graph-bounded | user picks per task | re-scan |

**Core product principle (unchanged from your brief):** the deterministic
scanner is the *only* source of finding truth — existence, severity,
category, file, line, evidence. The LLM is used **only** for explanation,
root-cause reasoning, suggestions, patch plans, and patch generation.
**A re-scan decides whether a finding is actually fixed.**

## What this pack delivers

**Scanner (Python) — verified against your repo:**
- Six new root-cause analyzers (all firing on a OneKE-style fixture,
  zero false positives on safe patterns):
  prompt-injection-placeholder, cypher-injection-from-llm-or-user,
  config-controlled-file-read, default-db-credentials,
  env-proxy-mutation, llm-codegen-to-exec.
- Weak-signal downgrades: `json.dumps` alone is a transform (not export),
  tempfile create/cleanup is benign, dependencies grouped per manifest,
  output-schema/prompt-contract grouped per file.
- **`is_real_fix()`** — the gate that rejects TODO/comment/whitespace/
  AST-equivalent/Edge-marker diffs so they become *suggestions*, never
  fixes.
- Structural **fingerprint + dedup** so duplicate findings collapse.

**Orchestration (TypeScript) — pure logic verified:**
- `intelligence-mode.ts` — the five-mode policy, a complexity scorer,
  per-task routing, and hard guardrails.
- `context-bundle.ts` + `server-context-bundle.ts` — the graph-bounded
  **ContextBundle** that replaces "send the whole file". Budget-trimmed,
  redacted, never full-file except the capped `max-patch` escape hatch.
- `server-model-router-ext.ts` — mode + complexity → concrete model id
  across **all** wired providers (OpenAI / Anthropic / Google / custom).
- `server-cost-controller.ts` — pricing, pre-flight estimate, budget cap.
- Full `/api/finding/patch` (preview + safe apply), mode-aware
  `/api/findings/fix-filtered` (one LLM call per cluster), and
  `/api/scan/estimate`.
- `patch-confidence-realfix.ts` — TS mirror of `is_real_fix` on diffs.

**UI:**
- `intelligence-mode-toggle.tsx` — the five-mode picker.
- `model-selector.tsx` — Cursor-style per-task model selection (Manual).

## Test status (run in this pack's development sandbox)

```
Scanner (pytest):   22 new tests PASS  (test_root_causes.py, test_real_fix_validator.py)
                    93 existing tests PASS, 7 pre-existing failures unrelated
                    (they reference ScanReport.suppressions, absent on your
                     current main — not introduced here)
TypeScript (node --test): 11/11 PASS   (tests/intelligence-modes.test.ts)
End-to-end scan:    all 6 new rules fire through engine.run_scan; grouping
                    + dedup integrated; no regressions.
```

## Files

See `IMPLEMENTATION_NOTES.md` for the full file-by-file map and the exact
integration points (adapter functions are marked where they touch APIs
this pack can't see).

## Apply

See `apply_instructions.md`.
