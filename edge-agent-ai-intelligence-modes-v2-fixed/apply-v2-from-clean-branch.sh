#!/usr/bin/env bash
set -euo pipefail

# Apply from repo root of https://github.com/anushkasingh-2001/edge-agent-ai
# Recommended: start from a clean intelligence-modes branch.

if [ ! -d .git ]; then
  echo "ERROR: Run this from the edge-agent-ai repo root." >&2
  exit 1
fi

CURRENT_BRANCH=$(git branch --show-current || true)
if [ "$CURRENT_BRANCH" != "intelligence-modes" ]; then
  echo "WARNING: current branch is '$CURRENT_BRANCH', expected 'intelligence-modes'."
  echo "Press Ctrl+C now if this is wrong, or wait 5 seconds to continue..."
  sleep 5
fi

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

apply_patch_if_needed() {
  local patch_file="$1"
  local label="$2"
  if git apply --check "$patch_file" >/dev/null 2>&1; then
    echo "$label"
    git apply "$patch_file"
  elif git apply --reverse --check "$patch_file" >/dev/null 2>&1; then
    echo "$label already applied; skipping"
  else
    echo "$label did not apply cleanly; trying 3-way..."
    git apply --3way "$patch_file"
  fi
}

echo "1/5 Applying Step 1-6 intelligence-mode wiring patch..."
apply_patch_if_needed "$BUNDLE_DIR/patches/01-intelligence-modes-wiring.patch" "Applying 01-intelligence-modes-wiring.patch"

echo "2/5 Copying new files and tests..."
mkdir -p lib app/api/plan components tests
cp "$BUNDLE_DIR/new-files/lib/server-subscription.ts" lib/server-subscription.ts
cp "$BUNDLE_DIR/new-files/lib/server-ai-provider-resolver.ts" lib/server-ai-provider-resolver.ts
cp "$BUNDLE_DIR/new-files/lib/plan-client.ts" lib/plan-client.ts
mkdir -p app/api/plan
cp "$BUNDLE_DIR/new-files/app/api/plan/route.ts" app/api/plan/route.ts
cp "$BUNDLE_DIR/new-files/components/ai-provider-toggle.tsx" components/ai-provider-toggle.tsx
cp "$BUNDLE_DIR/new-files/components/model-selector.tsx" components/model-selector.tsx
cp "$BUNDLE_DIR/new-files/tests/"*.test.ts tests/

echo "3/5 Applying Hosted/BYOK provider patch..."
apply_patch_if_needed "$BUNDLE_DIR/patches/02-hosted-byok-provider.patch" "Applying 02-hosted-byok-provider.patch"

echo "4/5 Applying v2 all-mode corrections..."
node "$BUNDLE_DIR/scripts/apply-all-mode-fixes.mjs"

echo "5/5 Done. Suggested verification:"
echo "  npx tsc --noEmit"
echo "  node --import tsx/esm --test tests/step1-mode-plumbing.test.ts tests/step2-mode-routing.test.ts tests/step4-context-bundle.test.ts tests/step5-explain-mode.test.ts tests/step6-max-plan.test.ts tests/hosted-byok-resolver.test.ts tests/all-modes-e2e-wiring.test.ts"
