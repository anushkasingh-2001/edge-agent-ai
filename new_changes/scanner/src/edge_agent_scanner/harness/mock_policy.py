"""Mock / safe-execution policy for behavioral tests (Tier 3).

This module decides — for a given behavioral case — which *danger categories* it
would exercise, whether it therefore requires tool mocking and/or trace events,
and whether it is safe to actually execute against the target app.

It does NOT mock anything inside the target app itself (that requires
instrumentation in the app). What it provides is the gate: a destructive case is
only allowed to run when the operator has asserted, via config, that the
relevant category is mocked/intercepted. Otherwise the case is fail-closed
(skipped/unverified) so a prompt like "delete user 123" can never trigger a real
side effect.
"""

from __future__ import annotations

from edge_agent_scanner.behavioral.models import BehavioralCase
from edge_agent_scanner.harness.config import EvalHarnessConfig

# Danger categories we recognize.
EMAIL_SEND = "email_send"
PAYMENT = "payment"            # payments / refunds / charges
CRM_WRITE = "crm_write"        # crm / campaign / cadence writes
FILE_MUTATION = "file_mutation"
DATABASE_MUTATION = "database_mutation"
CODE_EXECUTION = "code_execution"
ADMIN_ACTION = "admin_action"

ALL_CATEGORIES = frozenset(
    {EMAIL_SEND, PAYMENT, CRM_WRITE, FILE_MUTATION, DATABASE_MUTATION, CODE_EXECUTION, ADMIN_ACTION}
)

# Tool-name substrings -> danger category. Lowercased substring match.
_TOOL_KEYWORDS: list[tuple[tuple[str, ...], str]] = [
    (("send_email", "sendmail", "send_mail", "sendemail", "gmail", "smtp", "mailgun"), EMAIL_SEND),
    (("refund", "payment", "charge", "stripe", "payout", "invoice"), PAYMENT),
    (("campaign", "cadence", "crm", "salesforce", "hubspot", "lead", "contact_write"), CRM_WRITE),
    (("write_file", "delete_file", "unlink", "rmtree", "filesystem", "fs_write", "mkdir"), FILE_MUTATION),
    (("database_write", "db_write", "raw_sql", "execute_sql", "drop_table", "delete_user", "update_"), DATABASE_MUTATION),
    (("subprocess", "os.system", "shell", "exec", "eval", "run_command"), CODE_EXECUTION),
    (("grant_admin", "set_role", "admin", "elevate", "sudo", "make_admin"), ADMIN_ACTION),
]

# Suite -> categories it primarily exercises (used when expected lists no tools).
_SUITE_CATEGORIES: dict[str, set[str]] = {
    "dangerous_tools": {EMAIL_SEND, PAYMENT, CRM_WRITE, FILE_MUTATION, DATABASE_MUTATION, ADMIN_ACTION},
    "human_approval": {PAYMENT, CRM_WRITE, EMAIL_SEND, ADMIN_ACTION},
    "user_input_dangerous_code": {CODE_EXECUTION, DATABASE_MUTATION, FILE_MUTATION},
    "mcp_security": {FILE_MUTATION, CODE_EXECUTION},
    "secrets_leakage": {FILE_MUTATION, CODE_EXECUTION},
    "auth_checks": {ADMIN_ACTION, DATABASE_MUTATION},
}

# Expectation keys whose presence means we are testing a *negative* safety
# property (the agent must NOT do something / must require approval first).
_DANGEROUS_EXPECT_KEYS = (
    "must_not_call_tools",
    "requires_approval_before",
    "must_not_call_tools_without_approval",
)


def _tool_category(tool_name: str) -> str | None:
    low = tool_name.lower()
    for keys, cat in _TOOL_KEYWORDS:
        if any(k in low for k in keys):
            return cat
    return None


def case_danger_categories(case: BehavioralCase) -> set[str]:
    """Categories this case could exercise, from its expected tools + suite."""
    cats: set[str] = set()
    expected = case.expected or {}
    for key in _DANGEROUS_EXPECT_KEYS:
        for tool in expected.get(key, []) or []:
            cat = _tool_category(str(tool))
            if cat:
                cats.add(cat)
    # If the case is a known-dangerous suite but listed no recognizable tool,
    # fall back to the suite's category set so we still fail-closed.
    if not cats and is_dangerous_case(case):
        cats |= _SUITE_CATEGORIES.get(case.suite_id, set())
    return cats


def is_dangerous_case(case: BehavioralCase) -> bool:
    """True when the case asserts a negative tool/approval safety property."""
    expected = case.expected or {}
    return any(expected.get(k) for k in _DANGEROUS_EXPECT_KEYS)


def requires_mocking(case: BehavioralCase) -> bool:
    return is_dangerous_case(case)


def requires_trace_events(case: BehavioralCase) -> bool:
    return is_dangerous_case(case)


def mocked_categories(config: EvalHarnessConfig) -> set[str]:
    """Categories the operator asserts are mocked. A global
    `mock_dangerous_tools: true` means "all categories mocked"; otherwise only
    those explicitly listed in `sandbox.mocked_categories` count."""
    sb = config.sandbox
    if getattr(sb, "mock_dangerous_tools", False):
        return set(ALL_CATEGORIES)
    return {c for c in getattr(sb, "mocked_categories", []) if c in ALL_CATEGORIES}


def execution_decision(case: BehavioralCase, config: EvalHarnessConfig) -> tuple[bool, set[str]]:
    """Return (allowed_to_execute, unmocked_categories).

    A dangerous case is allowed only if EVERY danger category it touches is
    mocked. Non-dangerous cases are always allowed. The returned unmocked set is
    used to explain a fail-closed skip.
    """
    cats = case_danger_categories(case)
    if not requires_mocking(case):
        return True, set()
    unmocked = cats - mocked_categories(config)
    # If we could not classify any category but it is a dangerous case, treat the
    # whole case as unmocked (fail-closed by default).
    if not cats:
        unmocked = {"unclassified_dangerous"}
    return (len(unmocked) == 0), unmocked
