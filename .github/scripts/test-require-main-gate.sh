#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
script="$script_dir/require-main-gate.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat >"$tmp_dir/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "api" || "$*" != *"actions/workflows/oc-review.yml/runs"* ]]; then
  echo "unexpected gh invocation" >&2
  exit 97
fi
if [[ "$*" != *"head_sha=${RELEASE_SHA}"* || "$*" != *"per_page=100"* ]]; then
  echo "the API request must filter the exact SHA and fetch up to 100 runs" >&2
  exit 98
fi
printf '%s\n' "${MOCK_GH_RESPONSE:?}"
MOCK_GH
chmod +x "$tmp_dir/gh"

sha="0123456789abcdef0123456789abcdef01234567"
other_sha="abcdef0123456789abcdef0123456789abcdef01"

make_response() {
  local response_sha="$1"
  local status="$2"
  local conclusion="$3"
  local event="$4"
  printf '{"workflow_runs":[{"id":42,"head_sha":"%s","status":"%s","conclusion":%s,"event":"%s"}]}\n' \
    "$response_sha" "$status" "$conclusion" "$event"
}

assert_result() {
  local name="$1"
  local expected_status="$2"
  local response="$3"
  local actual_status=0

  if env \
    PATH="$tmp_dir:$PATH" \
    GH_REPO=developing-today-forks/openchamber \
    RELEASE_SHA="$sha" \
    MOCK_GH_RESPONSE="$response" \
    bash "$script" >"$tmp_dir/output" 2>&1; then
    actual_status=0
  else
    actual_status=$?
  fi

  if [[ "$actual_status" -ne "$expected_status" ]]; then
    cat "$tmp_dir/output" >&2
    printf 'FAIL: %s (expected exit %s, got %s)\n' \
      "$name" "$expected_status" "$actual_status" >&2
    exit 1
  fi

  printf 'PASS: %s\n' "$name"
}

assert_result "accepts a successful exact-SHA main-gate run" 0 \
  "$(make_response "$sha" completed '"success"' push)"
assert_result "accepts a successful manual run for the exact SHA" 0 \
  "$(make_response "$sha" completed '"success"' workflow_dispatch)"
assert_result "rejects a failed main-gate run" 1 \
  "$(make_response "$sha" completed '"failure"' push)"
assert_result "rejects a pending main-gate run" 1 \
  "$(make_response "$sha" in_progress null push)"
assert_result "rejects a successful run for another SHA" 1 \
  "$(make_response "$other_sha" completed '"success"' push)"
assert_result "rejects a missing main-gate run" 1 \
  '{"workflow_runs":[]}'
