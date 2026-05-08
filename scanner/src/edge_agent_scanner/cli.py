"""CLI entry: python -m edge_agent_scanner.cli scan <repo_path> --out report.json"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from edge_agent_scanner.engine import run_scan


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="edge-agent-scanner", description="Edge Agent AI static scanner")
    sub = parser.add_subparsers(dest="command", required=True)

    scan_p = sub.add_parser("scan", help="Scan a local repository")
    scan_p.add_argument("repo_path", type=Path, help="Root directory of the repository to scan")
    scan_p.add_argument(
        "--out",
        type=Path,
        default=Path("report.json"),
        help="Output JSON path (default: ./report.json)",
    )

    args = parser.parse_args(argv)
    if args.command != "scan":
        return 1

    repo = args.repo_path
    if not repo.is_dir():
        print(f"Error: not a directory: {repo}", file=sys.stderr)
        return 2

    report = run_scan(repo)
    out_path: Path = args.out
    out_path.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    print(f"Wrote {out_path.resolve()} ({report.summary.total} findings, risk_score={report.risk_score})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
