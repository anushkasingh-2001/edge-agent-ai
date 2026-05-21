# Edge Agent AI follow-up patch after replacing `ir/sinks.py`

Apply these files on top of the previous `edge_agent_ai_refactor_libcst_treesitter_pack`.

Why these files changed:

- `ir/sinks.py` now supports a broader side-effect ontology plus `.edgeagent/config.yaml|json` repo overrides.
- `ir/builder.py` now passes `repo_root` into side-effect inference.
- `engine.py` now calls `build_agent_ir(files, repo_root=root)`.
- `ir/graph.py` now loads repo-specific side-effect rules and stores detailed side-effect matches/severity in `tool.metadata`.
- `analyzers/dangerous_tools.py` now uses the detailed side-effect matches/severity instead of hardcoded severity sets.
- `analyzers/approval_gates.py` now uses the tool metadata severity, so repo-specific high/critical tools automatically require approval.
- `scanner/pyproject.toml` is included for completeness because YAML config support needs `PyYAML`.

Copy paths exactly into your repo. `ADD/...` paths are files from the previous pack; overwrite them with these improved versions.
