#!/usr/bin/env bash
# Put a contributor PR on top of current main, squashed, ready to finish by hand.
#
# usage: prep.sh <pr-number>
#
# Works in $TRIAGE_WT (default /tmp/triage/wt), a throwaway worktree of this
# repo, never the maintainer's checkout. One-time setup from the repo root:
#   git worktree add --detach /tmp/triage/wt origin/main
#   ln -s "$PWD/node_modules" /tmp/triage/wt/node_modules
#   for p in ui web vscode electron; do ln -s "$PWD/packages/$p/node_modules" /tmp/triage/wt/packages/$p/node_modules; done
#
# Leaves branch pr<N> on origin/main with the whole PR staged as one change
# (conflicts resolved once, not per commit) and pr<N>-head at the PR's tip.
# Prints CLEAN or CONFLICTS plus the conflicted files.
set -u
WT=${TRIAGE_WT:-/tmp/triage/wt}
STATE=${TRIAGE_STATE:-/tmp/triage}
REPO=openchamber/openchamber
n=$1
cd "$WT"
read -r owner branch mcm < <(gh pr view "$n" -R "$REPO" --json headRepositoryOwner,headRefName,maintainerCanModify \
  -q '.headRepositoryOwner.login+" "+.headRefName+" "+(.maintainerCanModify|tostring)')
echo "$owner $branch $mcm" > "$STATE/cur.txt"
if [ "$mcm" != "true" ]; then echo "maintainerCanModify is false: we cannot push to $owner:$branch"; fi
git merge --abort 2>/dev/null
git reset -q --hard
git clean -fdq -e node_modules
git fetch -q origin
git fetch -q "https://github.com/$owner/openchamber.git" "$branch" && git branch -f "pr${n}-head" FETCH_HEAD
git checkout -q -B "pr$n" origin/main
if git merge --squash "pr${n}-head" > "$STATE/merge.log" 2>&1; then
  echo CLEAN
else
  echo CONFLICTS
  git diff --name-only --diff-filter=U
fi
echo "$owner:$branch maintainerCanModify=$mcm"
