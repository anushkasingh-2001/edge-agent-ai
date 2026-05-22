# Final new_changes bundle

This is the final corrected `new_changes` folder.

## Apply

From your repo root:

```bash
rsync -av new_changes/scanner/ scanner/
rsync -av new_changes/lib/ lib/
rsync -av new_changes/components/ components/
rsync -av new_changes/app/ app/
```

Then run:

```bash
python -m compileall scanner/src
cd scanner
pip install -e .
edge-agent-scanner --help
```

For frontend:

```bash
npm install
npm run lint
npm run build
```

## Important fixes included

1. Trace-dependent behavioral checks no longer fake-pass when the target app returns no `trace_events`.
2. `http_harness.py` no longer emits duplicate `case_end` traces; `runner.py` owns lifecycle traces.
3. Docker/FastAPI generated commands use `0.0.0.0` inside containers so port mapping works.
4. `scanner/pyproject.toml` is now included at the correct path, not under `scanner/src`.
5. Docker HTTP behavioral tests reject `sandbox.network: "none"` because the harness cannot reach the app with network disabled.

## After applying

You can remove the staging folder if you do not want to keep it:

```bash
git rm -r new_changes
```

Only do this after copying the files into the real paths.

## PyInstaller / bundled scanner — hidden imports (action required before packaging)

The refactor introduced parser dependencies that PyInstaller cannot always
discover by static analysis. Before building the bundled `edge-agent-scanner`
binary, add these to `scanner/pyinstaller.spec` `hiddenimports` (this file lives
in the original repo, so it was intentionally NOT modified by this patch):

```python
hiddenimports = [
    "libcst",
    "libcst.metadata",
    "tree_sitter",
    "tree_sitter_language_pack",
    # add specific tree-sitter language grammars if your build needs them, e.g.:
    # "tree_sitter_python", "tree_sitter_javascript", "tree_sitter_typescript",
]
```

`libcst` ships compiled native code and `tree_sitter_language_pack` loads
grammars dynamically, so a bundle built without these will import-fail at
runtime on `edge_agent_scanner.ir.extract_python` /
`edge_agent_scanner.ir.extract_ts_js`. If you do not package with PyInstaller,
no action is needed. `networkx` was removed from dependencies (unused), so it
must NOT be added to hidden imports.
