#!/usr/bin/env bash
#
# Web-process boundary restart script (POSIX).
#
# Boots the real `openchamber-guardian` entrypoint, spawns the real
# `guardian-test-opencode.js` managed-child fixture, and uses a small
# Node helper to drive the full lifecycle (spawn → credential → health
# → graceful restart → wrong-owner refusal) over authenticated IPC
# sockets. A real web binary is not bundled into this worktree; the
# helper below performs the same role the web server would.
#
# Exit status:
#   0 — all checks passed
#   1 — a check failed
#   2 — environment missing (no node, no fixture, non-Linux)
#
# Linux only. Native Windows is intentionally out of scope; the
# Windows workflow covers the same path with hard-gated CI.

set -euo pipefail

case "$(uname -s)" in
  Linux*) ;;
  *)
    echo "skip: not Linux" >&2
    exit 0
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARDIAN_ENTRY="$REPO_ROOT/packages/web/bin/openchamber-guardian.js"
SMOKE_FIXTURE="$REPO_ROOT/scripts/guardian-test-opencode.js"
BOUNDARY_HELPER="$REPO_ROOT/scripts/web-restart-boundary-helper.mjs"

if [[ ! -f "$GUARDIAN_ENTRY" ]]; then
  echo "fail: guardian entry not found at $GUARDIAN_ENTRY" >&2
  exit 1
fi
if [[ ! -f "$SMOKE_FIXTURE" ]]; then
  echo "fail: managed-child fixture not found at $SMOKE_FIXTURE" >&2
  exit 1
fi
if [[ ! -f "$BOUNDARY_HELPER" ]]; then
  echo "fail: boundary helper not found at $BOUNDARY_HELPER" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "skip: node not available" >&2
  exit 0
fi
if ! node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"; then
  echo "fail: Node.js >=22 is required for the process-boundary check" >&2
  exit 1
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "fail: timeout is required for bounded process-boundary cleanup" >&2
  exit 1
fi

DATA_DIR="$(mktemp -d -t openchamber-web-restart-boundary.XXXXXX)"
SOCKET_PATH="$DATA_DIR/guardian.sock"
LOG_FILE="$DATA_DIR/guardian.log"
AUTH_SECRET_PATH="$DATA_DIR/managed-opencode-handoff-v2/guardian-auth.secret"
PID_MARKER="$DATA_DIR/managed-opencode-handoff-v2/guardian.pid"
GUARDIAN_STATE_PATH="$DATA_DIR/guardian-process.json"
CHILD_STATE_PATH="$DATA_DIR/managed-opencode-handoff-v2/managed-child.json"
BOUNDARY_OWNER_ID="web-restart-boundary-owner-${BASHPID:-$$}"
BOUNDARY_RUNTIME_ID="web-restart-boundary-runtime-${BASHPID:-$$}"
GUARDIAN_PID=""
BODY_HELPER_COMPLETED=false

run_bounded_helper() {
  local seconds=$1
  shift
  timeout --signal=TERM --kill-after=2s "${seconds}s" \
    node "$BOUNDARY_HELPER" "$@"
}

wait_for_guardian_reap() {
  local pid=$1
  local attempts=0
  while (( attempts < 60 )); do
    if [[ ! -e "/proc/$pid/stat" ]]; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi

    local stat_line=""
    local process_state=""
    stat_line=$(<"/proc/$pid/stat") || stat_line=""
    if [[ -n "$stat_line" && "$stat_line" == *") "* ]]; then
      process_state="${stat_line##*) }"
      process_state="${process_state%% *}"
    fi
    if [[ "$process_state" == "Z" ]]; then
      # The guardian is already out of execution; reap only this direct
      # run-owned child. Never wait indefinitely for a live or ambiguous PID.
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.05
    attempts=$((attempts + 1))
  done
  return 1
}

cleanup() {
  local body_status=$?
  local cleanup_failed=false
  local cleanup_unresolved=false
  local cleanup_status=0
  local child_cleanup_proven=false
  local guardian_cleanup_proven=false
  local guardian_reaped=false
  local intentional_post_cleanup=false
  local child_state_present=false

  # First give the still-live guardian an owner-scoped chance to stop only
  # this run's child. If the guardian is already gone, the identity-checked
  # child state below remains the fallback. A failed IPC attempt is recorded;
  # it is never converted into success or allowed to authorize broad cleanup.
  if [[ -S "$SOCKET_PATH" ]] && [[ -n "$GUARDIAN_PID" ]] \
    && [[ -e "$GUARDIAN_STATE_PATH" ]] && kill -0 "$GUARDIAN_PID" 2>/dev/null; then
    if [[ -e "$CHILD_STATE_PATH" ]]; then
      child_state_present=true
    fi
    if run_bounded_helper 5 \
      --cleanup-owned \
      --socket-path "$SOCKET_PATH" \
      --secret-path "$AUTH_SECRET_PATH" \
      --owner-instance-id "$BOUNDARY_OWNER_ID" \
      --runtime-identity "$BOUNDARY_RUNTIME_ID" \
      --guardian-state-path "$GUARDIAN_STATE_PATH" \
      --child-state-path "$CHILD_STATE_PATH" \
      >/dev/null 2>>"$LOG_FILE"; then
      if [[ "$child_state_present" == true ]]; then
        child_cleanup_proven=true
      fi
    else
      cleanup_failed=true
      echo "fail: owner-scoped cleanup attempt failed; retaining escalation authority" >&2
    fi
  fi

  # The guardian PID is never signaled from a bare, reusable PID. The helper
  # validates the exact PID/start/command/cwd identity recorded immediately
  # after this run spawned it, then performs TERM -> KILL escalation.
  if [[ ! -e "$GUARDIAN_STATE_PATH" ]] && [[ -n "$GUARDIAN_PID" ]] && kill -0 "$GUARDIAN_PID" 2>/dev/null; then
    # A signal can arrive between the guardian fork and the initial identity
    # record. Re-record only when the live process still has this run's exact
    # argv and cwd; never fall back to a bare PID kill.
    if ! run_bounded_helper 5 \
      --record-process-state "$GUARDIAN_STATE_PATH" \
      --pid "$GUARDIAN_PID" \
      --role guardian \
      --expected-command "$GUARDIAN_ENTRY" \
      --expected-cwd "$REPO_ROOT" \
      --expected-data-dir "$DATA_DIR" \
      --expected-socket-path "$SOCKET_PATH" \
      >/dev/null 2>>"$LOG_FILE"; then
      cleanup_failed=true
      echo "fail: guardian identity re-record failed; refusing unsafe escalation" >&2
    fi
  fi
  if [[ -e "$GUARDIAN_STATE_PATH" ]]; then
    if run_bounded_helper 5 \
      --cleanup-state "$GUARDIAN_STATE_PATH" \
      --grace-ms 3000 \
      >/dev/null 2>>"$LOG_FILE"; then
      guardian_cleanup_proven=true
    else
      cleanup_unresolved=true
    fi
  elif [[ -n "$GUARDIAN_PID" ]] && kill -0 "$GUARDIAN_PID" 2>/dev/null; then
    echo "fail: guardian identity state is unavailable; refusing unsafe escalation for pid $GUARDIAN_PID" >&2
    cleanup_unresolved=true
  fi

  if [[ -n "$GUARDIAN_PID" ]]; then
    if wait_for_guardian_reap "$GUARDIAN_PID"; then
      guardian_reaped=true
    else
      echo "fail: guardian did not exit within the bounded cleanup wait" >&2
      cleanup_unresolved=true
    fi
  fi

  # If guardian shutdown failed before it could terminate the detached child,
  # this state can only be removed after the helper revalidates the exact
  # child identity. A PID reuse or command/cwd mismatch is left untouched.
  if [[ -e "$CHILD_STATE_PATH" ]]; then
    if run_bounded_helper 5 \
      --cleanup-state "$CHILD_STATE_PATH" \
      --grace-ms 500 \
      --owner-instance-id "$BOUNDARY_OWNER_ID" \
      --runtime-identity "$BOUNDARY_RUNTIME_ID" \
      >/dev/null 2>>"$LOG_FILE"; then
      child_cleanup_proven=true
    else
      cleanup_unresolved=true
    fi
  fi

  if [[ -n "$GUARDIAN_PID" ]] && kill -0 "$GUARDIAN_PID" 2>/dev/null; then
    cleanup_unresolved=true
  fi
  if [[ -e "$CHILD_STATE_PATH" ]]; then
    cleanup_unresolved=true
  fi

  # The hanging cleanup and retained guardian are deliberate test seams. A
  # signal can leave the exact guardian record behind after the first bounded
  # attempt even though the guardian has already stopped. Retry only this
  # owner-scoped seam; normal ambiguous/live cleanup must retain its evidence.
  if [[ "$cleanup_unresolved" == true ]] \
    && [[ "${OPENCHAMBER_BOUNDARY_LEAVE_GUARDIAN:-0}" == "1" ]] \
    && [[ "${OPENCHAMBER_BOUNDARY_HANG_CLEANUP:-0}" == "1" ]]; then
    if [[ "$guardian_cleanup_proven" != true && -e "$GUARDIAN_STATE_PATH" ]]; then
      if run_bounded_helper 5 \
        --cleanup-state "$GUARDIAN_STATE_PATH" \
        --grace-ms 3000 \
        >/dev/null 2>>"$LOG_FILE"; then
        guardian_cleanup_proven=true
      fi
    fi
    if [[ "$child_cleanup_proven" != true && -e "$CHILD_STATE_PATH" ]]; then
      if run_bounded_helper 5 \
        --cleanup-state "$CHILD_STATE_PATH" \
        --grace-ms 500 \
        --owner-instance-id "$BOUNDARY_OWNER_ID" \
        --runtime-identity "$BOUNDARY_RUNTIME_ID" \
        >/dev/null 2>>"$LOG_FILE"; then
        child_cleanup_proven=true
      fi
    fi
    if [[ "$guardian_reaped" != true && -n "$GUARDIAN_PID" ]]; then
      if wait_for_guardian_reap "$GUARDIAN_PID"; then
        guardian_reaped=true
      fi
    fi
    # A completed helper has already stopped every child through exact
    # incarnation/owner checks. If it was interrupted before completion, a
    # missing child record is intentionally not treated as proof.
    if [[ "$BODY_HELPER_COMPLETED" == true ]] \
      && [[ ! -e "$CHILD_STATE_PATH" ]]; then
      child_cleanup_proven=true
    fi
    if [[ "$guardian_cleanup_proven" == true ]] \
      && [[ "$child_cleanup_proven" == true ]] \
      && [[ "$guardian_reaped" == true ]] \
      && [[ ! -e "$GUARDIAN_STATE_PATH" ]] \
      && [[ ! -e "$CHILD_STATE_PATH" ]]; then
      intentional_post_cleanup=true
      cleanup_unresolved=false
      if [[ -s "$LOG_FILE" ]]; then
        echo "diagnostic: intentional boundary cleanup log before root removal:" >&2
        cat "$LOG_FILE" >&2 || true
      fi
    fi
  fi

  if [[ "$body_status" -ne 0 ]]; then
    echo "fail: boundary test body exited with status $body_status" >&2
  else
    echo "ok: boundary test body completed" >&2
  fi
  if [[ "$cleanup_failed" == true ]]; then
    echo "fail: boundary cleanup reported a failure" >&2
  fi
  if [[ "$cleanup_unresolved" == true ]]; then
    echo "fail: boundary cleanup remains unresolved; retaining authority and data" >&2
  fi

  if [[ "$cleanup_unresolved" == false ]]; then
    if ! rm -rf "$DATA_DIR" 2>/dev/null; then
      cleanup_unresolved=true
      echo "fail: boundary temp root could not be removed: $DATA_DIR" >&2
    fi
  else
    echo "fail: retaining boundary data at $DATA_DIR because identity-safe cleanup was incomplete" >&2
  fi

  if [[ "$intentional_post_cleanup" == true && "$cleanup_unresolved" == true ]]; then
    echo "fail: intentional boundary root removal was not confirmed: $DATA_DIR" >&2
  fi

  if [[ "$cleanup_failed" == true || "$cleanup_unresolved" == true ]]; then
    cleanup_status=1
  fi
  echo "status: body=$body_status cleanup=$cleanup_status" >&2

  trap - EXIT
  # Cleanup is secondary to the body/signal result. A failed cleanup makes a
  # successful body fail, but it must never replace a nonzero body status.
  if [[ "$body_status" -ne 0 ]]; then
    exit "$body_status"
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

mkdir -p "$DATA_DIR"
node "$GUARDIAN_ENTRY" --data-dir "$DATA_DIR" --socket-path "$SOCKET_PATH" >"$LOG_FILE" 2>&1 &
GUARDIAN_PID=$!
if ! node "$BOUNDARY_HELPER" \
  --record-process-state "$GUARDIAN_STATE_PATH" \
  --pid "$GUARDIAN_PID" \
  --role guardian \
  --expected-command "$GUARDIAN_ENTRY" \
  --expected-cwd "$REPO_ROOT" \
  --expected-data-dir "$DATA_DIR" \
  --expected-socket-path "$SOCKET_PATH" \
  >/dev/null 2>>"$LOG_FILE"; then
  echo "fail: guardian process identity could not be recorded" >&2
  exit 1
fi

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

if run_bounded_helper 120 \
  --socket-path "$SOCKET_PATH" \
  --secret-path "$AUTH_SECRET_PATH" \
  --fixture "$SMOKE_FIXTURE" \
  --cwd "$REPO_ROOT" \
  --child-state-path "$CHILD_STATE_PATH" \
  --owner-instance-id "$BOUNDARY_OWNER_ID" \
  --runtime-identity "$BOUNDARY_RUNTIME_ID"; then
  BODY_HELPER_COMPLETED=true
else
  exit $?
fi

if [[ "${OPENCHAMBER_BOUNDARY_SKIP_GUARDIAN_ASSERT:-0}" != "1" ]]; then
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
fi

echo "ok"
