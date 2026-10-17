# Runtime Diagnosis: AutoAgent Linux startup, X11 vs Wayland, and GPU path

Date: 2026-10-17
Author: Atlas (runtime/protocol diagnostician)
Scope: read-only diagnosis. No source files were modified. All artifacts are under
`/home/tars/yysapp/AutoAgent/docs/cross-platform/`.

## 1. Environment

| Item | Value |
|---|---|
| OS | Ubuntu 24.04, kernel 7.0.0-38-generic |
| Session | `XDG_SESSION_TYPE=x11`, `DISPLAY=:1`, `WAYLAND_DISPLAY` empty |
| Desktop | GNOME (`XDG_CURRENT_DESKTOP=ubuntu:GNOME`) |
| GPU | Intel Raptor Lake-S UHD Graphics `[8086:a78b]`, driver `i915`; `/dev/dri/renderD128`, `renderD129` |
| AutoAgent installed | `autoagent 0.8.1` (`dpkg`), Electron `41.3.0` at `/usr/lib/autoagent/electron-dist` |
| AutoAgent launcher | `/usr/bin/autoagent` (identical to `packaging/deb/usr/bin/autoagent`) |
| maxwire installed | `/opt/maxwire`, Electron `43.2.0`, `chrome-sandbox` mode `4755` |
| Window tools | `xwininfo`, `xprop` present; `xdotool`, `wmctrl` absent |
| Compositors | `weston`, `cage`, `sway`, `wayfire`, `kwin_wayland`, `labwc`, `river`, `hyprland`, `gamescope` absent. `gnome-shell 46.2` (mutter 46.2) supports `--nested --wayland`. |

No Wayland socket existed in `$XDG_RUNTIME_DIR` and the session is X11. A real Wayland
environment was nevertheless obtained with the installed `gnome-shell` nested compositor
(see section 6).

## 2. Method and process containment

- Every GUI run used `setsid` and was terminated with `kill -TERM -- -$pid`
  (process group), followed by `kill -KILL` if needed.
- Most runs used a throwaway `HOME` (`/tmp/atlas-*`) so the user's `~/.config/autoagent`
  and single-instance lock were untouched.
- Runs against the real profile were used only for timing comparison.
- After every batch: `pgrep -af '/usr/lib/autoagent/electron'` and `ss -ltn 'sport = :8081'`
  were checked. No GUI, server, or engine processes were left behind.
- The minimal probe app is at `docs/cross-platform/evidence/probe-app/`. It loads a
  `data:` page with a 20 fps canvas; it is not part of the product.

Representative invocation:

```sh
setsid env HOME=/tmp/atlas-home DISPLAY=:1 \
  timeout -s TERM 15 /usr/lib/autoagent/electron --no-sandbox \
  [FLAGS] /usr/lib/autoagent/main.js >> evidence.log 2>&1 &
spid=$!
# poll: xwininfo -root -tree | grep '("autoagent"'
kill -TERM -- -"$spid"; sleep 2; kill -KILL -- -"$spid"
```

Window detection initially matched a Nautilus window whose title is "AutoAgent"
(the file manager was showing this repository). Results below use WM_CLASS matching
(`("autoagent" "autoagent")`) instead of title matching.

## 3. X11 matrix (installed build, isolated HOME)

All runs: Electron 41.3.0, `--no-sandbox`, app path `/usr/lib/autoagent/main.js`.

| Case | Ozone flag | Other flags | Window seen (WM_CLASS) | `did-finish-load` | `ready-to-show` | GPU error lines | Exit |
|---|---|---|---|---|---|---|---|
| x11-baseline | none | none | yes, `("autoagent" "autoagent")` | 837 ms | not observed before kill | 0 | 143 (timeout TERM) |
| x11-ozone-x11 | `--ozone-platform=x11` | none | yes, 1200x870+360+84 | 674 ms | 878 ms | 0 | 143 |
| x11-disable-gpu | none | `--disable-gpu` | yes | 646 ms | 843 ms | 0 | 143 |
| x11-disable-gpu-swrast | none | `--disable-gpu --disable-software-rasterizer` | yes | 668 ms | 880 ms | 0 | 143 |
| wayland-explicit (no compositor) | `--ozone-platform=wayland` | none | no | never (only module init) | never | 0 | **139 (SIGSEGV)** |

Key raw excerpt (`evidence/wayland-explicit.log`):

```
[perf] +0ms (Δ0ms) module init done
ERROR:ui/ozone/platform/wayland/host/wayland_connection.cc:202] Failed to connect to Wayland display: 没有那个文件或目录 (2)
ERROR:ui/ozone/platform/wayland/ozone_platform_wayland.cc:281] Failed to initialize Wayland platform
```

Forcing Wayland with no compositor does not fail gracefully: the process dies with
SIGSEGV (exit 139), it does not print a user-visible error or exit cleanly.

## 4. Real-profile timing (window mapped vs first paint)

The shipped `show: true` maps the window almost immediately; `ready-to-show` is the
first-paint milestone. The gap is a blank/white window.

| Case | `did-finish-load` | `ready-to-show` | First-paint delay |
|---|---|---|---|
| real-default (in-process GPU, real profile) | 385 ms | **1959 ms** | ~1574 ms |
| real-ozone-x11 (same, explicit x11) | 422 ms | **1960 ms** | ~1538 ms |
| real-disable-gpu | 434 ms | **435 ms** | ~1 ms |

Shipped launcher `/usr/bin/autoagent`, isolated HOME, 100 ms window polling:

| Case | Window mapped | `did-finish-load` | `ready-to-show` |
|---|---|---|---|
| `/usr/bin/autoagent` | **526 ms** | 639 ms | **2190 ms** |
| `/usr/bin/autoagent --disable-gpu` | 529 ms | 673 ms | **876 ms** |

So the window is visible at ~0.53 s but unpainted for another ~1.66 s with the default
GPU path. With `--disable-gpu`, first paint lands at 876 ms.

Raw excerpt (`evidence/launcher-default` log is under
`/tmp/atlas-aa-launcher-default/.local/share/autoagent/autoagent.log`, copied values):

```
[perf] +324ms (Δ36ms) BrowserWindow created
[perf] +639ms did-finish-load
[perf] +639ms (Δ316ms) loadURL done
[perf] +639ms (Δ316ms) window created
[perf] +2190ms ready-to-show
```

## 5. Historical log storm: what actually happened

The 223 MB `~/.local/share/autoagent/autoagent.log` contains three launches
(`module init done` at lines 1, 578037, 1601758). The long GPU storm sits entirely
inside **launch #2** (PID 279510), not the latest launch.

Launch #2 (`evidence` is in the user log, not modified):

```
[perf] +401ms did-finish-load
[perf] +403ms ready-to-show
...
[279510:1017/001552.495087:ERROR:ui/gl/angle_platform_impl.cc:47]
  ImageEGL.cpp:112 (operator()): eglCreateImage failed with 0x00003009
[279510:1017/001552.495111:ERROR:ui/gl/scoped_egl_image.cc:23]
  Failed to create EGLImage: EGL_SUCCESS
[279510:1017/001552.495114:ERROR:ui/ozone/common/native_pixmap_egl_binding.cc:75]
  Unable to initialize binding from pixmap
[279510:1017/001552.495126:ERROR:gpu/command_buffer/service/shared_image/ozone_image_backing.cc:315]
  OzoneImageBacking::ProduceSkiaGanesh failed to create GL representation
[279510:1017/001552.495256:ERROR:gpu/command_buffer/service/raster_decoder.cc:1120]
  RasterDecoderImpl: Context lost during MakeCurrent.
...
```

Measured extent of launch #2:

| Metric | Value |
|---|---|
| First error | 00:15:52.495 |
| Last error | 00:28:18.051 |
| Duration | 745.56 s |
| `Context lost during MakeCurrent` | 177,923 (~238.6/s) |
| `eglCreateImage failed` | 88,970 |
| `OzoneImageBacking` failures | 44,485 (~59.7/s) |
| `RasterDecoderImpl` context lost | 177,923 |

Interpretation: the page **did** load and the window **did** show at +403 ms, but it
then failed to keep painting for 12.5 minutes. This is a rendering-liveness failure,
not a load failure. Launch #3 (10:24) has zero GPU errors and `ready-to-show` at
+2047 ms, i.e. the slow-but-correct case reproduced in section 4.

Caveat: the historical log does not record which session type launch #2 ran under.
The error signature is exactly the one reproduced below when the current build is
forced onto Wayland with `in-process-gpu` enabled.

## 6. Wayland reproduction

### 6.1 Nested compositor

No standalone compositor is installed. A real Wayland server was started with the
installed GNOME Shell:

```sh
RT=/tmp/atlas-wl-runtime; mkdir -m 700 "$RT"
setsid env XDG_RUNTIME_DIR="$RT" DISPLAY=:1 XDG_SESSION_TYPE=wayland \
  dbus-run-session -- gnome-shell --nested --wayland --no-x11 --sm-disable
```

Result (`evidence/gnome-nested.log`):

```
libmutter-Message: Running GNOME Shell (using mutter 46.2) as a Wayland display server
libmutter-Message: Using Wayland display name 'wayland-0'
```

Socket `/tmp/atlas-wl-runtime/wayland-0` appeared after 2 s. The compositor was
terminated and verified stopped after testing.

### 6.2 AutoAgent on Wayland (installed build, `--no-sandbox`)

| Case | Flags | `did-finish-load` | `ready-to-show` | GPU error lines in 9 s | Exit |
|---|---|---|---|---|---|
| wl-auto | none (Electron auto-select) | 612 ms | 837 ms | **3474** | 0 |
| wl-explicit | `--ozone-platform=wayland` | 605 ms | 814 ms | **4762** | 0 |
| wl-x11 | `--ozone-platform=x11` | 694 ms | 901 ms | **0** | 143 |
| wl-explicit-disable-gpu | `--ozone-platform=wayland --disable-gpu` | 619 ms | 814 ms | **0** | 0 |

Two conclusions:

1. **Electron 41.3 auto-selects Wayland when `WAYLAND_DISPLAY` is set.** A verbose
   run with no ozone flag binds `libwayland-client.so.0` in the main process and logs
   from `ui/ozone/platform/wayland/...`; no X11 connection is opened. Therefore the
   missing `--ozone-platform` in the launcher is not currently causing
   protocol misselection on this Electron version, though it makes selection implicit.
2. **The Wayland GPU storm is caused by the GPU path, not by protocol selection
   alone.** Forcing X11 gives zero errors; disabling GPU on Wayland gives zero errors.

### 6.3 Isolation probe: `in-process-gpu` is the trigger

Probe: `evidence/probe-app/` (`main.cjs`). `TEST_INPROC=1` adds only
`app.commandLine.appendSwitch('in-process-gpu')`; the page and hardware are identical.

| Probe case | Environment | Flags | `did-finish-load` | `ready-to-show` | GPU errors in 6 s |
|---|---|---|---|---|---|
| wl-probe-ipgpu | Wayland | none | 456 ms | 482 ms | **2934 / 2917** |
| wl-probe-noipgpu | Wayland | none | 405 ms | 414 ms | **0** |
| x11-probe-ipgpu | X11 | none | 437 ms | **2166 ms** | 0 |
| x11-probe-noipgpu | X11 | none | 327 ms | **401 ms** | 0 |
| wl-probe-ipgpu-nocompositing | Wayland | `--disable-gpu-compositing` | 416 ms | 444 ms | **0** |

Error kinds with Wayland + `in-process-gpu` (one 6 s run):

```
1072 Context lost          1072 MakeCurrent
 536 eglCreateImage         268 Failed to create EGLImage
 268 OzoneImageBacking      522 SharedImageStub
 268 Unable to initialize binding
```

This is a controlled A/B: the single `in-process-gpu` switch, on Wayland, changes
the result from 0 errors to ~2900 errors in 6 seconds. On X11 the same switch does
not error, but adds ~1.76 s to first paint (2166 ms vs 401 ms).

## 7. Sandbox behavior

```
$ /usr/lib/autoagent/electron --version
FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper
binary was found, but is not configured correctly. ... chrome-sandbox is owned by
root and has mode 4755.
exit=133

$ /usr/lib/autoagent/electron --no-sandbox --version
v41.3.0
exit=0
```

Installed permission:

```
$ stat -c '%a %U:%G %n' /usr/lib/autoagent/electron-dist/chrome-sandbox
755 root:root /usr/lib/autoagent/electron-dist/chrome-sandbox

$ stat -c '%a %U:%G %n' /opt/maxwire/desktop/chrome-sandbox
4755 root:root /opt/maxwire/desktop/chrome-sandbox
```

Launching the app without `--no-sandbox` reproduces the same FATAL and exit 133
(`evidence/sandbox-fatal.log`). The launcher hides this by always passing
`--no-sandbox` (`packaging/deb/usr/bin/autoagent:27`).

## 8. maxwire comparison (isolated HOME/XDG, no production instance running)

`pgrep -af maxwire` was empty and port 8081 was free before launch.

```
setsid env HOME=/tmp/atlas-maxwire-home XDG_CONFIG_HOME=... XDG_DATA_HOME=... \
  XDG_STATE_HOME=... XDG_RUNTIME_DIR=... DISPLAY=:1 \
  timeout -s TERM 20 /usr/bin/maxwire-app
```

Observed:

| Metric | Result |
|---|---|
| Window (`WM_CLASS` maxwire) | **1480 ms**, 1440x900 |
| Backend health | `{"ok": true, "db": "ok", "version": "5.0.0", ...}` |
| GPU process | **out-of-process** (`--type=gpu-process --ozone-platform=x11`) |
| Renderer sandbox | `--enable-sandbox`, zygote launched through `chrome-sandbox` mode 4755 |
| Shutdown | launcher exit 0, `maxwire stop` ran, no processes left, port 8081 free |
| Desktop log | timestamped, one line per lifecycle event |

Process tree excerpt:

```
/opt/maxwire/desktop/electron /opt/maxwire/desktop/resources/app
  \_ electron --type=zygote --no-zygote-sandbox
  |   \_ /opt/maxwire/desktop/chrome-sandbox ... --type=zygote
  |       \_ electron --type=renderer ... --enable-sandbox --ozone-platform=x11
  \_ electron --type=gpu-process --ozone-platform=x11 ...
  \_ maxwire-server
```

Launch-related code differences:

- `packaging/linux/maxwire-app:21-25` passes `--ozone-platform=wayland` when
  `WAYLAND_DISPLAY` is non-empty, otherwise leaves the default.
- `desktop/main.cjs:273,285` creates the window hidden and shows it only on
  `ready-to-show`.
- `desktop/main.cjs:227-252` waits up to 12 s for backend `/api/health` before
  creating the window; failure is fatal and logged.
- `desktop/main.cjs:310-320` retries the single-instance lock 10 times at 1.5 s.
- `desktop/main.cjs:344-365` uses a non-blocking error box with a 60 s timeout and
  always calls `shutdown()`.
- `desktop/main.cjs:254-264` and `packaging/linux/maxwire-app:33` clean up the
  backend at OS level even if the JS quit path did not run.
- No `in-process-gpu`, no `--no-sandbox`, no forced GPU acceleration anywhere.

Note: maxwire's window time (1480 ms) is **slower** than AutoAgent's DOM load
(~640 ms) because it waits for the Python backend. Its perceptual advantage is not
raw load time; it is that it does not show a window until first paint and its GPU
path is stable.

## 9. Evidence index (absolute paths)

- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/x11-baseline.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/x11-ozone-x11.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/x11-disable-gpu.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/x11-disable-gpu-swrast.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/wayland-explicit.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/sandbox-fatal.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/real-default.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/real-ozone-x11.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/real-disable-gpu.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/gnome-nested.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/wl-auto.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/wl-explicit.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/wl-x11.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/wl-explicit-disable-gpu.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/wl-ipgpu-timed.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/wl-noipgpu-timed.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/x11-ipgpu-timed.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/x11-noipgpu-timed.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/wl-ipgpu-nocompositing.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/wl-auto-verbose.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/maxwire-launch.log`
- `/home/tars/yysapp/AutoAgent/docs/cross-platform/evidence/probe-app/`

## 10. Caveats

- The nested mutter compositor is not the user's production Wayland session. It uses
  the same i915 GPU and driver, and reproduces the exact EGLImage/DMABUF failure
  signature, but it has no panel/taskbar, so icon grouping and `app_id` could not be
  visually verified.
- The 12.5-minute historical storm could not be reproduced on demand in the current
  X11 session. The A/B probe proves the mechanism but not the original session type.
- Timing numbers vary by profile/cache; the paired deltas (same binary, same machine,
  same minute, one switch changed) are the reliable evidence.
