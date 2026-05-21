from __future__ import annotations

import json
from pathlib import Path
from pydantic import BaseModel, Field


class ProjectSignal(BaseModel):
    kind: str
    file: str
    value: str
    confidence: float = 0.5


class DetectedProject(BaseModel):
    project_type: str = "unknown"
    signals: list[ProjectSignal] = Field(default_factory=list)
    candidate_install_commands: list[str] = Field(default_factory=list)
    candidate_start_commands: list[str] = Field(default_factory=list)
    candidate_ports: list[int] = Field(default_factory=list)


def detect_project(repo_path: Path) -> DetectedProject:
    repo = repo_path.resolve()
    detected = DetectedProject()

    package_json = repo / "package.json"
    if package_json.exists():
        try:
            data = json.loads(package_json.read_text(encoding="utf-8"))
            scripts = data.get("scripts", {})
            detected.project_type = "node"
            detected.signals.append(ProjectSignal(kind="manifest", file="package.json", value="Node/JS project", confidence=0.9))
            if "dev" in scripts:
                detected.candidate_start_commands.append("npm run dev")
            if "start" in scripts:
                detected.candidate_start_commands.append("npm start")
            detected.candidate_install_commands.append("npm install")
            detected.candidate_ports.extend([3000, 5173, 8080])
        except Exception:
            pass

    if (repo / "requirements.txt").exists() or (repo / "pyproject.toml").exists():
        if detected.project_type == "unknown":
            detected.project_type = "python"
        detected.signals.append(ProjectSignal(kind="manifest", file="requirements.txt/pyproject.toml", value="Python project", confidence=0.85))
        if (repo / "requirements.txt").exists():
            detected.candidate_install_commands.append("pip install -r requirements.txt")
        if (repo / "app.py").exists():
            detected.candidate_start_commands.append("python app.py")
            detected.candidate_start_commands.append("streamlit run app.py")
        if (repo / "main.py").exists():
            detected.candidate_start_commands.append("python main.py")
            detected.candidate_start_commands.append("uvicorn main:app --host 127.0.0.1 --port 8000")
        detected.candidate_ports.extend([8000, 8501, 5000])

    if (repo / "Dockerfile").exists():
        detected.signals.append(ProjectSignal(kind="container", file="Dockerfile", value="Dockerized app", confidence=0.75))

    if (repo / "docker-compose.yml").exists() or (repo / "compose.yml").exists():
        detected.signals.append(ProjectSignal(kind="container", file="docker-compose.yml/compose.yml", value="Compose app", confidence=0.8))
        detected.candidate_start_commands.append("docker compose up --build")

    detected.candidate_install_commands = list(dict.fromkeys(detected.candidate_install_commands))
    detected.candidate_start_commands = list(dict.fromkeys(detected.candidate_start_commands))
    detected.candidate_ports = list(dict.fromkeys(detected.candidate_ports))
    return detected
