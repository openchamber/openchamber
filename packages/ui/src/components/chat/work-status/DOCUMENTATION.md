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
When it overlays the transcript, it uses the shared `oc-glass-panel` surface;
the inline card keeps its lighter, non-blurred fill instead.

## Placement

`ChatContainer`'s top-level return is a flex row:

- the existing chat column (`data-composer-bound`, `flex-1 min-w-0`), holding
  the viewport, the composer and the timeline dialog;
- `WorkStatusPanel`, a fixed-width `shrink-0` sibling.

Nothing inside `ChatViewport` changed. The virtualizer sees the column shrink
exactly as it already does when the context panel opens.

## Visibility

`useWorkStatusVisibility` hides the panel when any of these hold:

- the user switched it off;
- the runtime is mobile or VS Code;
- the context panel is open for the directory the app is effectively on —
  looked up through `useEffectiveDirectory` and `normalizeContextPanelDirectoryKey`,
  the same key the rail and the panel use. It is deliberately **not** the
  directory this panel reports about: a managed Chat reports about none, and
  that empty key answered "closed" for a context panel that was plainly open;
- the row cannot fit `WORK_STATUS_MIN_CHAT_WIDTH` of transcript alongside
  `WORK_STATUS_PANEL_WIDTH` of panel.

`ChatContainer` additionally suppresses it in mini-chat and in expanded-input
mode. It remains available on a new-session draft: when the draft targets a
project or pending worktree, the panel uses that directory for project, MCP,
and usage readouts before a session exists.

Managed Chats never render or warm the Project repository section. A Chat draft
also passes no fallback directory to the panel, so an active project's branch
cannot leak into the draft while directory-independent sections remain
available.

`rowRef` is a **callback ref, not an object ref**. An object ref gives no signal
when the node attaches, so the measuring effect read `.current`, found nothing
whenever the row mounted after the effect first ran, and only recovered on the
next unrelated dependency change — in practice, opening and closing the context
panel. `useWorkStatusVisibility.test.ts` covers a row that attaches late.

### Why the chat area is measured, not the chat column

**The width test must observe something the panel cannot resize.** The chat
column's width is an *output* of the visibility decision: hiding the panel
widens the chat, which would re-satisfy a chat-width test and re-show the
panel, which narrows the chat again — an infinite oscillation.

It measures the **chat area** — the container holding the chat and the context
panel together, marked `data-chat-area` in `MainLayout`. Measuring the chat row
instead reported a width still catching up while the context panel animated
closed, so the panel reappeared only once that number crossed the threshold:
the chat widened and then narrowed again. The chat area does not move when the
context panel opens. `useWorkStatusVisibility.test.ts` pins both properties.

The context-panel check mirrors `ContextPanel`'s own derivation: `isOpen` alone
is not enough, because a panel with no resolvable active tab renders nothing
and therefore displaces nothing.

## Data sources

Everything is read from already-warm caches. The panel adds no aggregated
endpoint; quota data refreshes through the shared fixed three-minute quota timer,
which requests only providers enabled for this panel.

| Block | Source | Notes |
|---|---|---|
| Context + cost | `contextUsage.ts` over `useSessionMessages`; cost via `useSubagentCostRollup` (own cost + every descendant subagent, recursively) | see below — the store getters cannot serve this |
| Branch, ahead/behind, attention | `useGitStore` directory state | warmed via `runBackgroundNetworkTask(ensureStatus)` and refreshed from Git mutation hints |
| Changed files | `useGitStore` status `files` + `diffStats` | working tree, not session-authored edits |
| PR + checks | `useFreshestPrVisualSummaryForBranch` | **read-only**; follows the freshest remote-keyed entry for the branch |
| Subagents | child sessions from `useAllLiveSessions` (`parentID`) + `useAllSessionStatuses`; per-row cost from `useSubagentCostRollup`'s `perChildCost` (each child's own subtree total, so nested subagent-of-subagent cost rolls up under its immediate parent row) | |
| Subagent blockers | directory `permission` / `question` maps | one subscription covers every child |
| Usage | `components/usage/usageGroups.ts` over `useQuotaStore` | grouping shared with the mobile popover; presentation is not |
| Linked threads | `lib/linkedIssues.ts` over session metadata | written by the flows that attach an issue or PR |
| Goal | `useSessionGoal` | respects the Settings toggle |
| MCP | `useMcpStore` | connect/disconnect reuses the dropdown's actions |
| Pinned messages | `getContextObligatoryMessages` + `state.part` | see below |
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

### Pinned messages load only what they need

Pins are most useful on a long session — which is exactly when the pinned
message has scrolled far enough back not to be loaded, leaving the row with a
placeholder. The section materialises the session, but only when a pin actually
resolves to nothing: having pins is not a reason to fetch a session, and
neither is something being unloaded in general.

### PR status is deliberately read-only

The panel never calls `startWatching`. PR watching is owned by the background
tracker, and its concurrency gate exists because per-consumer PR fetches once
saturated the browser's connection pool and stalled startup for ~20s. A panel
that started a watch per open session would reintroduce exactly that fan-out.
The PR surface can watch a concrete remote while passive readers initially know
only the automatic remote key, so the panel reads the freshest entry for the
directory and branch across remote keys. This keeps its PR and checks rows in
sync with the live PR surface without adding another request owner.

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

One exception: while the directory is a worktree whose creation has not
finished (`useWorktreeBootstrapPending`), the working tree transiently holds
bootstrap files that the initial git reset is about to remove. Those are not
changes on the branch, so the panel neither fetches status nor renders the
changed-files row until the bootstrap settles, then forces one status fetch so
the row reflects the reset tree rather than a mid-creation snapshot.

## Section order

Ordering is by durability, not category:

1. **Session** (goal, context, cost), **Project** (attention, branch,
   changes, PR, checks) and **Usage** — true for as long as the session is
   open. Usage sits here rather than lower down because a spent quota stops the
   work outright;
2. **Subagents**, **Tasks** — what is happening right now;
3. **MCP**, **Pinned messages**, **Context sources** — supporting material.

## Switching it off

A persisted preference (`workStatusPanelEnabled`) drives a header toggle, and a
dialog behind the equalizer icon switches individual sections off. Hidden
sections are stored rather than visible ones, so a section added later appears
for everyone instead of staying invisible to whoever had saved settings before
it existed. Both travel the full settings pipeline, including the server
whitelist without which the keys never reach `settings.json`.

`workStatusPanelVisible` is separate and transient: the switch can be on while
layout still refuses the panel. The header and the git rail read it to drop the
readouts the panel already carries, and it is deliberately not persisted — it
describes the current frame, not a preference.

## Appearing and disappearing

The panel collapses on the context panel's own curve and duration rather than
unmounting, and slides out to the right with a fade when switched off. It stays
mounted wherever it could ever show, so the collapse has something to animate;
its content is dropped once the collapse finishes.

An empty card is a border around a settings icon, which reads as a fault. Each
section decides for itself that it has nothing to say, so they report through
`presenceContext.ts` and the panel collapses when none rendered. Deriving that
at the panel level would mean duplicating every data source the sections read.

There is one deliberate exception: when the user hides every section, the card
stays visible with a localized empty state and section controls. Collapsing that
state would also hide the only recovery path. A panel with enabled sections but
no data still follows the presence reports and collapses as before.

The scroll offset resets on session change: restoring one session's offset into
another's shorter panel lands somewhere arbitrary.

The Subagents section opens itself when subagents appear where there were none,
on that edge only: re-expanding on every count change would fight a user who
just collapsed it.

Its expanded list is capped at eight rows and scrolls independently, so a
session with many subagents does not crowd every section below it out of the
panel.

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
needs refreshing. A GitHub row opens github.com. A Linear row opens the
right-hand Linear panel when Linear is connected on desktop/web; otherwise it
opens the Linear URL (no rail in VS Code or the phone shell, and none while
disconnected).

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
- **Usage** — `useQuotaAutoRefresh` schedules the shared fixed three-minute
  refresh; the *first* fetch was performed by the dropdown's open handler.
- **Skills** — `loadSkills()` ran only when the composer's slash autocomplete
  opened, so the context-sources count was whatever happened to be cached. The
  section loads them itself, keyed on the directory, since skills are
  discovered relative to the active project. It does not wrap the call in
  `runBackgroundNetworkTask`: the store already gates its own fetch.

Usage waits for the instance to say it is initialised. Quota providers report
themselves as configured only once the instance can read their credentials,
which on a remote instance is not true when the UI mounts — a fetch fired at
mount gets "nothing configured" for every provider, and since each one then has
a result, nothing asks again until the three-minute refresh. That is why Usage
could stay missing from the panel until Settings -> Usage forced a fresh fetch.
`useQuotaStore.ensureLoadedForRuntime` owns both the readiness rule and the
once-per-instance bookkeeping, so every caller can ask on each connection
change.

### These readouts belong to the connected instance

Quotas, MCP status, skills, agent memory and the Linear/GitHub logins are all
served by whichever OpenChamber instance is connected, and each was cached
globally or by directory alone — which two instances can share. A switch left
the previous instance's answers on screen, and its Linear login usable against
a runtime that has no Linear. `apps/runtimeEndpointReset.ts` now drops all of
them, each store guarding its own in-flight requests with a generation so a
response for the previous instance cannot land in the new one. The MCP and
skills effects take `isConnected` as a dependency — not a gate — because
`directory` alone does not change when both instances hold the same path.

The panel now performs these itself, silently and through the
background-network gate, so it cannot compete with chat bootstrap traffic for
sockets. Usage additionally provides an explicit refresh action in its section
header. A panel that reports a subsystem's state cannot depend on an unrelated
component having been mounted or opened.

The repository section follows the same ownership rule. It subscribes directly
to `sessionEvents` Git refresh hints and refreshes its directory's shared Git
cache, rather than relying on the composer's former changed-files row or on the
Git context surface being opened first.

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

- Test/build/dev-server status and LSP diagnostics — a separate track. Note
  that `state.lsp` already exists in the sync state.
