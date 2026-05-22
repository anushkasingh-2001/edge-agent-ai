"""Accuracy-regression analyzer model-config title contract.

Before the fix, every model configuration line — even on a single,
first-time scan with no baseline — produced a finding titled
"Model configuration changed". That title implies a diff that
doesn't exist (the analyzer has no baseline to compare against).

Contract:

  * Single ``model="x"`` binding → ``"Model configuration detected"``.
  * Two distinct models in the same file → ``"Model configuration
    changed"`` (the file itself records an in-repo diff) and the
    evidence carries ``(old=..., new=...)``.
  * Comment lines mentioning ``model=`` must not produce findings.
  * Prompt-contract title is sharper when the prompt mentions
    action-taking tool names but lacks an approval policy.
"""

from __future__ import annotations

from edge_agent_scanner.engine import run_scan


def _scan(tmp_path, name: str, body: str):
    (tmp_path / name).write_text(body, encoding="utf-8")
    return run_scan(tmp_path)


def _accuracy(report) -> list:
    return [f for f in report.findings if f.rule_id == "accuracy-regression-risk"]


def test_single_model_binding_titled_as_detected(tmp_path) -> None:
    body = (
        "from openai import OpenAI\n"
        "client = OpenAI()\n"
        "response = client.responses.create(model='gpt-5-mini', input='hi')\n"
    )
    report = _scan(tmp_path, "agent.py", body)
    accuracy = _accuracy(report)
    model_findings = [f for f in accuracy if "model" in f.title.lower()]
    assert model_findings, "expected an accuracy finding for the model binding"
    f = model_findings[0]
    assert f.title == "Model configuration detected", (
        f"single-scan model binding must use 'detected' title; got {f.title!r}"
    )


def test_two_distinct_models_in_same_file_titled_as_changed(tmp_path) -> None:
    body = (
        "from openai import OpenAI\n"
        "client = OpenAI()\n"
        "# fast path\n"
        "fast = client.responses.create(model='gpt-4o-mini', input='hi')\n"
        "slow = client.responses.create(model='gpt-5-mini', input='hi')\n"
    )
    report = _scan(tmp_path, "agent.py", body)
    changed = [f for f in _accuracy(report) if f.title == "Model configuration changed"]
    assert changed, (
        "two distinct model literals in the same file must promote at least "
        "one finding's title to 'Model configuration changed'"
    )
    # Evidence carries the old/new pair so the developer can see the diff.
    f = changed[0]
    assert "old=" in f.evidence and "new=" in f.evidence, (
        f"changed-title finding must carry old=/new= in evidence; got {f.evidence!r}"
    )


def test_comment_line_with_model_keyword_does_not_produce_finding(tmp_path) -> None:
    body = (
        "# we should pin model='gpt-5-mini' eventually\n"
        "// model: 'gpt-5-mini'\n"
        "def f():\n"
        "    pass\n"
    )
    report = _scan(tmp_path, "notes.py", body)
    accuracy = _accuracy(report)
    assert not [f for f in accuracy if "model" in f.title.lower()], (
        f"comments must not produce model-config findings; got: {[f.title for f in accuracy]}"
    )


def test_typescript_model_string_literal_classifies(tmp_path) -> None:
    body = (
        "import OpenAI from 'openai';\n"
        "const client = new OpenAI();\n"
        "const reply = await client.responses.create({ model: 'gpt-5-mini', input: 'hi' });\n"
    )
    report = _scan(tmp_path, "agent.ts", body)
    accuracy = _accuracy(report)
    model_findings = [f for f in accuracy if "model" in f.title.lower()]
    assert model_findings, "TS object-literal `model: '...'` should still classify"
    assert model_findings[0].title == "Model configuration detected"


# ---------------------------------------------------------------------------
# Prompt contract sharpening (action-taking prompts)
# ---------------------------------------------------------------------------

def test_action_taking_prompt_without_approval_uses_specific_title(tmp_path) -> None:
    body = (
        "SYSTEM_PROMPT = (\n"
        "    'You are Ava, an AI Sales Development Assistant. '\n"
        "    'Use the create_cadence tool to launch outreach campaigns. '\n"
        "    'Use add_contacts_to_cadence when adding prospects. '\n"
        "    'Return JSON with a status field.'\n"
        ")\n"
    )
    report = _scan(tmp_path, "prompts.py", body)
    prompt_findings = [f for f in report.findings if f.rule_id == "prompt-contract"]
    assert prompt_findings, "expected a prompt-contract finding for an action-taking prompt"
    titles = [f.title for f in prompt_findings]
    assert any("approval policy" in t.lower() for t in titles), (
        f"action-taking prompt without approval must surface the sharper title; "
        f"got: {titles}"
    )


def test_generic_prompt_without_approval_uses_default_title(tmp_path) -> None:
    body = (
        "SYSTEM_PROMPT = 'You are a helpful assistant.'\n"
    )
    report = _scan(tmp_path, "prompts.py", body)
    prompt_findings = [f for f in report.findings if f.rule_id == "prompt-contract"]
    # Could be empty (only 3+ missing concepts fire); if any fire,
    # they should use the default "underspecified" wording.
    for f in prompt_findings:
        assert "underspecified" in f.title.lower()
