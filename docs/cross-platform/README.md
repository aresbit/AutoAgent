# Cross-platform refactor docs

Index and status for the Linux desktop packaging/runtime refactor.

## Documents

| Document | Purpose |
|---|---|
| [diagnosis.md](diagnosis.md) | Atlas's read-only runtime diagnosis: X11 vs Wayland, GPU path, sandbox, startup timing |
| [root-cause.md](root-cause.md) | Prioritized root causes (P0/P1/P2) with evidence and `file:line` references |
| [packaging-playbook.md](packaging-playbook.md) | Target maxwire-style layout, permissions, dependencies, maintainer scripts, desktop entry, reproducible build |
| [source-change-list.md](source-change-list.md) | Every file that must change, with precise edit intent |
| [skill-draft/SKILL.md](skill-draft/SKILL.md) | Reusable `electron-linux-packaging` skill (also installed at `/home/tars/.claude/skills/electron-linux-packaging/SKILL.md`) |
| [implementation-log.md](implementation-log.md) | Files changed, owners, and verification status |
| [evaluation.md](evaluation.md) | Sentinel's independent evaluation (verdict: PASS); targeted post-fix re-check appended when it lands |
| [evidence/](evidence/) | Atlas's runtime logs (X11/Wayland/sandbox/GPU). Read-only; do not edit |

## Why this refactor

Three findings drive the change:

1. **P0 — remove `in-process-gpu` on Linux.** The unconditional switch
   (`src/main.ts:311-313`) keeps Chromium's GPU service in the browser process.
   On Wayland it produced 2917-2934 EGLImage/context-loss errors in 6 s; without
   it, 0. On X11, `ready-to-show` took 2166 ms with the switch and 401 ms without
   it. Evidence: `evidence/wl-ipgpu-timed.log`, `evidence/x11-ipgpu-timed.log`,
   `evidence/x11-noipgpu-timed.log`.
2. **P1 — install `chrome-sandbox` as root:root 4755 and stop passing
   `--no-sandbox`.** The current package installs the helper mode 0755 and the
   launcher always disables the sandbox. Launching without `--no-sandbox` aborts
   with a FATAL sandbox error. Evidence: `evidence/sandbox-fatal.log`.
3. **P1 — do not show the window until `ready-to-show`.** `show: true` maps a
   blank white window at 526 ms while first paint arrives at 2190 ms (default)
   or 876 ms (`--disable-gpu`). The window must be created with `show: false`
   and shown on `ready-to-show`.

## Target in one screen

```
/opt/autoagent/engine/{bun,rg,cli.js}
/opt/autoagent/desktop/{electron, chrome-sandbox(4755), resources/app/...}
/usr/bin/autoagent                    # fixed-path launcher, no --no-sandbox
/usr/share/applications/autoagent.desktop
/usr/share/icons/hicolor/*/apps/autoagent.png
```

Build output: `release/autoagent_<version>_amd64.deb` plus `.sha256`.

## Status

Sentinel's independent evaluation and targeted post-fix re-check both report
PASS: [evaluation.md](evaluation.md). The final artifact rebuilt byte-identically
at the stated hash. Root-only install/upgrade/remove remains unverified.

Final artifact:

- Path: `release/autoagent_0.8.0_amd64.deb`
- SHA256: `b43f51624d5c1ef7642fc13630a15d7e274b03f206af02469f766c02b035ebc9`
- Size: 109,712,608 bytes

| Workstream | Status | Owner |
|---|---|---|
| Diagnosis (X11/Wayland/GPU/sandbox) | Done | Atlas |
| Packaging blueprint (layout, deps, scripts, build) | Done | Atlas |
| Runtime implementation (`src/main.ts`, `src/runtime-paths.ts`) | Implemented and independently verified ([evaluation.md](evaluation.md)) | Kiln |
| Packaging implementation (builder, launcher, DEBIAN, desktop entry) | Implemented and independently verified on X11 and nested Wayland ([evaluation.md](evaluation.md)) | Anvil |
| P3 launcher socket fix | Resolved and independently re-verified ([evaluation.md](evaluation.md)) | Anvil |
| Root-only install/upgrade/remove | Unverified — evaluation ran without root and did not execute real `apt`/`dpkg` install, upgrade, or remove | Sentinel |
| Independent evaluation | PASS for the initial build and the final artifact ([evaluation.md](evaluation.md)) | Sentinel |

P2 note: cold-profile `ready-to-show` is 2.23-2.34 s; warm-profile is
373-386 ms. The cold number is a fresh-profile measurement (cold caches, fonts,
and shader initialization), not steady-state. It is not claimed as fixed.

## Verified now (2026-10-17, diagnosis only)

These are baseline facts about the current tree, not claims about the target build.

- Host: Ubuntu 24.04.5 LTS x86_64, `dpkg-deb` 1.22.6.
- Current `autoagent.desktop` passes `desktop-file-validate`.
- Current launcher, postinst, and `build-deb.sh` pass shell syntax checks.
- Locked Electron is `41.3.0`.
- Current staging tree is 127 MiB, has no `electron-dist/`, and tracks `bun` in git
  even though it is gitignored.
- Sandbox failure: `evidence/sandbox-fatal.log`.
- Forced Wayland on a non-Wayland session fails: `evidence/wayland-explicit.log`.

## Open items

- Root-only `apt`/`dpkg` install, upgrade with the old app running, and remove
  with user data preserved.
- P2 cold-profile `ready-to-show` 2.23-2.34 s (warm 373-386 ms): either add a
  bounded show fallback, show on `did-finish-load`, or document the 1.5 s bar as
  warm-start only. This is not claimed as fixed.

## Top five risks

1. Removing the `--no-sandbox` workaround without a root-owned 4755
   `chrome-sandbox` makes the app abort at launch.
2. Forcing Wayland on an X11/headless session aborts startup; gate on
   `WAYLAND_DISPLAY`.
3. Moving `/usr/lib/autoagent` to `/opt/autoagent` without updating
   `src/runtime-paths.ts` leaves the engine unable to find `bun`/`cli.js`/`rg`.
4. Keep staging in `mktemp`, not `packaging/deb`; otherwise stale artifacts and
   version drift return.
5. `preinst` process cleanup must be scoped by `/proc/PID/exe`, or an upgrade can
   kill an unrelated Electron app.

## Ownership

- Diagnosis and evidence: Atlas (`diagnosis.md`, `root-cause.md`, `evidence/`).
- Runtime source edits: Kiln, coordinated with Atlas on `src/main.ts`.
- Packaging/build edits: Anvil.
- Independent evaluation: Sentinel.
- Documentation and reusable skill: Scribe.
