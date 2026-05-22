from __future__ import annotations

IGNORED_DIRS = {
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
    ".edgeagent",
}

TEXT_EXTENSIONS = {
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
    ".toml",
}

MAX_FILE_BYTES = 768 * 1024
MAX_FINDINGS_PER_RULE = 150
MAX_GRAPH_DEPTH = 8
ENABLE_LLM_VERIFIER_DEFAULT = False

# External scanners are optional. Missing binaries should never crash scans.
GITLEAKS_BINARY = "gitleaks"
TRUFFLEHOG_BINARY = "trufflehog"
OSV_SCANNER_BINARY = "osv-scanner"
SEMGREP_BINARY = "semgrep"

# ---------------------------------------------------------------------------
# Backwards-compatibility aliases.
# The existing walker.py imports `SKIP_DIR_NAMES`; the legacy approval-gate
# rule imports `APPROVAL_CONTEXT_LINES`. Keep both names exported so dropping
# this config in place does not break unmodified modules during migration.
# ---------------------------------------------------------------------------
SKIP_DIR_NAMES = IGNORED_DIRS
APPROVAL_CONTEXT_LINES = 15
