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
