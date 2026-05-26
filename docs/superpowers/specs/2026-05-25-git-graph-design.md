# Git Graph Visualization — Design Spec

**Date:** 2026-05-25  
**Status:** Approved

---

## Overview

Replace the linear commit list inside the existing History modal with a proper git graph visualization — colored branch lanes, commit dots, merge/branch connectors, ref badges, and a full action surface per commit. The modal shell, diff viewer, and all other Git panel tabs are untouched.

---

## Goals

- Show the full commit DAG (all refs/branches) with visual branch lanes inside the History modal.
- Let users perform common commit operations (checkout, create branch, cherry-pick, revert, reset, merge, rebase) directly from the graph.
- Keep the UX pattern identical to the current History section: clicking a commit expands an inline detail row.
- Introduce no new dependencies.

## Non-Goals

- Interactive rebase (reordering, squash, fixup via drag-and-drop) — out of scope for this iteration.
- Blame / annotate view.
- Tag management UI.
- Submodule support.
- Any changes to the Commit, Update, or PR tabs.

---

## User Experience

### Graph layout

The History modal (`max-w-5xl h-[90vh]`) shows a scrollable list. To the left of each commit row is an SVG column containing:

- A **colored dot** at the commit's assigned lane position.
- **Vertical line segments** extending up and down through the commit's lane.
- **Bezier curves** at branch/merge points where lanes split or converge.

Lane width is 16px. The SVG column width equals `(maxActiveLanes + 1) * 16px`, capped at a reasonable max (e.g. 12 lanes = 192px). If a repo has more than 12 concurrent active branches, excess lanes are collapsed visually.

Each lane gets a color cycling through a fixed palette of 8 theme-token-based colors (see Implementation section).

### Commit row

Each row shows (left to right):

1. SVG graph column (described above).
2. **Ref badges** — branch and tag names parsed from the `refs` field, rendered as colored pills. Current HEAD branch gets a distinct style.
3. **Commit message** — truncated to one line.
4. **Author name** — truncated with tooltip.
5. **Date** — same locale format as current.
6. **Short hash** (8 chars, monospace) + copy button.

Clicking anywhere on the row toggles the inline detail section.

### Inline detail (expanded state)

When a row is expanded, a detail section appears directly below it, containing:

1. **Action buttons row** — primary actions as buttons, Reset as a split button:
   - Checkout
   - Create branch here (opens inline name input)
   - Cherry-pick
   - Revert
   - Reset... (opens a popover with Soft / Mixed / Hard options; Hard requires a confirmation dialog)
   - Merge into current branch
   - Rebase onto this commit

2. **Changed files list** with per-file diff toggle — identical to current `HistoryCommitRow` expanded state.

All actions close the modal on success and trigger a git status refresh. Conflict outcomes (cherry-pick, merge, rebase) leave the modal open and display the existing `ConflictDialog` / `InProgressOperationBanner` flow.

### Load more

The existing log size selector (25 / 50 / 100) is retained. A "Load more" affordance appended at the bottom of the list allows incremental loading without resetting scroll position.

---

## Architecture

### 1. Server — `packages/web/server/lib/git/service.js`

**Change `getLog`:**

Add an optional `all?: boolean` parameter. When `true`, pass `--all` to include all refs (remote branches, tags). Existing callers that omit `all` are unaffected.

Extend the `--pretty=format:` string to include `%P` (space-separated parent hashes).

Current format (approximate):
```
%H|%ai|%s|%b|%an|%ae|%D
```

New format:
```
%H|%P|%ai|%s|%b|%an|%ae|%D
```

Parse the new `parents` field as `string[]` (split on space, filter empty).

**New server function `checkoutCommit(directory, hash)`:**

Runs `git checkout <hash>`, resulting in detached HEAD. Returns `{ success: boolean }`. Already adjacent to `checkoutBranch` in `service.js`. Exposed via a new `POST /api/git/checkout-commit` route.

**New endpoints (4):**

| Method | Path | Handler |
|--------|------|---------|
| `POST` | `/api/git/checkout-commit` | `git checkout <hash>` — detached HEAD |
| `POST` | `/api/git/cherry-pick` | `git cherry-pick <hash>` |
| `POST` | `/api/git/revert` | `git revert --no-commit <hash>` |
| `POST` | `/api/git/reset` | `git reset --soft\|--mixed\|--hard <hash>` |

Create-branch (`createBranch` with a `startPoint`), merge, and rebase already exist.

Cherry-pick and revert return:
```ts
{ success: boolean; conflict?: boolean; conflictFiles?: string[] }
```

Reset returns:
```ts
{ success: boolean }
```

Hard reset must validate that the working tree is clean before executing, or the caller must explicitly pass `{ force: true }` after the user confirms in the UI.

### 2. Types — `packages/ui/src/lib/api/types.ts`

Extend `GitLogEntry`:
```ts
parents: string[]   // new — parent commit hashes
```

Add new request/response types:
```ts
interface CherryPickRequest { directory: string; hash: string }
interface CherryPickResponse { success: boolean; conflict?: boolean; conflictFiles?: string[] }

interface RevertRequest { directory: string; hash: string }
interface RevertResponse { success: boolean; conflict?: boolean; conflictFiles?: string[] }

interface ResetRequest { directory: string; hash: string; mode: 'soft' | 'mixed' | 'hard'; force?: boolean }
interface ResetResponse { success: boolean }
```

### 3. Client API — `packages/ui/src/lib/gitApiHttp.ts`

Add four thin wrappers:
- `checkoutCommit(directory, hash): Promise<{ success: boolean }>`
- `cherryPick(directory, hash): Promise<CherryPickResponse>`
- `revert(directory, hash): Promise<RevertResponse>`
- `reset(directory, hash, mode, force?): Promise<ResetResponse>`

Mirror them in `gitApi.ts` (runtime adapter pattern, same as all other git functions).

### 4. Lane assignment — `packages/ui/src/components/views/git/gitGraph.ts`

A new pure module (no React, no side effects) exporting:

```ts
export type LaneColor = string  // CSS color value from theme palette

export interface ConnectorSegment {
  fromLane: number
  toLane: number
  color: LaneColor
  type: 'straight' | 'branch-out' | 'merge-in'
}

export interface LanedCommit {
  commit: GitLogEntry
  lane: number
  color: LaneColor
  connectors: ConnectorSegment[]   // segments to draw between this row and the next
}

export function assignLanes(commits: GitLogEntry[]): LanedCommit[]
```

**Algorithm (greedy, O(n)):**

1. Build a child→parent map from `commit.parents`.
2. Maintain an `activeLanes: Array<string | null>` where each slot holds the commit hash that "owns" that lane (i.e., the commit whose parent is expected next on that lane).
3. For each commit (newest-first):
   a. Find any existing lane whose owner matches this commit's hash. If found, assign this commit to that lane. If not, assign the lowest free lane.
   b. Update the lane's owner to `commit.parents[0]` (the first parent continues the lane).
   c. For each additional parent (`parents[1..n]`), open a new lane and assign it to that parent hash.
   d. When two lanes converge on the same parent, free the higher-numbered lane.
4. Emit `ConnectorSegment` entries describing the lines to draw below each row.

### 5. Per-row SVG segment — `packages/ui/src/components/views/git/GitGraphSegment.tsx`

Because commit rows expand/collapse (showing file lists and diffs), a single monolithic SVG spanning the entire list would go out of alignment as row heights change. Instead, each `HistoryCommitRow` renders its own `<GitGraphSegment>` — a small SVG that fills exactly the height of that row.

A `GitGraphSegment` accepts:
- `laned: LanedCommit` — the lane data for this commit
- `totalLanes: number` — total active lanes at this point (for SVG width)
- `isExpanded: boolean` — whether the row is currently expanded

It renders:
- **Passing-through lanes** (lanes active but not this commit's lane): vertical `<line>` elements from y=0 to y=100% in the appropriate lane's color.
- **This commit's dot**: `<circle>` at `(lane * LANE_WIDTH + LANE_WIDTH/2, 50%)` — vertically centered in the non-expanded row header area.
- **Branch-out / merge-in curves**: cubic bezier `<path>` elements connecting lane columns at the top and bottom edges of the segment.
- When `isExpanded`, the segment height grows with the row; passing-through lines extend the full height; the dot stays in the fixed header portion (first `ROW_HEADER_HEIGHT` pixels).

`ROW_HEADER_HEIGHT` is a shared constant (e.g. `40px`) used by both `GitGraphSegment` and `HistoryCommitRow` to pin the dot's vertical position consistently.

The SVG width equals `(totalLanes) * LANE_WIDTH + LANE_WIDTH/2`, with `LANE_WIDTH = 16`.

**Lane color palette (8 colors, theme tokens):**
```ts
const LANE_COLORS = [
  'var(--chart-1)',        // blue
  'var(--chart-2)',        // green
  'var(--chart-3)',        // orange/yellow
  'var(--chart-4)',        // rose/coral
  'var(--chart-5)',        // golden sand
  'var(--syntax-keyword)', // purple/blue
  'var(--syntax-string)',  // teal/cyan
  'var(--status-info)',    // cyan/blue (8th lane)
]
```

### 6. Updated `HistoryCommitRow` — `packages/ui/src/components/views/git/HistoryCommitRow.tsx`

Changes:
- Accept `laned: LanedCommit` prop (replaces the standalone `entry` prop, or wraps it).
- Render ref badges from `entry.refs` — parse `HEAD -> branchName`, `origin/branchName`, `tag: tagName` patterns.
- Add the action buttons row in the expanded state (above the file list).
- Wire action button handlers: call client API functions, handle loading/error states, trigger status refresh on success.
- Conflict results from cherry-pick, revert, merge, and rebase are propagated up to `GitView` via a callback prop `onConflict(result)`. `GitView` already owns the `ConflictDialog` and `InProgressOperationBanner` state; `HistorySection` calls `onConflict` and `GitView` opens the appropriate dialog. This is consistent with how merge/rebase conflicts from other tabs are handled.

### 7. Updated `HistorySection` — `packages/ui/src/components/views/git/HistorySection.tsx`

Changes:
- Call `assignLanes(entries)` after log fetch to produce `LanedCommit[]`.
- Render `<GitGraphCanvas laned={laned} rowHeight={ROW_HEIGHT} />` as a sticky left column.
- Pass `laned[i]` to each `HistoryCommitRow` instead of `entry`.
- Keep the load-size selector and "load more" logic.

---

## Data Flow

```
User opens History modal
  → GitView fetches /api/git/log?maxCount=N&all=true
  → Server returns GitLogResponse with parents[] on each entry
  → HistorySection calls assignLanes(entries) → LanedCommit[]
  → GitGraphCanvas renders SVG from LanedCommit[]
  → HistoryCommitRow renders each row with graph dot aligned

User clicks commit row
  → Inline detail expands
  → Action buttons rendered
  → User clicks "Cherry-pick"
    → POST /api/git/cherry-pick {directory, hash}
    → On success: modal closes, git status refresh triggered
    → On conflict: ConflictDialog opens (existing flow)
```

---

## Error Handling

- **Cherry-pick / revert conflicts**: Return `{ success: false, conflict: true, conflictFiles: [...] }`. The UI routes to the existing `ConflictDialog` / `InProgressOperationBanner`.
- **Hard reset with dirty working tree**: Server returns a descriptive error. UI surfaces it as a toast; user must stash or commit first.
- **Log fetch failure**: Existing error state in `HistorySection` unchanged.
- **Action failures (network, git error)**: Toast with error message. Modal stays open.

---

## Testing

- Unit tests for `assignLanes` in `gitGraph.test.ts`: linear history, single branch; two diverging branches; merge commit; criss-crossing branches; octopus merge (3+ parents).
- Unit tests for the four new server endpoints: success path, conflict path, error path.
- Smoke test: existing `HistorySection` renders without regression (existing log entries without `parents` field are treated as `parents: []` — no graph lines drawn, dots still shown).

---

## Files Changed

| File | Change |
|------|--------|
| `packages/web/server/lib/git/service.js` | Extend `getLog` format; add `cherryPick`, `revert`, `reset` functions |
| `packages/web/server/lib/git/routes.js` | Add 4 new POST routes |
| `packages/ui/src/lib/api/types.ts` | Add `parents` to `GitLogEntry`; add 3 new request/response types |
| `packages/ui/src/lib/gitApiHttp.ts` | Add `cherryPick`, `revert`, `reset` HTTP wrappers |
| `packages/ui/src/lib/gitApi.ts` | Mirror new functions via runtime adapter |
| `packages/ui/src/components/views/git/gitGraph.ts` | New — lane assignment algorithm |
| `packages/ui/src/components/views/git/GitGraphSegment.tsx` | New — per-row SVG segment renderer |
| `packages/ui/src/components/views/git/HistoryCommitRow.tsx` | Add ref badges, action buttons |
| `packages/ui/src/components/views/git/HistorySection.tsx` | Wire lane assignment + SVG canvas |
| `packages/web/server/lib/git/service.test.js` | Tests for 3 new server functions |
| `packages/ui/src/components/views/git/gitGraph.test.ts` | Tests for `assignLanes` |
