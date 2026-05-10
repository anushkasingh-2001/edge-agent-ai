"""Scanner defaults: paths to skip, extensions, size limits."""

from __future__ import annotations

SKIP_DIR_NAMES: frozenset[str] = frozenset(
    {
        "node_modules",
        ".git",
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

# Default max file size for text scan (bytes)
MAX_FILE_BYTES: int = 512 * 1024

# Max findings retained per rule_id (after dedupe) to keep reports bounded
MAX_FINDINGS_PER_RULE: int = 150

# Lines before/after a hit for approval-gate context
APPROVAL_CONTEXT_LINES: int = 15
