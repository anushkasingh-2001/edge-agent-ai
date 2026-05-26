# Edge Agent AI Intelligence Modes — V2 Fixed Bundle

Target repo/branch:

```bash
https://github.com/anushkasingh-2001/edge-agent-ai/tree/intelligence-modes
```

This is the corrected bundle for the five modes:

- **Save** — deterministic scanner truth + explanation only, no LLM patch generation.
- **Auto** — smart routing, cheap/mid/strong based on complexity.
- **Pro** — stronger coding model + larger context.
- **Max** — deep plan → patch → validate behavior.
- **Manual** — user-selected model per task, with all guardrails still enforced.

## What this V2 fixes compared with the previous bundle

1. **Manual mode now uses real selected model IDs end-to-end.**
   The first bundle mixed `manualModels`, `manualModelSelection`, task names, and tier names. This bundle normalizes aliases and supports values like:

   ```ts
   { patch: "anthropic:claude-sonnet-4-5-20250929" }
   ```

2. **Fix all / Fix filtered now receives the chosen mode.**
   The previous UI rendered the mode toggle but did not pass the selected mode into the Fix button/dialog/client path.

3. **Hosted/BYOK is visible in the Findings UI.**
   The AI provider toggle is rendered, and Manual mode shows the model selector.

4. **The patch pipeline honors the resolver-selected model.**
   The previous Hosted/BYOK resolver could pick a model, but the patch pipeline could silently route again by tier. V2 adds `forceModel` / `forceTwoStep` plumbing.

5. **Hosted credit consumption is recorded after successful model preview generation.**

6. **New regression test included:**

   ```bash
   node --import tsx/esm --test tests/all-modes-e2e-wiring.test.ts
   ```

## Apply from a clean branch

Recommended if you have not applied the earlier bundle, or if you can reset to a clean `intelligence-modes` branch:

```bash
git checkout intelligence-modes
bash /path/to/edge-agent-ai-intelligence-modes-v2-fixed/apply-v2-from-clean-branch.sh
```

Then verify:

```bash
npx tsc --noEmit
node --import tsx/esm --test \
  tests/step1-mode-plumbing.test.ts \
  tests/step2-mode-routing.test.ts \
  tests/step4-context-bundle.test.ts \
  tests/step5-explain-mode.test.ts \
  tests/step6-max-plan.test.ts \
  tests/hosted-byok-resolver.test.ts \
  tests/all-modes-e2e-wiring.test.ts
```

## Apply only the V2 fixes

Use this only if the older bundle is already applied and you only need the corrections:

```bash
bash /path/to/edge-agent-ai-intelligence-modes-v2-fixed/apply-fixes-only.sh
```

## Hosted mode env example

```bash
EDGE_AGENT_HOSTED_PROVIDER=openai_compatible
EDGE_AGENT_HOSTED_OPENAI_KEY=sk-...
EDGE_AGENT_PLAN_TIER=enterprise
EDGE_AGENT_USD_PER_CREDIT=0.001
```

For Manual per-task model selection in local testing, use `EDGE_AGENT_PLAN_TIER=enterprise`; the bundled plan layer intentionally blocks per-task selection on lower plans so upgrade/quota behavior can be tested.

## Important

This bundle only edits your local repo when you run the script. It does not create commits or push to GitHub.
