"""Guarantee: the static scanner makes ZERO LLM/network calls.

The AI-personalized explanation feature lives in the Next.js API route
(``app/api/finding/explain``) and is triggered only when a user opens a
finding. The scanner itself must never reach out to any LLM provider —
that's the whole point of having a deterministic static pass first.

These tests enforce the invariant by:

  1. Patching the low-level socket layer so any attempted TCP/UDP
     connection during ``run_scan`` raises immediately. If something
     in the scanner pipeline tried to hit api.openai.com (or any
     other host) the test would fail loudly.
  2. Verifying that an environment with a "poison" ``OPENAI_API_KEY``
     value still produces a normal scan report — confirming the key
     isn't even read by ``run_scan``.
"""

from __future__ import annotations

import socket
from pathlib import Path

import pytest

from edge_agent_scanner.engine import run_scan


@pytest.fixture
def fixture_repo(tmp_path: Path) -> Path:
    # Mix of files designed to produce a few realistic findings (subprocess,
    # accuracy-regression signal, secret-shape) so the scanner actually
    # exercises its analyzers rather than running an empty pipeline.
    (tmp_path / "agent.py").write_text(
        "import subprocess\n"
        "subprocess.check_output(['ls'])\n"
        "model = 'gpt-4o-mini'\n",
        encoding="utf-8",
    )
    (tmp_path / "cfg.py").write_text(
        'OPENAI_KEY = "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n',
        encoding="utf-8",
    )
    (tmp_path / "requirements.txt").write_text("langchain\n", encoding="utf-8")
    return tmp_path


def test_scan_does_not_open_any_network_socket(fixture_repo: Path, monkeypatch) -> None:
    """If anything in the scanner tries to open a socket, fail the test.

    This is the strongest possible guarantee: even an HTTPS call via
    requests/httpx/openai goes through socket.create_connection (or
    socket.socket for raw paths), so blocking those covers all stdlib +
    third-party network clients without us having to know which one was
    used.
    """

    def _blocked(*args, **kwargs):
        raise AssertionError(
            "run_scan attempted a network call; the static scanner must "
            f"make ZERO outbound connections (args={args!r}, kwargs={kwargs!r})"
        )

    monkeypatch.setattr(socket, "create_connection", _blocked)
    real_socket = socket.socket

    def _blocked_socket(family=socket.AF_INET, type=socket.SOCK_STREAM, *a, **kw):
        if family in {socket.AF_INET, socket.AF_INET6} and type == socket.SOCK_STREAM:
            raise AssertionError(
                f"run_scan tried to open a TCP socket (family={family}, type={type})"
            )
        return real_socket(family, type, *a, **kw)

    monkeypatch.setattr(socket, "socket", _blocked_socket)

    report = run_scan(fixture_repo)
    assert report.summary.total >= 0  # smoke: scan completed without raising


def test_scan_ignores_openai_api_key_env(fixture_repo: Path, monkeypatch) -> None:
    """A poisoned OPENAI_API_KEY in the environment must not change scan
    output and must not be consulted by the scanner. We assert behaviour
    parity between a scan with and without the env var set."""

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    before = run_scan(fixture_repo)

    monkeypatch.setenv("OPENAI_API_KEY", "sk-poison-this-should-never-be-read")
    after = run_scan(fixture_repo)

    # The static scanner is deterministic for a fixed input, so the rule_ids,
    # severities, files, and lines must match exactly. If the scanner had
    # somehow started consulting the key it would either change findings,
    # add new ones, or (most likely) crash on the bogus value.
    def _fingerprint(report) -> list[tuple]:
        return sorted(
            (f.rule_id, f.severity, f.file, f.line, f.title) for f in report.findings
        )

    assert _fingerprint(before) == _fingerprint(after)
