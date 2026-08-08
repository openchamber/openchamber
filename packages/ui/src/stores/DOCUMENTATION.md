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
- `messageQueueStore.ts`

These stores coordinate persistent project/session metadata across multiple views.

`messageQueueStore.ts` keeps a queued message until its own send resolves, so between dispatch and resolution the entry is still visible to every reader. Dispatchers must therefore mark the send (`markSending`/`clearSending`) and read `getSendableQueue()` — or filter `sendingIds` themselves — instead of dispatching straight from `queuedMessages`; otherwise a composer submit merges a message the auto-send hook is already delivering and it is sent twice (the window is seconds over a relay). `clearQueue()` retains in-flight entries for the same reason. `sendingIds` is deliberately not persisted: a restart has no in-flight sends, and a stale flag would strand a queued message.

`useGlobalSessionsStore.ts` owns cold/global active and archived session coverage, including `sessionsByDirectory`. It is complementary to directory child stores: it is not the source of live busy/retry status or session messages.

User-visible session ordering is also not owned by the global cache array order. `sync/session-ordering.ts` combines lifecycle rank with timestamp fallbacks, and session surfaces must use that shared comparator instead of independently sorting global sessions by `time.updated`.

Global refresh rules:

- The OpenCode `archived` list flag means "also include archived sessions": the server only drops its `time_archived IS NULL` condition. The global cache therefore loads with one inclusive request (`archived: true`) and splits active/archived client-side via `splitGlobalSessionsByArchived` — an `archived: false` request cannot be truthful because the server filter excludes restored sessions (`time.archived` falsy-but-present, see "Restore (unarchive) contract" in `sync/DOCUMENTATION.md`). For callers that still want only archived records, `listGlobalSessionPages` narrows inclusive responses at the data boundary (default `narrowToArchived`), so the archived cache never holds active sessions and no consumer has to re-derive that. Pagination progress stays measured on the raw response, so a page that is full upstream but filtered out here is not mistaken for the last page.
- Per-directory refresh issues one inclusive request per directory (previously two), bounded to two requests across callers and prioritizing the current directory.
- Each directory is an independent completeness scope. A failed directory preserves its previous sessions while successful directories reconcile normally.
- Fetch failure must remain distinguishable from a successful empty list; failed scopes cannot destructively clear cached sessions.
- Runtime switch increments the load generation and clears the previous runtime's snapshot so stale in-flight work cannot commit.
- Live session mutations update the cache directly after successful SDK actions; they preserve stable directory metadata when lighter event payloads omit it.
- Full and per-directory loads capture a mutation revision. At commit time they overlay only per-session create/update/archive/delete/move mutations newer than that baseline, including no-op deletion tombstones, so an older response cannot undo newer local authority.

Permission auto-accept policy is authoritative in the active Web server or VS Code extension host. Owner snapshots carry a monotonic revision; the UI rejects lower revisions and any hydration or mutation completion captured before a runtime reset. Persisted UI policy is not live authority. The version-2 store retains an old unscoped policy only as a one-runtime legacy migration candidate, then removes it after successful migration.

Shared safe storage treats durable failures per key. A quota or access failure creates an ephemeral override or tombstone for that key without disabling reads and writes for unrelated keys; later writes retry the durable backend. Deferred adapters retain failed operations for a later flush, and malformed Zustand JSON is removed and treated as missing so hydration can recover.

Project and UI settings use successful settings synchronization as authority. Omitted fields in a complete snapshot reset to canonical client defaults, including an omitted project list becoming empty; transport or settings-load failure dispatches no synchronization event and preserves current state. Settings save responses are partial patches and must not clear unrelated in-memory preferences or local mirrors.

Project ordering defaults to manual. Session display persistence v3 migrates the previously shipped `recent` project order to `manual` while preserving every other explicit sort mode.

Session folders persist in runtime-specific v2 browser keys without silently evicting older runtime namespaces. Runtime switch, page hide, app freeze, and unload synchronously flush the pending browser snapshot before lifecycle suspension or namespace replacement. A runtime switch then cancels stale old-runtime disk work and starts generation-owned disk hydration. Missing or malformed server files are not authoritative empty snapshots; disk data may replace browser state only when it carries a real revision and no newer local folder mutation occurred. Server writes are serialized and reject non-newer revisions so delayed or duplicate requests cannot overwrite the current state. File-search cache and in-flight keys include runtime plus directory and are cleared on endpoint reset.

Persisted session todos use a bounded composite key of runtime, normalized directory, and session ID. Ambiguous legacy todo entries are discarded rather than claimed by whichever runtime starts first. Authoritative deletion uses an explicit runtime identity, and session-folder deletion scans every scope in the active runtime so archived assignments cannot survive after their session is gone.

Chat composer drafts, confirmed mentions, inline-comment drafts, and pinned sessions use the same runtime/directory/session ownership rule. Chat drafts use a bounded shared envelope and notify mounted composers when authoritative deletion clears their identity, preventing unmount autosave from resurrecting deleted text. Inline drafts enforce per-session, global-session, and serialized-byte bounds. Pins retain every valid composite key across runtimes without silent age/count eviction and are never pruned from the first startup list. Confirmed local deletion and routed deletion events clear immediately; after an authoritative baseline exists, a later complete omission also cleans persisted state. Ambiguous session-only legacy drafts and pins are not claimed.

Composer draft edits remain immediate in memory and use a trailing durable-write debounce. Pending text and confirmed mentions flush synchronously when the document becomes hidden, freezes, receives `pagehide`, switches identity, or unmounts; authoritative deletion cancels pending work before any lifecycle flush can run. The shared chat-draft envelope reuses its parsed snapshot until the storage value changes. Inline-comment draft byte accounting indexes serialized buckets and recalculates only the changed session bucket during normal edits; deferred storage still performs the final full-envelope serialization and lifecycle flush.

### `useTerminalStore.ts`

`useTerminalStore` owns terminal tab arrangement per directory plus PTY scrollback.

Scrollback is deliberately **not** stored on the tab. `buffers` is a separate map keyed by
directory and tab id, and `getBuffer()` returns a shared frozen empty buffer for tabs that
have produced no output. PTY output arrives at streaming frequency, so keeping it inside
`sessions` made every output chunk allocate a new tab, a new directory entry and a new
`sessions` map. That invalidated every tab-strip subscription, re-ran the project-action
run monitor, and made Zustand persist rewrite the session-storage snapshot per chunk.

Invariants to preserve when editing:

- Output actions (`appendToBuffer`, `replaceBuffer`) must leave `sessions` referentially
  unchanged; only `buffers` and `nextChunkId` may change.
- Buffer entries are owned by their tab. `closeTab`, `removeDirectory`, `clearAll`, and
  rebinding a tab to a different terminal session must drop the entry.
- Output for an unknown tab is ignored rather than creating an orphan buffer.
- Only `sessions` and `nextTabId` are persisted. `partialize` reuses its previous
  projection while both are referentially unchanged, and the storage adapter skips a write
  for an unchanged projection, so streaming output performs no persistence work.
- Consumers that react to output must subscribe to `buffers`, not `sessions`.

## Git / PR Stores

The Git and PR stores are the most important stores to understand before editing this directory.

### `useGitStore.ts`

`useGitStore` is a centralized active-runtime, per-directory Git cache.

Core model:

- active runtime owns one `directories` map keyed by directory
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
- nested repository discovery (`nestedReposByRoot`, `nestedRepoSelection`, `ensureNestedRepos`) is per-root state for roots that are not themselves git repositories; discovery failure is a `null` marker (never a valid empty result), selections are persisted per runtime + root, and `useEffectiveGitDirectory(root)` resolves the directory the Git tab operates on (`root` when the root is a repository, the selected nested repository otherwise)
- runtime reset replaces all live entries with that runtime's persisted branch seeds and invalidates old completions
- status, branches, log, identity, repository probes, and prefetch diffs commit through runtime and per-channel generations
- status mutations advance a revision so older refreshes cannot undo optimistic or confirmed index changes
- branch persistence is versioned, bounded, runtime-scoped, and claims the ambiguous legacy cache once
- diff data has per-directory and aggregate count/UTF-8-byte limits; oversized single entries are rejected

### `useGitHubPrStatusStore.ts`

`useGitHubPrStatusStore` is a centralized PR cache keyed by a collision-safe tuple of runtime, directory, branch, and requested remote.

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
- parameter changes advance an entry revision; stale queued, successful, and failed requests cannot update a newer authority
- `startWatching()` / `stopWatching()` are for true live PR consumers only
- `refreshTargets()` supports one-shot multi-target bootstrap without turning on live watching
- runtime reset disposes timers, watchers, API references, and request ownership while inert namespaced snapshots remain isolated
- persisted cache is versioned, TTL-filtered, and bounded for page refresh continuity, not broad background syncing

## Ownership Rules

These rules are important. Breaking them tends to reintroduce idle CPU churn, stale UI, or rerender fanout.

1. No broad `directories` or `entries` subscriptions in normal UI components.
2. No root pollers for Git or PR.
3. No broad idle sweeps across many directories.
4. Prefer store `ensure*` methods over direct runtime API calls from views.
5. Visible consumers should drive refresh. Hidden consumers should not.
6. Header should not depend on PR store.
7. A closed context panel (or hidden git surface) should not create live PR work.
8. File tree Git status should update only when the file tree is visible.
9. Global session refresh must remain bounded and failure-isolated per directory.
10. Global session cache must not drive live activity indicators or message-loading state.

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
- a mounted file-mutating tool issues a one-shot Git refresh hint when it transitions from active to successfully finalized; remounting historical completed tools does not replay the hint
- a successful dirty save from the in-app file editor issues a path-scoped Git refresh hint; clean autosave checks remain no-ops
- refresh hints with authoritative file paths invalidate only those cached and currently rendered diffs before status refresh; pathless tools request status reconciliation without broadly remounting DiffView
- targeted diff remounts preserve the user's current file-section anchor and intra-file offset before paint instead of resetting the stacked view to the top
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
