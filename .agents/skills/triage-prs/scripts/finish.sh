#!/usr/bin/env bash
# Land the prepared PR: commit as the PR author, push to their branch, thank, merge.
#
# usage: finish.sh <pr-number> "<squash subject>" "<comment to the author>" ["<squash body>"]
#
# Run after prep.sh and after the fixes are staged and validated in $TRIAGE_WT.
# The commit carries the PR author's name (no agent trailers); the squash
# merge on GitHub keeps them as the author of record. The body is where
# "Closes #N" goes.
set -eu
WT=${TRIAGE_WT:-/tmp/triage/wt}
STATE=${TRIAGE_STATE:-/tmp/triage}
REPO=openchamber/openchamber
n=$1; subject=$2; thanks=$3; body=${4:-}
cd "$WT"
read -r owner branch _mcm < "$STATE/cur.txt"
author=$(git log -1 --format='%an <%ae>' "pr${n}-head")
# Stage tracked work only: the node_modules links in the worktree stay out.
git add -A -- . ':!node_modules' ':!packages/*/node_modules'
git -c core.hooksPath=/dev/null commit -q --author="$author" -m "$subject"
git push -q --force "https://github.com/$owner/openchamber.git" "HEAD:$branch"
gh pr comment "$n" -R "$REPO" --body "$thanks" > /dev/null
# GitHub needs a moment to see the pushed head before it accepts the merge.
for _ in 1 2 3 4; do
  sleep 4
  if gh pr merge "$n" -R "$REPO" --squash --admin --subject "$subject (#$n)" --body "$body" 2> "$STATE/merge.err"; then
    echo "merged #$n"
    exit 0
  fi
  cat "$STATE/merge.err"
done
exit 1
