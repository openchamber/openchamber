#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
audit="$script_dir/audit-workflow-caller-jobs.py"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# A caller job carrying timeout-minutes is the #1399 failure itself.
cat >"$tmp_dir/bad.yml" <<'YAML'
name: bad
on: push
jobs:
  call:
    uses: ./.github/workflows/other.yml
    timeout-minutes: 5
YAML

# A caller job with only allowed keys, beside an ordinary job that may
# carry anything, is valid.
cat >"$tmp_dir/good.yml" <<'YAML'
name: good
on: push
jobs:
  call:
    name: Call it
    uses: ./.github/workflows/other.yml
    needs: [prep]
    if: github.ref == 'refs/heads/main'
    permissions: { contents: read }
    secrets: inherit
    with: { flag: true }
  plain:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo ok
YAML

if python3 "$audit" "$tmp_dir/bad.yml" >"$tmp_dir/bad.out" 2>&1; then
  echo "expected the audit to fail on bad.yml" >&2
  exit 1
fi
grep -q 'job "call"' "$tmp_dir/bad.out"
grep -q '"timeout-minutes"' "$tmp_dir/bad.out"

python3 "$audit" "$tmp_dir/good.yml" >/dev/null
echo "test-audit-workflow-caller-jobs: ok"
