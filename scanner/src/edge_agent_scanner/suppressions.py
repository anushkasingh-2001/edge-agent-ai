"""Per-line finding suppression — for EXPLICIT human opt-outs only.

The scanner intentionally honours ONE marker shape:

    # edge-agent: noqa rule-id[,rule-id...]
    <offending line>

That's a deliberate, hand-typed opt-out — equivalent to `# noqa` in
flake8 / ruff. A developer writes it after reviewing the finding and
deciding "I understand the risk and I'm accepting it (or it's a false
positive)." Same shape works with `//` and `<!--` comments for JS,
TS, HTML, etc.

What we do NOT honour
---------------------
Anything auto-inserted by the fix engine — most notably the
`=== Edge Agent fix [<rule>] === ... === end Edge Agent fix ===`
fence block produced by `lib/server-finding-fixes.ts::fenceLines` —
is treated as ORDINARY CODE and does NOT suppress anything. The
fix engine plants those blocks any time the user clicks "Apply Fix"
on a rule that has no rule-specific rewrite (most prompt-contract,
many auth-checks, etc.). Those blocks contain ONLY a TODO comment;
the underlying vulnerable code is unchanged. Treating that as a
suppression would mean clicking one button silently launders every
flagged route / prompt / dangerous-tool call. The scanner exists
to prevent exactly that.

A practical reading of the rule: a finding only goes away when the
analyzer's own re-evaluation of the (changed) code says so — e.g.
adding `Depends(get_current_user)` to a FastAPI route makes
`analyze_auth_checks` stop flagging it. Comments alone never clear
findings unless the comment is the explicit noqa marker above.

Design rules
------------
- Only the contiguous comment region IMMEDIATELY above the finding
  line is considered. The first non-comment, non-blank line stops
  the walk so a stale noqa high in a file can't reach a later
  finding.
- File reads are cached in a small in-function dict so a file is
  read at most once per scan, no matter how many findings it has.
- A finding for a file we couldn't read (moved, permissions, etc.)
  is always KEPT — we never silence data we couldn't verify.
- Suppressed findings are reported separately in
  `ScanReport.suppressions.entries` so `git diff` reviewers and the
  UI can audit exactly what got hidden.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .report import Finding

# `# edge-agent: noqa rule-a, rule-b`. Accepts both `noqa` and
# `suppress` for ergonomics, and allows the rule list to be omitted
# (meaning "all rules on this line"). A bare `# edge-agent: noqa`
# is treated as a wildcard suppression and tagged separately so the
# UI / report can flag it for review (wholesale silencing is more
# dangerous than per-rule and deserves visibility).
_NOQA_RE = re.compile(
    r"edge-agent\s*:\s*(?:noqa|suppress)(?:\s+([a-z0-9_,\- ]+))?",
    re.IGNORECASE,
)

# How many lines above the finding we'll consider for a marker.
# 8 is intentionally tight — a noqa lives one line above the
# offending code, not 30 lines up. Tightening the window prevents a
# stale noqa at the top of a file from accidentally silencing a
# later, unrelated finding.
_LOOKBACK = 8


@dataclass
class SuppressedFinding:
    """One finding the scanner decided to hide, plus *why*.

    Surfaced verbatim in the scan report so:
      - the UI can show "5 findings suppressed by markers" with a
        toggle to expand the list, and
      - `git diff` reviewers can sanity-check what got silenced.
    """

    finding: Finding
    marker_kind: str  # "noqa" | "noqa_wildcard"
    marker_line: int  # 1-indexed line of the marker comment itself


@dataclass
class SuppressionResult:
    kept: list[Finding] = field(default_factory=list)
    suppressed: list[SuppressedFinding] = field(default_factory=list)


def _strip_comment_prefix(raw: str) -> str:
    """Trim a leading `#`, `//`, or `<!--` so the regex matchers can
    work against just the body of the comment.

    Returns the original line if no recognised comment prefix is found
    (caller treats this as "not a comment", which stops the walk).
    """
    s = raw.strip()
    if s.startswith("#"):
        return s.lstrip("#").strip()
    if s.startswith("//"):
        return s[2:].strip()
    if s.startswith("<!--"):
        return s[4:].strip().rstrip("-->").strip()
    return raw  # unchanged — caller will see it isn't a comment


def _is_blank_or_comment(raw: str) -> bool:
    s = raw.strip()
    if not s:
        return True
    return s.startswith("#") or s.startswith("//") or s.startswith("<!--")


def _read_lines(path: Path) -> list[str] | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeDecodeError):
        return None
    # Split on \r\n or \n so Windows checkouts work the same.
    return text.splitlines()


def _find_marker_for(
    lines: list[str], finding_line_1indexed: int, rule_id: str
) -> tuple[str, int] | None:
    """Walk upward from `finding_line_1indexed - 1` looking for an
    EXPLICIT `# edge-agent: noqa <rule>` opt-out covering `rule_id`.

    Returns `(kind, marker_line_1indexed)` on match, else None.

    Crucially we DO NOT honour the fix engine's auto-inserted
    `=== Edge Agent fix [rule] ===` fence as a suppression — those
    lines are ordinary code from the scanner's perspective. Honoring
    them would mean any click of "Apply Fix" silently approves the
    underlying vulnerable code.
    """
    if finding_line_1indexed <= 1 or finding_line_1indexed > len(lines) + 1:
        return None

    start = finding_line_1indexed - 2  # 0-indexed line above the finding
    stop = max(-1, start - _LOOKBACK)

    i = start
    while i > stop:
        if i < 0 or i >= len(lines):
            break
        raw = lines[i]

        stripped = _strip_comment_prefix(raw)
        m = _NOQA_RE.search(stripped)
        if m:
            arg = (m.group(1) or "").strip()
            if not arg:
                return ("noqa_wildcard", i + 1)
            wanted = {
                r.strip().lower()
                for r in arg.split(",")
                if r.strip()
            }
            if rule_id.lower() in wanted:
                return ("noqa", i + 1)

        if not _is_blank_or_comment(raw):
            # Hit real code — the contiguous comment region above the
            # finding is over. Stop walking.
            break

        i -= 1
    return None


def apply_suppressions(
    findings: list[Finding], scan_root: Path
) -> SuppressionResult:
    """Filter `findings` against on-disk noqa markers.

    Files are read at most once per scan via a tiny in-function cache
    keyed on the resolved absolute path. Failure to read a file (it
    moved, permissions changed) yields the finding as-kept — we never
    suppress data we couldn't verify.
    """
    out = SuppressionResult()
    cache: dict[Path, list[str] | None] = {}

    for f in findings:
        if not f.file or f.line <= 0:
            out.kept.append(f)
            continue
        abs_path = (scan_root / f.file).resolve()
        if abs_path not in cache:
            cache[abs_path] = _read_lines(abs_path)
        lines = cache[abs_path]
        if lines is None:
            out.kept.append(f)
            continue

        marker = _find_marker_for(lines, f.line, f.rule_id)
        if marker is None:
            out.kept.append(f)
        else:
            kind, marker_line = marker
            out.suppressed.append(
                SuppressedFinding(
                    finding=f,
                    marker_kind=kind,
                    marker_line=marker_line,
                )
            )
    return out
