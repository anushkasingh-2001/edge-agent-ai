"""Tests for the intelligence-mode root-cause analyzers.

Mirrors the existing scanner/tests conventions: build a tiny fixture
repo in tmp_path, run the analyzer, assert on rule_ids. Each test has a
POSITIVE case (rule fires) and a NEGATIVE case (safe pattern does not
fire) so we lock in precision as well as recall.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from edge_agent_scanner.walker import iter_scanned_files
from edge_agent_scanner.ir.builder import build_agent_ir
from edge_agent_scanner.analyzers.root_causes import analyze_root_causes


def _scan(tmp_path: Path) -> list:
    files = iter_scanned_files(tmp_path)
    ir = build_agent_ir(files, repo_root=tmp_path)
    return analyze_root_causes(ir, files)


def _rule_ids(findings) -> set[str]:
    return {f.rule_id for f in findings}


def test_prompt_injection_placeholder_detected(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text(
        "def h(request):\n"
        "    user_text = request.json['text']\n"
        "    prompt = f'You are an assistant. {user_text}'\n"
        "    client.chat.completions.create(messages=[{'role':'user','content':prompt}])\n",
        encoding="utf-8",
    )
    assert "prompt-injection-placeholder" in _rule_ids(_scan(tmp_path))


def test_prompt_injection_placeholder_guarded_not_flagged_high(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text(
        "def h(request):\n"
        "    user_text = sanitize_prompt(request.json['text'])\n"
        "    prompt = f'You are an assistant. {user_text}'\n",
        encoding="utf-8",
    )
    findings = _scan(tmp_path)
    pi = [f for f in findings if f.rule_id == "prompt-injection-placeholder"]
    # With a sanitizer on the path it must NOT be high severity.
    assert all(f.severity != "high" for f in pi)


def test_cypher_injection_detected(tmp_path: Path) -> None:
    (tmp_path / "g.py").write_text(
        "def q(request, session):\n"
        "    name = completion.choices[0].message.content\n"
        "    session.run(f\"MATCH (n) WHERE n.name='{name}' RETURN n\")\n",
        encoding="utf-8",
    )
    assert "cypher-injection-from-llm-or-user" in _rule_ids(_scan(tmp_path))


def test_cypher_parameterized_not_flagged(tmp_path: Path) -> None:
    (tmp_path / "g.py").write_text(
        "def q(request, session):\n"
        "    name = request.json['name']\n"
        "    session.run('MATCH (n) WHERE n.name=$name RETURN n', name=name)\n",
        encoding="utf-8",
    )
    assert "cypher-injection-from-llm-or-user" not in _rule_ids(_scan(tmp_path))


def test_config_controlled_file_read_detected(tmp_path: Path) -> None:
    (tmp_path / "r.py").write_text(
        "import yaml\n"
        "def load(config_file):\n"
        "    config = yaml.safe_load(open(config_file))\n"
        "    path = config['data_path']\n"
        "    return open(path, 'r').read()\n",
        encoding="utf-8",
    )
    assert "config-controlled-file-read" in _rule_ids(_scan(tmp_path))


def test_guarded_file_read_not_flagged(tmp_path: Path) -> None:
    (tmp_path / "r.py").write_text(
        "from pathlib import Path\n"
        "def load(config):\n"
        "    BASE = Path('/data')\n"
        "    p = (BASE / config['name']).resolve()\n"
        "    assert p.is_relative_to(BASE)\n"
        "    return open(p).read()\n",
        encoding="utf-8",
    )
    assert "config-controlled-file-read" not in _rule_ids(_scan(tmp_path))


def test_default_db_credentials_detected(tmp_path: Path) -> None:
    (tmp_path / "db.py").write_text(
        "from neo4j import GraphDatabase\n"
        "driver = GraphDatabase.driver('bolt://x', auth=('neo4j', 'neo4j'))\n",
        encoding="utf-8",
    )
    assert "default-db-credentials" in _rule_ids(_scan(tmp_path))


def test_env_credentials_not_flagged(tmp_path: Path) -> None:
    (tmp_path / "db.py").write_text(
        "import os\n"
        "from neo4j import GraphDatabase\n"
        "driver = GraphDatabase.driver('bolt://x', auth=(os.environ['U'], os.environ['P']))\n",
        encoding="utf-8",
    )
    assert "default-db-credentials" not in _rule_ids(_scan(tmp_path))


def test_env_proxy_mutation_detected(tmp_path: Path) -> None:
    (tmp_path / "e.py").write_text(
        "import os\n"
        "def setup(config):\n"
        "    os.environ['HTTPS_PROXY'] = config['proxy']\n",
        encoding="utf-8",
    )
    assert "env-proxy-mutation" in _rule_ids(_scan(tmp_path))


def test_llm_codegen_to_exec_detected(tmp_path: Path) -> None:
    (tmp_path / "c.py").write_text(
        "def run(prompt):\n"
        "    generated_code = llm.invoke(prompt).content\n"
        "    exec(generated_code)\n",
        encoding="utf-8",
    )
    findings = _scan(tmp_path)
    rules = _rule_ids(findings)
    assert "llm-codegen-to-exec" in rules
    crit = [f for f in findings if f.rule_id == "llm-codegen-to-exec"]
    assert any(f.severity == "critical" for f in crit)


def test_llm_codegen_sandboxed_not_flagged(tmp_path: Path) -> None:
    (tmp_path / "c.py").write_text(
        "from RestrictedPython import compile_restricted\n"
        "def run(prompt):\n"
        "    generated_code = llm.invoke(prompt).content\n"
        "    byte_code = compile_restricted(generated_code, '<inline>', 'exec')\n"
        "    exec(byte_code, {'__builtins__': {}})\n",
        encoding="utf-8",
    )
    assert "llm-codegen-to-exec" not in _rule_ids(_scan(tmp_path))


def test_json_dumps_alone_not_flagged(tmp_path: Path) -> None:
    (tmp_path / "j.py").write_text(
        "import json\n"
        "def export(data):\n"
        "    return json.dumps(data)\n",
        encoding="utf-8",
    )
    # None of the new root-cause rules should fire on a pure transform.
    assert _rule_ids(_scan(tmp_path)) == set()


def test_tempfile_cleanup_not_flagged(tmp_path: Path) -> None:
    (tmp_path / "t.py").write_text(
        "import tempfile, os\n"
        "def work():\n"
        "    with tempfile.NamedTemporaryFile(delete=False) as tf:\n"
        "        tf.write(b'x')\n"
        "        p = tf.name\n"
        "    os.unlink(p)\n",
        encoding="utf-8",
    )
    assert _rule_ids(_scan(tmp_path)) == set()
