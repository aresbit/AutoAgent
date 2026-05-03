#!/usr/bin/env bash
set -euo pipefail

# Build AutoAgent .deb package
# Bundles bun runtime + bundled JS → zero external dependencies
# Prerequisites: bun, dpkg-deb

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PACKAGING_DIR="${PROJECT_DIR}/packaging/deb"
OPENCC_DIST_DIR="${PROJECT_DIR}/packages/opencc/dist"
DESKTOP_DIST_DIR="${PROJECT_DIR}/dist"

VERSION="${1:-0.2.0}"
DEB_NAME="autoagent_${VERSION}_amd64.deb"
OUTPUT_DIR="${PROJECT_DIR}/dist"

echo "=== AutoAgent .deb Builder ==="
echo "Version: ${VERSION}"

# Step 1: Bundle JS — CLI engine + Desktop app
echo ""
echo "[1/7] Bundling CLI engine..."
cd "${PROJECT_DIR}/packages/opencc"
bun build src/entrypoints/cli.tsx --outdir dist --target bun 2>&1
echo "  CLI bundle: $(du -h "${OPENCC_DIST_DIR}/cli.js" | cut -f1)"

echo "[2/7] Bundling Desktop app..."
cd "${PROJECT_DIR}"
bun run build:desktop 2>&1
echo "  main.js:    $(du -h "${DESKTOP_DIST_DIR}/main.js" | cut -f1)"
echo "  preload.cjs: $(du -h "${DESKTOP_DIST_DIR}/preload.cjs" | cut -f1)"
echo "  client/:    $(du -sh "${DESKTOP_DIST_DIR}/client" | cut -f1)"

# Step 3: Copy runtime binaries (bun + rg + electron) into the package
echo "[3/7] Staging runtime binaries..."
BUN_BIN="$(command -v bun)"
RG_BIN="${RG_BIN:-$(command -v rg)}"
ELECTRON_DIST="${PROJECT_DIR}/node_modules/electron/dist"
mkdir -p "${PACKAGING_DIR}/usr/lib/autoagent"
mkdir -p "${PACKAGING_DIR}/usr/bin"

cp "${BUN_BIN}" "${PACKAGING_DIR}/usr/lib/autoagent/bun"
strip "${PACKAGING_DIR}/usr/lib/autoagent/bun" 2>/dev/null || true
echo "  bun:     $(du -h "${PACKAGING_DIR}/usr/lib/autoagent/bun" | cut -f1)"

# Keep rg private to the app at /usr/lib/autoagent/rg (not /usr/bin/rg, which
# would conflict with the system ripgrep package). The JS ripgrep resolver finds
# it next to __dirname before falling back to /usr/bin/rg.
if [ -n "${RG_BIN}" ] && [ -x "${RG_BIN}" ]; then
  cp "${RG_BIN}" "${PACKAGING_DIR}/usr/lib/autoagent/rg"
else
  echo "Error: rg binary not found. Install ripgrep or set RG_BIN." >&2
  exit 1
fi
strip "${PACKAGING_DIR}/usr/lib/autoagent/rg" 2>/dev/null || true
echo "  rg:      $(du -h "${PACKAGING_DIR}/usr/lib/autoagent/rg" | cut -f1)"

# Bundle Electron so the desktop app is self-contained.
if [ -x "${ELECTRON_DIST}/electron" ]; then
  rsync -a "${ELECTRON_DIST}/" "${PACKAGING_DIR}/usr/lib/autoagent/electron-dist/"
  # symlink so find_electron() picks it up
  ln -sf "electron-dist/electron" "${PACKAGING_DIR}/usr/lib/autoagent/electron"
  echo "  electron: $(du -h "${ELECTRON_DIST}/electron" | cut -f1)"
else
  echo "Error: electron not found at ${ELECTRON_DIST}/electron. Run 'bun install' first." >&2
  exit 1
fi

# Step 4: Update version in control file
echo "[4/7] Updating package metadata..."
sed -i "s/^Version:.*/Version: ${VERSION}/" "${PACKAGING_DIR}/DEBIAN/control"

# Step 5: Copy bundled JS to packaging
echo "[5/7] Staging JS bundles..."
cp "${OPENCC_DIST_DIR}/cli.js" "${PACKAGING_DIR}/usr/lib/autoagent/cli.js"
cp "${DESKTOP_DIST_DIR}/main.js" "${PACKAGING_DIR}/usr/lib/autoagent/main.js"
cp "${DESKTOP_DIST_DIR}/preload.cjs" "${PACKAGING_DIR}/usr/lib/autoagent/preload.cjs"
rm -rf "${PACKAGING_DIR}/usr/lib/autoagent/client"
cp -r "${DESKTOP_DIST_DIR}/client" "${PACKAGING_DIR}/usr/lib/autoagent/client"
# Copy autowork prompt assets for desktop replica / imagine features
rm -rf "${PACKAGING_DIR}/usr/lib/autoagent/autowork"
cp -r "${DESKTOP_DIST_DIR}/autowork" "${PACKAGING_DIR}/usr/lib/autoagent/autowork"
# Copy artifact preload for standalone artifact windows
cp "${DESKTOP_DIST_DIR}/artifact-preload.cjs" "${PACKAGING_DIR}/usr/lib/autoagent/artifact-preload.cjs"
# Copy app icon for BrowserWindow (dock/taskbar icon)
cp "${PROJECT_DIR}/assets/icon.png" "${PACKAGING_DIR}/usr/lib/autoagent/icon.png"
# Sync hicolor theme icons from assets
cp "${PROJECT_DIR}/assets/icon_16x16.png" "${PACKAGING_DIR}/usr/share/icons/hicolor/16x16/apps/autoagent.png"
cp "${PROJECT_DIR}/assets/icon_32x32.png" "${PACKAGING_DIR}/usr/share/icons/hicolor/32x32/apps/autoagent.png"
cp "${PROJECT_DIR}/assets/icon_48x48.png" "${PACKAGING_DIR}/usr/share/icons/hicolor/48x48/apps/autoagent.png"
cp "${PROJECT_DIR}/assets/icon_64x64.png" "${PACKAGING_DIR}/usr/share/icons/hicolor/64x64/apps/autoagent.png"
cp "${PROJECT_DIR}/assets/icon_128x128.png" "${PACKAGING_DIR}/usr/share/icons/hicolor/128x128/apps/autoagent.png"
cp "${PROJECT_DIR}/assets/icon_256x256.png" "${PACKAGING_DIR}/usr/share/icons/hicolor/256x256/apps/autoagent.png"
cp "${PROJECT_DIR}/assets/icon_512x512.png" "${PACKAGING_DIR}/usr/share/icons/hicolor/512x512/apps/autoagent.png"

# Step 6: Set permissions
echo "[6/7] Setting permissions..."
chmod 755 "${PACKAGING_DIR}/DEBIAN/postinst"
chmod 755 "${PACKAGING_DIR}/usr/bin/autoagent"
chmod 755 "${PACKAGING_DIR}/usr/lib/autoagent/bun"
chmod 755 "${PACKAGING_DIR}/usr/lib/autoagent/rg"
chmod 755 "${PACKAGING_DIR}/usr/lib/autoagent/electron-dist/electron"
chmod 755 "${PACKAGING_DIR}/usr/lib/autoagent/electron-dist/chrome-sandbox" 2>/dev/null || true
chmod 755 "${PACKAGING_DIR}/usr/lib/autoagent/electron-dist/chrome_crashpad_handler" 2>/dev/null || true
chmod 644 "${PACKAGING_DIR}/usr/lib/autoagent/cli.js"
chmod 644 "${PACKAGING_DIR}/usr/lib/autoagent/main.js"
chmod 644 "${PACKAGING_DIR}/usr/lib/autoagent/preload.cjs"
chmod 644 "${PACKAGING_DIR}/usr/lib/autoagent/artifact-preload.cjs"
chmod 644 "${PACKAGING_DIR}/usr/lib/autoagent/icon.png"
chmod 644 "${PACKAGING_DIR}/usr/lib/autoagent/package.json"
find "${PACKAGING_DIR}/usr/lib/autoagent/client" -type f -exec chmod 644 {} \;
find "${PACKAGING_DIR}/usr/lib/autoagent/autowork" -type f -exec chmod 644 {} \;
find "${PACKAGING_DIR}/usr/share/icons" -type f -exec chmod 644 {} \;
find "${PACKAGING_DIR}/usr/share/applications" -type f -exec chmod 644 {} \;

# Ensure all files are owned by root:root for .deb correctness
chown -R root:root "${PACKAGING_DIR}" 2>/dev/null || true

# Step 7: Build the .deb
echo "[7/7] Building .deb package..."
mkdir -p "${OUTPUT_DIR}"
dpkg-deb --root-owner-group --build "${PACKAGING_DIR}" "${OUTPUT_DIR}/${DEB_NAME}"

echo ""
echo "============================================"
echo "  Package built: ${OUTPUT_DIR}/${DEB_NAME}"
echo "  Size: $(du -h "${OUTPUT_DIR}/${DEB_NAME}" | cut -f1)"
echo "============================================"
echo ""
echo "Install with:"
echo "  sudo dpkg -i ${OUTPUT_DIR}/${DEB_NAME}"
echo ""
echo "Inspect with:"
echo "  dpkg-deb --info ${OUTPUT_DIR}/${DEB_NAME}"
echo "  dpkg-deb --contents ${OUTPUT_DIR}/${DEB_NAME}"
