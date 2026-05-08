# Edge Agent Scanner

Static analysis CLI for local agent repositories. Emits a versioned `report.json` for later integration with the Edge Agent AI UI.

## Install (editable)

From the `scanner/` directory:

```bash
pip install -e ".[dev]"
```

## Run tests

```bash
pytest -q
```

## Scan a repository

```bash
python -m edge_agent_scanner.cli scan /path/to/repo --out report.json
```

Options:

- `--out` — output JSON path (default: `report.json` in the current working directory if omitted; the CLI requires `--out` explicitly per invocation pattern above)

## Report schema

See `edge_agent_scanner/report.py` for the Pydantic models. Findings use `rule_id` values aligned with the UI Scan Center check IDs.
