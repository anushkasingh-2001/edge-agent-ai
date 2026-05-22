"""Scanner defaults: paths to skip, extensions, size limits.

The new IR/analyzer pipeline expects ``IGNORED_DIRS`` and ``TEXT_EXTENSIONS``,
while the legacy walker imports ``SKIP_DIR_NAMES`` and the historical
approval-gate rule imports ``APPROVAL_CONTEXT_LINES``. We keep all four names
exported with compatible types so dropping the new pipeline into place does
not break previously-shipped modules.
"""

from __future__ import annotations

IGNORED_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        ".next",
        "dist",
        "build",
        "__pycache__",
        "venv",
        ".venv",
        ".turbo",
        # Edge Agent AI's own bookkeeping (policy.yaml, last-scan.json,
        # base-scan-cache.json, untracked-attribution.json). Without
        # this skip, the scanner walks our cached scan reports — which
        # contain serialised dangerous-tool names, secret patterns,
        # and code snippets from real findings — and re-flags them
        # against the project, causing main's issue count to balloon
        # every time a baseline scan ran. See the "9 → 21 jump" bug.
        ".edgeagent",
    }
)

TEXT_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".py",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".json",
        ".yaml",
        ".yml",
        ".md",
        ".txt",
        ".toml",  # pyproject.toml / tool configs for framework detection
    }
)

# Default max file size for text scan (bytes). Bumped from 512KB to 768KB so
# generated OpenAPI/MCP descriptors used by the new extractors fit, while
# still keeping the walker bounded.
MAX_FILE_BYTES: int = 768 * 1024

# Max findings retained per rule_id (after dedupe) to keep reports bounded
MAX_FINDINGS_PER_RULE: int = 150

# Graph traversal depth ceiling for the reachability analyzers. Used by
# `ir.graph.find_paths` to keep BFS work bounded.
MAX_GRAPH_DEPTH: int = 8

# Optional LLM verifier is OFF by default. Toggled via
# EDGE_AGENT_LLM_VERIFIER=1 environment variable.
ENABLE_LLM_VERIFIER_DEFAULT: bool = False

# External scanners are optional. Missing binaries should never crash scans.
GITLEAKS_BINARY: str = "gitleaks"
TRUFFLEHOG_BINARY: str = "trufflehog"
OSV_SCANNER_BINARY: str = "osv-scanner"
SEMGREP_BINARY: str = "semgrep"

# ---------------------------------------------------------------------------
# Backwards-compatibility aliases.
# walker.py imports `SKIP_DIR_NAMES`; the legacy approval-gate rule imports
# `APPROVAL_CONTEXT_LINES`. Both names stay exported so the rest of the codebase
# (and existing tests, scripts, and CI configs) continue to work unchanged.
# ---------------------------------------------------------------------------
SKIP_DIR_NAMES: frozenset[str] = IGNORED_DIRS

# Lines before/after a hit for approval-gate context (legacy approval rule).
APPROVAL_CONTEXT_LINES: int = 15
