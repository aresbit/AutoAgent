#!/usr/bin/env bash
set -euo pipefail

# Build AutoAgent .deb package
# Bundles bun runtime + bundled JS → zero external dependencies
# Prerequisites: bun, dpkg-deb

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PACKAGING_DIR="${PROJECT_DIR}/packaging/deb"
DIST_DIR="${PROJECT_DIR}/packages/opencc/dist"

VERSION="${1:-0.1.0}"
DEB_NAME="autoagent_${VERSION}_amd64.deb"
OUTPUT_DIR="${PROJECT_DIR}/dist/deb"

echo "=== AutoAgent .deb Builder ==="
echo "Version: ${VERSION}"

# Step 1: Bundle JS (not compile — keep Commander.js CLI intact)
echo ""
echo "[1/6] Bundling JS..."
cd "${PROJECT_DIR}/packages/opencc"
bun build src/entrypoints/cli.tsx --outdir dist --target bun 2>&1
echo "  JS bundle: $(du -h "${DIST_DIR}/cli.js" | cut -f1)"

# Step 2: Copy bun runtime binary into the package
echo "[2/6] Staging bun runtime..."
BUN_BIN="$(command -v bun)"
mkdir -p "${PACKAGING_DIR}/usr/lib/autoagent"
cp "${BUN_BIN}" "${PACKAGING_DIR}/usr/lib/autoagent/bun"
strip "${PACKAGING_DIR}/usr/lib/autoagent/bun" 2>/dev/null || true
echo "  bun: $(du -h "${PACKAGING_DIR}/usr/lib/autoagent/bun" | cut -f1)"

# Step 3: Update version in control file
echo "[3/6] Updating package metadata..."
sed -i "s/^Version:.*/Version: ${VERSION}/" "${PACKAGING_DIR}/DEBIAN/control"

# Step 4: Copy bundled JS to packaging
echo "[4/6] Staging JS bundle..."
cp "${DIST_DIR}/cli.js" "${PACKAGING_DIR}/usr/lib/autoagent/cli.js"

# Step 5: Set permissions
echo "[5/6] Setting permissions..."
chmod 755 "${PACKAGING_DIR}/DEBIAN/postinst"
chmod 755 "${PACKAGING_DIR}/usr/bin/autoagent"
chmod 755 "${PACKAGING_DIR}/usr/lib/autoagent/bun"
chmod 644 "${PACKAGING_DIR}/usr/lib/autoagent/cli.js"
find "${PACKAGING_DIR}/usr/share/icons" -type f -exec chmod 644 {} \;
find "${PACKAGING_DIR}/usr/share/applications" -type f -exec chmod 644 {} \;

# Ensure all files are owned by root:root for .deb correctness
chown -R root:root "${PACKAGING_DIR}" 2>/dev/null || true

# Step 6: Build the .deb
echo "[6/6] Building .deb package..."
mkdir -p "${OUTPUT_DIR}"
dpkg-deb --build "${PACKAGING_DIR}" "${OUTPUT_DIR}/${DEB_NAME}"

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
