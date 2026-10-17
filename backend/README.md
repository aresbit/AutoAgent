# AutoAgent backend

Local FastAPI backend for AutoAgent. The application core (`domain/`,
`application/`) is framework-free; `composition.py` is the only place concrete
adapters are constructed.

```bash
uv sync --frozen
uv run python -m autoagent_backend --version
uv run python -m autoagent_backend --port 8787 --data-dir /tmp/autoagent
```

See `docs/matebot-modernization/` at the repository root for the architecture,
API contract and implementation plan.
