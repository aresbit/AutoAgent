# PM Decisions Log

Use this file for language/architecture/process decisions.
Each decision must include alternatives, rationale, tradeoffs, and time context.


## Decision 2026-10-17T03:20:25.081Z: Fix Linux rendering stability
- Type: architecture
- Chosen: Out-of-process GPU (Chromium default) + hide-until-ready + bounded renderer recovery
- Options considered: Keep in-process-gpu and add flags | Disable GPU entirely | Out-of-process GPU by default (chosen)
- Rationale: Atlas's controlled A/B shows in-process-gpu causes 2917-2934 GPU errors in 6s on Wayland and 2166ms vs 401ms first paint on X11. Out-of-process GPU is Chromium's stable default and maxwire's behavior. show:false until ready-to-show removes the ~1.66s blank window. Two bounded reloads recover from renderer crashes without loops.
- Tradeoffs: Slightly later first visible frame than an eager blank window; recovery reloads may briefly reset renderer state.
- Time context: Electron 41.3.0, Ubuntu 24.04, GNOME 46.2, measured 2026-10-17
- Guardrail risk signals: (none)


## Decision 2026-10-17T03:20:30.938Z: Linux packaging strategy
- Type: architecture
- Chosen: Custom reproducible dpkg-deb pipeline with /opt/autoagent layout and SUID sandbox
- Options considered: Adopt electron-builder linux target | Keep /usr/lib layout with system Electron | Custom /opt self-contained deb (chosen)
- Rationale: electron-builder hides SUID modes and maintainer scripts. The custom builder gives exact payload control, pinned Electron SHA256, one setuid file at 4755, explicit Ubuntu 24.04 Depends, deterministic output (verified byte-identical rebuild), and no runtime Node/npm/Bun/Python dependency. This mirrors maxwire's proven package_deb.py approach.
- Tradeoffs: More code to maintain than electron-builder; requires a pinned Electron archive and checksum in CI.
- Time context: Artifact autoagent_0.8.0_amd64.deb, 2026-10-17
- Guardrail risk signals: (none)


## Decision 2026-10-17T03:50:54.408Z: Deep interfaces for all business APIs
- Type: architecture
- Chosen: Coarse-grained intention-revealing HTTP API + Protocol/ABC ports + thin adapters
- Options considered: Thin CRUD endpoints mirroring DB rows | Expose opencc CLI/stream-json directly to the SPA | Deep interfaces: narrow public surface, rich hidden implementation (chosen)
- Rationale: Per software-design-skill (ADT/information hiding, dependency inversion, FastAPI layering): the SPA should depend on a small set of stable, business-level operations, not on SQLite rows, subprocess argv, or raw stream-json frames. Define EnginePort, SessionStorePort, SettingsPort, WorkspacePort and MateBotPort as Protocol/ABCs; HTTP handlers are thin adapters; opencc details (--matebot, resume, restart) are hidden behind EnginePort. This keeps the API testable and lets us swap the engine or storage without touching the UI.
- Tradeoffs: Fewer, coarser endpoints require careful DTO design and make ad-hoc UI queries harder; mitigated by a documented bootstrap snapshot and typed client.
- Time context: AutoAgent MateBot modernization, 2026-10-17
- Guardrail risk signals: (none)


## Decision 2026-10-17T06:24:27.993Z: MateBot vendoring and model configuration
- Type: architecture
- Chosen: Vendor MateBot source at vendor/matebot; OpenCC source at vendor/opencc (symlink to packages/opencc); desktop long connection uses the vendored OpenccSession; model config is read from ~/.claude/settings.json with an optional per-app override
- Options considered: Reimplement the long connection inside the backend | Import the vendored OpenccSession (chosen) | Maintain a separate provider/model store
- Rationale: The user clarified that OpenCC is the harness and MateBot is the Feishu bridge plus the desktop long-connection channel. Vendoring the actual MateBot OpenccSession keeps the desktop and Feishu bridge behavior aligned (persistent child, --matebot, session resume) instead of maintaining a divergent copy. Reusing ~/.claude/settings.json avoids a second model/provider configuration and keeps the desktop compatible with the CLI; an optional per-app override is passed as --model without mutating the user's file.
- Tradeoffs: Vendored code must be updated deliberately; model source precedence must be documented; packaged Nuitka must ship the vendored Python file or a compiled bridge.
- Time context: MateBot upstream c0deb163, 2026-10-17
- Guardrail risk signals: (none)


## Decision 2026-10-17T06:41:55.723Z: Engine configuration precedence
- Type: architecture
- Chosen: Reuse ~/.claude/settings.json first; fall back to a frontend-editable ~/.autoagent/settings.json; process env last; per-app override remains highest priority
- Options considered: Only ~/.claude/settings.json | Only an AutoAgent-local config | Claude settings first, AutoAgent fallback, frontend-editable (chosen)
- Rationale: The user wants maximum reuse: the desktop must behave like the OpenCC CLI when ~/.claude/settings.json is present. When it is missing or incomplete, AutoAgent stores its own engine config under ~/.autoagent (not a separate provider silo) and the frontend can edit it. Model precedence: explicit app override > Claude settings > ~/.autoagent/settings.json > process env > OpenCC default. Credentials follow the same idea and are never serialized.
- Tradeoffs: Two config files to reconcile; atomic writes and 0600 permissions are required; silent token exposure must be avoided.
- Time context: 2026-10-17
- Guardrail risk signals: (none)
