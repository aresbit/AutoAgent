#!/usr/bin/env bash
set -euo pipefail

# Set up an apt repository on GitHub Pages
# Prerequisites: GitHub repo with Pages enabled on gh-pages branch
#
# Usage:
#   1. Run this script: ./scripts/setup-apt-repo.sh
#   2. Push the gh-pages branch to GitHub
#   3. Users add the repo: echo "deb [trusted=yes] https://USER.github.io/REPO/debian ./" | sudo tee /etc/apt/sources.list.d/autoagent.list
#
# For production, replace [trusted=yes] with proper GPG signing.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

REPO_DIR="${PROJECT_DIR}/apt-repo"
DIST="stable"
COMPONENT="main"

echo "=== AutoAgent APT Repository Setup ==="

# Check for required tools
for cmd in dpkg-scanpackages gzip; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Install: sudo apt install dpkg-dev gzip"
    exit 1
  fi
done

# Create repo structure
mkdir -p "${REPO_DIR}/pool/main"
mkdir -p "${REPO_DIR}/dists/${DIST}/${COMPONENT}/binary-all"
mkdir -p "${REPO_DIR}/dists/${DIST}/${COMPONENT}/binary-amd64"

# Copy existing .deb files to pool
echo "[1/4] Copying packages to pool..."
DEB_DIR="${PROJECT_DIR}/dist/deb"
if [[ -d "$DEB_DIR" ]]; then
  cp "${DEB_DIR}"/*.deb "${REPO_DIR}/pool/main/" 2>/dev/null || true
  echo "  Copied $(ls "${DEB_DIR}"/*.deb 2>/dev/null | wc -l) package(s)."
else
  echo "  No packages found in ${DEB_DIR}. Build first: ./scripts/build-deb.sh"
fi

# Generate Packages file
echo "[2/4] Generating Packages index..."
cd "$REPO_DIR"
dpkg-scanpackages --multiversion pool > "${REPO_DIR}/dists/${DIST}/${COMPONENT}/binary-all/Packages"
gzip -kf "${REPO_DIR}/dists/${DIST}/${COMPONENT}/binary-all/Packages"

echo "[3/4] Creating Release file..."
cat > "dists/${DIST}/Release" <<RELEASE
Origin: AutoAgent
Label: AutoAgent
Suite: ${DIST}
Codename: ${DIST}
Architectures: all amd64
Components: ${COMPONENT}
Description: AutoAgent - AI-powered coding agent CLI
Date: $(date -u +"%a, %d %b %Y %H:%M:%S UTC")
RELEASE

echo "[4/4] Apt repo structure ready at ${REPO_DIR}"

echo ""
echo "=== Next Steps ==="
echo ""
echo "1. Initialize gh-pages branch:"
echo "   cd ${PROJECT_DIR}"
echo "   git checkout --orphan gh-pages"
echo "   git rm -rf ."
echo "   cp -r ${REPO_DIR}/* ."
echo "   git add -A"
echo "   git commit -m 'Initialize apt repository'"
echo "   git push origin gh-pages"
echo ""
echo "2. Enable GitHub Pages in repo Settings → Pages → Source: gh-pages"
echo ""
echo "3. Users install via:"
echo "   echo 'deb [trusted=yes] https://<USER>.github.io/<REPO> stable main' | sudo tee /etc/apt/sources.list.d/autoagent.list"
echo "   sudo apt update && sudo apt install autoagent"
echo ""
echo "4. (Recommended) Sign the repo with GPG for production:"
echo "   gpg --default-key YOUR_KEY -bao Release.gpg Release"
echo "   gpg --default-key YOUR_KEY --clear-sign --output InRelease Release"
