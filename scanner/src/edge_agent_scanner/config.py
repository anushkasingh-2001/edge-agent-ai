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
