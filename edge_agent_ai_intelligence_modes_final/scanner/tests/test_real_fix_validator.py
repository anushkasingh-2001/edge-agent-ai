"""Tests for the real-fix validator and finding grouping.

These lock in the single most important safety property: a
TODO/comment/whitespace/AST-equivalent diff is NEVER a real fix.
"""

from __future__ import annotations

from edge_agent_scanner.remediation.validators import (
    is_real_fix,
    guard_added,
    REASON_OK,
    REASON_NO_NET_CHANGE,
    REASON_WHITESPACE_ONLY,
    REASON_AST_EQUIVALENT,
    REASON_TODO_OR_COMMENT_ONLY,
)
from edge_agent_scanner.remediation.patches import build_patch_proposal


def test_todo_only_is_not_a_real_fix() -> None:
    old = "def run(q):\n    session.run(q)\n"
    new = "def run(q):\n    # TODO: validate input\n    session.run(q)\n"
    r = is_real_fix(old, new)
    assert r.is_real_fix is False


def test_real_parameterization_is_a_real_fix() -> None:
    old = "def run(q):\n    session.run(q)\n"
    new = "def run(q, name):\n    session.run(q, {'name': name})\n"
    r = is_real_fix(old, new)
    assert r.is_real_fix is True
    assert r.reason == REASON_OK


def test_no_change_rejected() -> None:
    code = "x = 1\n"
    assert is_real_fix(code, code).reason == REASON_NO_NET_CHANGE


def test_whitespace_only_rejected() -> None:
    old = "def f():\n    return 1\n"
    new = "def f():\n        return 1\n"
    assert is_real_fix(old, new).reason == REASON_WHITESPACE_ONLY


def test_ast_equivalent_rejected() -> None:
    old = "x = 'a'\n"
    new = 'x = "a"\n'
    assert is_real_fix(old, new).reason == REASON_AST_EQUIVALENT


def test_comment_only_non_python_rejected() -> None:
    old = "function f(q){\n  db.run(q);\n}\n"
    new = "function f(q){\n  // TODO sanitize\n  db.run(q);\n}\n"
    r = is_real_fix(old, new, language="ts")
    assert r.is_real_fix is False


def test_build_patch_proposal_classifies_suggestion() -> None:
    old = "def run(q):\n    session.run(q)\n"
    new = "def run(q):\n    # TODO: fix me\n    session.run(q)\n"
    prop = build_patch_proposal(
        file="x.py", old_contents=old, new_contents=new, explanation="advice",
    )
    assert prop.role == "suggestion"


def test_build_patch_proposal_classifies_fix() -> None:
    old = "def run(q):\n    session.run(q)\n"
    new = "def run(q, name):\n    session.run(q, {'name': name})\n"
    prop = build_patch_proposal(
        file="x.py", old_contents=old, new_contents=new, explanation="parameterize",
        rule_id="cypher-injection-from-llm-or-user",
    )
    assert prop.role == "fix"


def test_guard_added_detects_parameterization() -> None:
    assert guard_added(
        "session.run(q, params={'n': n})", "cypher-injection-from-llm-or-user"
    )
    assert guard_added("key = os.getenv('K')", "secrets")
    assert not guard_added("x = 1", "secrets")
