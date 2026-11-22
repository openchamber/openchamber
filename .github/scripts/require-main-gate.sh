#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO must be set}"
: "${RELEASE_SHA:?RELEASE_SHA must be set}"

if [[ ! "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::RELEASE_SHA must be a full lowercase commit SHA." >&2
  exit 1
fi

if ! workflow_runs="$(gh api --method GET \
  "repos/${GH_REPO}/actions/workflows/oc-review.yml/runs" \
  -f "head_sha=${RELEASE_SHA}" \
  -f per_page=100 2>/dev/null)"; then
  echo "::error::Could not verify the pr checks main-gate result. Refusing to release." >&2
  exit 1
fi

if jq --exit-status --arg sha "$RELEASE_SHA" \
  'any(.workflow_runs[]?; .head_sha == $sha and .conclusion == "success")' \
  <<<"$workflow_runs" >/dev/null; then
  printf 'The pr checks main gate succeeded for %s.\n' "$RELEASE_SHA"
  exit 0
fi

echo "::error::No successful pr checks main-gate run exists for release SHA ${RELEASE_SHA}. Dispatch oc-review.yml on this exact SHA, wait for success, then retry." >&2
jq --raw-output --arg sha "$RELEASE_SHA" \
  '.workflow_runs[]? | select(.head_sha == $sha) | "run \(.id): event=\(.event) status=\(.status) conclusion=\(.conclusion // "pending")"' \
  <<<"$workflow_runs" >&2
exit 1
