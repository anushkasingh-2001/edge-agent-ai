# Merge Checklist

Use this checklist after copying the patch pack into `edge-agent-ai`.

## Must-have before trusting results

- [ ] `Save / Deterministic+Explain` allows LLM explanation but not LLM truth.
- [ ] `Auto` uses ContextBundle and routes models by task/complexity.
- [ ] `Pro` uses stronger model and expanded graph context.
- [ ] `Max` uses plan → patch → validate → re-scan.
- [ ] `Manual` lets user choose model but keeps guardrails.
- [ ] `json.dumps` alone is not data export.
- [ ] dependencies are grouped per manifest.
- [ ] prompt-contract rule is context-aware.
- [ ] unsafe Cypher and LLM-codegen→exec are detected.
- [ ] default DB credentials are detected.
- [ ] global `os.environ` mutation is detected.
- [ ] TODO/comment-only patches are never marked fixed.
- [ ] Fix filtered clusters before LLM calls.
- [ ] Re-scan decides fixed/not fixed.

## Commands

```bash
python -m compileall scanner/src
cd scanner && pytest -q && cd ..
pnpm test
pnpm test:explain
node --import tsx/esm --test tests/intelligence-modes.test.ts
pnpm build
```
