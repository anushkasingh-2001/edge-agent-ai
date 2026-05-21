from __future__ import annotations

from pathlib import Path
from pydantic import BaseModel

from edge_agent_scanner.harness.config import load_evals_config
from edge_agent_scanner.harness.docker_runner import DockerSandbox, DockerSandboxError


class SandboxResult(BaseModel):
    ok: bool
    message: str
    logs: str = ""


def create_harness_from_repo(repo_path: Path):
    config = load_evals_config(repo_path)
    if config is None:
        raise DockerSandboxError("No .edgeagent/evals.yaml found. Run auto-harness discovery or add config manually.")
    return DockerSandbox(repo_path, config)


def run_in_sandbox_placeholder(*_args, **_kwargs) -> SandboxResult:
    return SandboxResult(
        ok=False,
        message="Use create_harness_from_repo(repo_path) for Docker-based behavioral execution.",
    )
