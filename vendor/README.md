# Vendored code

## `matebot/`

Copied from `/home/tars/yysapp/MateBot` at commit `c0deb163e8a4b5319a8dce7e15f5fc6188cafb88`
(2026-10-06) as the canonical MateBot bridge + long-connection code.

Included: the Python bridge (`feishu_bridge.py`, `feishu_api.py`,
`feishu_renderer.py`, `feishu_config.py`, `bridge.py`), the long-lived OpenCC
session (`opencc_backend.py`), its session store (`session_store.py`), soul /
memory / attention modules, scripts, hooks, tests, and docs.

Excluded to keep the repository small: `.git/`, `vendor/opencc/`, `workspace/`
(user data), `skills/` (large generated assets), `uv.lock`, caches and logs.

Update procedure (do not edit vendored files in place):

```bash
rsync -a --delete \
  --exclude='.git' --exclude='vendor' --exclude='workspace' --exclude='skills' \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='.venv' --exclude='uv.lock' \
  --exclude='*.log' --exclude='.pytest_cache' --exclude='.ruff_cache' \
  /home/tars/yysapp/MateBot/ vendor/matebot/
```

Record the upstream commit in this file when updating.

## `opencc` (symlink)

`vendor/opencc -> ../../packages/opencc` is the vendored OpenCC harness source.
The built CLI is `packages/opencc/dist/cli.js`; it exposes `--matebot`.
Update it with the selective three-way merge in
`docs/matebot-modernization/opencc-delta.md`, not by replacing the subtree.
