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
