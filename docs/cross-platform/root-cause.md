# Root Cause Analysis: AutoAgent Linux rendering and startup

Date: 2026-10-17
Companion evidence: `/home/tars/yysapp/AutoAgent/docs/cross-platform/diagnosis.md`

Priorities:

- **P0**: directly causes the observed failure or a multi-second user-visible defect.
- **P1**: high-impact robustness/security defect that should ship in the same fix batch.
- **P2**: correctness/hygiene issue; fix after the P0/P1 batch.

## 1. Prioritized findings

| ID | Priority | Finding | Evidence | File:line |
|---|---|---|---|---|
| RC-1 | **P0** | Unconditional `in-process-gpu` on Linux causes the Wayland EGLImage/context-loss storm and a ~1.5-1.8 s first-paint stall on X11 | Wayland+ipgpu probe: 2934 errors/6 s; no ipgpu: 0. X11 ipgpu `ready-to-show` 2166 ms vs 401 ms. Shipped launcher 2190 ms vs 876 ms with `--disable-gpu` | `src/main.ts:311-313` |
| RC-2 | **P1** | Launcher relies on Chromium's implicit ozone selection; no explicit `--ozone-platform` for Wayland/X11 | Electron 41 auto-selects Wayland here (libwayland-client bound), but behavior is environment-dependent; explicit Wayland with no compositor exits 139 SIGSEGV instead of a controlled failure | `packaging/deb/usr/bin/autoagent:27` |
| RC-3 | **P1** | `chrome-sandbox` installed mode 0755 and launcher always uses `--no-sandbox` | App without `--no-sandbox`: FATAL, exit 133. Installed helper `755`; maxwire helper `4755` and works | `scripts/build-deb.sh:104`, `packaging/deb/usr/bin/autoagent:27` |
| RC-4 | **P1** | Window is shown before first paint (`show: true`), producing a blank white window during the GPU stall | Window mapped at 526 ms, `ready-to-show` 2190 ms (default) and 876 ms (`--disable-gpu`) | `src/main.ts:2021`, `src/main.ts:2040-2042` |
| RC-5 | **P2** | No recovery after the window is up: GPU context loss, renderer crash, and repeated load failure are logged only | 177,923 context-lost lines over 745 s with no reload/fallback; handlers only `console.error` | `src/main.ts:2054-2062` |
| RC-6 | **P2** | Desktop name is set without the `.desktop` suffix, unlike maxwire | X11 WM_CLASS verified as `("autoagent" "autoagent")`, so X11 grouping works; Wayland `app_id`/icon grouping unverified | `src/main.ts:331-335`, `src/main.ts:2016` |
| RC-7 | **P2** | Package metadata is stale and build script does not install `package.json`; default build version is `0.2.0` | Installed `package.json` says `0.2.0` while `dpkg` says `0.8.1`; no `cp package.json` in build script | `scripts/build-deb.sh:14`, `scripts/build-deb.sh:77-90`, `/usr/lib/autoagent/package.json` |
| RC-8 | **P2** | Single append-only log with no rotation; 223 MB after 3 launches | `~/.local/share/autoagent/autoagent.log` = 223 MB; no rotation logic | `packaging/deb/usr/bin/autoagent:25-27` |
| RC-9 | **P2** | Single-instance lock fails immediately with no retry and no log | Launch during a slow shutdown silently exits | `src/main.ts:2707-2710` |
| RC-10 | **P2** | Main renderer runs with `sandbox: false`; Chromium sandbox is disabled globally via `--no-sandbox` | Renderer process is unsandboxed; maxwire uses `sandbox: true` + SUID helper | `src/main.ts:2023-2028` |

## 2. P0 detail: `in-process-gpu`

```ts
// src/main.ts:311-313
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('in-process-gpu');
}
```

This keeps Chromium's GPU service inside the browser process. Consequences proven by
the A/B probe (`evidence/probe-app/`, identical page and hardware, one switch changed):

| Environment | `in-process-gpu` | Errors in 6 s | First paint |
|---|---|---|---|
| Wayland (mutter 46.2) | on | 2917-2934 | 482 ms |
| Wayland (mutter 46.2) | off | 0 | 414 ms |
| X11 | on | 0 | 2166 ms |
| X11 | off | 0 | 401 ms |

On Wayland the failing path is:

```
eglCreateImage failed with 0x00003009 (EGL_BAD_MATCH)
  -> Failed to create EGLImage
  -> native_pixmap_egl_binding: Unable to initialize binding from pixmap
  -> OzoneImageBacking::ProduceSkiaGanesh failed to create GL representation
  -> RasterDecoderImpl: Context lost during MakeCurrent
  -> context already lost, every frame thereafter
```

Because the GPU context lives in the browser process, Chromium cannot discard and
restart a separate GPU process. The failure persists at ~239 context losses/second
(measured from the historical log, 177,923 events over 745.56 s).

On X11 the same switch does not error, but adds a consistent ~1.5-1.8 s to first
paint (`ready-to-show` 2166 ms vs 401 ms in the probe; 2190 ms vs 876 ms through the
shipped launcher). The user sees a white window for that period.

**Minimal fix:** remove the switch. There is no need to replace it with anything;
Electron uses an out-of-process GPU by default.

```diff
-// Startup optimizations
-if (process.platform === 'linux') {
-  app.commandLine.appendSwitch('in-process-gpu');
-}
```

If a GPU fallback is desired later, prefer the tested narrow mitigation
`--disable-gpu-compositing` (Wayland probe: 0 errors), but that still leaves the GPU
in-process and does not remove the X11 first-paint penalty. Removing the switch is
simpler and addresses both symptoms.

## 3. P1 detail: explicit ozone selection

Current launcher (`packaging/deb/usr/bin/autoagent:27`):

```sh
exec $ELECTRON --no-sandbox "${AGENT_HOME}/main.js" "$@" >> "${LOG}" 2>&1
```

Electron 41.3 auto-selected Wayland correctly in the nested test (verbose run binds
`libwayland-client` and logs `ui/ozone/platform/wayland/...`, with no X11
connection). So the missing flag is **not** proven to cause misselection on this
version. It is still a robustness gap: selection depends on Chromium heuristics, and
a failed Wayland connection is not handled (exit 139 SIGSEGV with no message).

**Minimal fix:** choose explicitly, and let RC-1 make Wayland usable:

```sh
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  OZONE="--ozone-platform=wayland"
elif [ -n "${DISPLAY:-}" ]; then
  OZONE="--ozone-platform=x11"
else
  OZONE=""
fi
exec $ELECTRON $OZONE "${AGENT_HOME}/main.js" "$@" >> "${LOG}" 2>&1
```

Do this **after** or together with RC-1. Selecting Wayland without removing
`in-process-gpu` only makes the broken path deterministic.

## 4. P1 detail: sandbox helper

Installed state:

```
/usr/lib/autoagent/electron-dist/chrome-sandbox   755 root:root   -> FATAL exit 133
/opt/maxwire/desktop/chrome-sandbox               4755 root:root  -> works
```

The build explicitly strips the SUID bit:

```sh
# scripts/build-deb.sh:104
chmod 755 "${PACKAGING_DIR}/usr/lib/autoagent/electron-dist/chrome-sandbox"
```

The launcher then compensates globally:

```sh
# packaging/deb/usr/bin/autoagent:27
exec $ELECTRON --no-sandbox ...
```

This defeats the sandbox for the browser, GPU, and renderer, and hides packaging
regressions. It also amplifies RC-1: an isolated GPU process would be able to crash
and restart independently.

**Minimal fix (three parts):**

1. Build:

```sh
chown root:root "${PACKAGING_DIR}/usr/lib/autoagent/electron-dist/chrome-sandbox"
chmod 4755 "${PACKAGING_DIR}/usr/lib/autoagent/electron-dist/chrome-sandbox"
```

2. Defensive postinst (runs as root):

```sh
chown root:root /usr/lib/autoagent/electron-dist/chrome-sandbox
chmod 4755 /usr/lib/autoagent/electron-dist/chrome-sandbox
```

3. Remove `--no-sandbox` from the launcher. If a development escape hatch is needed,
gate it on an explicit environment variable, never unconditionally.

## 5. P1 detail: window shown before first paint

```ts
// src/main.ts:2021
show: true,
...
// src/main.ts:2040-2042
mainWindow.once('ready-to-show', () => {
  console.error(`[perf] +${(performance.now() - t0).toFixed(0)}ms ready-to-show`);
});
```

The comment above `show` says "Hide until fully rendered — avoids flash, feels
faster", but the value contradicts it. Measured: window mapped at 526 ms, first paint
at 2190 ms (default) or 876 ms (`--disable-gpu`).

**Minimal fix:**

```diff
-    show: true,
+    show: false,
...
 mainWindow.once('ready-to-show', () => {
   console.error(`[perf] +${...}ms ready-to-show`);
+  mainWindow?.show();
 });
```

This makes the slow GPU path feel like a normal startup instead of a blank window,
and matches maxwire (`desktop/main.cjs:273,285`).

## 6. P2 detail: post-load recovery

Current handlers only log:

```ts
// src/main.ts:2054-2062
mainWindow.webContents.on('did-fail-load', (...) => { console.error(...) });
mainWindow.webContents.on('render-process-gone', (...) => { console.error(...) });
```

The initial shell load already has a good recovery chain: one HTTP retry, then
`file://`, then a `data:` error page (`src/main.ts:2066-2112`). What is missing is
recovery **after** the window is live, and any user-visible error.

**Minimal fix:**

- Keep a `reloadedOnce` flag; on `render-process-gone` with `reason !== 'clean-exit'`,
  reload once. If it happens again, show an error page (the `data:` fallback already
  exists) instead of leaving a frozen or white window.
- Log the GPU feature status once at startup (`app.getGPUFeatureStatus()`), so the
  next GPU incident has a diagnosis trail.
- With RC-1 fixed, a GPU process crash no longer takes down the whole browser
  process; this handler becomes actionable.

## 7. P2 detail: desktop name / WM class

```ts
// src/main.ts:331-335
app.setName('autoagent');
app.setDesktopName?.('autoagent');
// src/main.ts:2016
desktopFileName: 'autoagent',
```

maxwire uses the full file name (`desktop/main.cjs:299-300`):

```js
app.setName("MaxWire");
app.setDesktopName("maxwire.desktop");
```

X11 was verified correct: the window is `("autoagent" "autoagent")`, which matches
`StartupWMClass=autoagent` in `/usr/share/applications/autoagent.desktop`. No X11
change is required. Wayland `app_id` matching could not be visually verified in the
nested compositor (no panel/taskbar).

**Minimal fix:** when touching this, use a single constant
`LINUX_DESKTOP_FILE = 'autoagent.desktop'` for `setDesktopName` and
`desktopFileName`, then verify the GNOME Wayland app_id/icon on a real Wayland
session before shipping. This is hygiene, not a proven startup cause.

## 8. P2 detail: package layout and version metadata

- `scripts/build-deb.sh:14` defaults to `VERSION="${1:-0.2.0}"`.
- The script copies `main.js`, `preload.cjs`, `client/`, `autowork/`, artifacts, and
  icons (`scripts/build-deb.sh:77-90`) but never copies `package.json`.
- Installed result: `dpkg` reports `0.8.1`, while `/usr/lib/autoagent/package.json`
  reports `"version":"0.2.0"` (left over from an older build).
- The install layout is flat (`main.js`, `client/`, `electron-dist/`, `bun`, `rg`,
  `cli.js`), unlike maxwire's `desktop/resources/app` plus root-level Electron. Flat
  layout works because the launcher passes `main.js` explicitly; it is not a startup
  cause.

**Minimal fix:**

- Copy the real `package.json` into the staged app.
- Derive `VERSION` from `package.json` (or require an explicit argument) instead of
  hardcoding `0.2.0`.
- Add a post-install assertion that `dpkg` version, `package.json` version, and the
  Electron bundle version are mutually consistent.

## 9. P2 detail: logging

The launcher writes an unbounded append-only file:

```sh
LOG="${HOME}/.local/share/autoagent/autoagent.log"
exec $ELECTRON ... >> "${LOG}" 2>&1
```

Measured 223 MB after three launches. The second launch contributed ~400k GPU error
lines. Logging every context-loss line is both a symptom amplifier and a disk-space
risk.

**Minimal fix:**

- Rotate at launch:

```sh
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 20971520 ]; then
  mv -f "$LOG" "$LOG.1"
fi
```

- Keep the structured `[perf]` marks.
- After RC-1, suppress repeated identical GPU messages (or drop stderr verbosity for
  the GPU channel) so one incident cannot produce hundreds of megabytes.

## 10. P2 detail: single-instance behavior

```ts
// src/main.ts:2707-2710
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
```

If the previous instance is still shutting down, the new launch silently disappears.
maxwire retries 10 times at 1.5 s and logs why it exits
(`desktop/main.cjs:27-28,310-320`).

**Minimal fix:** retry 3-10 times with a short delay and log each attempt. This
matters most during upgrades and when the launcher is clicked twice.

## 11. Performance explanation: why maxwire feels faster/more stable

### Proven

1. **First paint.** AutoAgent's default path stalls ~1.5-1.8 s after the window is
   mapped (`show: true`). `ready-to-show` is 2190 ms via the shipped launcher and
   1959-1960 ms in real-profile runs; with `--disable-gpu` it is 876 ms / 435 ms.
   The probe isolates this to `in-process-gpu`: 2166 ms vs 401 ms on X11.
2. **Wayland stability.** With `in-process-gpu`, one bad EGLImage/DMABUF binding
   poisons the only GPU context and never recovers (2934 errors/6 s in the probe;
   177,923 context-loss events/745 s in the historical log). Without it, the same
   page on the same compositor produces 0 errors.
3. **Perceived startup.** maxwire maps its window only at `ready-to-show`
   (`desktop/main.cjs:273,285`), so the user never sees an unpainted window.
   AutoAgent maps at ~526 ms and paints at ~2190 ms, which reads as "slow".
4. **Process isolation.** maxwire runs the GPU service out-of-process and the renderer
   sandboxed (`--enable-sandbox`, SUID helper). A GPU fault is recoverable and does
   not take down the UI.

### Hypothesized (not proven)

1. React renderer cost: AutoAgent serves a 7.9 MB `app.js`; maxwire serves a static
   Python-backed page. This may add main-thread/render work, but no isolated
   measurement was made. The DOM load is already ~640 ms, so it does not explain the
   1.5 s gap.
2. Electron version: maxwire uses 43.2.0, AutoAgent uses 41.3.0. Newer Chromium may
   have better ozone/GPU handling. Not isolated in this investigation.
3. Profile/cache state: the real AutoAgent profile has a 54 MB `Cache` and 4.6 MB
   `GPUCache`; cache warmth can shift timings by a few hundred ms. The paired A/B
   results control for this.

### Bottom line

maxwire is not faster at loading. It is **more stable and feels faster** because it
never presents an unpainted window and does not poison the UI with a broken
in-process GPU context. Fixing RC-1 + RC-4 should remove most of the perceptual gap.

## 12. Recommended first three fixes

1. **Remove `in-process-gpu` from `src/main.ts` (RC-1).**
   Largest effect: eliminates the Wayland storm and cuts ~1.3-1.8 s off first paint
   on X11. No replacement flag needed.
2. **Show the window on `ready-to-show` instead of `show: true` (RC-4).**
   One-line behavior fix that removes the white-window period and makes startup feel
   deterministic regardless of GPU timing.
3. **Fix the sandbox packaging (RC-3).**
   `chmod 4755` the helper in build + postinst, remove unconditional `--no-sandbox`.
   This restores process isolation and prevents a GPU fault from cascading.

RC-2 (explicit ozone selection) should be applied in the same batch, after RC-1.

## 13. Wayland verification status and blockers

- A real Wayland server was obtained with the installed `gnome-shell 46.2`
  (`--nested --wayland`) under an isolated `XDG_RUNTIME_DIR` and a private dbus
  session. It reproduced the EGLImage/DMABUF failure on the same i915 hardware.
- Remaining blockers:
  - No standalone compositor (`weston`/`cage`/`sway`/`wayfire`) is installed; the
    nested GNOME Shell is the only available path and requires `dbus-run-session`.
  - Current login session is X11, so the user's actual Wayland session cannot be
    exercised without logging out.
  - The nested compositor has no panel/taskbar, so Wayland `app_id`, icon grouping,
    and portal behavior remain unverified.
  - Verifying the RC-1 fix under Wayland still requires a rebuild; the probe proves
    the mechanism but the shipped bundle's `main.js` has the switch baked in at
    `/usr/lib/autoagent/main.js:17707`.
