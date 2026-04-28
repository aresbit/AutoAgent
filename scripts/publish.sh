#!/usr/bin/env bash
set -euo pipefail

# AutoAgent Publisher — bump version, build .deb, create GitHub Release
# Usage: ./scripts/publish.sh <version> [--dry-run]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

VERSION="${1:?Usage: $0 <version> [--dry-run]}"
shift
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

DEB_NAME="autoagent_${VERSION}_all.deb"
DEB_PATH="${PROJECT_DIR}/dist/deb/${DEB_NAME}"

echo "=== AutoAgent Publisher v${VERSION} ==="
echo ""

# --- Guard checks ---
if ! command -v gh &>/dev/null; then
  echo "ERROR: gh (GitHub CLI) not found. Install: https://cli.github.com"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "ERROR: gh not authenticated. Run: gh auth login"
  exit 1
fi

REMOTE="$(cd "$PROJECT_DIR" && git remote get-url origin 2>/dev/null || echo "")"
if [[ -z "$REMOTE" ]]; then
  echo "ERROR: No git remote 'origin' configured."
  exit 1
fi

REPO="$(echo "$REMOTE" | sed 's|.*github\.com[:/]||;s|\.git$||')"
COMMIT="$(cd "$PROJECT_DIR" && git rev-parse --short HEAD)"
TAG="v${VERSION}"

echo "  Remote : $REMOTE"
echo "  Repo   : $REPO"
echo "  Commit : $COMMIT"
echo "  Tag    : $TAG"
echo ""

# --- Step 1: Bump versions ---
echo "[1/5] Bumping version to ${VERSION}..."
cd "$PROJECT_DIR"

# Update control file
sed -i "s/^Version:.*/Version: ${VERSION}/" packaging/deb/DEBIAN/control

# Update root package.json if it exists
[[ -f package.json ]] && {
  tmp=$(mktemp)
  jq --arg v "$VERSION" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json
}

echo "  Version files updated."

# --- Step 2: Build .deb ---
echo "[2/5] Building .deb package..."
bash scripts/build-deb.sh "$VERSION"

if [[ ! -f "$DEB_PATH" ]]; then
  echo "ERROR: .deb not found at ${DEB_PATH}"
  exit 1
fi
echo "  Built: ${DEB_PATH} ($(du -h "$DEB_PATH" | cut -f1))"

# --- Step 3: Commit & tag ---
echo "[3/5] Committing version bump..."
cd "$PROJECT_DIR"
git add packaging/deb/DEBIAN/control package.json 2>/dev/null || true
git commit -m "chore: bump version to ${VERSION}" || echo "  (nothing to commit)"

echo "[4/5] Creating tag ${TAG}..."
if git rev-parse "$TAG" &>/dev/null; then
  echo "  Tag ${TAG} already exists, skipping."
else
  git tag -a "$TAG" -m "AutoAgent ${TAG}"
fi

# --- Step 4: Push ---
if $DRY_RUN; then
  echo "[DRY RUN] Would push commit + tag to origin."
  echo "[DRY RUN] Would create GitHub release: gh release create ${TAG} ${DEB_PATH} ..."
else
  echo "[5/5] Pushing to remote..."
  git push origin HEAD
  git push origin "$TAG"

  # --- Step 5: GitHub Release ---
  echo ""
  echo "Creating GitHub Release..."
  gh release create "$TAG" "$DEB_PATH" \
    --title "AutoAgent ${TAG}" \
    --notes "$(cat <<EOF
## What's new in ${TAG}

### Install
\`\`\`bash
# Download and install the .deb
wget https://github.com/${REPO}/releases/download/${TAG}/${DEB_NAME}
sudo dpkg -i ${DEB_NAME}

# Or via apt (if apt repo configured)
# sudo apt install autoagent
\`\`\`

### SDK (npm)
\`\`\`bash
npm install @codeany/open-agent-sdk
\`\`\`

**Full Changelog**: https://github.com/${REPO}/compare/...${TAG}
EOF
)"

  echo ""
  echo "============================================"
  echo "  Published: AutoAgent ${TAG}"
  echo "  Release:  https://github.com/${REPO}/releases/tag/${TAG}"
  echo "  .deb:     https://github.com/${REPO}/releases/download/${TAG}/${DEB_NAME}"
  echo "============================================"
fi
