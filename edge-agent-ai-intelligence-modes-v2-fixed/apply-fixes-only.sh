#!/usr/bin/env bash
set -euo pipefail

# Use this only if you already applied the earlier intelligence-mode bundle
# and just want the v2 corrections. It copies fixed helper files and applies
# idempotent source edits.

if [ ! -d .git ]; then
  echo "ERROR: Run this from the edge-agent-ai repo root." >&2
  exit 1
fi
BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p lib components tests
cp "$BUNDLE_DIR/new-files/lib/server-ai-provider-resolver.ts" lib/server-ai-provider-resolver.ts
cp "$BUNDLE_DIR/new-files/components/model-selector.tsx" components/model-selector.tsx
cp "$BUNDLE_DIR/new-files/tests/all-modes-e2e-wiring.test.ts" tests/all-modes-e2e-wiring.test.ts
node "$BUNDLE_DIR/scripts/apply-all-mode-fixes.mjs"

echo "Done. Suggested verification:"
echo "  npx tsc --noEmit"
echo "  node --import tsx/esm --test tests/all-modes-e2e-wiring.test.ts"
