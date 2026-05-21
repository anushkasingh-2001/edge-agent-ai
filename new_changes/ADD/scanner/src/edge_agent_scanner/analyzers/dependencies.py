from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from packaging.requirements import InvalidRequirement, Requirement

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.ir.models import CodeLocation
from edge_agent_scanner.walker import ScannedFile


def _run_osv(repo_root: Path):
    if not shutil.which("osv-scanner"):
        return []
    try:
        proc = subprocess.run(
            ["osv-scanner", "--format", "json", "--recursive", str(repo_root)],
            check=False,
            capture_output=True,
            text=True,
            timeout=90,
        )
        data = json.loads(proc.stdout or "{}")
        return data.get("results") or []
    except Exception:
        return []


def _analyze_requirements(files: list[ScannedFile]):
    findings = []
    for sf in files:
        if not sf.rel_path.lower().endswith("requirements.txt"):
            continue
        for i, line in enumerate(sf.lines, start=1):
            raw = line.strip()
            if not raw or raw.startswith("#") or raw.startswith("-r"):
                continue
            try:
                req = Requirement(raw)
            except InvalidRequirement:
                continue
            specs = list(req.specifier)
            exact_pinned = any(s.operator == "==" for s in specs)
            compatible_pinned = any(s.operator == "~=" for s in specs)
            if not exact_pinned and not compatible_pinned:
                findings.append(
                    make_finding(
                        rule_id="dependency-risks",
                        severity="low",
                        category="Dependencies",
                        title=f"Unpinned dependency: {req.name}",
                        location=CodeLocation(file=sf.rel_path, start_line=i, end_line=i, symbol=req.name),
                        reason="Dependency is not exactly pinned or compatible-release pinned. Parsed with packaging.Requirement, so extras like [srv] are handled correctly.",
                        suggested_fix="Pin production dependencies with == or use a lockfile. Consider hashes for high-integrity builds.",
                        evidence=raw,
                        code=raw,
                        confidence=0.78,
                    )
                )
    return findings


def analyze_dependencies(repo_root: Path, files: list[ScannedFile]):
    findings = _analyze_requirements(files)
    for result in _run_osv(repo_root):
        for pkg in result.get("packages", []) or []:
            package = pkg.get("package", {}) or {}
            name = package.get("name") or "dependency"
            vulns = pkg.get("vulnerabilities") or []
            for v in vulns:
                findings.append(
                    make_finding(
                        rule_id="dependency-risks",
                        severity="high",
                        category="Dependencies",
                        title=f"Known vulnerable dependency: {name}",
                        location=CodeLocation(file=str(result.get("source", {}).get("path") or "dependency manifest"), start_line=1, end_line=1, symbol=name),
                        reason="OSV-Scanner reported a known vulnerability for this dependency.",
                        suggested_fix="Upgrade to a fixed version, remove the dependency, or apply the upstream mitigation.",
                        evidence=str(v.get("id") or v.get("summary") or "OSV vulnerability"),
                        confidence=0.92,
                    )
                )
    return findings
