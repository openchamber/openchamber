# Work-status panel

A card rendered to the right of the transcript inside `ChatContainer`. It
reports the state of the current session, its branch, its quotas and its
subagents.

## Structure

Every readout is a **labelled row**: icon, name, trailing value. A number
without a name is unreadable at a glance, which is what an unlabelled stream of
values degenerates into.

Rows are grouped into **named sections**, one component each, composed in
order by `WorkStatusPanel`. The separator between them is a
`:not(:first-child)` CSS rule rather than a prop, because every section renders
conditionally; passing "am I first?" down would mean each one tracking what the
sections above it decided to render.

Sections render nothing when they have no rows, so the panel collapses upward
instead of reserving empty space.

## What it is not

It is **not** a context-panel surface. It is not registered in
`lib/surfaces/registry.ts`, has no rail icon, no tab, no persisted width and no
resizer. It is a card floating inside the chat column — rounded border, faint
fill, its own margin — rather than a docked pane flush against the window edge.

## Placement

`ChatContainer`'s top-level return is a flex row:

- the existing chat column (`data-composer-bound`, `flex-1 min-w-0`), holding
  the viewport, the composer and the timeline dialog;
- `WorkStatusPanel`, a fixed-width `shrink-0` sibling.

Nothing inside `ChatViewport` changed. The virtualizer sees the column shrink
exactly as it already does when the context panel opens.

## Visibility

`useWorkStatusVisibility` hides the panel when any of these hold:

- the runtime is mobile or VS Code;
- the context panel is open for the active directory;
- the row cannot fit `WORK_STATUS_MIN_CHAT_WIDTH` of transcript alongside
  `WORK_STATUS_PANEL_WIDTH` of panel.

`ChatContainer` additionally suppresses it in mini-chat and in expanded-input
mode. It *is* shown on a new-session draft, where branch and working-tree state
inform what to ask for.

`rowRef` is a **callback ref, not an object ref**. An object ref gives no signal
when the node attaches, so the measuring effect read `.current`, found nothing
whenever the row mounted after the effect first ran, and only recovered on the
next unrelated dependency change — in practice, opening and closing the context
panel. `useWorkStatusVisibility.test.ts` covers a row that attaches late.

### Why the row is measured, not the chat column

**The width test must observe the row that contains both columns.** The chat
column's width is an *output* of the visibility decision: hiding the panel
widens the chat, which would re-satisfy a chat-width test and re-show the
panel, which narrows the chat again — an infinite oscillation. The row's width
does not depend on the panel, so it is the only stable input.
`useWorkStatusVisibility.test.ts` pins this with an explicit assertion on which
element the `ResizeObserver` was given.

The context-panel check mirrors `ContextPanel`'s own derivation: `isOpen` alone
is not enough, because a panel with no resolvable active tab renders nothing
and therefore displaces nothing.

## Data sources

Everything is read from already-warm caches. The panel adds no aggregated
endpoint and no polling of its own.

| Block | Source | Notes |
|---|---|---|
| Context + cost | `contextUsage.ts` over `useSessionMessages`, `Session.cost` | see below — the store getters cannot serve this |
| Branch, ahead/behind, attention | `useGitStore` directory state | warmed via `runBackgroundNetworkTask(ensureStatus)` |
| Changed files | `useGitStore` status `files` + `diffStats` | working tree, not session-authored edits |
| PR + checks | `usePrVisualSummary` | **read-only** |
| Subagents | child sessions from `useAllLiveSessions` (`parentID`) + `useAllSessionStatuses` | |
| Subagent blockers | directory `permission` / `question` maps | one subscription covers every child |
| Queue | `useMessageQueueStore` | |
| Usage | `components/usage/usageGroups.ts` over `useQuotaStore` | grouping shared with the mobile popover; presentation is not |
| Goal | `useSessionGoal` | respects the Settings toggle |
| MCP | `useMcpStore` | connect/disconnect reuses the dropdown's actions |
| Pinned messages | `getContextObligatoryMessages` + `state.part` | text resolved from the loaded part records |
| Todos | live `state.todo[sessionId]`, persisted fallback | live channel wins |

### Context usage has its own computation, on purpose

`useSessionUIStore.getContextUsage` cannot serve this panel for two reasons:

1. It reads `getSyncMessages(sessionId)` with **no directory**, resolving to the
   *current* directory's child store, and keys off the store's own
   `currentSessionId`. A session held by another directory — a worktree, or the
   moment after a directory switch — reads as "no messages", and the readout
   vanished while the header still showed a value.
2. It is an **imperative getter**, as is `useConfigStore.getCurrentModel`.
   Selecting one yields a reference that never changes, so calling it during
   render subscribes to nothing; the readout went stale across session switches.

`contextUsage.ts` therefore computes the same quantity from messages the panel
has already subscribed to for a known session and directory, and the panel
subscribes to `currentProviderId` / `currentModelId` for the limits.
`contextUsage.test.ts` pins the arithmetic — notably that the *latest*
reporting assistant turn is the answer, not a sum across turns.

Two further rules on this readout:

- The displayed percentage is computed **unrounded**. `clampPercent` applies
  `Math.round`, so routing the display value through it turned 33.6% into
  "34.0%" and made the panel disagree with the header. Rounding is still right
  for the colour threshold, which is what the header feeds it.
- When the model exposes no context limit, the percentage falls back to the
  store's own default limit instead of disappearing.

There is no cost-only fallback row. A row labelled "Context" showing nothing but
a price is not a context reading; cost rides along with the percentage or waits
for it.

### PR status is deliberately read-only

The panel never calls `startWatching`. PR watching is owned by the background
tracker, and its concurrency gate exists because per-consumer PR fetches once
saturated the browser's connection pool and stalled startup for ~20s. A panel
that started a watch per open session would reintroduce exactly that fan-out.

### Changed files come from git status, not the session

`Session.summary` looks like the obvious source and does not work. OpenCode's
`SessionSummary.summarize` writes `{additions: 0, deletions: 0, files: 0}` at
the start of every turn and then fills only the **message**-level
`summary.diffs`; session-level totals stay zero forever. The `session.diff`
event is reset to `[]` in the same place and carries real content only on
revert, so `state.session_diff` is not an aggregate either.

That leaves two honest options: aggregate per-message `summary.diffs` across
every turn, or read git status. The panel reads git status — it is
authoritative, already cached per directory, costs nothing extra, and sits
directly under the branch row where working-tree state is what a reader
expects.

The consequence is a real semantic difference: this counts the working tree,
including edits the user made by hand and excluding session edits that are
already committed. If a session-authored count is ever needed, it has to come
from aggregating message summaries, not from `Session.summary`.

## Section order

Ordering is by durability, not category:

1. **Session** (goal, context, cost), **Repository** (attention, branch,
   changes, PR, checks) and **Usage** — true for as long as the session is
   open. Usage sits here rather than lower down because a spent quota stops the
   work outright;
2. **Subagents**, **Tasks** — what is happening right now;
3. **MCP**, **Pinned**, **Context sources** — supporting material.

The Subagents section opens itself when subagents appear where there were none,
on that edge only: re-expanding on every count change would fight a user who
just collapsed it.

## Tasks

Icons and strike-through match the composer's todo dropdown, so one list does
not read as two. Two deliberate differences:

- **Completed items stay.** The dropdown is a queue to work through; this is a
  record of the session.
- **Sorted by status** — in progress, then pending, then completed — and stable
  within each rank, since the agent's own ordering carries meaning.

Rows truncate at this width, so each carries a delayed tooltip with the full
task text.

## Collapsed Usage headline

Collapsed, the Usage section shows one quota rather than a mode word: the
**shortest window reported by the provider the composer is pointed at**. A
5-hour bucket answers "will the next turn land"; a monthly one does not.

Selection rules live in `usageHeadline.ts` and are pinned by
`usageHeadline.test.ts`:

- provider ids are matched directly, with a small alias table for the ones that
  diverge from OpenCode's (`openai`/`chatgpt` → `codex`, `anthropic` → `claude`,
  `gemini` → `google`);
- model-scoped rows are skipped while any provider-level row exists — a
  per-model quota is not the provider's;
- rows without a window duration (credit balances, tool counters) are a last
  resort, never preferred over a real window;
- **no match means no headline.** The section falls back to the display-mode
  label, because showing an unmatched provider's quota would read as the active
  one.

## Actions

Rows that name something the app can already show are buttons:

| Row | Opens |
|---|---|
| Context | the context overview (`openContextOverview`), same destination as the header readout |
| Changes | working-tree diff (`openContextPanelTab`, `diffScope: 'working'`, no target path) |
| Branch | git surface (`openContextSurface(dir, 'git')`) |
| Pull request, Checks | PR surface (`openContextSurface(dir, 'pr')`) |
| Subagent | that child session's chat tab, read-only |
| Goal (row) | the composer's own `SessionGoalDialog` |
| Goal (pause/resume) | `setSessionGoalStatus(sessionId, directory, status)` |
| MCP switch | connects/disconnects the server |
| MCP status | the state doubles as the button that reconnects |
| Pinned (pin icon) | unpins the message |
| Pinned (text) | jumps the transcript to that message |

The goal icon reproduces the **composer target button's** colour mapping, not
the goal strip's. The two disagree today — the strip paints `paused` muted and
`blocked` warning, the button paints them info and error — and the button is
where this panel's reader last saw the goal. Unifying them is a separate change.

Jumping to a message goes through the `#message-<id>` URL hash, which
`useChatTurnNavigation` listens for inside `ChatContainer`. It is the only
cross-component jump the chat exposes; there is no store action or ref
registry. An unchanged hash fires no event, so the panel clears it first to make
a repeat press work.

Opening a subagent takes the same branch as the transcript's Task tool: an
embedded panel, mobile, or VS Code navigates to the session instead of nesting
a tab.

## Context sources

Linked GitHub threads first, then skills and MCP counts.

Agents are deliberately absent: an agent is who does the work, not material
loaded into the context. Tools are absent too — `Agent.tools` is a per-agent
override map rather than a registry, so its size would be a number that means
something other than "tools available".

### Linked issues and pull requests

Written by the flows that already attach a thread — the composer's issue/PR
pickers, and session creation from an issue or PR in `NewWorktreeDialog` and
`GitHubIssuePickerDialog`. There is no manual "link this" control: attaching a
thread to the work *is* the act of linking it.

Stored in session metadata as a **snapshot** (`lib/linkedIssues.ts`, namespace
`openchamber.linked_issues`), riding the same `patchSessionMetadata` channel as
pinned messages. Number, title, url, author and avatar only — the body,
comments and state belong to GitHub, and mirroring them would mean owning their
staleness. The stored title can drift; that is the price of a store that never
needs refreshing. The row opens the real thread, which is where current state
lives.

Writes happen **after** the send promise resolves and are deliberately
swallowed on failure: the message went out, and a missing bookkeeping entry
must not surface as a send error.

The entry id comes from the thread URL rather than a separate owner/repo pair,
because every attach flow has the URL and only some carry the repo separately.
Issues and pull requests share one id shape, since they share a numbering space
per repository.

## Loading data the header used to own

Two readouts had no loader of their own and appeared only after the user opened
the matching header dropdown:

- **MCP** — `McpDropdown` was the only mount-time caller of `refresh()`.
- **Usage** — `useQuotaAutoRefresh` merely schedules an interval; the *first*
  fetch was performed by the dropdown's open handler.

The panel now performs both itself, silently and through the
background-network gate, so it cannot compete with chat bootstrap traffic for
sockets. A panel that reports a subsystem's state cannot depend on an unrelated
component having been mounted or opened.

## Persisted panel state

Expanded sections (`workStatusExpandedSections`, keyed by a stable section id)
and the scroll offset (`workStatusScrollTop`) live in the persisted
`useUIStore`. Component state would not do: the panel unmounts every time the
context panel opens, which would silently discard the user's arrangement.

The scroll offset is restored in the scroller's callback ref, at the moment it
attaches, and read through `useUIStore.getState()` rather than a subscription —
subscribing would fight the user mid-scroll. Writes are coalesced to one per
animation frame.

## Not implemented yet

- Linked GitHub issues (needs session-metadata storage alongside
  `context_obligatory_messages`).
- Test/build/dev-server status and LSP diagnostics — a separate track. Note
  that `state.lsp` already exists in the sync state.
