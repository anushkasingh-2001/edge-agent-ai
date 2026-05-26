# Apply Instructions

This pack does **not** touch your repo. Apply it deliberately.

> Work on a branch. Nothing here auto-applies; every patch is preview +
> human-confirmed by design.

## 0. Branch + backup

```bash
cd /path/to/edge-agent-ai
git checkout -b intelligence-modes
```

## 1. Copy the new files

From the pack root, copy preserving relative paths:

```bash
PACK=/path/to/edge_agent_ai_intelligence_modes_patch

# --- Scanner (Python) ---
cp "$PACK/scanner/src/edge_agent_scanner/analyzers/root_causes.py"        scanner/src/edge_agent_scanner/analyzers/
cp "$PACK/scanner/src/edge_agent_scanner/analyzers/finding_grouping.py"   scanner/src/edge_agent_scanner/analyzers/
cp "$PACK/scanner/src/edge_agent_scanner/ir/sinks_ext.py"                 scanner/src/edge_agent_scanner/ir/
cp "$PACK/scanner/src/edge_agent_scanner/ir/sources_ext.py"               scanner/src/edge_agent_scanner/ir/
cp "$PACK/scanner/src/edge_agent_scanner/remediation/validators.py"       scanner/src/edge_agent_scanner/remediation/   # superset of original
cp "$PACK/scanner/src/edge_agent_scanner/remediation/patches.py"          scanner/src/edge_agent_scanner/remediation/   # superset of original
mkdir -p scanner/src/edge_agent_scanner/data
cp "$PACK/scanner/src/edge_agent_scanner/data/default_credentials.json"   scanner/src/edge_agent_scanner/data/
cp "$PACK/scanner/tests/test_root_causes.py"                              scanner/tests/
cp "$PACK/scanner/tests/test_real_fix_validator.py"                       scanner/tests/

# --- Orchestration (TypeScript) ---
cp "$PACK/lib/context-bundle.ts"               lib/
cp "$PACK/lib/server-context-bundle.ts"        lib/
cp "$PACK/lib/intelligence-mode.ts"            lib/
cp "$PACK/lib/server-model-router-ext.ts"      lib/
cp "$PACK/lib/server-cost-controller.ts"       lib/
cp "$PACK/lib/patch-confidence-realfix.ts"     lib/
cp "$PACK/app/api/finding/patch/route.ts"           app/api/finding/patch/route.ts        # replaces scaffold
cp "$PACK/app/api/findings/fix-filtered/route.ts"   app/api/findings/fix-filtered/route.ts
mkdir -p app/api/scan/estimate
cp "$PACK/app/api/scan/estimate/route.ts"           app/api/scan/estimate/route.ts

# --- UI ---
cp "$PACK/components/intelligence-mode-toggle.tsx"  components/
cp "$PACK/components/model-selector.tsx"            components/

# --- Tests ---
cp "$PACK/tests/intelligence-modes.test.ts"         tests/
```

## 2. Apply the engine + report diff

```bash
git apply "$PACK/scanner/PATCH_engine_report.diff"
# If it doesn't apply cleanly (your main moved), open the .diff and make
# the 4 edits by hand — they are: add 6 rule ids to RuleId + ALL_RULE_IDS,
# add 3 fields to Finding, add 2 imports + 2 lines in run_scan.
```

## 3. (Recommended) wire the ContextBundle into the patch prompt

In `lib/server-patch-pipeline.ts`, the model currently receives the full
redacted file. To enforce "no whole files" on the patch path, build a
bundle instead. Minimal change:

```ts
import { buildContextBundle } from "./server-context-bundle"
import { bundleModeFor } from "./context-bundle"

// ...inside generatePatchPreview, replacing the buildPatchPrompt call:
const bundle = buildContextBundle({
  projectPath: ctx.projectPath,
  mode: bundleModeFor("auto", "patch"),   // or thread the real mode through
  finding: {
    id: ctx.finding.id, rule_id: ctx.finding.rule_id, severity: ctx.finding.severity,
    title: ctx.finding.rule_id, file: ctx.finding.file, line: ctx.finding.line,
    evidence_path: [], // pass finding.evidence_path if available
  },
  irHash: SCANNER_VERSION,
})
const promptUser = JSON.stringify(bundle)   // or a compact rendering
```

The route works without this step (falls back to your existing prompt);
this is what makes the no-full-file guarantee hold on the fix path.

## 4. Add test scripts (optional)

In `package.json` `scripts`:

```json
"test:modes": "node --import tsx/esm --test tests/intelligence-modes.test.ts",
"test:realfix": "node --import tsx/esm --test tests/intelligence-modes.test.ts"
```

## 5. Run everything

```bash
# Python scanner
python -m compileall scanner/src
cd scanner && pytest -q && cd ..

# TypeScript
pnpm test                      # your existing suites
pnpm test:explain
node --import tsx/esm --test tests/intelligence-modes.test.ts
pnpm build
```

Expected:
- `pytest`: your 93 pre-existing passes + 22 new passes. (The 7
  `suppressions` failures pre-date this pack — they reference
  `ScanReport.suppressions`, which isn't on your current main.)
- `node --test tests/intelligence-modes.test.ts`: 11 pass.
- `pnpm build`: compiles (ensure `@types/node` is installed via
  `pnpm install` first; the pack uses the same `node:` imports your repo
  already uses).

## 6. Wire the UI

Drop `<IntelligenceModeToggle value={mode} onChange={setMode} />` into
your findings toolbar, thread `mode` into the explain/patch/fix-filtered
request bodies as `intelligenceMode`, and render `<ModelSelector/>` when
`mode === "manual"`.

## Environment knobs

- `EDGE_AGENT_MAX_SCAN_USD` — per-scan spend cap (default `2.0`).
- `EDGE_AGENT_FIX_MODEL`, `EDGE_AGENT_FIX_DEEP_MODEL`,
  `EDGE_AGENT_EXPLAINER_MODEL` — already honoured by your router; the
  new router extension respects them automatically.

## Rollback

```bash
git checkout main
git branch -D intelligence-modes
```

No files outside the repo are touched; `.bak` backups are created by the
apply path under `.edge-agent/backups/` only when you click Apply on a
real patch.
