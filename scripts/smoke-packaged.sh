#!/usr/bin/env bash
# Smoke-test a built .deb without installing it system-wide.
#
#   scripts/smoke-packaged.sh [release/autoagent_<v>_amd64.deb] [--gui]
#
# Extracts the package into a disposable tree and verifies:
#   - backend --version / --runtime-check
#   - /api/health, / (SPA index), and one hashed /assets/* file
#   - one fake-engine turn over SSE
#   - clean SIGTERM shutdown with no orphan
#   - setuid chrome-sandbox, leak checks, desktop entry, ldd, Depends
# With --gui (and DISPLAY set) it also launches Electron with --no-sandbox and
# asserts the window-ready/backend-ready log lines. GUI smoke never installs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

DEB=""
GUI=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --gui) GUI=1; shift ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      [ -z "$DEB" ] || { echo "[smoke] ERROR: multiple .deb arguments" >&2; exit 1; }
      DEB="$1"
      shift
      ;;
  esac
done

die() {
  echo "[smoke] ERROR: $*" >&2
  exit 1
}

log() {
  echo "[smoke] $*"
}

if [ -z "$DEB" ]; then
  DEB="$(ls -1t "$PROJECT_DIR"/release/autoagent_*_amd64.deb 2>/dev/null | head -1 || true)"
fi
[ -n "$DEB" ] && [ -f "$DEB" ] || die "no .deb found (pass a path or run scripts/build-deb.sh)"
DEB="$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")"

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}
need dpkg-deb
need curl
need python3

TMP="$(mktemp -d)"
ROOT="$TMP/root"
APP="$ROOT/opt/autoagent"
BIN="$APP/backend/autoagent-backend"
TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
DATA="$TMP/data"
STATE="$TMP/state"
LOGS="$STATE/logs"
WORKSPACE="$TMP/workspace"
SERVER_PID=""
GUI_PID=""

cleanup() {
  set +e
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  if [ -n "$GUI_PID" ] && kill -0 "$GUI_PID" 2>/dev/null; then
    kill -TERM "$GUI_PID" 2>/dev/null
    sleep 1
    kill -KILL "$GUI_PID" 2>/dev/null
    wait "$GUI_PID" 2>/dev/null
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

find_free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

wait_healthy() {
  local port="$1" pid="$2"
  for _ in $(seq 1 150); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$port/api/health" >"$TMP/health.json" 2>/dev/null; then
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.1
  done
  return 1
}

log "deb: $DEB ($(du -h "$DEB" | cut -f1))"
mkdir -p "$ROOT"
dpkg-deb -x "$DEB" "$ROOT"

# ---------------------------------------------------------------- static audit
[ -x "$BIN" ] || die "backend executable missing from package"
[ -x "$APP/engine/bun" ] || die "engine/bun missing from package"
[ -f "$APP/engine/opencc-dist/cli.js" ] || die "engine/opencc-dist/cli.js missing"
[ -f "$APP/frontend/dist/index.html" ] || die "frontend/dist/index.html missing"
[ -f "$APP/vendor/matebot/opencc_backend.py" ] || die "vendor/matebot/opencc_backend.py missing"
[ "$(stat -c '%a' "$APP/vendor/matebot")" = "755" ] || die "vendor directory mode is not 755"
[ "$(stat -c '%a' "$APP/vendor/matebot/opencc_backend.py")" = "644" ] \
  || die "vendored module mode is not 644"
[ -f "$APP/desktop/resources/app/entry.js" ] || die "desktop entry.js missing"
[ -f "$APP/desktop/resources/app/main.js" ] || die "desktop main.js missing"
[ -f "$APP/desktop/resources/app/artifact-preload.cjs" ] || die "artifact preload missing"
[ -f "$ROOT/usr/share/applications/autoagent.desktop" ] || die "desktop entry missing"

SUID_LIST="$(dpkg-deb -c "$DEB" | awk '$1 ~ /^-..s/ {print $1, $2, $6}')"
SUID_COUNT="$(printf '%s\n' "$SUID_LIST" | grep -c . || true)"
[ "$SUID_COUNT" = "1" ] || die "expected exactly one setuid file, found $SUID_COUNT: $SUID_LIST"
case "$SUID_LIST" in
  "-rwsr-xr-x root/root ./opt/autoagent/desktop/chrome-sandbox") ;;
  *) die "unexpected setuid entry: $SUID_LIST" ;;
esac
log "setuid: $SUID_LIST"

LEAKS="$(find "$ROOT" \( -name node_modules -o -name '*.map' -o -name '.git*' \) -print -quit)"
[ -z "$LEAKS" ] || die "forbidden artifact in package: $LEAKS"
if grep -R -q -- '--no-sandbox' "$ROOT/usr/bin" "$ROOT/usr/share/applications"; then
  die "launcher or desktop entry passes --no-sandbox"
fi
if grep -q 'export AUTOAGENT_ENGINE=' "$ROOT/usr/bin/autoagent"; then
  die "launcher must leave AUTOAGENT_ENGINE unset (backend defaults to matebot)"
fi

DEPENDS="$(dpkg-deb -f "$DEB" Depends)"
if printf '%s\n' "$DEPENDS" | grep -Eq 'nodejs|npm|python3|build-essential|unzip|electron|bun'; then
  die "runtime Depends contains a forbidden package: $DEPENDS"
fi
log "Depends: $DEPENDS"

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$ROOT/usr/share/applications/autoagent.desktop" \
    || die "desktop entry failed validation"
fi

LDD_ELECTRON="$(ldd "$APP/desktop/electron" 2>/dev/null | grep 'not found' || true)"
[ -z "$LDD_ELECTRON" ] || die "unresolved Electron libs: $LDD_ELECTRON"
if head -c 4 "$BIN" 2>/dev/null | grep -q $'\x7fELF'; then
  LDD_BACKEND="$(ldd "$BIN" 2>/dev/null | grep 'not found' || true)"
  [ -z "$LDD_BACKEND" ] || die "unresolved backend libs: $LDD_BACKEND"
fi

# ---------------------------------------------------------------- CLI checks
log "backend --version"
"$BIN" --version

log "backend --runtime-check (default engine, vendored MateBot)"
RUNTIME_JSON="$(
  env -u AUTOAGENT_ENGINE \
    AUTOAGENT_DATA_DIR="$DATA/cli" \
    AUTOAGENT_STATE_DIR="$STATE/cli" \
    AUTOAGENT_LOG_DIR="$LOGS/cli" \
    AUTOAGENT_MATEBOT_VENDOR_DIR="$APP/vendor/matebot" \
    AUTOAGENT_BUN_PATH="$APP/engine/bun" \
    AUTOAGENT_OPENCC_CLI_PATH="$APP/engine/opencc-dist/cli.js" \
    "$BIN" --runtime-check
)"
printf '%s\n' "$RUNTIME_JSON"
printf '%s' "$RUNTIME_JSON" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
assert payload.get("ok") is True, payload
assert payload.get("engineMode") == "matebot", payload
engine = payload["engine"]
assert engine.get("matebotVendorExists") is True, engine
assert engine.get("matebotVendor", "").endswith(
    "/opt/autoagent/vendor/matebot/opencc_backend.py"
), engine
assert engine.get("bun"), engine
assert engine.get("cli"), engine
'

# ---------------------------------------------------------------- server smoke
PORT="$(find_free_port)"
mkdir -p "$WORKSPACE"
printf 'hello from the packaged backend\n' >"$WORKSPACE/hello.txt"
log "starting backend on 127.0.0.1:$PORT (AUTOAGENT_ENGINE=fake)"
AUTOAGENT_ENGINE=fake \
AUTOAGENT_PACKAGED=0 \
AUTOAGENT_BIND=127.0.0.1 \
AUTOAGENT_PORT="$PORT" \
AUTOAGENT_API_TOKEN="$TOKEN" \
AUTOAGENT_BOOT_ID="packaged-smoke" \
AUTOAGENT_DATA_DIR="$DATA/app" \
AUTOAGENT_STATE_DIR="$STATE/app" \
AUTOAGENT_LOG_DIR="$LOGS/app" \
AUTOAGENT_FRONTEND_DIST="$APP/frontend/dist" \
AUTOAGENT_MATEBOT_VENDOR_DIR="$APP/vendor/matebot" \
AUTOAGENT_BUN_PATH="$APP/engine/bun" \
AUTOAGENT_OPENCC_CLI_PATH="$APP/engine/opencc-dist/cli.js" \
AUTOAGENT_DEFAULT_CWD="$WORKSPACE" \
  "$BIN" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

if ! wait_healthy "$PORT" "$SERVER_PID"; then
  cat "$TMP/server.log" >&2 || true
  die "backend did not become healthy"
fi
log "GET /api/health"
cat "$TMP/health.json"

log "GET /"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/" -o "$TMP/index.html"
grep -q '<div id="root"' "$TMP/index.html" || die "SPA index does not look like the built app"
grep -oE '/assets/[^" ]+\.(js|css)' "$TMP/index.html" | head -1 >"$TMP/asset-path" || true
ASSET_PATH="$(head -1 "$TMP/asset-path")"
[ -n "$ASSET_PATH" ] || die "index.html references no hashed asset"
log "GET $ASSET_PATH"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT$ASSET_PATH" -o "$TMP/asset"
[ -s "$TMP/asset" ] || die "asset was empty"
log "asset bytes: $(wc -c <"$TMP/asset")"

log "file API: list, read, atomic write and hash CAS"
curl -fsS --max-time 5 \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/api/files?root=workspace&path=" -o "$TMP/files.json"
python3 - "$TMP/files.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
names = {entry["name"] for entry in payload["entries"]}
assert "hello.txt" in names, names
assert "/workspace" not in json.dumps(payload), "absolute path leaked into the DTO"
PY
curl -fsS --max-time 5 \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/api/files/content?root=workspace&path=hello.txt" \
  -o "$TMP/file.json"
python3 - "$TMP/file.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
assert payload["text"] == "hello from the packaged backend\n", payload
assert payload["binary"] is False and len(payload["sha256"]) == 64, payload
PY
curl -fsS --max-time 5 -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"root":"workspace","path":"written.txt","text":"packaged"}' \
  "http://127.0.0.1:$PORT/api/files/content" -o "$TMP/write.json"
python3 - "$TMP/write.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
assert payload["size"] == 8 and payload["created"] is True, payload
PY
ZERO_HASH="$(printf '0%.0s' {1..64})"
STALE_STATUS="$(
  curl -sS -o "$TMP/stale.json" -w '%{http_code}' --max-time 5 -X PUT \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"root\":\"workspace\",\"path\":\"written.txt\",\"text\":\"clobber\",\"expectedSha256\":\"$ZERO_HASH\"}" \
    "http://127.0.0.1:$PORT/api/files/content"
)"
[ "$STALE_STATUS" = "409" ] || die "stale hash did not return 409 (got $STALE_STATUS)"
grep -q '"code":"HASH_MISMATCH"' "$TMP/stale.json" || die "stale hash code missing"
log "file API: ok"

log "fake turn over SSE"
SESSION_ID="$(
  curl -fsS -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"title":"packaged-smoke"}' \
    "http://127.0.0.1:$PORT/api/sessions" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
)"
TURN_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
curl -fsS --max-time 30 -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"text\":\"hello\"}" \
  "http://127.0.0.1:$PORT/api/turns/$TURN_ID/stream" >"$TMP/turn.sse"
grep -q '^event: turn.completed$' "$TMP/turn.sse" || {
  cat "$TMP/turn.sse" >&2
  die "fake turn did not complete"
}
log "turn events: $(grep -c '^event: ' "$TMP/turn.sse")"

# ---------------------------------------------------------------- shutdown
kill -TERM "$SERVER_PID"
for _ in $(seq 1 60); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  kill -KILL "$SERVER_PID" 2>/dev/null || true
  die "backend ignored SIGTERM"
fi
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
PID_FILE="$DATA/app/runtime/backend.pid"
if [ -f "$PID_FILE" ]; then
  ORPHAN_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$ORPHAN_PID" ] && kill -0 "$ORPHAN_PID" 2>/dev/null; then
    die "orphan backend pid $ORPHAN_PID survived shutdown"
  fi
fi
log "shutdown clean, no orphan"

# ---------------------------------------------------------------- optional GUI
if [ "$GUI" -eq 1 ]; then
  if [ -z "${DISPLAY:-}" ]; then
    log "GUI smoke skipped: DISPLAY is not set"
  elif [ ! -x "$APP/desktop/electron" ]; then
    log "GUI smoke skipped: Electron binary is missing"
  else
    GUI_STATE="$TMP/gui-state"
    GUI_DATA="$TMP/gui-data"
    log "GUI smoke on DISPLAY=$DISPLAY (test-only --no-sandbox)"
    env \
      AUTOAGENT_APP_DIR="$APP" \
      AUTOAGENT_PACKAGED=1 \
      AUTOAGENT_ENGINE_DIR="$APP/engine" \
      AUTOAGENT_BUN_PATH="$APP/engine/bun" \
      AUTOAGENT_OPENCC_CLI_PATH="$APP/engine/opencc-dist/cli.js" \
      AUTOAGENT_FRONTEND_DIST="$APP/frontend/dist" \
      AUTOAGENT_DATA_DIR="$GUI_DATA" \
      AUTOAGENT_STATE_DIR="$GUI_STATE" \
      XDG_STATE_HOME="$GUI_STATE" \
      XDG_CONFIG_HOME="$GUI_DATA" \
      DISPLAY="$DISPLAY" \
      timeout 45 "$APP/desktop/electron" --no-sandbox "$APP/desktop/resources/app" \
      >"$TMP/gui.log" 2>&1 &
    GUI_PID=$!

    GUI_READY=0
    for _ in $(seq 1 300); do
      if grep -q ' INFO app.ready' "$GUI_STATE/logs/desktop.log" 2>/dev/null; then
        GUI_READY=1
        break
      fi
      kill -0 "$GUI_PID" 2>/dev/null || break
      sleep 0.1
    done
    if [ "$GUI_READY" -ne 1 ]; then
      tail -40 "$TMP/gui.log" >&2 || true
      tail -40 "$GUI_STATE/logs/desktop.log" >&2 || true
      die "GUI smoke did not reach app.ready"
    fi
    log "GUI reached app.ready; terminating"
    kill -TERM "$GUI_PID" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$GUI_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$GUI_PID" 2>/dev/null || true
    wait "$GUI_PID" 2>/dev/null || true
    GUI_PID=""
    BACKEND_PID="$(grep -oE '"backendPid":[0-9]+' "$GUI_STATE/logs/desktop.log" | tail -1 | cut -d: -f2 || true)"
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
      # The shell closes the window first; the backend gets SIGTERM and exits
      # asynchronously (usually <1 s). Allow the documented grace period.
      for _ in $(seq 1 150); do
        kill -0 "$BACKEND_PID" 2>/dev/null || break
        sleep 0.1
      done
    fi
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
      die "GUI backend pid $BACKEND_PID survived"
    fi
    log "GUI smoke OK"
  fi
fi

log "OK"
