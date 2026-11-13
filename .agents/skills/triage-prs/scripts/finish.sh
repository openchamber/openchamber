#!/usr/bin/env bash
# Land the prepared PR: commit as the PR author, rebase onto current main, push
# to their branch, thank, merge.
#
# usage: finish.sh <pr-number> "<squash subject>" "<comment to the author>" ["<squash body>"]
#
# Run after prep.sh (same TRIAGE_WT and TRIAGE_STATE) once the fixes are
# validated in the worktree. Uncommitted changes become the landing commit, or
# are amended into it when a fix agent already committed. The commit carries
# the PR author's name (no agent trailers); the squash merge on GitHub keeps
# them as the author of record. The body is where "Closes #N" goes.
#
# Right before the push the commit is rebased onto a fresh origin/main, so the
# author's branch never gets a stale base that main has moved past. A conflict
# stops here with exit 2 and nothing pushed: resolve it in the worktree (or
# hand it back to an agent), validate again, and rerun. The push carries a
# lease on the author's head as prep.sh fetched it, so a push the author made
# since is never overwritten: the push fails, and the PR is prepared again.
set -eu
WT=${TRIAGE_WT:-/tmp/triage/wt}
STATE=${TRIAGE_STATE:-/tmp/triage}
REPO=openchamber/openchamber
n=$1; subject=$2; thanks=$3; body=${4:-}
cd "$WT"
read -r owner branch _mcm author_head < "$STATE/cur.txt"
if [ -z "${author_head:-}" ]; then
  echo "$STATE/cur.txt has no author head; run prep.sh again" >&2
  exit 1
fi
if [ "$owner" = openchamber ] && [ "$branch" = main ]; then
  echo "pr$n targets openchamber/openchamber main; refusing to push there" >&2
  exit 1
fi
author=$(git log -1 --format='%an <%ae>' "pr${n}-head")
git fetch -q origin
# Landing commits are counted from where HEAD meets the current main, so a
# manual rebase onto origin/main still counts as one.
ahead=$(git rev-list --count "$(git merge-base HEAD origin/main)..HEAD")
if [ "$ahead" -gt 1 ]; then
  echo "pr$n has $ahead commits on top of main; squash them into one before finishing" >&2
  exit 1
fi
# The node_modules links in the worktree are gitignored, so -A leaves them out.
# Naming them in an exclude pathspec makes git refuse ignored paths and exit 1.
git add -A
if [ "$ahead" -eq 0 ]; then
  git -c core.hooksPath=/dev/null commit -q --author="$author" -m "$subject"
elif ! git diff --cached --quiet; then
  git -c core.hooksPath=/dev/null commit -q --amend --no-edit
fi
if ! git -c core.hooksPath=/dev/null rebase -q origin/main > "$STATE/rebase.log" 2>&1; then
  conflicts=$(git diff --name-only --diff-filter=U)
  git rebase --abort
  echo "REBASE CONFLICT: pr$n no longer applies to current origin/main; nothing was pushed." >&2
  echo "Conflicted files:" >&2
  echo "$conflicts" >&2
  echo "Resolve in $WT (git rebase origin/main), validate again, then rerun finish.sh." >&2
  exit 2
fi
# A rerun after a failed comment or merge expects our own last push there, not
# the author's head from prep (prep.sh clears pushed.txt).
expected=$author_head
if [ -s "$STATE/pushed.txt" ]; then
  expected=$(cat "$STATE/pushed.txt")
fi
if ! git push -q --force-with-lease="refs/heads/$branch:$expected" "https://github.com/$owner/openchamber.git" "HEAD:refs/heads/$branch"; then
  echo "PUSH REFUSED: $owner:$branch moved since prep.sh (the author pushed?); nothing was overwritten. Read their new commits, then prepare the PR again (TRIAGE_DISCARD=1 prep.sh $n drops this landing commit)." >&2
  exit 3
fi
git rev-parse HEAD > "$STATE/pushed.txt"
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
