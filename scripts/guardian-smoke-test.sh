#!/usr/bin/env bash
#
# Guardian smoke test (Linux-only).
#
# End-to-end runtime check for the OpenChamber guardian:
#   1. Spawns `node packages/web/bin/openchamber-guardian.js` against a temp
#      data-dir and an isolated socket path.
#   2. Probes the Unix domain socket via an inline Node IPC client.
#   3. Sends a `list` request and asserts the response is `[]`.
#   4. Sends a `shutdown` request and asserts the process exits cleanly.
#
# Exit codes:
#   0 = ok (or skipped on non-Linux / when node is unavailable)
#   1 = smoke test failure
#
# Usage:
#   bash scripts/guardian-smoke-test.sh

set -uo pipefail

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

if [[ ! -f "$GUARDIAN_ENTRY" ]]; then
  echo "fail: guardian entry not found at $GUARDIAN_ENTRY" >&2
  exit 1
fi

DATA_DIR="$(mktemp -d -t openchamber-guardian-smoke.XXXXXX)"
mkdir -p "$DATA_DIR/run"
SOCKET_PATH="$DATA_DIR/guardian.sock"
LOG_FILE="$DATA_DIR/run/guardian.log"

# The PID file is written by the entrypoint at the default
# ~/.local/state/openchamber/guardian.pid location. We don't track it here so
# the smoke test stays hermetic; the test only checks the socket and the
# `list` / `shutdown` RPCs.

cleanup() {
  if [[ -n "${GUARDIAN_PID:-}" ]] && kill -0 "$GUARDIAN_PID" 2>/dev/null; then
    kill -TERM "$GUARDIAN_PID" 2>/dev/null || true
    # Give the guardian 2s to exit gracefully, then escalate to SIGKILL so a
    # stuck shutdown handler does not leave the process leaked.
    for _ in $(seq 1 20); do
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

fail() {
  echo "fail: $1" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "skip: node not available"
  exit 0
fi

# Spawn the guardian with an isolated data dir and an explicit socket path.
node "$GUARDIAN_ENTRY" --data-dir "$DATA_DIR" --socket-path "$SOCKET_PATH" >"$LOG_FILE" 2>&1 &
GUARDIAN_PID=$!

# Wait up to 5s for the socket to appear.
for _ in $(seq 1 50); do
  if [[ -S "$SOCKET_PATH" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -S "$SOCKET_PATH" ]]; then
  fail "guardian socket not created at $SOCKET_PATH (see $LOG_FILE)"
fi

# Inline IPC client: send a `list` request and assert the response is [].
node - "$SOCKET_PATH" <<'NODE_EOF' || fail "list RPC failed"
const net = require('node:net');
const socketPath = process.argv[2];
const client = net.createConnection(socketPath);
let buffer = '';
const id = `smoke-list-${Date.now()}-${Math.random().toString(36).slice(2)}`;
client.on('connect', () => {
  client.write(JSON.stringify({ id, method: 'list', params: {} }) + '\n');
});
client.on('data', (chunk) => {
  buffer += chunk.toString();
  const nl = buffer.indexOf('\n');
  if (nl < 0) return;
  const line = buffer.slice(0, nl).trim();
  client.end();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    console.error('bad list response:', err.message, line);
    process.exit(2);
  }
  if (!Array.isArray(parsed.result)) {
    console.error('expected array result, got', parsed);
    process.exit(2);
  }
  if (parsed.result.length !== 0) {
    console.error('expected [] for fresh guardian, got', parsed.result);
    process.exit(3);
  }
  process.exit(0);
});
client.on('error', (err) => {
  console.error('socket error:', err.message);
  process.exit(4);
});
setTimeout(() => { console.error('list timeout'); process.exit(5); }, 5000);
NODE_EOF

# Send `shutdown` over IPC. The guardian should exit and remove the PID file.
node - "$SOCKET_PATH" <<'NODE_EOF' || fail "shutdown RPC failed"
const net = require('node:net');
const socketPath = process.argv[2];
const client = net.createConnection(socketPath);
let buffer = '';
const id = `smoke-shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}`;
client.on('connect', () => {
  client.write(JSON.stringify({ id, method: 'shutdown', params: {} }) + '\n');
});
client.on('data', (chunk) => {
  buffer += chunk.toString();
  const nl = buffer.indexOf('\n');
  if (nl < 0) return;
  client.end();
  try {
    JSON.parse(buffer.slice(0, nl).trim());
  } catch (err) {
    console.error('bad shutdown response:', err.message);
    process.exit(2);
  }
  gotResponse = true;
  process.exit(0);
});
let gotResponse = false;
client.on('error', (err) => {
  // The guardian may close the socket before the response arrives.
  // Only treat as ok if we already received data.
  if (gotResponse) process.exit(0);
  console.error('shutdown socket error:', err.message);
  process.exit(2);
});
setTimeout(() => {
  if (gotResponse) process.exit(0);
  console.error('shutdown timeout');
  process.exit(5);
}, 3000);
NODE_EOF

# Wait for the guardian to actually exit.
for _ in $(seq 1 50); do
  if ! kill -0 "$GUARDIAN_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if kill -0 "$GUARDIAN_PID" 2>/dev/null; then
  fail "guardian did not exit after shutdown"
fi

echo "ok"
