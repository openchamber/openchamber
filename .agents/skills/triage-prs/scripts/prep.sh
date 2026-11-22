#!/usr/bin/env bash
# Put a contributor PR on top of current main, squashed, ready to finish by hand.
#
# usage: prep.sh <pr-number>
#
# Works in $TRIAGE_WT (default /tmp/triage/wt), a throwaway worktree of this
# repo, never the maintainer's checkout; $TRIAGE_STATE (default /tmp/triage)
# holds the PR's head owner, branch and tip for finish.sh. When several PRs
# are worked at once, give each its own pair, such as
#   TRIAGE_WT=/tmp/triage/wt-<N> TRIAGE_STATE=/tmp/triage/st-<N>
# A missing worktree is created detached at origin/main, with node_modules
# linked to the main checkout's, so no install runs.
#
# An existing worktree is reset for the new PR only when nothing in it would be
# lost: no uncommitted change and no commit that finish.sh has not pushed.
# TRIAGE_DISCARD=1 resets it anyway.
#
# Leaves branch pr<N> on origin/main with the whole PR staged as one change
# (conflicts resolved once, not per commit) and pr<N>-head at the PR's tip.
# Prints CLEAN or CONFLICTS plus the conflicted files.
set -u
WT=${TRIAGE_WT:-/tmp/triage/wt}
STATE=${TRIAGE_STATE:-/tmp/triage}
REPO=openchamber/openchamber
n=$1
mkdir -p "$STATE"
if [ ! -e "$WT/.git" ]; then
  main_checkout=$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")
  git -C "$main_checkout" fetch -q origin
  git -C "$main_checkout" worktree add -q --detach "$WT" origin/main || exit 1
  ln -s "$main_checkout/node_modules" "$WT/node_modules"
  for dir in "$main_checkout"/packages/*/node_modules; do
    pkg=$(basename "$(dirname "$dir")")
    [ -d "$WT/packages/$pkg" ] && ln -s "$dir" "$WT/packages/$pkg/node_modules"
  done
fi
cd "$WT" || exit 1
if [ "${TRIAGE_DISCARD:-}" != 1 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "REFUSED: $WT has uncommitted changes; finish or discard them (TRIAGE_DISCARD=1) first" >&2
    exit 3
  fi
  if [ "$(git rev-list --count "$(git merge-base HEAD origin/main)..HEAD")" -gt 0 ] \
    && [ "$(git rev-parse HEAD)" != "$(cat "$STATE/pushed.txt" 2>/dev/null)" ]; then
    echo "REFUSED: $WT holds an unpushed commit ($(git log -1 --format='%h %s')); finish it or discard it (TRIAGE_DISCARD=1) first" >&2
    exit 3
  fi
fi
read -r owner branch mcm < <(gh pr view "$n" -R "$REPO" --json headRepositoryOwner,headRefName,maintainerCanModify \
  -q '.headRepositoryOwner.login+" "+.headRefName+" "+(.maintainerCanModify|tostring)')
if [ "$mcm" != "true" ]; then echo "maintainerCanModify is false: we cannot push to $owner:$branch"; fi
git merge --abort 2>/dev/null
git reset -q --hard
git clean -fdq -e node_modules
git fetch -q origin
git fetch -q "https://github.com/$owner/openchamber.git" "$branch" || { echo "cannot fetch $owner:$branch" >&2; exit 1; }
git branch -f "pr${n}-head" FETCH_HEAD
# finish.sh pushes with a lease on this head, so an author push made since is never overwritten.
echo "$owner $branch $mcm $(git rev-parse FETCH_HEAD)" > "$STATE/cur.txt"
rm -f "$STATE/pushed.txt"
git checkout -q -B "pr$n" origin/main
if git merge --squash "pr${n}-head" > "$STATE/merge.log" 2>&1; then
  echo CLEAN
else
  echo CONFLICTS
  git diff --name-only --diff-filter=U
fi
echo "$owner:$branch maintainerCanModify=$mcm"
