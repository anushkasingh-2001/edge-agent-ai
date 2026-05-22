from __future__ import annotations

import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from edge_agent_scanner.harness.config import EvalHarnessConfig, choose_image, guess_container_port
from edge_agent_scanner.harness.http_harness import HttpBehavioralHarness
from edge_agent_scanner.harness.ports import find_free_port


class DockerSandboxError(RuntimeError):
    pass


def _run(cmd: list[str], timeout: int = 120, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise DockerSandboxError(
            f"Command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    return proc


def _copy_repo(src: Path, dst: Path) -> None:
    ignore = shutil.ignore_patterns(
        ".git", "node_modules", ".next", "dist", "build",
        "__pycache__", ".venv", "venv", ".edgeagent/tmp",
    )
    shutil.copytree(src, dst, ignore=ignore)


def _docker_safe_start_command(cmd: str) -> str:
    return (
        cmd.replace("--host 127.0.0.1", "--host 0.0.0.0")
        .replace("--host localhost", "--host 0.0.0.0")
        .replace("127.0.0.1:8000", "0.0.0.0:8000")
        .replace("localhost:8000", "0.0.0.0:8000")
    )



class DockerSandbox:
    def __init__(self, repo_path: Path, config: EvalHarnessConfig):
        self.repo_path = repo_path.resolve()
        self.config = config
        self.container_name = f"edgeagent-{uuid.uuid4().hex[:12]}"
        self.temp_dir: tempfile.TemporaryDirectory | None = None
        self.workspace: Path | None = None
        self.host_port: int | None = None
        self.container_port: int = guess_container_port(config)

    def __enter__(self) -> HttpBehavioralHarness:
        if not shutil.which("docker"):
            raise DockerSandboxError("Docker CLI is not installed or not on PATH.")

        self.temp_dir = tempfile.TemporaryDirectory(prefix="edgeagent-sandbox-")
        tmp_root = Path(self.temp_dir.name)
        self.workspace = tmp_root / "workspace"
        _copy_repo(self.repo_path, self.workspace)

        if self.config.sandbox.network == "none":
            raise DockerSandboxError('HTTP behavioral tests require sandbox.network != "none" so the harness can reach the app.')

        image = choose_image(self.repo_path, self.config)
        self.host_port = find_free_port()

        docker_run = [
            "docker", "run", "-d", "--rm",
            "--name", self.container_name,
            "--memory", self.config.sandbox.memory,
            "--cpus", self.config.sandbox.cpus,
            "-w", "/workspace",
            "-v", f"{self.workspace}:/workspace",
            "-p", f"127.0.0.1:{self.host_port}:{self.container_port}",
        ]


        for key, value in self.config.sandbox.env.items():
            docker_run.extend(["-e", f"{key}={value}"])

        docker_run.extend([image, "sh", "-lc", "sleep infinity"])
        _run(docker_run, timeout=60)

        if self.config.app.install_command:
            _run(["docker", "exec", self.container_name, "sh", "-lc", self.config.app.install_command],
                 timeout=self.config.sandbox.timeout_seconds)

        if not self.config.app.start_command:
            raise DockerSandboxError("No start_command configured.")

        start_command = _docker_safe_start_command(self.config.app.start_command)
        _run(["docker", "exec", "-d", self.container_name, "sh", "-lc", start_command], timeout=15)

        self._wait_for_startup()
        chat_url = self._rewrite_url(self.config.app.chat_url or f"http://127.0.0.1:{self.container_port}/chat")
        return HttpBehavioralHarness(self.config, chat_url=chat_url, run_id=self.container_name)

    def __exit__(self, exc_type, exc, tb):
        try:
            _run(["docker", "rm", "-f", self.container_name], timeout=20, check=False)
        finally:
            if self.temp_dir:
                self.temp_dir.cleanup()

    def _rewrite_url(self, url: str) -> str:
        assert self.host_port is not None
        return (
            url.replace(f":{self.container_port}", f":{self.host_port}")
            .replace("0.0.0.0", "127.0.0.1")
            .replace("localhost", "127.0.0.1")
        )

    def _wait_for_startup(self) -> None:
        import urllib.request

        deadline = time.time() + self.config.sandbox.startup_timeout_seconds
        urls = []
        if self.config.app.health_url:
            urls.append(self._rewrite_url(self.config.app.health_url))
        if self.config.app.chat_url:
            urls.append(self._rewrite_url(self.config.app.chat_url))

        if not urls:
            time.sleep(3)
            return

        last_error = None
        while time.time() < deadline:
            for url in urls:
                try:
                    with urllib.request.urlopen(url, timeout=2):
                        return
                except Exception as exc:
                    last_error = exc
            time.sleep(1)

        if self.config.app.chat_url:
            return

        logs = _run(["docker", "logs", self.container_name], timeout=10, check=False)
        raise DockerSandboxError(f"App did not become healthy. Last error: {last_error}\nLogs:\n{logs.stdout}\n{logs.stderr}")
