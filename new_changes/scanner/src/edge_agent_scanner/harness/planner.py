from __future__ import annotations

from pathlib import Path
from pydantic import BaseModel, Field

from edge_agent_scanner.harness.detector import DetectedProject, detect_project


class HarnessPlan(BaseModel):
    status: str
    project_type: str
    install_command: str | None = None
    start_command: str | None = None
    candidate_ports: list[int] = Field(default_factory=list)
    candidate_chat_urls: list[str] = Field(default_factory=list)
    message: str
    detected: DetectedProject


def build_harness_plan(repo_path: Path) -> HarnessPlan:
    detected = detect_project(repo_path)
    start_command = detected.candidate_start_commands[0] if detected.candidate_start_commands else None
    install_command = detected.candidate_install_commands[0] if detected.candidate_install_commands else None

    ports = detected.candidate_ports or [8000, 3000]
    urls: list[str] = []
    for port in ports:
        urls.extend([
            f"http://127.0.0.1:{port}/chat",
            f"http://127.0.0.1:{port}/api/chat",
            f"http://127.0.0.1:{port}/invoke",
            f"http://127.0.0.1:{port}/run",
        ])

    status = "auto_detected" if start_command else "failed"
    return HarnessPlan(
        status=status,
        project_type=detected.project_type,
        install_command=install_command,
        start_command=start_command,
        candidate_ports=ports,
        candidate_chat_urls=urls,
        message=(
            "Candidate harness detected. Review before running in sandbox."
            if start_command
            else "Could not infer how to start this repo. Add .edgeagent/evals.yaml manually."
        ),
        detected=detected,
    )
