#!/usr/bin/env bash
# Build a self-contained AutoAgent backend for /opt/autoagent/backend.
#
# Primary strategy: Nuitka --standalone (no system Python at runtime).
# Fallback strategy: an embedded CPython runtime (python-build-standalone, via
# `uv python install`) with the locked dependencies installed into its prefix.
# The fallback is still self-contained at runtime: the package never Depends on
# python3. It is larger and slower on a cold start than the Nuitka output.
#
# Usage:
#   scripts/build-backend.sh                 # Nuitka, fallback on failure
#   scripts/build-backend.sh --fallback      # force embedded Python
#   scripts/build-backend.sh --verify-only   # verify an existing backend/build
#
# Output: backend/build/autoagent-backend (+ the .dist support tree flattened).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_DIR/backend"
BUILD_DIR="${AUTOAGENT_BACKEND_BUILD_DIR:-$BACKEND_DIR/build}"
ENTRY_NAME="autoagent-backend"
PYTHON_VERSION="3.12"

export TZ=UTC
export LC_ALL=C
# Deterministic hashing/iteration order in Nuitka's code generator.
export PYTHONHASHSEED=0
# Reproducible compiler metadata and a stable epoch for generated manifests.
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$PROJECT_DIR" log -1 --format=%ct 2>/dev/null || echo 0)}"
export SOURCE_DATE_EPOCH
# uv-managed build tools (Nuitka needs patchelf from the project environment).
export PATH="$BACKEND_DIR/.venv/bin:$PATH"

MODE="nuitka"
VERIFY_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fallback) MODE="fallback"; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *) echo "[backend] ERROR: unexpected argument: $1" >&2; exit 1 ;;
  esac
done

die() {
  echo "[backend] ERROR: $*" >&2
  exit 1
}

log() {
  echo "[backend] $*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}

# ---------------------------------------------------------------- preflight
[ "$(uname -s)" = "Linux" ] || die "the backend is packaged for Linux only"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "x86_64 is required (found $(uname -m))" ;;
esac

need uv
need curl
command -v python3 >/dev/null 2>&1 || die "missing required build tool: python3"

BUN_BIN="${BUN_BIN:-${PROJECT_DIR}/build-resources/bun}"
[ -x "$BUN_BIN" ] || BUN_BIN="$(command -v bun || true)"
[ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ] || die "bun not found (build-time only)"
OPENCC_CLI="${OPENCC_CLI:-${PROJECT_DIR}/packages/opencc/dist/cli.js}"
[ -f "$OPENCC_CLI" ] || die "missing opencc CLI: $OPENCC_CLI (run the opencc build first)"

# ---------------------------------------------------------------- verification
find_free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

stop_and_assert_gone() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.2
  if kill -0 "$pid" 2>/dev/null; then
    die "backend process $pid survived SIGKILL"
  fi
}

verify_backend() {
  local bin="$1"
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  log "verify: --version"
  local version_out
  version_out="$("$bin" --version)"
  printf '%s\n' "$version_out"
  case "$version_out" in
    "autoagent-backend "*) ;;
    *) die "unexpected --version output: $version_out" ;;
  esac

  log "verify: --runtime-check"
  local runtime_out
  runtime_out="$(
    AUTOAGENT_DATA_DIR="$tmp/data" \
    AUTOAGENT_STATE_DIR="$tmp/state" \
    AUTOAGENT_LOG_DIR="$tmp/logs" \
    AUTOAGENT_MATEBOT_VENDOR_DIR="$PROJECT_DIR/vendor/matebot" \
    AUTOAGENT_BUN_PATH="$BUN_BIN" \
    AUTOAGENT_OPENCC_CLI_PATH="$OPENCC_CLI" \
    "$bin" --runtime-check
  )"
  printf '%s\n' "$runtime_out"
  printf '%s' "$runtime_out" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
assert payload.get("ok") is True, payload
assert payload["engine"].get("bun"), payload
assert payload["engine"].get("cli"), payload
'

  local port token session_id turn_id status sse
  port="$(find_free_port)"
  token="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  session_id=""
  turn_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  status=0

  log "verify: start server on 127.0.0.1:$port with AUTOAGENT_ENGINE=fake"
  AUTOAGENT_ENGINE=fake \
  AUTOAGENT_PACKAGED=0 \
  AUTOAGENT_BIND=127.0.0.1 \
  AUTOAGENT_PORT="$port" \
  AUTOAGENT_API_TOKEN="$token" \
  AUTOAGENT_BOOT_ID="build-verify" \
  AUTOAGENT_DATA_DIR="$tmp/data" \
  AUTOAGENT_STATE_DIR="$tmp/state" \
  AUTOAGENT_LOG_DIR="$tmp/logs" \
  AUTOAGENT_MATEBOT_VENDOR_DIR="$PROJECT_DIR/vendor/matebot" \
  AUTOAGENT_BUN_PATH="$BUN_BIN" \
  AUTOAGENT_OPENCC_CLI_PATH="$OPENCC_CLI" \
  "$bin" >"$tmp/server.log" 2>&1 &
  local server_pid=$!

  local ready=0
  for _ in $(seq 1 120); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$port/api/health" >"$tmp/health.json" 2>/dev/null; then
      ready=1
      break
    fi
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 0.1
  done
  if [ "$ready" -ne 1 ]; then
    cat "$tmp/server.log" >&2 || true
    stop_and_assert_gone "$server_pid"
    die "backend did not become healthy"
  fi
  log "verify: GET /api/health"
  cat "$tmp/health.json"

  log "verify: --health-check"
  AUTOAGENT_API_TOKEN="$token" "$bin" --health-check "http://127.0.0.1:$port/api/health"

  log "verify: fake turn"
  session_id="$(
    curl -fsS -X POST \
      -H "Authorization: Bearer $token" \
      -H 'Content-Type: application/json' \
      -d '{"title":"build-verify"}' \
      "http://127.0.0.1:$port/api/sessions" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
  )"
  sse="$(
    curl -fsS --max-time 30 -X POST \
      -H "Authorization: Bearer $token" \
      -H 'Content-Type: application/json' \
      -d "{\"sessionId\":\"$session_id\",\"text\":\"hello\"}" \
      "http://127.0.0.1:$port/api/turns/$turn_id/stream"
  )" || status=$?
  printf '%s\n' "$sse" >"$tmp/turn.sse"
  if [ "$status" -ne 0 ] || ! grep -q '^event: turn.completed$' "$tmp/turn.sse"; then
    cat "$tmp/turn.sse" >&2 || true
    cat "$tmp/server.log" >&2 || true
    stop_and_assert_gone "$server_pid"
    die "fake turn did not complete"
  fi
  grep -E '^(event|data): ' "$tmp/turn.sse" | head -20

  stop_and_assert_gone "$server_pid"
  log "verify: backend stopped, no orphan"
}

if [ "$VERIFY_ONLY" -eq 1 ]; then
  [ -x "$BUILD_DIR/$ENTRY_NAME" ] || die "missing $BUILD_DIR/$ENTRY_NAME"
  verify_backend "$BUILD_DIR/$ENTRY_NAME"
  log "verify-only OK"
  exit 0
fi

# ---------------------------------------------------------------- build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

build_with_nuitka() {
  log "Nuitka version: $(uv run --project "$BACKEND_DIR" nuitka --version 2>&1 | head -1)"
  command -v patchelf >/dev/null 2>&1 \
    || die "Nuitka standalone needs patchelf (declared in backend dev dependencies; run uv sync --project backend)"

  # Stable source/output paths: Nuitka embeds the entry module's path in the
  # binary, so using mktemp for every build makes the artifact non-reproducible.
  local work="$BACKEND_DIR/.nuitka-work"
  local entry="$work/autoagent_backend_entry.py"
  rm -rf "$work"
  mkdir -p "$work/out"

  cat >"$entry" <<'PY'
from autoagent_backend.__main__ import main

raise SystemExit(main())
PY

    log "running Nuitka --standalone (this compiles FastAPI/Pydantic/uvicorn)"
  if ! PYTHONPATH="$BACKEND_DIR/src" uv run --project "$BACKEND_DIR" python -m nuitka \
    --standalone \
    --assume-yes-for-downloads \
    --no-pyi-file \
    --remove-output \
    --output-dir="$work/out" \
    --output-filename="$ENTRY_NAME" \
    --include-package=autoagent_backend \
    --include-package=uvicorn \
    --include-package=websockets \
    --include-package=fastapi \
    --include-package=pydantic \
    --include-package=pydantic_core \
    --include-package=starlette \
    --include-package=anyio \
    --include-package=click \
    --include-package=h11 \
    --nofollow-import-to=pytest \
    --nofollow-import-to=tests \
    --nofollow-import-to=mypy \
    --nofollow-import-to=ruff \
    "$entry"; then
    echo "[backend] Nuitka compilation failed (see log above)" >&2
    rm -rf "$work"
    return 1
  fi

  local dist_dir
  dist_dir="$(find "$work/out" -maxdepth 1 -mindepth 1 -type d -name '*.dist' -print -quit)"
  if [ -z "$dist_dir" ] || [ ! -x "$dist_dir/$ENTRY_NAME" ]; then
    echo "[backend] Nuitka produced no usable .dist tree under $work/out" >&2
    rm -rf "$work"
    return 1
  fi
  cp -a "$dist_dir/." "$BUILD_DIR/"
  chmod 0755 "$BUILD_DIR/$ENTRY_NAME"
  rm -rf "$work"
}

build_with_embedded_python() {
  log "fallback: installing an embedded CPython $PYTHON_VERSION runtime"
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  uv python install --install-dir "$tmp/py" "$PYTHON_VERSION"

  local embedded_py
  embedded_py="$(find "$tmp/py" -maxdepth 3 -type f -name 'python3.12' -path '*/bin/*' -print -quit)"
  if [ -z "$embedded_py" ]; then
    embedded_py="$(find "$tmp/py" -maxdepth 3 -type f -name 'python3' -path '*/bin/*' -print -quit)"
  fi
  [ -n "$embedded_py" ] && [ -x "$embedded_py" ] || die "embedded Python was not installed"

  log "fallback: exporting locked runtime requirements"
  uv export --project "$BACKEND_DIR" --no-dev --no-emit-project \
    --format requirements-txt --no-header --no-annotate >"$tmp/requirements.txt"
  [ -s "$tmp/requirements.txt" ] || die "uv export produced no requirements"

  log "fallback: installing dependencies into the embedded runtime"
  # The runtime was just downloaded into this build tree; it is not the host
  # system Python, so uv's externally-managed guard is deliberately overridden.
  uv pip install --python "$embedded_py" --no-cache --break-system-packages \
    -r "$tmp/requirements.txt"

  mkdir -p "$BUILD_DIR/python"
  # The install dir contains one cpython-* prefix; keep that prefix name so
  # CPython can locate its stdlib relative to the executable.
  cp -a "$tmp/py/." "$BUILD_DIR/python/"
  # uv also writes convenience aliases as absolute symlinks into its cache;
  # they must not leak into the relocatable package.
  find "$BUILD_DIR/python" -maxdepth 1 -type l -delete

  local py_prefix
  py_prefix="$(find "$BUILD_DIR/python" -maxdepth 1 -mindepth 1 -type d -name 'cpython-*' -print -quit)"
  [ -n "$py_prefix" ] || die "embedded Python prefix not found"
  "$py_prefix/bin/python3" -c 'import fastapi, uvicorn, pydantic, pydantic_core, starlette, anyio'

  mkdir -p "$BUILD_DIR/py"
  cp -a "$BACKEND_DIR/src/autoagent_backend" "$BUILD_DIR/py/"

  # Drop caches and test-only payloads; they are not needed at runtime.
  find "$BUILD_DIR" -type d -name '__pycache__' -prune -exec rm -rf {} +
  find "$BUILD_DIR" \( -name '*.pyc' -o -name '*.pyi' \) -delete
  rm -rf \
    "$py_prefix/lib/python${PYTHON_VERSION}/test" \
    "$py_prefix/lib/python${PYTHON_VERSION}/idlelib" \
    "$py_prefix/lib/python${PYTHON_VERSION}/tkinter" \
    "$py_prefix/lib/python${PYTHON_VERSION}/turtledemo" \
    "$py_prefix/lib/python${PYTHON_VERSION}/ensurepip"

  cat >"$BUILD_DIR/$ENTRY_NAME" <<'SH'
#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON="$HERE/python/cpython-3.12/bin/python3"
[ -x "$PYTHON" ] || {
  PYTHON="$(find "$HERE/python" -maxdepth 3 -type f -name 'python3.12' -path '*/bin/*' -print -quit)"
}
[ -n "$PYTHON" ] && [ -x "$PYTHON" ] || {
  PYTHON="$(find "$HERE/python" -maxdepth 3 -type f -name 'python3' -path '*/bin/*' -print -quit)"
}
[ -n "$PYTHON" ] && [ -x "$PYTHON" ] || {
  echo "autoagent-backend: embedded Python runtime is missing" >&2
  exit 1
}
PYTHONPATH="$HERE/py${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONPATH
export PYTHONDONTWRITEBYTECODE=1
exec "$PYTHON" -m autoagent_backend "$@"
SH
  chmod 0755 "$BUILD_DIR/$ENTRY_NAME"
}

case "$MODE" in
  fallback)
    build_with_embedded_python
    BUILD_MODE="embedded-python"
    ;;
  nuitka)
    if build_with_nuitka; then
      BUILD_MODE="nuitka-standalone"
    else
      echo "[backend] WARNING: Nuitka standalone failed; falling back to embedded Python." >&2
      echo "[backend] Tradeoff: larger install (~60-100 MiB more), slower cold start," >&2
      echo "[backend] but still no system Python dependency at runtime." >&2
      rm -rf "$BUILD_DIR"
      mkdir -p "$BUILD_DIR"
      build_with_embedded_python
      BUILD_MODE="embedded-python"
    fi
    ;;
  *) die "unknown mode: $MODE" ;;
esac

if [ "$BUILD_MODE" = "embedded-python" ]; then
  INFO_PY="$(find "$BUILD_DIR/python" -maxdepth 3 -type f -name 'python3.12' -path '*/bin/*' -print -quit)"
  BUILT_PY_VERSION="$("$INFO_PY" --version | awk '{print $2}')"
else
  BUILT_PY_VERSION="$(uv run --project "$BACKEND_DIR" python --version | awk '{print $2}')"
fi

cat >"$BUILD_DIR/BUILD-INFO.json" <<JSON
{
  "mode": "$BUILD_MODE",
  "python": "$BUILT_PY_VERSION",
  "nuitka": "$(uv run --project "$BACKEND_DIR" nuitka --version 2>&1 | head -1)",
  "sourceDateEpoch": ${SOURCE_DATE_EPOCH:-0}
}
JSON

log "build mode: $BUILD_MODE"
log "output: $BUILD_DIR/$ENTRY_NAME ($(du -sh "$BUILD_DIR" | awk '{print $1}'))"

verify_backend "$BUILD_DIR/$ENTRY_NAME"
log "OK"
