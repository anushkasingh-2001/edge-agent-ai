# Add to scanner/pyproject.toml dependencies

```toml
"PyYAML>=6.0.1"
```

No Python Docker SDK is required. This patch uses the Docker CLI through subprocess.
Docker must be installed on the machine running behavioral tests.
