#!/usr/bin/env bash
# Build the AutoAgent .deb from a fresh staging directory.
#
# Version authority: package.json. This script never mutates packaging/deb.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

ELECTRON_VERSION="41.3.0"
ELECTRON_ZIP="${PROJECT_DIR}/build-resources/electron-v${ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_SHA256="b20e03cf174f8e56e235127d784dff8161ef4bb9c6bbc3d9383130225eb1e2a2"

PACKAGING_DIR="${PROJECT_DIR}/packaging/deb"
CONTROL_TEMPLATE="${PACKAGING_DIR}/DEBIAN/control"
LAUNCHER_TEMPLATE="${PACKAGING_DIR}/usr/bin/autoagent"
DESKTOP_TEMPLATE="${PACKAGING_DIR}/usr/share/applications/autoagent.desktop"
OUTPUT_DIR="${PROJECT_DIR}/release"
BUILD_LOCK="/tmp/autoagent-build.lock"

export TZ=UTC
export LC_ALL=C

die() {
  echo "[deb] ERROR: $*" >&2
  exit 1
}

log() {
  echo "[deb] $*"
}

# ---------------------------------------------------------------- arguments
EXPECTED_VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      EXPECTED_VERSION="$2"
      shift 2
      ;;
    --version=*)
      EXPECTED_VERSION="${1#*=}"
      shift
      ;;
    *)
      die "unexpected argument: $1 (version comes from package.json)"
      ;;
  esac
done

# ---------------------------------------------------------------- preflight
[ "$(uname -s)" = "Linux" ] || die "the .deb must be built on Linux"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "the .deb must be built on x86_64 (found $(uname -m))" ;;
esac

for tool in bun dpkg-deb unzip sha256sum zipinfo; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
[ -x /usr/bin/desktop-file-validate ] || command -v desktop-file-validate >/dev/null 2>&1 \
  || die "missing required tool: desktop-file-validate (desktop-file-utils)"

# ---------------------------------------------------------------- version
cd "$PROJECT_DIR"

VERSION="$(bun -e 'console.log(require("./package.json").version)' | tr -d '\r\n')"
case "$VERSION" in
  ''|*[!0-9.+~-]*) die "invalid version in package.json: '$VERSION'" ;;
esac
if [ -n "$EXPECTED_VERSION" ] && [ "$EXPECTED_VERSION" != "$VERSION" ]; then
  die "requested version '$EXPECTED_VERSION' does not match package.json version '$VERSION'"
fi

log "version: $VERSION"

# ---------------------------------------------------------------- build
# Kiln may build concurrently; serialize install + build.
log "installing dependencies and building (flock: $BUILD_LOCK)"
# AUTOAGENT_OFFLINE=1 uses the local bun cache and makes no registry calls. The
# lockfile is frozen either way; offline is for build hosts without egress.
BUN_INSTALL_ARGS=(--frozen-lockfile)
if [ "${AUTOAGENT_OFFLINE:-0}" = "1" ]; then
  BUN_INSTALL_ARGS+=(--offline)
fi
run_build() {
  bun install "${BUN_INSTALL_ARGS[@]}"
  (
    cd "$PROJECT_DIR/frontend"
    bun install "${BUN_INSTALL_ARGS[@]}"
    bun run build
  )
  bun build packages/opencc/src/entrypoints/cli.tsx \
    --outdir packages/opencc/dist --target bun
  bun desktop/build.mjs
  if [ "${AUTOAGENT_REUSE_BACKEND:-0}" = "1" ]; then
    log "AUTOAGENT_REUSE_BACKEND=1: keeping backend/build as-is"
  else
    bash scripts/build-backend.sh
  fi
}
if command -v flock >/dev/null 2>&1; then
  ( flock -x 9; run_build ) 9>"$BUILD_LOCK"
else
  run_build
fi

for required in \
  "desktop/dist/entry.js" \
  "desktop/dist/main.js" \
  "desktop/dist/preload.cjs" \
  "desktop/dist/artifact-preload.cjs" \
  "frontend/dist/index.html" \
  "frontend/dist/assets" \
  "backend/build/autoagent-backend" \
  "vendor/matebot/opencc_backend.py" \
  "packages/opencc/dist/cli.js"; do
  [ -e "$PROJECT_DIR/$required" ] || die "build output missing: $required"
done
[ -x "$PROJECT_DIR/backend/build/autoagent-backend" ] \
  || die "backend binary is not executable: backend/build/autoagent-backend"

# ---------------------------------------------------------------- electron
if [ ! -f "$ELECTRON_ZIP" ]; then
  if [ -f "${ELECTRON_ZIP}.part" ]; then
    log "waiting for concurrent Electron download to finish"
    for _ in $(seq 1 900); do
      [ -f "$ELECTRON_ZIP" ] && break
      sleep 1
    done
  fi
  if [ ! -f "$ELECTRON_ZIP" ]; then
    command -v curl >/dev/null 2>&1 || die "missing $ELECTRON_ZIP and curl is unavailable"
    log "downloading Electron ${ELECTRON_VERSION}"
    curl -fL --retry 3 --connect-timeout 20 -o "${ELECTRON_ZIP}.part" "$ELECTRON_URL"
    mv "${ELECTRON_ZIP}.part" "$ELECTRON_ZIP"
  fi
fi
[ -f "$ELECTRON_ZIP" ] || die "missing Electron runtime: $ELECTRON_ZIP"

ACTUAL_ELECTRON_SHA256="$(sha256sum "$ELECTRON_ZIP" | awk '{print $1}')"
[ "$ACTUAL_ELECTRON_SHA256" = "$ELECTRON_SHA256" ] \
  || die "Electron SHA256 mismatch: expected $ELECTRON_SHA256, got $ACTUAL_ELECTRON_SHA256"
if [ -f "${ELECTRON_ZIP}.sha256" ]; then
  RECORDED_ELECTRON_SHA256="$(awk 'NR==1 {print $1}' "${ELECTRON_ZIP}.sha256")"
  [ "$RECORDED_ELECTRON_SHA256" = "$ACTUAL_ELECTRON_SHA256" ] \
    || die "Electron .sha256 sidecar disagrees with the archive"
fi

# ---------------------------------------------------------------- staging
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

ENGINE_DIR="$STAGE/opt/autoagent/engine"
BACKEND_DIR="$STAGE/opt/autoagent/backend"
FRONTEND_DIST="$STAGE/opt/autoagent/frontend/dist"
VENDOR_DIR="$STAGE/opt/autoagent/vendor/matebot"
DESKTOP_DIR="$STAGE/opt/autoagent/desktop"
APP_DIR="$DESKTOP_DIR/resources/app"

mkdir -p \
  "$ENGINE_DIR" \
  "$BACKEND_DIR" \
  "$FRONTEND_DIST" \
  "$VENDOR_DIR" \
  "$APP_DIR" \
  "$STAGE/usr/bin" \
  "$STAGE/usr/share/applications" \
  "$STAGE/usr/share/icons/hicolor" \
  "$STAGE/usr/share/pixmaps" \
  "$STAGE/DEBIAN"

# ---------------------------------------------------------------- runtime
BUN_BIN="${PROJECT_DIR}/build-resources/bun"
if [ ! -x "$BUN_BIN" ]; then
  BUN_BIN="$(command -v bun || true)"
fi
[ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ] || die "bundled bun runtime not found"

RG_BIN="${RG_BIN:-${PROJECT_DIR}/build-resources/rg}"
if [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v rg || true)"
fi
[ -n "$RG_BIN" ] && [ -x "$RG_BIN" ] || die "bundled rg runtime not found (set RG_BIN)"

install -m 0755 "$BUN_BIN" "$ENGINE_DIR/bun"
install -m 0755 "$RG_BIN" "$ENGINE_DIR/rg"
install -D -m 0644 "$PROJECT_DIR/packages/opencc/dist/cli.js" \
  "$ENGINE_DIR/opencc-dist/cli.js"

if command -v strip >/dev/null 2>&1; then
  strip --strip-unneeded "$ENGINE_DIR/bun" 2>/dev/null || true
  strip --strip-unneeded "$ENGINE_DIR/rg" 2>/dev/null || true
fi

"$ENGINE_DIR/bun" --version >/dev/null 2>&1 || die "bundled bun runtime failed to execute"
"$ENGINE_DIR/rg" --version >/dev/null 2>&1 || die "bundled rg runtime failed to execute"

# ---------------------------------------------------------------- backend
# Self-contained Nuitka tree (or embedded-Python fallback); the executable is
# at the top level so the desktop can spawn /opt/autoagent/backend/<binary>.
cp -a "$PROJECT_DIR/backend/build/." "$BACKEND_DIR/"
[ -x "$BACKEND_DIR/autoagent-backend" ] || die "backend executable missing from stage"

# ---------------------------------------------------------------- vendor
# Vendored MateBot is loaded by path at runtime (never bundled into Nuitka).
# Ship Python sources only: no caches, VCS metadata, source maps or node trees.
VENDOR_SRC="$PROJECT_DIR/vendor/matebot"
[ -f "$VENDOR_SRC/opencc_backend.py" ] || die "missing vendor/matebot/opencc_backend.py"
cp -a "$VENDOR_SRC/." "$VENDOR_DIR/"
find "$VENDOR_DIR" -depth \( -name '__pycache__' -o -name 'node_modules' \) \
  -type d -prune -exec rm -rf {} +
find "$VENDOR_DIR" \( -name '*.pyc' -o -name '.git*' -o -name '*.map' \) -delete
[ -f "$VENDOR_DIR/opencc_backend.py" ] || die "vendored MateBot module missing from stage"

log "backend runtime-check from the staged tree"
env -u AUTOAGENT_ENGINE \
  AUTOAGENT_MATEBOT_VENDOR_DIR="$VENDOR_DIR" \
  AUTOAGENT_BUN_PATH="$ENGINE_DIR/bun" \
  AUTOAGENT_OPENCC_CLI_PATH="$ENGINE_DIR/opencc-dist/cli.js" \
  "$BACKEND_DIR/autoagent-backend" --runtime-check >/dev/null \
  || die "staged backend failed --runtime-check"

# ---------------------------------------------------------------- frontend
cp -a "$PROJECT_DIR/frontend/dist/." "$FRONTEND_DIST/"
[ -f "$FRONTEND_DIST/index.html" ] || die "frontend index.html missing from stage"
[ -d "$FRONTEND_DIST/assets" ] || die "frontend assets missing from stage"

# ---------------------------------------------------------------- app payload
install -m 0644 "$PROJECT_DIR/desktop/dist/entry.js" "$APP_DIR/entry.js"
install -m 0644 "$PROJECT_DIR/desktop/dist/main.js" "$APP_DIR/main.js"
install -m 0644 "$PROJECT_DIR/desktop/dist/preload.cjs" "$APP_DIR/preload.cjs"
install -m 0644 "$PROJECT_DIR/desktop/dist/artifact-preload.cjs" "$APP_DIR/artifact-preload.cjs"
install -m 0644 "$PROJECT_DIR/assets/icon.png" "$APP_DIR/icon.png"

cat > "$APP_DIR/package.json" <<APP_PACKAGE_JSON
{"name":"autoagent","version":"${VERSION}","private":true,"type":"module","main":"entry.js"}
APP_PACKAGE_JSON

# ---------------------------------------------------------------- electron
log "extracting Electron ${ELECTRON_VERSION}"
while IFS= read -r entry; do
  case "$entry" in
    /*|..|../*|*/../*|*/..) die "unsafe path in Electron archive: $entry" ;;
  esac
done < <(zipinfo -1 "$ELECTRON_ZIP")

unzip -q "$ELECTRON_ZIP" -d "$DESKTOP_DIR"

[ -x "$DESKTOP_DIR/electron" ] || die "Electron archive did not contain electron"
[ -f "$DESKTOP_DIR/chrome-sandbox" ] || die "Electron archive did not contain chrome-sandbox"

rm -rf "$DESKTOP_DIR/resources/default_app.asar"

# Keep only en-US and zh-CN locales.
if [ -d "$DESKTOP_DIR/locales" ]; then
  find "$DESKTOP_DIR/locales" -maxdepth 1 -type f -name '*.pak' \
    ! -name 'en-US.pak' ! -name 'zh-CN.pak' -delete
fi

# ---------------------------------------------------------------- integration
install -m 0755 "$LAUNCHER_TEMPLATE" "$STAGE/usr/bin/autoagent"
install -m 0644 "$DESKTOP_TEMPLATE" "$STAGE/usr/share/applications/autoagent.desktop"

for size in 16 32 48 64 128 256 512; do
  icon_source="$PROJECT_DIR/assets/icon_${size}x${size}.png"
  [ -f "$icon_source" ] || die "missing icon: $icon_source"
  install -D -m 0644 "$icon_source" \
    "$STAGE/usr/share/icons/hicolor/${size}x${size}/apps/autoagent.png"
done
install -m 0644 "$PROJECT_DIR/assets/icon_512x512.png" "$STAGE/usr/share/pixmaps/autoagent.png"

# Ship a copyright file only when the repository actually carries a license.
for license in \
  "$PROJECT_DIR/LICENSE" \
  "$PROJECT_DIR/LICENSE.md" \
  "$PROJECT_DIR/LICENSE.txt" \
  "$PROJECT_DIR/COPYING"; do
  if [ -f "$license" ]; then
    install -D -m 0644 "$license" "$STAGE/usr/share/doc/autoagent/copyright"
    break
  fi
done

# ---------------------------------------------------------------- control
INSTALLED_KIB="$(find "$STAGE" -path "$STAGE/DEBIAN" -prune -o -type f -printf '%s\n' \
  | awk '{ total += $1 } END { print int((total + 1023) / 1024) }')"

awk -v version="$VERSION" -v size="$INSTALLED_KIB" '
  /^Version:/        { print "Version: " version; next }
  /^Installed-Size:/ { print "Installed-Size: " size; next }
  { print }
' "$CONTROL_TEMPLATE" > "$STAGE/DEBIAN/control"

for script in preinst postinst prerm postrm; do
  [ -f "$PACKAGING_DIR/DEBIAN/$script" ] || die "missing maintainer script: $script"
  install -m 0755 "$PACKAGING_DIR/DEBIAN/$script" "$STAGE/DEBIAN/$script"
done

# ---------------------------------------------------------------- permissions
# Directories 755, regular files 644, then explicit executables.
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod 0644 {} +

chmod 0755 \
  "$STAGE/usr/bin/autoagent" \
  "$STAGE/DEBIAN/preinst" \
  "$STAGE/DEBIAN/postinst" \
  "$STAGE/DEBIAN/prerm" \
  "$STAGE/DEBIAN/postrm" \
  "$ENGINE_DIR/bun" \
  "$ENGINE_DIR/rg" \
  "$BACKEND_DIR/autoagent-backend" \
  "$DESKTOP_DIR/electron" \
  "$DESKTOP_DIR/chrome_crashpad_handler"

# Embedded-Python fallback: the interpreter and its entrypoints must stay
# executable after the blanket 0644 normalization above.
if [ -d "$BACKEND_DIR/python" ]; then
  find "$BACKEND_DIR/python" -type f -path '*/bin/*' -exec chmod 0755 {} +
fi

# Chromium's SUID sandbox: the only setuid file in the package.
chmod 4755 "$DESKTOP_DIR/chrome-sandbox"

# ---------------------------------------------------------------- leak checks
check_stage_leaks() {
  local found
  found="$(find "$STAGE" \
    \( -name node_modules -o -name '*.map' -o -name '.git*' -o -name '*.ts' -o -name '*.tsx' \
       -o -name '__pycache__' -o -name '*.pyc' \) \
    -print -quit)"
  [ -z "$found" ] || die "forbidden build artifact in package: $found"

  if grep -q -- '--no-sandbox' "$STAGE/usr/bin/autoagent"; then
    die "launcher must not pass --no-sandbox"
  fi
  if grep -R -q -- '--no-sandbox' "$STAGE/usr/share/applications" 2>/dev/null; then
    die "desktop entry must not pass --no-sandbox"
  fi
}
check_stage_leaks

# ---------------------------------------------------------------- build
# Deterministic archive metadata.
SOURCE_DATE_EPOCH="$(git -C "$PROJECT_DIR" log -1 --format=%ct 2>/dev/null || true)"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
export SOURCE_DATE_EPOCH

find "$STAGE" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

mkdir -p "$OUTPUT_DIR"
DEB_NAME="autoagent_${VERSION}_amd64.deb"
DEB_PATH="$OUTPUT_DIR/$DEB_NAME"
rm -f "$DEB_PATH" "${DEB_PATH}.sha256"

log "building $DEB_PATH"
dpkg-deb --root-owner-group --uniform-compression -Zxz --build "$STAGE" "$DEB_PATH"

# ---------------------------------------------------------------- verification
check_stage_leaks

[ "$(dpkg-deb -f "$DEB_PATH" Package)" = "autoagent" ] \
  || die "unexpected Package field"
[ "$(dpkg-deb -f "$DEB_PATH" Architecture)" = "amd64" ] \
  || die "unexpected Architecture field"
[ "$(dpkg-deb -f "$DEB_PATH" Version)" = "$VERSION" ] \
  || die "unexpected Version field"

DEPENDS="$(dpkg-deb -f "$DEB_PATH" Depends)"
if printf '%s\n' "$DEPENDS" | grep -Eq 'nodejs|npm|python3|build-essential|unzip'; then
  die "runtime Depends contains a build tool: $DEPENDS"
fi

SUID_LINES="$(dpkg-deb -c "$DEB_PATH" | awk '$1 ~ /^-..s/ {print}')"
SUID_COUNT="$(printf '%s\n' "$SUID_LINES" | grep -c . || true)"
[ "$SUID_COUNT" = "1" ] || die "expected exactly one setuid file, found $SUID_COUNT"
case "$SUID_LINES" in
  *'/opt/autoagent/desktop/chrome-sandbox'*) ;;
  *) die "the setuid file is not chrome-sandbox" ;;
esac

if dpkg-deb -c "$DEB_PATH" | grep -Eq 'node_modules|\.map$|/\.git'; then
  die "forbidden path found in built archive"
fi

if dpkg-deb -c "$DEB_PATH" | grep -q 'resources/default_app.asar'; then
  die "archive still contains resources/default_app.asar"
fi

# Verify the launcher in the built payload, not just the stage.
TMP_EXTRACT="$(mktemp -d)"
trap 'rm -rf "$STAGE" "$TMP_EXTRACT"' EXIT
dpkg-deb -x "$DEB_PATH" "$TMP_EXTRACT"
if grep -q -- '--no-sandbox' "$TMP_EXTRACT/usr/bin/autoagent"; then
  die "installed launcher passes --no-sandbox"
fi
[ -x "$TMP_EXTRACT/opt/autoagent/desktop/electron" ] || die "electron not executable after extraction"
[ -x "$TMP_EXTRACT/opt/autoagent/engine/bun" ] || die "bun not executable after extraction"
[ -x "$TMP_EXTRACT/opt/autoagent/engine/rg" ] || die "rg not executable after extraction"
[ -f "$TMP_EXTRACT/opt/autoagent/engine/opencc-dist/cli.js" ] || die "opencc cli.js missing after extraction"
[ -x "$TMP_EXTRACT/opt/autoagent/backend/autoagent-backend" ] \
  || die "backend binary missing after extraction"
[ -f "$TMP_EXTRACT/opt/autoagent/frontend/dist/index.html" ] \
  || die "frontend index.html missing after extraction"
[ -f "$TMP_EXTRACT/opt/autoagent/vendor/matebot/opencc_backend.py" ] \
  || die "vendored MateBot module missing after extraction"
[ "$(stat -c '%a' "$TMP_EXTRACT/opt/autoagent/vendor/matebot")" = "755" ] \
  || die "vendored MateBot directory mode is not 755"
[ "$(stat -c '%a' "$TMP_EXTRACT/opt/autoagent/vendor/matebot/opencc_backend.py")" = "644" ] \
  || die "vendored MateBot module mode is not 644"
if grep -q 'export AUTOAGENT_ENGINE=' "$TMP_EXTRACT/usr/bin/autoagent"; then
  die "installed launcher sets AUTOAGENT_ENGINE; the backend must default to matebot"
fi
[ -f "$TMP_EXTRACT/opt/autoagent/desktop/resources/app/entry.js" ] \
  || die "entry.js missing after extraction"
[ -f "$TMP_EXTRACT/opt/autoagent/desktop/resources/app/main.js" ] \
  || die "main.js missing after extraction"
[ -f "$TMP_EXTRACT/opt/autoagent/desktop/resources/app/artifact-preload.cjs" ] \
  || die "artifact-preload.cjs missing after extraction"

LDD_MISSING="$(ldd "$TMP_EXTRACT/opt/autoagent/desktop/electron" 2>/dev/null | grep 'not found' || true)"
[ -z "$LDD_MISSING" ] || die "unresolved Electron dependencies: $LDD_MISSING"

LDD_BACKEND_MISSING="$(ldd "$TMP_EXTRACT/opt/autoagent/backend/autoagent-backend" 2>/dev/null | grep 'not found' || true)"
[ -z "$LDD_BACKEND_MISSING" ] || die "unresolved backend dependencies: $LDD_BACKEND_MISSING"

desktop-file-validate "$TMP_EXTRACT/usr/share/applications/autoagent.desktop" \
  || die "desktop entry failed validation"

(
  cd "$OUTPUT_DIR"
  sha256sum "$DEB_NAME" > "${DEB_NAME}.sha256"
)

dpkg-deb --info "$DEB_PATH" >&2
printf '\n' >&2
dpkg-deb -c "$DEB_PATH" | awk '$1 ~ /^-..s/ {print "setuid: " $0}' >&2

log "artifact: $DEB_PATH"
log "size: $(du -h "$DEB_PATH" | cut -f1)"
log "sha256: $(awk '{print $1}' "${DEB_PATH}.sha256")"
log "done"
