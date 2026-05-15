"""PyInstaller entry shim for the Edge Agent AI scanner.

We deliberately keep this file *outside* the `edge_agent_scanner`
package so it never gets picked up by `pip install -e .` as an
installable script. PyInstaller imports it as a top-level module,
calls `cli.main()`, and forwards the exit code. Everything else lives
inside `src/edge_agent_scanner/` and is reached via the normal package
import path (configured via `pathex=["src"]` in pyinstaller.spec).
"""

from __future__ import annotations

import sys

from edge_agent_scanner.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
