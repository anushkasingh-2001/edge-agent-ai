from __future__ import annotations

from pathlib import Path
from typing import Any, Literal
from pydantic import BaseModel, Field


class AppHarnessConfig(BaseModel):
    kind: Literal["http", "cli"] = "http"
    install_command: str | None = None
    start_command: str | None = None
    health_url: str | None = None
    chat_url: str | None = None
    method: Literal["POST", "GET"] = "POST"
    input_template: dict[str, Any] = Field(default_factory=lambda: {"message": "{{prompt}}"})
    output_path: str | None = "response"
    container_port: int | None = None


class SandboxConfig(BaseModel):
    image: str | None = None
    network: Literal["bridge", "none", "limited"] = "bridge"
    timeout_seconds: int = 120
    startup_timeout_seconds: int = 30
    memory: str = "1g"
    cpus: str = "1.0"
    mock_dangerous_tools: bool = False
    # Per-category opt-in: categories the operator asserts are mocked/intercepted
    # in the target app (e.g. ["email_send", "payment"]). When mock_dangerous_tools
    # is true, all categories are considered mocked regardless of this list.
    mocked_categories: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)


class RuntimeConfig(BaseModel):
    max_p95_ms: int = 3000
    max_error_rate: float = 0.02
    concurrency: list[int] = Field(default_factory=lambda: [1, 5, 10])


class BehavioralConfig(BaseModel):
    suites: list[str] = Field(default_factory=list)
    runtime: RuntimeConfig = Field(default_factory=RuntimeConfig)


class EvalHarnessConfig(BaseModel):
    app: AppHarnessConfig = Field(default_factory=AppHarnessConfig)
    sandbox: SandboxConfig = Field(default_factory=SandboxConfig)
    behavioral: BehavioralConfig = Field(default_factory=BehavioralConfig)


def load_evals_config(repo_path: Path) -> EvalHarnessConfig | None:
    path = repo_path / ".edgeagent" / "evals.yaml"
    if not path.exists():
        path = repo_path / ".edgeagent" / "evals.yml"
    if not path.exists():
        return None
    try:
        import yaml
    except Exception as exc:
        raise RuntimeError("PyYAML is required to read .edgeagent/evals.yaml") from exc
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return EvalHarnessConfig.model_validate(data)


def guess_container_port(config: EvalHarnessConfig) -> int:
    if config.app.container_port:
        return config.app.container_port
    for url in [config.app.chat_url, config.app.health_url]:
        if not url:
            continue
        for port in [8000, 3000, 5173, 8501, 5000, 8080]:
            if f":{port}" in url:
                return port
    cmd = config.app.start_command or ""
    for port in [8000, 3000, 5173, 8501, 5000, 8080]:
        if str(port) in cmd:
            return port
    return 8000


def choose_image(repo_path: Path, config: EvalHarnessConfig) -> str:
    if config.sandbox.image:
        return config.sandbox.image
    if (repo_path / "package.json").exists():
        return "node:20-bookworm-slim"
    return "python:3.11-slim"
