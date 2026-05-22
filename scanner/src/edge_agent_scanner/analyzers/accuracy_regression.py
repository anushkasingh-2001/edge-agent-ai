from __future__ import annotations

import re
from pathlib import Path

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.finding_explanations import (
    accuracy_regression_explanation,
    format_reason,
)
from edge_agent_scanner.ir.models import AgentIR, CodeLocation
from edge_agent_scanner.walker import ScannedFile

# Each entry is ``(pattern, reason)``. Patterns intentionally include
# both Python (``model="x"``) and TS/JS (``model: "x"``) shapes so a
# config object literal still classifies, but the comment-line pre-filter
# below stops a sentence like ``# we should set model = "gpt-4"`` from
# producing a spurious finding.
RISK_PATTERNS = [
    (re.compile(r"\btemperature\s*[:=]\s*(0\.[7-9]|1(\.0)?)"), "High temperature on agent/model call"),
    (re.compile(r"\b(model|model_name|modelName)\s*[:=]\s*['\"][^'\"]+['\"]"), "Model selection detected"),
    (re.compile(r"\b(top_k|topK)\s*[:=]\s*\d+"), "Retriever top_k detected"),
    (re.compile(r"\b(output_schema|response_format|json_schema|outputFormat|responseFormat)\s*[:=]"), "Output schema detected"),
]

# Lines that begin with a single-line comment marker can mention the
# same keywords without being real configuration — pre-filter them.
_COMMENT_LINE_RX = re.compile(r"^\s*(#|//|/\*|\*[^/]?|\*/)")


def _is_comment_line(line: str) -> bool:
    return bool(_COMMENT_LINE_RX.match(line))


def analyze_accuracy_regression(ir: AgentIR, files: list[ScannedFile], repo_root: Path):
    findings = []
    # Track per-file (model_name, line) so we can detect a true
    # in-repo configuration change (multiple models bound). Without a
    # baseline scan to compare against, "changed" is honest only when
    # the SAME file actually declares more than one distinct model
    # value (e.g. a refactor that swapped providers). Anything else
    # surfaces as "Model configuration detected".
    models_per_file: dict[str, list[tuple[str, int, str]]] = {}

    for sf in files:
        if not sf.rel_path.endswith((".py", ".ts", ".tsx", ".js", ".jsx")):
            continue
        for i, line in enumerate(sf.lines, start=1):
            if _is_comment_line(line):
                continue
            for rx, reason in RISK_PATTERNS:
                m = rx.search(line)
                if not m:
                    continue
                expl = accuracy_regression_explanation(signal=reason, code_line=line)
                title = expl.title or reason
                # If this is a model-config signal, record the bound
                # model name so the post-pass can promote the title
                # to "Model configuration changed" when multiple
                # distinct models appear in the same file.
                if "model" in reason.lower():
                    mm = re.search(r"['\"]([^'\"]+)['\"]", line)
                    if mm:
                        models_per_file.setdefault(sf.rel_path, []).append(
                            (mm.group(1), i, line.strip())
                        )
                findings.append(
                    make_finding(
                        rule_id="accuracy-regression-risk",
                        severity="low",
                        category="Accuracy / quality risk",
                        title=title,
                        location=CodeLocation(file=sf.rel_path, start_line=i, end_line=i),
                        reason=format_reason(expl),
                        suggested_fix=expl.suggested_fix,
                        evidence=f"Configuration signal: {line.strip()[:200]}",
                        code=line,
                        confidence=0.45,
                    )
                )

    # Promote "detected" → "changed" when the same file binds more
    # than one distinct model literal — that's an in-repo diff we can
    # observe without an external baseline. Cross-scan baseline diffing
    # remains a TODO and would override this title from a higher layer.
    for path, entries in models_per_file.items():
        distinct = {name for name, _, _ in entries}
        if len(distinct) <= 1:
            continue
        old_model, new_model = sorted(distinct)[0], sorted(distinct)[-1]
        for f in findings:
            if f.file == path and f.title == "Model configuration detected":
                f.title = "Model configuration changed"
                f.evidence = (
                    f"Configuration signal: {f.code.strip()[:200]} "
                    f"(old={old_model}, new={new_model})"
                )
    return findings
