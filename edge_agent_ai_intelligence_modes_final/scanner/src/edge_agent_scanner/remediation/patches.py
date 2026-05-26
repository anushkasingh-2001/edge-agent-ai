"""Patch construction helpers.

Extends the original ``remediation/patches.py`` (which only had
``make_unified_diff``) with a *suggestion vs real-fix* aware builder so
the deterministic engine can NEVER hand back a TODO/comment marker as a
real fix.

Contract
--------
``build_patch_proposal`` returns a ``PatchProposal`` with a ``role`` of
either ``"fix"`` or ``"suggestion"``:

  * ``"fix"``        the new contents pass ``is_real_fix`` AND parse.
                     Eligible to clear a finding (after re-scan).
  * ``"suggestion"`` the change is advisory only (comment/TODO/doc, or
                     could not be made substantive). Shown to the user
                     but it NEVER decrements the finding count and NEVER
                     marks the finding fixed.

The original ``make_unified_diff`` is preserved.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field

from edge_agent_scanner.remediation.validators import (
    is_real_fix,
    validates_python_syntax,
)


def make_unified_diff(file: str, old: str, new: str) -> str:
    """Preserved original API."""
    return "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=f"a/{file}",
            tofile=f"b/{file}",
        )
    )


@dataclass
class PatchProposal:
    file: str
    old_contents: str
    new_contents: str
    explanation: str
    role: str = "suggestion"            # "fix" | "suggestion"
    real_fix_reason: str = ""
    parses: bool | None = None
    unified_diff: str = ""
    meta: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "file": self.file,
            "explanation": self.explanation,
            "role": self.role,
            "real_fix_reason": self.real_fix_reason,
            "parses": self.parses,
            "unified_diff": self.unified_diff,
            "meta": self.meta,
        }


def _language_for(file: str) -> str:
    f = file.lower()
    if f.endswith((".py",)):
        return "python"
    if f.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")):
        return "ts"
    return "other"


def build_patch_proposal(
    *,
    file: str,
    old_contents: str,
    new_contents: str,
    explanation: str,
    rule_id: str = "",
) -> PatchProposal:
    """Construct a proposal and classify it as fix vs suggestion.

    This is the single chokepoint that prevents TODO/comment-only
    "fixes" from ever being labelled a fix.
    """
    language = _language_for(file)
    diff = make_unified_diff(file, old_contents, new_contents)

    rf = is_real_fix(old_contents, new_contents, language=language)

    parses: bool | None = None
    if language == "python":
        parses = validates_python_syntax(new_contents)

    role = "suggestion"
    if rf.is_real_fix and (parses is not False):
        role = "fix"

    return PatchProposal(
        file=file,
        old_contents=old_contents,
        new_contents=new_contents,
        explanation=explanation,
        role=role,
        real_fix_reason=rf.reason,
        parses=parses,
        unified_diff=diff,
        meta={"rule_id": rule_id, "language": language},
    )


def comment_only_suggestion(
    *, file: str, line: int, contents: str, advice: str, rule_id: str = ""
) -> PatchProposal:
    """Produce an EXPLICITLY suggestion-only proposal that inserts an
    advisory comment. Useful when no safe automatic fix exists but we
    still want to guide the user.

    Crucially, the resulting proposal has ``role == "suggestion"`` by
    construction — ``build_patch_proposal`` would also classify it as a
    suggestion, but we mark it directly so intent is unambiguous and we
    never accidentally route it through the fix path.
    """
    lines = contents.splitlines(keepends=True)
    insert_at = max(0, min(len(lines), line - 1))
    marker = f"# SUGGESTION ({rule_id}): {advice}\n" if file.endswith(".py") else f"// SUGGESTION ({rule_id}): {advice}\n"
    new_lines = lines[:insert_at] + [marker] + lines[insert_at:]
    new_contents = "".join(new_lines)
    return PatchProposal(
        file=file,
        old_contents=contents,
        new_contents=new_contents,
        explanation=advice,
        role="suggestion",
        real_fix_reason="todo-or-comment-only",
        parses=validates_python_syntax(new_contents) if file.endswith(".py") else None,
        unified_diff=make_unified_diff(file, contents, new_contents),
        meta={"rule_id": rule_id, "suggestion_only": True},
    )
