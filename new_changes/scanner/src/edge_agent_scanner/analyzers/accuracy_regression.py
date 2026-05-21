from __future__ import annotations

import re
from pathlib import Path

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.ir.models import AgentIR, CodeLocation
from edge_agent_scanner.walker import ScannedFile

RISK_PATTERNS = [
    (re.compile(r"temperature\s*=\s*(0\.[7-9]|1(\.0)?)"), "High temperature on agent/model call"),
    (re.compile(r"(model|model_name)\s*=\s*['\"][^'\"]+['\"]"), "Model selection changed or configured"),
    (re.compile(r"(top_k|k)\s*=\s*\d+"), "Retriever top_k changed or configured"),
    (re.compile(r"(output_schema|response_format|json_schema)\s*="), "Output schema changed or configured"),
]


def analyze_accuracy_regression(ir: AgentIR, files: list[ScannedFile], repo_root: Path):
    findings = []
    for sf in files:
        if not sf.rel_path.endswith((".py", ".ts", ".tsx", ".js", ".jsx")):
            continue
        for i, line in enumerate(sf.lines, start=1):
            for rx, reason in RISK_PATTERNS:
                if rx.search(line):
                    findings.append(
                        make_finding(
                            rule_id="accuracy-regression-risk",
                            severity="low",
                            category="Accuracy risk",
                            title=reason,
                            location=CodeLocation(file=sf.rel_path, start_line=i, end_line=i),
                            reason="Static accuracy-risk signal. This does not prove accuracy dropped; it means behavioral evals should cover this change.",
                            suggested_fix="Run accuracy and regression behavioral suites. Add or update gold examples for this affected workflow.",
                            evidence=line.strip(),
                            code=line,
                            confidence=0.45,
                        )
                    )
    return findings
