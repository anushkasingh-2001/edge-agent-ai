"""Anti-laundering contract.

The deterministic fix engine (`lib/server-finding-fixes.ts`) wraps
its TODO-only fallback patches in a sentinel block:

    # === Edge Agent fix [<rule>] ===
    # rule: <rule> — TODO(edge-agent): review and add a fix manually.
    # === end Edge Agent fix ===
    <still-vulnerable line>

A user might reasonably expect that clicking "Apply Fix" cleared
the finding. It does NOT — those three comment lines change ZERO
runtime behaviour. If the scanner silently respected that fence as
a suppression, every "Apply Fix" click on a rule we don't have a
real rewrite for (most prompt-contract, many auth-checks, all of
human-approval, etc.) would secretly launder the underlying
vulnerable code through to the "no findings" report.

This file is the regression test for that anti-pattern. Each case:
  1. Constructs a real vulnerability the analyzer would normally
     flag (no-auth FastAPI route, raw subprocess call, vague
     prompt).
  2. Plants the EXACT sentinel block the fix engine produces, in
     the EXACT position it produces it (immediately above the
     offending line).
  3. Asserts the finding survives — both the `findings[]` list AND
     the `suppressions.entries` audit list must show it. If a
     future refactor reintroduces fence-honoring, every test here
     fails loudly.
"""

from __future__ import annotations

from pathlib import Path

from edge_agent_scanner.engine import run_scan


# Marker block in the EXACT shape `fenceLines(...)` produces in
# `lib/server-finding-fixes.ts`. The blank line after the close
# sentinel matches the engine's emission too. We assemble per-test
# because the rule_id varies.
def _fence(rule_id: str) -> str:
    return (
        f"# === Edge Agent fix [{rule_id}] ===\n"
        f"# rule: {rule_id} — TODO(edge-agent): review and add a fix manually.\n"
        f"# === end Edge Agent fix ===\n"
    )


def test_todo_marker_near_fastapi_route_does_not_suppress_auth_checks(
    tmp_path: Path,
) -> None:
    """Sentinel block above an unauthenticated POST handler must NOT
    silence the `auth-checks` finding."""
    fp = tmp_path / "api.py"
    fp.write_text(
        "from fastapi import FastAPI\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        + _fence("auth-checks")
        + "@app.post('/transfer')\n"
        "def transfer(amount: float):\n"
        "    return {'ok': True}\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    auth = [f for f in report.findings if f.rule_id == "auth-checks"]
    assert auth, (
        "auth-checks finding must survive an auto-inserted fix fence — "
        "the route still has no Depends(get_current_user), so the "
        "analyzer's conclusion is unchanged"
    )
    # And nothing under this rule should be in the suppression audit.
    assert all(
        e.rule_id != "auth-checks" for e in report.suppressions.entries
    ), "fix fence must not appear in the suppression audit either"


def test_todo_marker_near_dangerous_tool_does_not_suppress_dangerous_tools(
    tmp_path: Path,
) -> None:
    """Sentinel block above a `subprocess.run([...])` must NOT silence
    the `dangerous-tools` finding."""
    fp = tmp_path / "ops.py"
    fp.write_text(
        "import subprocess\n"
        "\n"
        + _fence("dangerous-tools")
        + "subprocess.run(['rm', '-rf', '/tmp/junk'])\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    dt = [f for f in report.findings if f.rule_id == "dangerous-tools"]
    assert dt, (
        "dangerous-tools finding must survive an auto-inserted fix fence — "
        "the call is still a raw subprocess.run, the analyzer hasn't "
        "changed its mind"
    )
    assert all(
        e.rule_id != "dangerous-tools" for e in report.suppressions.entries
    )


def test_todo_marker_near_prompt_does_not_suppress_prompt_contract(
    tmp_path: Path,
) -> None:
    """Sentinel block above a vague prompt assignment must NOT silence
    the `prompt-contract` finding. This is the exact scenario the user
    reported: "I clicked Fix on 4 medium prompt-contract findings,
    re-scanned, and they came right back." That's the CORRECT
    behaviour — the prompt text wasn't changed, so the analyzer
    rightly re-flags it. Confirming it here so a future refactor
    can't quietly reintroduce silent laundering."""
    fp = tmp_path / "agent.py"
    fp.write_text(
        "AGENT_NAME = 'demo'\n"
        "\n"
        + _fence("prompt-contract")
        + "PROMPT = '''Greet the user politely.'''\n",
        encoding="utf-8",
    )
    report = run_scan(tmp_path)
    pc = [f for f in report.findings if f.rule_id == "prompt-contract"]
    assert pc, (
        "prompt-contract finding must survive an auto-inserted fix fence — "
        "the prompt text is unchanged, so the contract checker still "
        "fails"
    )
    assert all(
        e.rule_id != "prompt-contract" for e in report.suppressions.entries
    )
