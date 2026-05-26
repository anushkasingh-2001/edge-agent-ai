"""Patch validators.

This module is the deterministic gate that decides whether a candidate
patch is a *real fix* or merely a *suggestion*. It exists because the
remediation engine (and any LLM patch path) can produce diffs whose only
net change is a ``# TODO`` marker, a comment, a docstring tweak, or a
whitespace reflow. Those must NEVER be allowed to mark a finding as
fixed — re-scan is the arbiter of "fixed", but a comment-only diff can't
even reach re-scan honestly, so we reject it up front and downgrade it
to ``suggestion``.

Layering note
-------------
This stays in ``remediation/`` and imports only the stdlib + ``report``
types it already shares. The TypeScript side (``lib/patch-confidence.ts``)
mirrors ``is_real_fix`` semantics so the UI and the scanner agree on what
"real fix" means.

Backwards compatibility
------------------------
The original module exposed ``validates_python_syntax(code) -> bool``.
That function is preserved verbatim so existing imports keep working.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Preserved from the original validators.py
# ---------------------------------------------------------------------------


def validates_python_syntax(code: str) -> bool:
    """Return True iff ``code`` parses as Python. Preserved API."""
    try:
        ast.parse(code)
        return True
    except SyntaxError:
        return False


# ---------------------------------------------------------------------------
# Real-fix detection
# ---------------------------------------------------------------------------

# Lines that carry no behavioural change. A diff whose substantive
# content is only these is a suggestion, not a fix.
_COMMENT_PREFIXES = ("#", "//", "/*", "*", "*/")
_TODO_RX = re.compile(r"^[#/*\s]*(TODO|FIXME|XXX|HACK|NOTE|REVIEW)\b", re.I)
# Edge Agent's own marker blocks (older deterministic engine inserted
# these). They must never count as a fix.
_EDGE_MARKER_RX = re.compile(r"(edge[-_ ]?agent|edgeagent)", re.I)
_DOCSTRING_DELIMS = ('"""', "'''")


def _is_inert_line(line: str) -> bool:
    """True when a (added or removed) line carries no executable change."""
    s = line.strip()
    if not s:
        return True
    if s.startswith(_COMMENT_PREFIXES):
        return True
    if _TODO_RX.match(s):
        return True
    if s in _DOCSTRING_DELIMS:
        return True
    # A pure Edge Agent marker comment line.
    if s.startswith("#") and _EDGE_MARKER_RX.search(s):
        return True
    return False


def _strip_ws(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _python_ast_equivalent(old: str, new: str) -> bool:
    """True when two Python snippets parse to the same AST dump.

    Used to catch diffs that only reformat (whitespace, quote style,
    comment churn) without changing behaviour. Returns False when either
    side fails to parse (we can't prove equivalence, so don't claim it).
    """
    try:
        old_tree = ast.dump(ast.parse(old))
        new_tree = ast.dump(ast.parse(new))
    except SyntaxError:
        return False
    return old_tree == new_tree


@dataclass
class RealFixResult:
    is_real_fix: bool
    reason: str

    def as_dict(self) -> dict:
        return {"is_real_fix": self.is_real_fix, "reason": self.reason}


# Reasons are stable strings the TS layer + tests assert on.
REASON_OK = "ok"
REASON_NO_NET_CHANGE = "no-net-change"
REASON_TODO_OR_COMMENT_ONLY = "todo-or-comment-only"
REASON_WHITESPACE_ONLY = "whitespace-only"
REASON_AST_EQUIVALENT = "ast-equivalent"
REASON_DOCSTRING_ONLY = "docstring-only"
REASON_EDGE_MARKER_ONLY = "edge-marker-only"


def is_real_fix(
    old_text: str,
    new_text: str,
    *,
    language: str = "python",
) -> RealFixResult:
    """Decide whether the change from ``old_text`` → ``new_text`` is a
    real fix or merely a suggestion.

    The check is intentionally conservative: when in doubt, it is better
    to label a borderline change a "suggestion" (the user still sees the
    diff) than to mark a finding fixed on the strength of a comment.

    Detection order (first failing gate wins):
      1. no-net-change         identical text.
      2. whitespace-only       differ only by whitespace.
      3. ast-equivalent        (python) parse to identical AST.
      4. todo-or-comment-only  every substantive added/removed line is
                               a comment / TODO / docstring delimiter /
                               Edge Agent marker.
    """
    if old_text == new_text:
        return RealFixResult(False, REASON_NO_NET_CHANGE)

    if _strip_ws(old_text) == _strip_ws(new_text):
        return RealFixResult(False, REASON_WHITESPACE_ONLY)

    if language == "python" and _python_ast_equivalent(old_text, new_text):
        return RealFixResult(False, REASON_AST_EQUIVALENT)

    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    old_set = _multiset(old_lines)
    new_set = _multiset(new_lines)

    # Lines genuinely added / removed (set difference on multisets).
    added = _diff_multiset(new_set, old_set)
    removed = _diff_multiset(old_set, new_set)

    substantive_added = [l for l in added if not _is_inert_line(l)]
    substantive_removed = [l for l in removed if not _is_inert_line(l)]

    if not substantive_added and not substantive_removed:
        # Distinguish the reason for a better UI message.
        all_changed = added + removed
        if all_changed and all(_EDGE_MARKER_RX.search(l) for l in all_changed):
            return RealFixResult(False, REASON_EDGE_MARKER_ONLY)
        if all_changed and all(
            l.strip() in _DOCSTRING_DELIMS
            or l.strip().startswith(_DOCSTRING_DELIMS)
            for l in all_changed
        ):
            return RealFixResult(False, REASON_DOCSTRING_ONLY)
        return RealFixResult(False, REASON_TODO_OR_COMMENT_ONLY)

    return RealFixResult(True, REASON_OK)


def _multiset(lines: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for l in lines:
        out[l] = out.get(l, 0) + 1
    return out


def _diff_multiset(a: dict[str, int], b: dict[str, int]) -> list[str]:
    """Lines present in ``a`` more often than in ``b`` (with multiplicity)."""
    out: list[str] = []
    for line, count in a.items():
        extra = count - b.get(line, 0)
        for _ in range(max(0, extra)):
            out.append(line)
    return out


def guard_added(new_text: str, rule_id: str, *, language: str = "python") -> bool:
    """Heuristic: did the patch add a guard appropriate to the rule?

    This is a *supporting* signal for patch confidence, never a gate on
    its own (re-scan remains the arbiter). It looks for the presence of
    a known guard token in the new text that maps to the finding's rule.
    Kept deliberately simple and dependency-free; the authoritative
    guard vocabulary lives in ``ir/guards.py``.
    """
    text = new_text.lower()
    rule_guards: dict[str, tuple[str, ...]] = {
        "cypher-injection-from-llm-or-user": (
            "session.run(", "$", "parameters=", "params=", "bindparam",
        ),
        "config-controlled-file-read": (
            ".resolve()", "is_relative_to", "realpath", "safe_join", "allowlist",
        ),
        "default-db-credentials": (
            "os.environ", "os.getenv", "getenv(", "process.env",
        ),
        "env-proxy-mutation": (
            "allowlist", "if ", "validate", "assert ",
        ),
        "llm-codegen-to-exec": (
            "restrictedpython", "asteval", "ast.parse", "ast.literal_eval",
            "allow_list", "allowlist",
        ),
        "prompt-injection-placeholder": (
            "escape", "sanitize", "quote", "allowlist", "strip",
        ),
        "user-input-dangerous-code": (
            "shlex.quote", "parameterized", "bindparam", "sanitize", "allowlist",
            "validate",
        ),
        "auth-checks": (
            "require_auth", "get_current_user", "login_required", "authorize",
            "permission",
        ),
        "human-approval": (
            "confirm_before_execute", "requires_approval", "approval_required",
            "human_in_the_loop",
        ),
        "secrets": ("os.environ", "os.getenv", "getenv(", "process.env"),
        "dependency-risks": ("==", "~="),
    }
    tokens = rule_guards.get(rule_id)
    if not tokens:
        return False
    return any(tok in text for tok in tokens)
