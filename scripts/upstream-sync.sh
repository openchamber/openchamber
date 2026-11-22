#!/usr/bin/env bash
# Deterministic upstream sync and validation helper for developing-today-forks/openchamber.
# Tracks upstream/main into devtoday/main.
set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
FORK_REMOTE="${FORK_REMOTE:-devtoday}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"

echo "==> Fetching latest remotes..."
git fetch -q "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
git fetch -q "$FORK_REMOTE" "$TARGET_BRANCH"

UPSTREAM_TIP=$(git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")
MERGE_BASE=$(git merge-base "$FORK_REMOTE/$TARGET_BRANCH" "$UPSTREAM_TIP")
COMMITS_BEHIND=$(git rev-list --count "$FORK_REMOTE/$TARGET_BRANCH..$UPSTREAM_TIP")

echo "Upstream tip:   $UPSTREAM_TIP"
echo "Merge base:     $MERGE_BASE"
echo "Commits behind: $COMMITS_BEHIND"

if [ "$COMMITS_BEHIND" -eq 0 ]; then
  echo "Fork is already up-to-date with $UPSTREAM_REMOTE/$UPSTREAM_BRANCH."
  exit 0
fi

echo "==> Performing merge of $UPSTREAM_REMOTE/$UPSTREAM_BRANCH..."
git merge --no-ff "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" -m "chore(sync): merge upstream $UPSTREAM_BRANCH into $TARGET_BRANCH" || {
  echo "Merge conflicts detected. Please resolve conflicts following fork principles:"
  echo "  1. Keep all features and routes from both sides."
  echo "  2. Do not remove any API or feature removed upstream (preserve fork capabilities)."
  echo "  3. Isolate fork features into modular files (e.g. routing/, plans/) to minimize future conflicts."
  echo "  4. Maintain dictionary key parity across all 15 locales in packages/ui/src/lib/i18n/."
  exit 1
}

echo "==> Validating build, i18n, and test suites..."
bun install
bun run type-check:ui
(cd packages/ui && bun test src/lib/i18n/messages.test.ts)
(cd packages/ui && env NODE_ENV=development bun test src/components/sections/routing/PlansSection.test.tsx)
(cd packages/web && npx vitest run server/lib/routing/)

echo "==> OpenChamber upstream sync successful."
