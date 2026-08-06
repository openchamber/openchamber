#!/usr/bin/env bash
#
# Authenticated guardian lifecycle smoke test (Linux).
#
# Starts the real guardian, exercises negative IPC authentication, launches a
# real managed OpenCode fixture, checks health/ownership, stops the child, and
# shuts down the guardian over its Unix-domain socket.

set -euo pipefail

case "$(uname -s)" in
  Linux*) ;;
  *)
    echo "skip: not Linux"
    exit 0
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARDIAN_ENTRY="$REPO_ROOT/packages/web/bin/openchamber-guardian.js"
SMOKE_CLIENT="$REPO_ROOT/scripts/guardian-smoke-client.js"
SMOKE_FIXTURE="$REPO_ROOT/scripts/guardian-test-opencode.js"

if [[ ! -f "$GUARDIAN_ENTRY" ]]; then
  echo "fail: guardian entry not found at $GUARDIAN_ENTRY" >&2
  exit 1
fi
if [[ ! -f "$SMOKE_CLIENT" || ! -f "$SMOKE_FIXTURE" ]]; then
  echo "fail: guardian managed-child smoke files are missing" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "skip: node not available"
  exit 0
fi

DATA_DIR="$(mktemp -d -t openchamber-guardian-smoke.XXXXXX)"
SOCKET_PATH="$DATA_DIR/guardian.sock"
LOG_FILE="$DATA_DIR/guardian.log"
AUTH_SECRET_PATH="$DATA_DIR/managed-opencode-handoff-v2/guardian-auth.secret"
PID_MARKER="$DATA_DIR/managed-opencode-handoff-v2/guardian.pid"
GUARDIAN_PID=""

cleanup() {
  if [[ -n "$GUARDIAN_PID" ]] && kill -0 "$GUARDIAN_PID" 2>/dev/null; then
    kill -TERM "$GUARDIAN_PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$GUARDIAN_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$GUARDIAN_PID" 2>/dev/null; then
      kill -KILL "$GUARDIAN_PID" 2>/dev/null || true
    fi
    wait "$GUARDIAN_PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$DATA_DIR"
node "$GUARDIAN_ENTRY" --data-dir "$DATA_DIR" --socket-path "$SOCKET_PATH" >"$LOG_FILE" 2>&1 &
GUARDIAN_PID=$!

for _ in $(seq 1 100); do
  if [[ -S "$SOCKET_PATH" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "fail: guardian socket not created at $SOCKET_PATH (see $LOG_FILE)" >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

node "$SMOKE_CLIENT" \
  --socket-path "$SOCKET_PATH" \
  --secret-path "$AUTH_SECRET_PATH" \
  --fixture "$SMOKE_FIXTURE" \
  --cwd "$REPO_ROOT"

for _ in $(seq 1 50); do
  if ! kill -0 "$GUARDIAN_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if kill -0 "$GUARDIAN_PID" 2>/dev/null; then
  echo "fail: guardian did not exit after shutdown (see $LOG_FILE)" >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if [[ -e "$PID_MARKER" ]]; then
  echo "fail: guardian PID marker was not removed after authenticated shutdown: $PID_MARKER" >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

echo "ok"
