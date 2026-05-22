# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the Edge Agent AI scanner.
#
# Produces a one-file executable named `edge-agent-scanner` (or
# `edge-agent-scanner.exe` on Windows) that wraps
# `edge_agent_scanner.cli:main` and forwards argv.
#
# Invoked by `scripts/build-scanner.mjs` like:
#
#     scanner/.venv/bin/python -m PyInstaller --noconfirm --clean \
#         scanner/pyinstaller.spec
#
# The scanner package itself uses 100% static imports (see
# `scanner/src/edge_agent_scanner/rules/__init__.py`), so PyInstaller's
# analyser walks the dependency tree without extra hints. The
# `collect_submodules` call below is defensive — if someone adds a new
# rule module later but forgets to re-export it from
# `rules/__init__.py`, this still pulls it in.
#
# `pydantic_core` is the Rust extension that ships with pydantic v2;
# pyinstaller-hooks-contrib >= 2024.7 handles it automatically, but we
# list it as a hidden import so a stale hooks-contrib fails loudly at
# build time rather than producing a binary that imports incorrectly
# at first scan.

from PyInstaller.utils.hooks import collect_submodules


# The new IR/analyzer pipeline introduces parser dependencies PyInstaller's
# static analyzer cannot always discover on its own:
#   - `libcst` is the LibCST-based Python extractor. It ships compiled native
#     code; without listing it (and `libcst.metadata`) the bundled binary
#     import-fails at first scan inside `ir.extract_python`.
#   - `tree_sitter` + `tree_sitter_language_pack` load grammars dynamically
#     from a package data directory at runtime, which PyInstaller cannot see
#     by static analysis. Without these hidden imports the bundled scanner
#     import-fails inside `ir.extract_ts_js`.
# `networkx` is deliberately NOT listed: it was removed from the new analyzers
# (replaced by lightweight BFS/adjacency in `ir.graph`) and must not be pulled
# back in.
hiddenimports = [
    *collect_submodules("edge_agent_scanner"),
    "pydantic",
    "pydantic_core",
    "libcst",
    "libcst.metadata",
    "tree_sitter",
    "tree_sitter_language_pack",
    # Specific tree-sitter grammars used by `ir.extract_ts_js` ("typescript"
    # for .ts/.tsx, "javascript" for .js/.jsx). If a future extractor adds a
    # new language, list its grammar here as well.
    # "tree_sitter_python", "tree_sitter_javascript", "tree_sitter_typescript",
]


a = Analysis(
    ["pyinstaller_entry.py"],
    pathex=["src"],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # `pytest` is dev-only. `tkinter` is pulled in by Python's stdlib but is
    # unused. `yaml` IS now imported at runtime by
    # `edge_agent_scanner.ir.sinks.load_repo_side_effect_rules` for the
    # `.edgeagent/config.yaml` override mechanism, so it must NOT be excluded.
    excludes=["pytest", "tkinter", "test", "_pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="edge-agent-scanner",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX trips Windows Defender heuristics on PyInstaller bootloaders
    # and gains almost nothing on macOS/Linux. Leave it off everywhere.
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
