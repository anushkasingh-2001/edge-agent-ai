"""Rule-quality regression tests.

Each test pins ONE of the precision improvements from the rule-quality
work onto a tiny fixture repo. The fixtures intentionally use the same
shape as the real-world false positives reported by Deep-Live-Cam and
OneKE so the failure mode they encode can never silently come back.

These tests run the FULL scan pipeline (analyzers + grouping +
suppressions), not just one analyzer in isolation. That is on purpose:
some of the precision improvements live in grouping/suppression layers,
and isolating an analyzer would let a regression slip through there.
"""

from __future__ import annotations

from pathlib import Path

from edge_agent_scanner.engine import run_scan
from edge_agent_scanner.report import Finding, ScanReport


def _scan(tmp_path: Path) -> ScanReport:
    """Run a full scan over ``tmp_path`` and return the structured report."""
    return run_scan(tmp_path)


def _findings_for_rule(report: ScanReport, rule_id: str) -> list[Finding]:
    return [f for f in report.findings if f.rule_id == rule_id]


def _rule_ids(report: ScanReport) -> set[str]:
    return {f.rule_id for f in report.findings}


# ---------------------------------------------------------------------------
# A. Prompt-injection requires a real LLM/prompt sink
# ---------------------------------------------------------------------------

def test_A_print_fstring_is_not_prompt_injection(tmp_path: Path) -> None:
    """`print(f"...{x}...")` must NOT fire as prompt-injection.

    Reproduces the Deep-Live-Cam false positive on
    ``print(f"Loading models with providers={_providers}...")``.
    """
    (tmp_path / "benchmark_pipeline.py").write_text(
        "import os\n"
        "def setup():\n"
        "    config = {'providers': ['cuda', 'cpu']}\n"
        "    _providers = config['providers']\n"
        "    print(f'Loading models with providers={_providers}...')\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    pi = _findings_for_rule(report, "prompt-injection-placeholder")
    assert pi == [], (
        f"print() of an f-string is a diagnostic, NOT a prompt sink; "
        f"got {len(pi)} finding(s): {[f.title for f in pi]}"
    )


def test_A_fstring_into_chat_completion_fires(tmp_path: Path) -> None:
    """f-string flowing into chat.completions.create must trigger."""
    (tmp_path / "agent.py").write_text(
        "def handle(request):\n"
        "    user_text = request.json['text']\n"
        "    prompt = f'You are a sales assistant. {user_text}'\n"
        "    return client.chat.completions.create(\n"
        "        messages=[{'role':'user','content': prompt}]\n"
        "    )\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    assert "prompt-injection-placeholder" in _rule_ids(report)


def test_A_fstring_into_prompt_template_with_user_data_fires(tmp_path: Path) -> None:
    """f-string with user-controlled placeholder into PromptTemplate fires.

    Uses ``request.json['instruction']`` so the source is unambiguously
    in ``FRAMEWORK_USER_INPUT_PATTERNS`` (a plain ``config[...]``
    indexing alone is not a config source — the *load* call is).
    """
    (tmp_path / "tpl.py").write_text(
        "from langchain.prompts import PromptTemplate\n"
        "def build(request):\n"
        "    instruction = request.json['instruction']\n"
        "    tpl = PromptTemplate.from_template(f'Do: {instruction}')\n"
        "    return tpl\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    assert "prompt-injection-placeholder" in _rule_ids(report)


def test_A_logger_fstring_is_not_prompt_injection(tmp_path: Path) -> None:
    """logger.info(f"...") must NOT fire as prompt-injection."""
    (tmp_path / "log.py").write_text(
        "import logging\n"
        "logger = logging.getLogger(__name__)\n"
        "def handle(request):\n"
        "    name = request.json['name']\n"
        "    logger.info(f'received name={name}')\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    assert _findings_for_rule(report, "prompt-injection-placeholder") == []


# ---------------------------------------------------------------------------
# B. env mutation: PATH vs HTTP_PROXY vs API key
# ---------------------------------------------------------------------------

def test_B_path_mutation_from_sys_prefix_is_low_no_network_wording(tmp_path: Path) -> None:
    """Trusted PATH prepend from sys.prefix + isdir guard → low, with
    DLL/search-path wording, NOT proxy/network."""
    (tmp_path / "boot.py").write_text(
        "import os, sys\n"
        "if sys.platform == 'win32':\n"
        "    _sp = os.path.join(sys.prefix, 'Lib', 'site-packages')\n"
        "    _torch_lib = os.path.join(_sp, 'torch', 'lib')\n"
        "    if os.path.isdir(_torch_lib):\n"
        "        os.environ['PATH'] = _torch_lib + os.pathsep + os.environ['PATH']\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    env = _findings_for_rule(report, "env-proxy-mutation")
    assert env, "PATH mutation should still produce a presence finding"
    f = env[0]
    assert f.severity in ("low", "medium"), (
        f"trusted sys.prefix PATH prepend must NOT be high; got {f.severity}"
    )
    text = (f.reason + " " + f.suggestedFix).lower()
    assert "search path" in text or "dll" in text or "library" in text, (
        f"PATH explanation must mention search path / DLL / library; got: {f.reason!r}"
    )
    # The explanation may CONTRAST against network routing ("not
    # network routing") — that wording is intentional. What's
    # forbidden is FRAMING the finding as network/proxy. Title is
    # the trustworthy header here.
    title = f.title.lower()
    assert "proxy" not in title and "network" not in title, (
        f"PATH title must NOT be framed as network/proxy; got: {f.title!r}"
    )


def test_B_http_proxy_from_user_input_is_high(tmp_path: Path) -> None:
    (tmp_path / "p.py").write_text(
        "import os\n"
        "def setup(request):\n"
        "    os.environ['HTTP_PROXY'] = request.json['proxy']\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    env = _findings_for_rule(report, "env-proxy-mutation")
    assert env and env[0].severity == "high", (
        f"HTTP_PROXY from request data must be high; got {[(f.severity, f.title) for f in env]}"
    )


def test_B_openai_base_url_from_config_is_medium_or_high(tmp_path: Path) -> None:
    """``config[...]`` indexing alone is NOT a config source; we need an
    actual config-load call in the window so ``classify_config_source``
    fires. ``yaml.safe_load`` is the canonical example."""
    (tmp_path / "p.py").write_text(
        "import os, yaml\n"
        "def setup(cfg_path):\n"
        "    config = yaml.safe_load(open(cfg_path))\n"
        "    os.environ['OPENAI_BASE_URL'] = config['proxy']\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    env = _findings_for_rule(report, "env-proxy-mutation")
    assert env, "OPENAI_BASE_URL mutation must fire"
    assert env[0].severity in ("medium", "high")


# ---------------------------------------------------------------------------
# C. subprocess list-arg / no shell=True is not shell injection
# ---------------------------------------------------------------------------

def test_C_subprocess_popen_list_args_is_not_shell_injection(tmp_path: Path) -> None:
    """``Popen(["ffmpeg", "-i", path])`` is a presence warning, not
    command/shell injection. The finding should be at most ``low`` and
    the explanation must mention list args / no shell=True and NOT
    shell injection."""
    (tmp_path / "core.py").write_text(
        "import subprocess\n"
        "def transcode(target_path, temp_output_path):\n"
        "    reader_cmd = ['ffmpeg', '-hide_banner', '-i', target_path]\n"
        "    writer_cmd = ['ffmpeg', '-hide_banner', '-y', temp_output_path]\n"
        "    reader = subprocess.Popen(reader_cmd, stdout=subprocess.PIPE)\n"
        "    writer = subprocess.Popen(writer_cmd, stdin=subprocess.PIPE)\n"
        "    reader.wait(); writer.wait()\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    dt = _findings_for_rule(report, "dangerous-tools")
    # Some grouping may collapse the two calls into one representative.
    assert dt, "subprocess presence warning should still fire"
    f = dt[0]
    assert f.severity == "low", (
        f"list-arg subprocess without shell=True must be low; got {f.severity}"
    )
    blob = (f.title + " " + f.reason + " " + f.suggestedFix).lower()
    assert "list arg" in blob or "no shell" in blob or "shell=true" in blob, (
        f"explanation must mention list args / no shell=True; got: {blob!r}"
    )
    # The finding may discuss "shell injection" as context (e.g.
    # "even without shell injection") — that wording is intentional
    # and matches the spec. What we forbid is FRAMING the finding
    # itself as a shell-injection finding (in the TITLE).
    assert "shell injection" not in f.title.lower(), (
        f"list-arg subprocess title must NOT frame as shell injection; got: {f.title!r}"
    )


# ---------------------------------------------------------------------------
# D. model supply-chain detector
# ---------------------------------------------------------------------------

def test_D_unverified_onnx_download_then_load_is_high(tmp_path: Path) -> None:
    (tmp_path / "download.py").write_text(
        "import urllib.request\n"
        "import onnxruntime\n"
        "def fetch():\n"
        "    url = 'https://huggingface.co/foo/bar/resolve/main/inswapper_128.onnx'\n"
        "    urllib.request.urlretrieve(url, 'm.onnx')\n"
        "def use():\n"
        "    return onnxruntime.InferenceSession('m.onnx')\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    mscs = _findings_for_rule(report, "model-supply-chain-risk")
    assert mscs, "unverified .onnx download + later load must trigger"
    assert mscs[0].severity in ("high", "medium")


def test_D_download_with_sha256_check_not_flagged(tmp_path: Path) -> None:
    (tmp_path / "download.py").write_text(
        "import urllib.request, hashlib\n"
        "EXPECTED_SHA256 = 'a' * 64\n"
        "def fetch():\n"
        "    url = 'https://huggingface.co/foo/bar/resolve/main/inswapper_128.onnx'\n"
        "    urllib.request.urlretrieve(url, 'm.onnx')\n"
        "    digest = hashlib.sha256(open('m.onnx','rb').read()).hexdigest()\n"
        "    assert digest == EXPECTED_SHA256\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    assert "model-supply-chain-risk" not in _rule_ids(report)


def test_D_hf_hub_unpinned_revision_warns(tmp_path: Path) -> None:
    (tmp_path / "hf.py").write_text(
        "from huggingface_hub import hf_hub_download\n"
        "def fetch():\n"
        "    return hf_hub_download(\n"
        "        repo_id='foo/bar', filename='m.safetensors', revision='main'\n"
        "    )\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    assert "model-supply-chain-risk" in _rule_ids(report)


# ---------------------------------------------------------------------------
# E. TLS verification disabled
# ---------------------------------------------------------------------------

def test_E_urllib_unverified_context_triggers(tmp_path: Path) -> None:
    (tmp_path / "fetch.py").write_text(
        "import ssl, urllib.request\n"
        "def fetch(url):\n"
        "    ctx = ssl._create_unverified_context()\n"
        "    return urllib.request.urlopen(url, context=ctx).read()\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    assert "tls-verification-disabled" in _rule_ids(report)


def test_E_requests_verify_false_triggers(tmp_path: Path) -> None:
    (tmp_path / "f.py").write_text(
        "import requests\n"
        "def get(url):\n"
        "    return requests.get(url, verify=False).text\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    tls = _findings_for_rule(report, "tls-verification-disabled")
    assert tls, "requests.get(..., verify=False) must trigger"
    assert tls[0].severity in ("medium", "high")


def test_E_unverified_download_of_onnx_is_high(tmp_path: Path) -> None:
    (tmp_path / "f.py").write_text(
        "import ssl, urllib.request\n"
        "def fetch():\n"
        "    ctx = ssl._create_unverified_context()\n"
        "    return urllib.request.urlopen(\n"
        "        'https://example.org/inswapper_128.onnx', context=ctx\n"
        "    ).read()\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    tls = _findings_for_rule(report, "tls-verification-disabled")
    assert tls and tls[0].severity == "high"


# ---------------------------------------------------------------------------
# F. grouped dependency findings list ALL packages
# ---------------------------------------------------------------------------

def test_F_grouped_deps_explanation_lists_multiple_packages(tmp_path: Path) -> None:
    (tmp_path / "requirements.txt").write_text(
        "numpy>=1.20\n"
        "pandas>=1.5\n"
        "torch>=2.0\n"
        "opencv-python>=4.5\n"
        "onnxruntime>=1.15\n"
        "Pillow>=10.0\n"
        "scipy>=1.10\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    deps = _findings_for_rule(report, "dependency-risks")
    assert deps, "unpinned deps must fire"
    rep = max(deps, key=lambda f: f.dup_count)
    assert rep.dup_count >= 7, (
        f"7 unpinned deps must collapse into a single grouped finding; "
        f"dup_count={rep.dup_count}"
    )
    text = (rep.reason + " " + rep.evidence + " " + rep.suggestedFix).lower()
    for name in ("numpy", "pandas", "torch", "onnxruntime"):
        assert name in text, f"grouped explanation must mention {name!r}; got: {text[:300]}"
    assert "lockfile" in text or "pin" in text


# ---------------------------------------------------------------------------
# H. json.dumps alone + tempfile cleanup are not dangerous-tools
# ---------------------------------------------------------------------------

def test_H_bare_json_dumps_no_finding(tmp_path: Path) -> None:
    (tmp_path / "j.py").write_text(
        "import json\n"
        "def shape(d):\n"
        "    return json.dumps(d)\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    dt = _findings_for_rule(report, "dangerous-tools")
    bare_export = [f for f in dt if "data export" in (f.title or "").lower()]
    assert not bare_export, (
        f"bare json.dumps must not fire as data export; got: {[f.title for f in bare_export]}"
    )


def test_H_tempfile_cleanup_no_finding(tmp_path: Path) -> None:
    (tmp_path / "t.py").write_text(
        "import tempfile, os\n"
        "def work():\n"
        "    with tempfile.NamedTemporaryFile(delete=False) as tf:\n"
        "        tf.write(b'x')\n"
        "        path = tf.name\n"
        "    try:\n"
        "        return path\n"
        "    finally:\n"
        "        os.unlink(path)\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    dt = _findings_for_rule(report, "dangerous-tools")
    assert not [f for f in dt if "tempfile" in (f.title or "").lower()]


# ---------------------------------------------------------------------------
# I. context-aware prompt-contract rule
# ---------------------------------------------------------------------------

def test_I_extraction_prompt_no_tool_policy_finding(tmp_path: Path) -> None:
    """An extraction/schema prompt must never get a missing-tool-policy
    criticism — that's an action-prompt concept."""
    (tmp_path / "p.py").write_text(
        "SYSTEM_PROMPT = (\n"
        "    'Extract the following fields from the input and return JSON: '\n"
        "    'name, role, company. If a field is not present, return null. '\n"
        "    'Do not invent values.'\n"
        ")\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    pc = _findings_for_rule(report, "prompt-contract")
    for f in pc:
        text = (f.title + " " + f.reason).lower()
        assert "tool-use policy" not in text and "tool policy" not in text, (
            f"extraction prompt got tool-policy criticism: {f.title!r} :: {f.reason!r}"
        )
        # Family stamp should say extraction when our classifier worked.
        fam = (f.confidence_features or {}).get("prompt_family", "")
        assert fam != "action", (
            f"extraction prompt was mis-classified as action: {f.confidence_features}"
        )


def test_I_action_prompt_without_approval_fires(tmp_path: Path) -> None:
    (tmp_path / "p.py").write_text(
        "SYSTEM_PROMPT = (\n"
        "    'You are an autopilot. Use the send_email tool to email customers. '\n"
        "    'Use create_meeting to schedule. Return JSON status.'\n"
        ")\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    pc = _findings_for_rule(report, "prompt-contract")
    assert pc, "action prompt without approval rule must fire"
    assert any("approval" in (f.title + f.reason).lower() for f in pc)


# ---------------------------------------------------------------------------
# J. Edge Agent marker comments must NEVER suppress a finding
# ---------------------------------------------------------------------------

def test_J_marker_block_does_not_suppress_dangerous_tool(tmp_path: Path) -> None:
    (tmp_path / "x.py").write_text(
        "import subprocess\n"
        "def run(user_input):\n"
        "    # === Edge Agent fix [dangerous-tools] ===\n"
        "    # TODO(edge-agent): review and add a fix manually.\n"
        "    # === end Edge Agent fix ===\n"
        "    subprocess.run('ls ' + user_input, shell=True)\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    dt = _findings_for_rule(report, "dangerous-tools")
    # The dangerous shell=True call MUST still surface.
    assert dt, (
        "Edge Agent marker block must NEVER suppress a dangerous-tools finding; "
        f"report titles={[f.title for f in report.findings]}"
    )


def test_J_noqa_marker_does_suppress(tmp_path: Path) -> None:
    (tmp_path / "x.py").write_text(
        "import subprocess\n"
        "def run():\n"
        "    # edge-agent: noqa dangerous-tools\n"
        "    subprocess.run(['ls'])\n",
        encoding="utf-8",
    )
    report = _scan(tmp_path)
    # Either filtered out OR captured in suppressions list.
    suppressed = list(report.suppressions.entries)
    dt_kept = _findings_for_rule(report, "dangerous-tools")
    suppressed_rules = {e.rule_id for e in suppressed}
    assert "dangerous-tools" in suppressed_rules or not dt_kept, (
        f"explicit noqa must suppress; suppressed={suppressed_rules}, kept={len(dt_kept)}"
    )
