# Session switch performance report

Date: 2026-07-11

## Outcome

The session row highlight is now committed independently from the authoritative
session switch and the heavy chat tree. In the six-switch development-mode
verification run, highlight latency was 18.7–27.8 ms. The new chat tree committed
in 89.5–312.1 ms while Markdown blocks and historical tools continued hydrating
in bounded background slices.

The absolute numbers below come from React/Vite development mode. Development
mode includes StrictMode and React DEV instrumentation, so production should be
faster; the acceptance gates intentionally use the slower development build.

## Baseline trace

Source: `Trace-20260711T002320.json.gz` supplied by the reporter.

Reproducible command:

```sh
python3 scripts/perf/analyze-session-switch-trace.py \
  /path/to/Trace-20260711T002320.json.gz
```

| Metric | Baseline |
| --- | ---: |
| Click samples | 6 |
| Click processing median | 258.94 ms |
| Click processing p95 / max | 1272.64 ms |
| Main-thread long tasks | 12 |
| Worst long task | 2291.68 ms |
| ParseHTML inside click windows | 42.25 ms |
| UpdateLayoutTree inside click windows | 62.55 ms |
| Layout inside click windows | 30.86 ms |
| Minor GC inside click windows | 56.31 ms |

The worst click spent about 1.27 seconds in its handler. The surrounding React
work included roughly 229 ms render, 373 ms commit, 324 ms effects, then another
249 ms render. A separate 2.29-second task contained about 568 ms render, 660 ms
commit, and 1037 ms effects.

The trace showed four causal groups:

1. The session ID was updated synchronously, so the sidebar highlight shared a
   batch with the entire chat remount.
2. The latest completed turn was always treated as a streaming tail and escaped
   history virtualization.
3. Historical Markdown synchronously ran parse, DOMPurify, decoration, and DOM
   insertion before paint; historical tools also registered layout effects even
   when animation was disabled.
4. Closed dialogs and broad sidebar/DnD consumers remained mounted and joined
   unrelated selection commits.

## Changes

### Selection and scheduling

- Added a narrow sidebar visual-selection store. Each row subscribes only to
  `state.sessionId === row.id`, so a click re-renders the old and new rows rather
  than the complete project tree.
- The visual row update commits first. The selected row's layout effect then
  uses a dedicated nested-rAF barrier to commit authority only after the row had
  a paint opportunity; it never waits behind the shared Markdown/tool queue.
- Every sidebar and direct navigation publishes a unique intent revision. Rapid
  or cross-entry switches cancel the intermediate authoritative commit.
- The chat root shows an inert lightweight surface during the authority change,
  preventing stale-session input or actions.
- Added User Timing measures:
  - `openchamber.session-switch.highlight-latency`
  - `openchamber.session-switch.content-latency`

### Historical rendering

- Only a genuinely working/streaming latest turn is kept outside virtualized
  history. Completed latest turns use the same virtualizer as older turns.
- Initial history overscan starts at 2 and grows by 2 in the shared frame-budget
  queue instead of mounting 8 desktop / 16 mobile overscan turns at once.
- Completed Markdown that has not entered the hydration window first paints a
  bounded skeleton over an invisible text-size spacer. Once released, the first
  layout pass sync-paints Markdown and reveals before the browser paints, then
  async morphdom upgrades to the rich DOM. Raw Markdown source is never painted.
  Work is cancelled when the row/session unmounts.
- Markdown hydration is scroll-driven rather than equal to virtual-list overscan:
  the newest turn stays hydrated immediately (including streaming-tail → history
  remounts), visible turns follow from bottom to top, and upward scrolling
  preloads only the nearest three mounted turns above the viewport. Idle time no
  longer upgrades every mounted overscan row.
- Hydrated history is tracked by stable entry keys, so prepends and far jumps do
  not accidentally hydrate unseen intermediate history. Streaming-tail Markdown
  remains immediate.
- Historical tool bodies hydrate individually through the same queue. Hydrated
  tool IDs are retained in a count-and-byte bounded LRU so scrolling does not
  repeatedly show placeholders.
- `animate=false` reveal paths no longer register layout/effect hooks.

### Cooperative scheduling and cancellation

- The shared frame queue now uses O(1) linked lanes ordered as
  `user-blocking > visible > background`. Cancelling an Activity removes its
  queued entries immediately instead of leaving FIFO tombstones that a later
  frame must scan with repeated `Array.shift()` calls.
- Markdown rendering for the current hydration window uses the visible lane;
  overscan and historical tool releases remain background work. Their React
  state updates run inside transitions, so a new synchronous session authority
  update can interrupt and discard the in-progress Fiber tree.
- Authoritative session visibility is never deferred by a transition. A cached
  Activity becomes visible from the synchronous selection key; a cache miss
  immediately replaces the old view with a lightweight bottom-aligned skeleton.
  Materializing the new Activity runs after that paint in the cancellable
  user-blocking queue, above visible/background Markdown work.
- Selection intent and cache materialization are separate pure state updates.
  The materializer validates an intent object, not only a session key, so stale
  work also fails for A -> B -> A without reading mutable render-time refs.
- A cache-miss Activity is staged outside the bounded LRU while Fiber renders
  it. It is admitted to the LRU only from the post-DOM-commit layout effect.
  If a newer shortcut interrupts that render, the newer selection clears the
  staged entry, so React lane rebasing cannot let an uncommitted B evict A.
- Cached `ChatContainerContent` trees are memoized and receive a stable estimate
  callback. Switching the active key therefore does not create prop-update work
  in every hidden Activity.
- Shiki requests carry `AbortSignal` and visible/background priority through the
  main-thread client and worker. Hidden-session jobs that have not started are
  removed; current visible highlighting overtakes queued history; cancelled
  results cannot mutate the DOM.
- React cannot preempt arbitrary synchronous JavaScript. One already-running
  Shiki tokenizer, one `marked`/DOMPurify block, Mermaid render, or morphdom
  commit must return before the browser can handle another task. The surrounding
  work is cancellable and block-scoped so stale work is bounded rather than
  draining an entire old session.

### Waste and cache control

- Tool output dialogs, plan dialogs, update/project dialogs, and the large new
  worktree dialog mount only while open.
- Synchronous Markdown HTML is cached, and Markdown, Mermaid, tool hydration,
  and turn projection caches are bounded by both entry count and estimated bytes.
- Turn projection cache keys are computed once per projection attempt instead of
  twice on a miss.

### LRU session views

- Previously, `ChatContainerContent` was keyed directly by the selected session,
  so every switch destroyed the old React tree. The chat shell now retains
  recently visited session views behind React `Activity` boundaries. Returning
  A → B → A reuses A's existing React state and DOM instead of remounting it.
- Hidden activities are not merely transparent or moved offscreen: React applies
  `display: none` and disconnects their effects and external-store subscriptions.
  This preserves local view state without letting every cached chat continue its
  full live workload in the background.
- Cache identity includes runtime, directory, and session ID. A runtime endpoint
  change remounts the runtime-scoped cache, so a remote host cannot inherit local
  composer, timeline, or DOM state even if IDs and paths happen to match. LRU
  recency is maintained independently from DOM order so a cache hit does not move
  a large hidden DOM subtree just to update ranking.
- Desktop keeps at most 4 views / 48 MiB estimated footprint. Mobile, VS Code, and
  mini-chat keep at most 2 views / 20 MiB. The active view is never evicted; the
  oldest inactive view is removed when either limit is exceeded.
- View weight is bucketed from message count and capped at 16 MiB per view. The
  coarse buckets avoid publishing cache-state updates on every streaming token or
  message-part delta. Estimate updates record weight first, then a committed
  layout pass trims against the latest selected key; a replayed old estimate
  cannot evict the current view.
- A unique active-intent identity is stored synchronously before background
  materialization. Interrupted A → B → A or A → B → C work therefore cannot
  change visibility or pollute/evict the LRU later. Cache-hit visibility does
  not wait for passive effects or the transition scheduler.
- Runtime manifests now require React/React DOM 19.2, the first stable release that
  exposes `Activity`; this avoids relying on the lockfile accidentally supplying a
  newer runtime than the declared minimum.

## Optimized verification

Environment: the same local data, React StrictMode, Vite development server,
three historical Agent Tracker sessions, six consecutive switches with 500 ms
between selections.

| Sample | Highlight painted | Chat content committed |
| ---: | ---: | ---: |
| 1 | 18.7 ms | 91.9 ms |
| 2 | 25.3 ms | 89.5 ms |
| 3 | 22.1 ms | 129.0 ms |
| 4 | 26.8 ms | 312.1 ms |
| 5 | 27.8 ms | 167.7 ms |
| 6 | 27.7 ms | 156.8 ms |
| Median | **26.05 ms** | **142.90 ms** |
| p95 / max | **27.8 ms** | **312.1 ms** |

Compared with the original trace's click-processing figures:

- Median highlight latency is 89.9% lower than the baseline median click task.
- Worst highlight latency is 97.8% lower than the baseline worst click task.
- Median content commit is 44.8% lower; the worst sampled content commit is
  75.5% lower.

The baseline click slice and the new User Timing measures are not identical
browser metrics, so these percentages describe user-visible critical-path
improvement rather than a laboratory A/B of the same trace event. A follow-up
Chrome recording can be passed to the analyzer to compare click slices and long
tasks on exactly the same basis; the User Timing measures will also appear in
that trace.

A post-change rapid B -> C -> A browser run ended with exactly one selected row,
the final A session in the URL, two hidden cached Activity views, 14 deferred
Markdown blocks, 28.2 ms highlight latency, and 187.0 ms content latency. No
intermediate session regained authority.

A later keyboard regression check used real `Mod+Shift+]` events. Before the
visibility fix, eight no-wait presses could leave the new title committed with
an empty chat main while the low-priority view transition caught up. After the
fix, ten no-wait presses ended with matching non-empty content, and all twelve
20 ms interval samples contained either the selected cached view or its explicit
loading placeholder; no old/blank view represented the new title.

## Acceptance gates

| Gate (development mode) | Result |
| --- | --- |
| Highlight p95 < 50 ms | Pass: 27.8 ms |
| Content commit median < 200 ms | Pass: 142.9 ms |
| Content commit p95 < 350 ms | Pass: 312.1 ms |
| Rapid switch keeps only latest authority commit | Pass: unit test |
| Direct navigation invalidates an older pending sidebar commit | Pass: unit test |
| Delayed content materialization cannot restore an intermediate session | Pass: rapid shortcut interactive race check |
| A → B → A stale materialization cannot enter/evict the LRU | Pass: identity-token unit test |
| Visible work overtakes background backlog; cancellation leaves no tombstones | Pass: queue tests |
| Cancelled Shiki work cannot publish; visible jobs overtake history | Pass: worker queue tests |
| Historical rich work is cancellable and frame-budgeted | Pass: unit tests + interactive run |
| Idle history leaves offscreen overscan Markdown deferred | Pass: interactive run (14 deferred after 2.5 s) |
| Upward scroll hydrates only visible + nearest older turns | Pass: candidate-order tests + interactive scroll |
| A → B → A retains the original chat view | Pass: LRU identity test + interactive Activity DOM check |
| Session view cache is count- and byte-bounded | Pass: unit tests |
| UI type-check | Pass |
| Edited-file lint | Pass |

## Regression commands

```sh
bun test \
  packages/ui/src/lib/afterPaintTaskQueue.test.ts \
  packages/ui/src/lib/dualLimitLru.test.ts \
  packages/ui/src/components/chat/hooks/useTurnRecords.test.ts \
  packages/ui/src/components/chat/lib/historyOverscan.test.ts \
  packages/ui/src/components/chat/lib/markdownHydrationWindow.test.ts \
  packages/ui/src/components/chat/markdown/markdown-worker-task-queue.test.ts \
  packages/ui/src/components/chat/lib/turns/turnProjectionCache.test.ts \
  packages/ui/src/components/chat/MarkdownRenderer.deferred.test.tsx \
  packages/ui/src/components/chat/sessionViewCache.test.ts \
  packages/ui/src/components/session/sidebar/sidebarVisualSelection.test.ts \
  packages/ui/src/components/session/sidebar/hooks/useProjectSessionSelection.test.ts

bun run --cwd packages/ui type-check
bun run --cwd packages/ui lint
```
