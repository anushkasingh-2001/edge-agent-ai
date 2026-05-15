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


hiddenimports = [
    *collect_submodules("edge_agent_scanner"),
    "pydantic",
    "pydantic_core",
]


a = Analysis(
    ["pyinstaller_entry.py"],
    pathex=["src"],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # `yaml` and `pytest` are declared in pyproject but never imported
    # at runtime — `import yaml` does not appear anywhere in
    # scanner/src. Excluding them trims ~5-10 MB.
    # `tkinter` is pulled in by Python's stdlib but is unused.
    excludes=["pytest", "yaml", "tkinter", "test", "_pytest"],
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
