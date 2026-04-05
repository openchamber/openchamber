# UI Stores

## Purpose

`packages/ui/src/stores` contains app-level Zustand stores for persistent UI state, runtime state, and feature caches.

Not all state in the UI belongs here.

Use a store when state is:

- shared across distant parts of the app
- needed outside a single component subtree
- cache-like and keyed by runtime identity (for example directory, branch, session id)
- updated imperatively from multiple surfaces

Do not put high-frequency local component state here just because it is convenient.

## Architecture

There are multiple store categories in this directory.

### Feature cache / query stores

These are the most performance-sensitive.

- `useGitStore.ts`
- `useGitHubPrStatusStore.ts`
- `useFilesViewTabsStore.ts`

These stores act like centralized keyed caches. UI should consume narrow slices from them instead of re-fetching the same data in multiple places.

### UI state stores

Examples:

- `useUIStore.ts`
- `useDirectoryStore.ts`
- `useFeatureFlagsStore.ts`
- `useUpdateStore.ts`

These stores coordinate visible app state, navigation, selected tabs, dialogs, and lightweight feature flags.

### Session / project coordination stores

Examples:

- `useProjectsStore.ts`
- `useGlobalSessionsStore.ts`
- `useSessionFoldersStore.ts`

These stores coordinate persistent project/session metadata across multiple views.

## Git / PR Stores

The Git and PR stores are the most important stores to understand before editing this directory.

### `useGitStore.ts`

`useGitStore` is a centralized per-directory Git cache.

Core model:

- top-level keyed by `directory`
- each directory entry contains:
  - repo detection
  - status
  - branches
  - log
  - identity
  - diff cache
  - per-directory loading flags
  - freshness timestamps

Important properties:

- `directories: Map<string, DirectoryGitState>` is the source of truth
- loading state is per-directory, not global
- `ensureStatus()` and `ensureAll()` are the preferred entry points for consumers
- in-flight dedupe exists for status and `ensureAll()`
- diff data is separately cached and capped with size + count limits

### `useGitHubPrStatusStore.ts`

`useGitHubPrStatusStore` is a centralized PR cache keyed by `directory::branch`.

Core model:

- each entry stores:
  - current PR status payload
  - loading / error state
  - whether initial status was resolved
  - refresh timestamps
  - watch count
  - runtime params
  - resolved identity

Important properties:

- `ensureEntry()` initializes a key lazily
- `setParams()` attaches runtime context
- `startWatching()` / `stopWatching()` are for true live PR consumers only
- `refreshTargets()` supports one-shot multi-target bootstrap without turning on live watching
- persisted cache is for page refresh continuity, not for broad background syncing

## Ownership Rules

These rules are important. Breaking them tends to reintroduce idle CPU churn, stale UI, or rerender fanout.

1. No broad `directories` or `entries` subscriptions in normal UI components.
2. No root pollers for Git or PR.
3. No broad idle sweeps across many directories.
4. Prefer store `ensure*` methods over direct runtime API calls from views.
5. Visible consumers should drive refresh. Hidden consumers should not.
6. Header should not depend on PR store.
7. Closed sidebar should not create live PR work.
8. File tree Git status should update only when the file tree is visible.

## Selector Rules

Use leaf selectors.

Good:

- `useGitStatus(directory)`
- `useGitBranches(directory)`
- `useGitBranchLabel(directory)`
- `useGitRepoStatusMap(directories)`
- `usePrVisualSummaryByKeys(keys)`

Bad:

- `useGitStore((state) => state.directories)` in feature components
- `useGitHubPrStatusStore((state) => state.entries)` in feature components
- render-time scans over every PR entry for a single project/group badge

Why this matters:

- Zustand reruns selectors on every `set`
- rerenders are avoided only if the selected result stays referentially stable
- broad subscriptions magnify fanout even when only one directory changed

## Performance Rules

### 1. Preserve references for unaffected entities

If directory `A` changes, directory `B` should keep the same derived reference where possible.

### 2. Keep loading state per entity

Do not add new global `isLoadingWhatever` flags for keyed cache work.

### 3. Avoid hidden work

If a surface is not visible, it should not keep refreshing Git/PR state.

Examples:

- `PullRequestSection` may watch a PR while visible
- `SessionSidebar` may bootstrap missing PR data for expanded visible groups
- hidden sidebar should not watch PRs

### 4. Prefer one-shot event hints over polling

Example already in use:

- successful mutating tools emit a centralized Git refresh hint through `sessionEvents`
- visible `GitView` / `DiffView` consume the hint and refresh current-directory status

This is preferred over background polling.

### 5. Treat `diffStats` carefully

`GitStatus.diffStats` may be omitted by light status fetches.

Rules:

- do not erase richer existing `diffStats` with a lighter payload
- if a UI surface requires per-file `+/-` stats, it must ensure a full enough status payload exists

### 6. Keep diff cache bounded

Diff cache has explicit limits because large repos can otherwise blow up memory.

Do not raise limits casually.

## Refresh Model

### Git

Expected model:

- `GitView` / `DiffView` ensure current-directory Git state when visible
- explicit Git actions refresh status/branches/log as needed
- successful file-mutating tools can issue a one-shot Git refresh hint
- no root-level background Git polling

### PR

Expected model:

- `PullRequestSection` is the only true live PR watcher
- `SessionSidebar` may do one-shot bootstrap for expanded visible project/worktree groups if PR info is missing
- no live PR work for header
- no background PR sweeps outside visible demand

## Known Intentional Fallbacks

There is still one explicit fallback path worth knowing about:

- `SessionSidebar` may call `checkIsGitRepository(...)` during initial worktree/project discovery when store state is not populated yet

This is currently acceptable as a narrow bootstrap fallback.

Do not widen it into a polling or broad refresh system.

## When Editing These Stores

Before changing store shape or selectors, ask:

1. Is this keyed by the right identity (directory, branch, session, root)?
2. Will this force unrelated consumers to rerender?
3. Should this be visible-demand-driven instead of background-driven?
4. Is there already a store cache for this data?
5. Am I duplicating fetch ownership in a component when it should live in a store action?

## Validation Checklist

After meaningful Git/PR store changes, verify manually:

1. Idle desktop app stays quiet on draft/chat screen.
2. Git view still loads status, branches, log, identity.
3. Diff view still opens the correct file and stays in sync.
4. Worktree sessions still show branch labels in header.
5. Expanded sidebar projects/worktrees can show PR state without requiring prior selection.
6. Hidden surfaces do not reintroduce live background work.
