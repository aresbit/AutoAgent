# Engine configuration precedence

The desktop must behave like the OpenCC CLI whenever the user already has a
Claude/OpenCC configuration. A second configuration is only used as a fallback,
and it lives under `~/.autoagent/` so it is easy to find and back up.

## Sources

| Source | Path | Who writes it |
|---|---|---|
| Desktop app override | SQLite settings (`Settings.model`) | The Settings panel (`PUT /api/settings`) |
| Claude/OpenCC config | `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` + `settings.local.json` | The OpenCC CLI / the user |
| AutoAgent fallback | `~/.autoagent/settings.json` (`AUTOAGENT_CONFIG_DIR` override; independent of the data dir) | `PUT /api/engine/config` |
| Process environment | `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, ... | The launcher / shell |

The backend and the desktop use the XDG data directory
(`${XDG_CONFIG_HOME:-~/.config}/autoagent`) for SQLite and layout state. The
engine fallback configuration is independent: it lives at
`~/.autoagent/settings.json` (`AUTOAGENT_CONFIG_DIR` override), so it stays
stable regardless of the data-dir convention.

## Model precedence

1. Desktop app override (`Settings.model` non-empty) — source `override`.
2. `settings.json` → `env.ANTHROPIC_MODEL` — source `claude-settings`.
3. `settings.json` → top-level `model` — source `claude-settings`.
4. `~/.autoagent/settings.json` → `model` — source `autoagent`.
5. Process `ANTHROPIC_MODEL` — source `env`.
6. OpenCC/MateBot default — source `default`.

## Credential and base URL precedence

1. `~/.claude/settings.json` / `settings.local.json`
   (`env.ANTHROPIC_AUTH_TOKEN`, `env.ANTHROPIC_API_KEY`, `apiKeyHelper`,
   `env.ANTHROPIC_BASE_URL`).
2. `~/.autoagent/settings.json` (`apiKey` / `apiKeyHelper`, `baseURL`).
3. Process environment.
4. None.

If the effective source is the AutoAgent fallback, the backend applies the
derived `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` to the environment of the
engine child. Values already supplied by the Claude configuration are never
overridden.

## API shape

`GET /api/engine/config` and `PUT /api/engine/config` expose only:

```json
{
  "model": "...",
  "baseURL": "...",
  "apiKeyConfigured": true,
  "apiKeyHelperConfigured": false,
  "path": "/home/<user>/.autoagent/settings.json"
}
```

The API never returns the raw key. The file is written atomically with mode
`0600`. Logs redact credentials.

## Desktop override semantics

The Settings panel shows the effective model (with its source badge) and an
optional **Override for this app** field. An override is passed to opencc as
`--model` for desktop sessions only; it does **not** modify
`~/.claude/settings.json` or `~/.autoagent/settings.json` unless the user saves
the fallback configuration through `PUT /api/engine/config`.
