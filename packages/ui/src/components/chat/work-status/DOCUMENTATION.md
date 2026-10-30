# Work-status panel

A card rendered to the right of the transcript, in the right slot it shares
with the context panel. It reports the state of the current session, its branch, its quotas and its
subagents.

## Structure

Every readout is a **labelled row**: icon, name, trailing value. A number
without a name is unreadable at a glance, which is what an unlabelled stream of
values degenerates into.

Rows are grouped into **named sections**, one component each, composed in
order by `WorkStatusPanel`. They are parted by space alone, no rule. The gap
is a `:not(:first-child)` CSS rule rather than a prop, because every section renders
conditionally; passing "am I first?" down would mean each one tracking what the
sections above it decided to render.

Sections render nothing when they have no rows, so the panel collapses upward
instead of reserving empty space. Turn stats keeps its header for a
selected session even without metrics, so a saved collapsed state can reopen.

## What it is not

It is **not** a context-panel surface. It is not registered in
`lib/surfaces/registry.ts`, has no rail icon, no tab, no persisted width and no
resizer. It is a card inside the chat column — rounded, with the dropdown's
hairline ring (`oc-panel-edge`, shared with the context panel card), a faint
fill and its own margin — rather than a docked pane flush against the window
edge. Opened over the transcript it is a dropdown and takes the dropdown's
full edge, lit top and tight shadows included (`data-edge-floating`).
When it overlays the transcript, it uses the shared `oc-glass-panel` surface;
the inline card keeps its lighter, non-blurred fill instead.

## Placement

`ChatContainer` owns the card's state, but the inline card renders through a
portal into the right slot (`components/layout/rightSlot.ts`): the context
panel's `aside` in `MainLayout`, which holds a right-anchored host for the card
under the panel's content. The slot animates one width for both, from the
card's column (`WORK_STATUS_COLUMN_WIDTH`, the card and its margins) to the
panel's width and back, while the card fades out and the panel fades in over
it. The chat column therefore narrows or widens once, in one direction.

The card tells the slot whether it wants its column through `reserved`:
switched on, room beside the chat (`roomy`, see below), and something to
show. It stays reserved while the context panel covers it, so closing the
panel goes straight back to the card's column instead of to nothing first.

When the chat area also fits the context panel (`roomyBesidePanel`), the card
keeps its column beside the open panel (`besidePanel`). The slot then grows
to the panel plus the card's column, the card's host anchors to the slot's
start and the panel card is offset past it, so the card stays between the
chat and the panel. Opening the panel slides it in from the window's edge
while the card moves with the chat's edge; closing reverses that. The
answer is known while the panel is closed too, so the commit that opens it
already animates to the final width.

The card has the lowest priority in the row: it claims no room from the left
zone and never makes the session sidebar fold. A panel dragged wider stops
where the chat would drop under its own minimum next to the card, and the card
yields once the panel is released wider than it fits beside.

The overlay form stays inside the chat column in `ChatContainer`.

### Why the card docks beside the panel instead of floating over the chat

A pinned card that floats over the transcript while a side panel is open was
weighed against it. Floating covers the transcript it reports on and needs an
opaque surface over moving text plus a rule for narrow windows. Docking uses
room the window already has and adds no setting: where the room is missing,
the card yields exactly as it did before, and the header still offers the
overlay.

## Visibility

`useWorkStatusVisibility` hides the panel when any of these hold:

- the user switched it off;
- the runtime is mobile or VS Code (the phone shows the sections in its own
  tab, see below);
- the row cannot fit `WORK_STATUS_MIN_CHAT_WIDTH` of transcript alongside
  `WORK_STATUS_PANEL_WIDTH` of panel. Only the threshold decisions are state
  (`roomy`, `roomyBesidePanel`); the width itself is not, because it changes
  on every frame of a sidebar animation and storing it re-rendered the whole
  chat each frame;
- the right zone's context panel is open and the row cannot also fit that
  panel at its own width (`sideZoneWidth`: the zone's stored size, or the tree
  width for Files showing only its tree), or the panel is expanded. The panel
  is looked up for the directory the app is effectively on, through
  `useEffectiveDirectory` and `normalizeContextPanelDirectoryKey`, the same
  key the rail and the panel use. It is deliberately **not** the directory
  this panel reports about: a managed Chat reports about none, and that empty
  key answered "closed" for a context panel that was plainly open.

The panel's width comes from the store, never from the DOM: it is the user's
setting, so a resize or a surface switch moves the threshold and the last
area reading is re-decided before paint.

`ChatContainer` additionally suppresses it in mini-chat and in expanded-input
mode. It remains available on a new-session draft: when the draft targets a
project or pending worktree, the panel uses that directory for project, MCP,
and usage readouts before a session exists.

Managed Chats never render or warm the Project repository section. A Chat draft
passes no fallback directory to the panel, so an active project's branch cannot
leak into it. The MCP section prepares the draft's own directory through
`prepareChatDraftDirectory`, shared with the header dropdown and first send.
MCP reads and toggles wait for that directory; they never use the previous
Chat's connections or the shared Chats root for a draft.

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

## On the phone

The phone has no card. Its workspace drawer opens on a Work status tab
(`apps/MobileStatusPane.tsx`), first by default, that renders the same
`WorkStatusSectionList` the card renders, for the session on screen. It
replaced the drawer's MCP tab: the MCP section carries the same switches.

- **Its own hidden list.** `mobileWorkStatusHiddenSections` is per device and
  starts with Subagents hidden; the order is the shared
  `workStatusSectionOrder`. `useWorkStatusHiddenSections` picks the list by
  `isMobile`, so the sections dialog edits whichever one is on screen.
- **Usage is left out** (`useUnavailableWorkStatusSections`). The phone has its
  own Usage page, which reads better there than these compact rows.
- **Rows go where the phone can show them.** The rows read
  `useMobileAppActions`: Branch and Changes switch to the drawer's Changes tab,
  PR and Checks open the PR on the issues and PRs board by its link, and the
  Context row and the project's app and run controls are absent, since they
  need a desktop host. A row that opens something outside the drawer (a
  subagent's session, a pinned message, the board) closes the drawer through
  `LeaveWorkStatusContext`; the desktop card provides none.
- **The phone's look, from the same primitives.** Under `WorkStatusTouchContext`
  (`touchContext.ts`) the primitives draw what the phone's Usage popover draws:
  a quiet heading over one toned card per section, rows at least 44px with a
  20px icon column, label then value on the end, text from the typography
  scale (`typography-ui-label`, `typography-meta`) so it follows the phone's
  text size. Sections take no props for it. The one section that reads the
  context itself is MCP: its switch moves from the icon column to the row's
  end, full size, where a phone puts a switch.
- The sections dialog opens from a button in the drawer's tab row, shown while
  this tab is open, rather than over the first heading as on the card.
- Sections mount only while the tab is on screen, so a closed drawer holds no
  subscriptions.

### Why a separate hidden list and not the shared one

Subagents are off on the phone unless the user turns them on, while on desktop
every section is on. One shared list could not hold both defaults, and a phone
and a laptop are set up apart anyway, as the drawer's tabs already are.

## Data sources

Everything is read from already-warm caches. The panel adds no aggregated
endpoint; quota data refreshes through the shared fixed three-minute quota timer,
which requests only providers enabled for this panel.

| Block | Source | Notes |
|---|---|---|
| Context + cost | `contextUsage.ts` over `useSessionMessages`; cost via `useSubagentCostRollup` (own cost + every descendant subagent, recursively) | see below — the store getters cannot serve this |
| Branch, ahead/behind, attention | `useGitStore` directory state | warmed via `runBackgroundNetworkTask(ensureStatus)` and refreshed from Git mutation hints |
| Changed files | `useGitStore` status `files` + `diffStats` | working tree, not session-authored edits |
| PR + checks | `useFreshestSourceControlVisualSummaryForBranch` | **read-only**; follows the freshest bound-identity entry for the branch |
| Subagents | child sessions from `useAllLiveSessions` (`parentID`) + `useAllSessionStatuses`; per-row cost from `computeRollup`'s `perChildCost` (each child's own subtree total, so nested subagent-of-subagent cost rolls up under its immediate parent row) | |
| Subagent blockers | directory `permission` / `question` maps | one subscription covers every child |
| Workflows | `useSessionWorkflowRuns` (`lib/workflows/store.ts`): the session's runs read once from the server, then kept current by `openchamber:workflow-run` events | only in builds with workflows |
| Usage | `components/usage/usageGroups.ts` over `useQuotaStore` | grouping shared with the mobile popover; presentation is not |
| Linked threads | `lib/linkedIssues.ts` over session metadata; state from tracked items | written by the flows that attach an issue or PR, and removable from the row; a linked PR that is also the checked-out branch's PR shows the branch summary, as its sidebar row does |
| Turn stats | `telemetry.ts` over `useSessionMessageRecords` | computed while authoritatively idle, including when collapsed; active mounts read warm records once for the previous turn; either rate above 5,000 tok/s is reported as unknown (see the two-rate description below) |
| Keep-warm switch | `useSessionWarmingStore`, mirrored from the server's `lib/session-warming` | on the Context row, shown only while Settings chose per-session warming and for a root session outside an isolated space; the tooltip's countdown ticks only while it is open |
| Goal | `useSessionGoal` | respects the Settings toggle |
| MCP | `useMcpStore` | connect/disconnect reuses the dropdown's actions |
| Pinned messages | `getContextObligatoryMessages` + `state.part`, else one `getSessionMessage` read | see below |
| Todos | live `state.todo[sessionId]`, persisted fallback | live channel wins |

### Subagent rows

Subagent status uses the Tasks section's leading icons: blue for busy/retrying,
green for idle, and a neutral clock while status is unknown. A successful status
snapshot of the panel's directory also establishes idle for omitted children,
skipping sessions whose status was invalidated. That snapshot is the server's
list of running sessions (`getActiveSessionStatuses`): the host's covers every
host directory, a space's covers only that space. So it covers a child in any
directory on the same side of that boundary, including one that moved to
another worktree (`session_move`); comparing the directories themselves left
such a child on the clock forever once the page reloaded after it finished.
The global status store fills the gap for children the snapshot does not cover:
a child it holds as busy runs, and one it saw settle is idle (or failed).
Permission requests and questions take precedence with a warning icon and text.
Running rows reuse `SessionActivityDuration` and its shared one-second ticker
for the current turn's elapsed time, including retries and waiting within that
turn. No timer is shown until the activity store has an observed start; blocked,
settled, and collapsed rows do not mount a running counter.

Rows are ordered newest first by creation time, never by last activity, which
reshuffled them on every step and moved them under the pointer. Rows group by
state first: blockers, then running, then unknown status, then finished (done
or failed, with no pending blocker). Creation order holds within each group, so
a fully finished list reads as it did at launch.
The section derives per-row cost with `computeRollup` over the live-session list
it already holds instead of opening a second subscription through the hook.

Directory bootstrap publishes each session page as it arrives, so subagent rows
do not wait for unrelated older history pages. Partial pages add coverage without
removing cached sessions. Only the completed list establishes authoritative
coverage and removes absent records; newer live updates and deletions win over
both partial pages and the final snapshot.

Hovering or focusing a row shows its session model's catalog display name,
falling back to the formatted model ID. Missing model metadata produces no
tooltip. Model-only session updates invalidate the live-session comparison.

### Turn stats

The section follows Usage by default and reuses the panel's existing rows. Only its header
has an icon; metric rows use labels and values without leading icons. It
reads already-loaded records without fetching history. The newest turn needs a
preceding user message and completed assistant steps. A truncated or unfinished
turn has no whole-turn result; later materialization can supply it. A newest
user message with no reply yet arrives while the session still reports idle, so
the section computes the turn before it instead and flags it as the previous
turn. Computing nothing there would commit an empty result just before the
session turns busy and blank the section for the whole run.

Two rates answer different questions. Response speed uses the final assistant
message's output tokens divided by the union of its nonempty text intervals.
It excludes initial waiting, reasoning tokens and reasoning time, and earlier
tool steps. It requires complete, valid text timing and a final message without
tools, errors, synthetic text or ignored text. This measures text delivery from
the live text timestamps, not provider-side decode speed. The header shows only
this rate; unavailable response timing never falls back to whole-turn speed.
OpenCode stores no timing for text, so a reloaded or never-watched turn has
text stamped with its step's `created` and `completed`. A text start equal to
`created` is that stamp, so Response speed is unknown after a reload.

Hiding it there was weighed against one window for both cases, the whole final
step from `created` to `completed`. That window gives the same number live and
after a reload, but it counts the initial wait and reasoning, which the row's
tooltip excludes, and it read about half the live rate on real turns. A missing
number is better than a second, lower one for the same turn.

Whole-turn speed uses output plus reasoning tokens from every step, divided by
elapsed assistant time minus the union of completed and failed tool intervals.
Waiting for each model response remains included. Invalid or missing inputs
omit the dependent metric rather than becoming zero; reported zeros remain
valid. TTFT averages the earliest text/reasoning start delay from every step,
only when all steps have a valid sample.

Either rate above 5,000 tok/s is reported as unknown. No provider streams that
fast, so such a value means the measured window is broken: a tool that runs
for nearly the whole step leaves a residual of a millisecond, and a text
interval can be equally short. The row is omitted rather than shown wrong.

Elapsed time is wall-clock time from the first user message in the turn through
the final assistant completion. It includes model waits, tool execution,
compaction, and other gaps; it is not used as a throughput denominator.

Metric labels stay short. Every row is a single hover and keyboard-focus target
for a shared tooltip that opens above the row after a 300ms hover delay, with a
portal outside the panel's scroller. Tooltips explain the measurement in every locale. The token row uses
compact input/output arrows; its tooltip gives full counts and explains that
input excludes cached tokens and output includes reasoning across all steps.

Records subscriptions stop while busy, retrying, or awaiting
status authority. Explicit idle events or a successful directory status snapshot
allow computation even when collapsed: the response-speed headline remains visible
and updates when a turn completes, after a remount, or when idle records change.
The collapsed body stays unmounted. One component-owned committed result keeps the
headline and rows stable during the next active turn. Whenever the shown numbers
belong to an earlier turn (a pending prompt, or a busy or retrying session), the
header says "Previous turn", followed by the response speed when there is one.
Opening or reopening the section mid-run reads already-loaded, revert-filtered
records once per scope, without fetching history or subscribing to streaming
updates. It excludes the entire newest user-bounded turn, even if some of its
assistant steps have completed. Missing or incomplete previous history shows no
numbers until idle. The retained result's identity includes
runtime, normalized directory and session. Scope changes discard it; fresh empty
or reverted records clear it. There is no global message-ID cache. Corrections
to existing message/part identities invalidate the current result.

### Why active mounts read history once

The mobile drawer unmounts its sections when closed, so component retention alone
loses the previous turn on reopen. One warm-store snapshot recovers that turn
without adding streaming work or history requests. The newest user-bounded turn
is excluded because a completed tool step does not prove that turn has finished.

### Context usage has its own computation, on purpose

The header's readout cannot serve this panel, and the panel once failed in two
ways by sharing the header's old `useSessionUIStore.getContextUsage` getter:

1. The header reads the current session's messages with **no directory**,
   resolving to the *current* directory's child store. A session held by
   another directory — a worktree, or the moment after a directory switch —
   reads as "no messages", and the readout vanished while the header still
   showed a value.
2. The getter was **imperative**, as is `useConfigStore.getCurrentModel`.
   Selecting one yields a reference that never changes, so calling it during
   render subscribes to nothing; the readout went stale across session switches.
   The header now reads through `useSessionMessagesSelector`, which subscribes.

`contextUsage.ts` therefore computes the same quantity from messages the panel
has already subscribed to for a known session and directory, and the panel
subscribes to `currentProviderId` / `currentModelId` for the limits.
`contextUsage.test.ts` pins the arithmetic — notably that the *latest*
reporting assistant turn is the answer, not a sum across turns.

Which message is "latest" is decided by `findLatestContextFill` in
`stores/utils/tokenUtils.ts`, shared with the VS Code header, mini chat,
mobile metadata, context sidebar and the context rail's ring icon
(`layout/ContextRailUsage.tsx`, which re-renders only when the reading changes
and reads cost only while its tooltip is open). A finished compaction's own record (a
`compaction` message with `status: 'completed'`) is not a reading: its tokens
describe the summarizing request,
whose input is the pre-compaction history. Until a later response reports
tokens, the fill is `compacted` and every surface shows a dash, never the older
pre-compaction number. A compaction still running, or one that failed, has not
changed the window, so the previous reading stays.

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
message sits before the loaded part of the transcript. Session metadata keeps
the pin's id, time, role and owning `sessionID`. A child accepts only its own
explicitly owned pins. It accepts a legacy ownerless pin only when its message
was created strictly after the child; missing session ids and incomplete child
timestamps fail closed. Root sessions, including user forks, keep inherited pins.
A pin that is not loaded reads its one
message from OpenCode (`opencodeClient.getSessionMessage`) for the row's text.
That read targets only the displayed session and never walks to a parent, and the
row keeps only a text part whose session and message ids match the pin, so a
parent's text cannot supply the label. No session is materialised for it, a loaded pin
costs nothing, and a failed read leaves the placeholder until the section mounts
again.

### Why pin ownership filtering applies only to child sessions

Child and subagent sessions must not display parent pins. User forks retain
their existing pin inheritance and compaction cursor. Copied messages receive
new ids, so mapping inherited pins to forked messages needs a separate change.

### PR status is deliberately read-only

The panel never calls `startWatching`. PR watching is owned by the background
tracker, and its concurrency gate exists because per-consumer PR fetches once
saturated the browser's connection pool and stalled startup for ~20s. A panel
that started a watch per open session would reintroduce exactly that fan-out.
The PR surface can watch a concrete remote while passive readers initially know
only the automatic remote key, so the panel reads the freshest entry for the
directory and branch across remote keys. This keeps its PR and checks rows in
sync with the live PR surface without adding another request owner.

### Why checks read "7/9" and not one word per state

The Checks row shows passed out of all after a dot in the run's colour: red
once any check failed, yellow while any still runs (the dot blinks on the
shared clock), green when all passed. Skipped and neutral checks count as
passed, as the server's summary counts them. This is the form GitHub's pull
request list uses, so the number reads the same in both places. The row once
showed "1 failed" or "2 running" alone, which gave no sense of how far the run
was; the per-state counts now live in the row's tooltip.

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

### Workflow rows

The Workflows section lists the runs the session proposed
(`packages/web/server/lib/workflows`), newest first. Where the context panel
exists (desktop and web), a run is one row that opens it in the Workflows
panel (`components/chat/workflows/WorkflowsPanel.tsx`), which shows its agents,
log, result and script. The row carries Run and Don't run while the run waits
for approval and Resume after a failure or a stop; a running run shows its
current phase and how many of its agents finished; a finished run's icon is
its state, with no word beside it, as in Subagents. Stop lives in the panel
and on the chat card. On the phone, which has no context panel, a run's row
carries the same actions plus Stop, an open run lists its phases with how many
agents finished and each phase its agents, and a finished run folds to its row
until pressed. An agent row opens its session like a subagent row
(`useOpenChildSession`, shared with the Subagents section).

A workflow's agents are child sessions of the session too. The Subagents
section leaves them out, so a run of fifty agents does not bury the session's
own subagents and each session shows in one place.

In a build without workflows the section exists in no list: the panel and the
sections dialog both drop it (`useUnavailableWorkStatusSections`), so the name
of an unreleased feature does not appear in the dialog. Its id stays in the
saved order, so it comes back where the user put it.

## Section order

The default order is by durability:

1. **Session** (goal, context, cost), **Project** (attention, branch,
   changes, PR, checks), **Usage**, and **Turn stats** (session telemetry:
   throughput, duration, TTFT, cache hit rate) — true for as long as the session
   is open. Usage sits here rather than lower down because a spent quota stops the
   work outright;
2. **Subagents** and **Workflows** — what is happening right now;
3. **MCP**, **Pinned messages**, **Context sources** — supporting material.

The sections dialog has drag handles for changing this order, including hidden
sections. A drop updates the panel immediately. `workStatusSectionOrder` is a
profile preference persisted through the settings registry and the local UI
store. Missing or empty order uses the default; duplicate and obsolete ids are
discarded, and newly introduced sections append in default order. Visibility
changes never alter positions.

`WorkStatusPrimaryGroup` supplies Session and Project through a composition
callback so the panel can place them independently while retaining one set of
data subscriptions. Keyed fragments preserve mounted sections and DOM order;
sections that render nothing leave no spacing wrappers. Secondary elements are
created by the panel, so primary readout updates do not rerender them.

The overlay's outside-click and Escape dismissal pauses while this dialog is
open, since the dialog is portalled outside the panel. Menus the panel opens
carry `data-work-status-popup` for the same reason: a dropdown's items render in
a body portal, so an unmarked press on one reads as an outside click and closes
the card before the item's action runs. A menu added to the panel later has to
carry the marker too.

The first rendered section heading reserves space on its right for the panel's
settings button. The scroller selects the first actual section DOM node, so
hidden and empty sections do not claim that space. Both heading variants expose
`data-work-status-heading`; only the heading is inset, leaving body rows at full
width. Heading summaries truncate within a bounded share of the available width
so project names and usage summaries cannot push actions under settings.

## Extension sections

An installed extension can add its own section (`contributes.statusSection`,
see `packages/sdk/DOCUMENTATION.md`). `WorkStatusExtensionSection` draws the
header from the extension's `statusTitle` (else its name) and panel icon, and
its body is a `PluginPane` with `surface="status"`: the same sandboxed iframe,
guest-scoped token, context, grants and pause gates as a rail panel.

Cost is bounded by mounting. The frame exists only while the panel's content is
mounted, the section is visible, and the section is expanded; the collapsible
drops its children when folded. `PluginPane` itself is lazy-loaded, so a panel
without extension sections never loads it. The frame's height starts at the
manifest `height` (default 120px) and follows the guest's `setHeight`, clamped
to 24..320px; taller content scrolls inside the frame, never the host. The last
requested height is remembered per extension id and version for the app
session (a module-level map, one number per installed extension), so folding
and reopening a section does not jump back to the manifest default.

An extension section is expanded by default unless its catalog row declares
`statusDefaultExpanded: false`; an explicit saved expansion choice wins. A row
with `statusRequiresProject` is absent, including from presence reporting, when
the panel has no actual Work Status directory. Status-frame controls exist only
while that expanded frame is mounted. A project change clears the header controls;
the guest republishes them from `onDirectory`. Workspace subscriptions and other
in-flight requests survive that project change. One or two controls use the header action
slot; three or four use a two-column row below the title. Folding removes the
controls with the frame rather than retaining a hidden controller.

An expanded extension can also open a sandboxed anchored popover outside its
body iframe. The host positions the card and loads the same approved entry
with `surface: 'popover'`. Folding or hiding the section removes the card with
its owner; project/runtime and authorization changes also dismiss it. Pointer
travel into the card and keyboard dismissal are handled by the SDK anchor
helper and the host overlay controller. This does not increase the status
frame's 320px height limit. The public contract is in `packages/sdk/API.md`,
under Anchored popovers.

### Sections the app draws

An extension that declares `statusSection.source` gets no frame. `WorkStatusGuestView` reads its service (`lib/guests/status-view.ts`) and draws the answer with the panel's own row vocabulary: the same 28px rows, muted text, tone colours from the theme, pills for chips and badges, the shared `Button`, `Switch` and dropdown. The body is mounted under the same rule as a frame (shown, expanded), so reading starts and stops with it, and is keyed by guest and directory, so a project change starts from an empty view rather than showing the last project's numbers. Reads pause while the document is hidden. Header controls in the answer go through the same `GuestStatusControlBinding` a frame's `setStatusControls` uses, so `StatusHeaderControls` draws both.

A failed read keeps the last view on screen, faded, under an error note; before the first answer the body says it is reading. An action holds its control, in a row or in the header, while the request runs, shows a chosen value at once, and keeps it until a read that started after the service's answer is on screen (`StatusViewPoller.refresh` resolves then), so a read already under way cannot flip it back. A refused action drops the choice and shows the service's message, or a generic one, in a toast. A row's tooltip covers the whole row, except on a row with a chart, whose own hover label owns the middle; there the tooltip sits on the label.

#### Why the host polls and not the service pushing

Polling a path keeps the service a plain HTTP handler, which is what every extension service already is, and reuses the authenticated `service/request` proxy with its pause, approval and size checks. A push channel would save requests while nothing changes, but needs a socket per section and reconnect logic in every extension. The interval has a floor of one second, reads never overlap, and a hidden document reads nothing.

#### Why only theme tones and not colours

The section sits among the app's own sections and follows the theme, light and dark, without the extension knowing either. An extension that needs its own colours keeps its frame.

#### Why rows keep their objects between reads

`createGuestStatusViewReader` returns the previous view untouched when the answer's body is byte-identical, and otherwise reuses each row object, and the header controls, whose JSON did not change. Rows are memoized by identity and the header binding follows the controls' identity, so a sample that moves one number redraws one row instead of the section and its header.

`useWorkStatusExtensionSections` lists active guests with a `statusEntry` or `statusSource` from
the catalog store (`useGuestStatusSections`). It is empty on VS Code and
mobile, which load no guests; the panel is hidden there anyway, but the empty
list is explicit rather than an accident of visibility. The rail owns loading
the catalog.

Section ids are `ext:<extension id>` and share the persisted order and hidden
lists with built-in ids. Sanitizing keeps well-formed `ext:` ids even when that
extension is not installed, because settings load before the catalog and a
paused or reinstalled extension should come back where the user put it.
`resolveWorkStatusSectionOrder` drops unavailable extension ids from what the
panel and the dialog show and appends available ones the saved order does not
know. A drag in the dialog writes the shown order followed by the saved ids it
did not show. "All hidden" and "Show all" count only sections that can
actually be shown. Extension rows carry an "Extension" label and no settings
search anchor (they are dynamic entities).

## Switching it off

A persisted preference (`workStatusPanelEnabled`) drives a header toggle, and a
dialog behind the equalizer icon switches individual sections off. Hidden
sections are stored rather than visible ones. Every section, including Turn
stats, is enabled by default. UI-store v21 migration and server-list hydration
remove the old automatic telemetry hiding unless `workStatusHiddenSectionsExplicit`
records a user-chosen list. Explicit hiding and other hidden sections survive.
The marker and list travel together through autosave, sanitization, and server
settings; an empty list enables everything. Complete settings
snapshots own this preference; unrelated partial save echoes leave it unchanged.

`workStatusPanelVisible` is separate and transient: the switch can be on while
layout still refuses the panel. The header's project/branch line and the git
rail read it to drop the readouts the panel already carries, and it is deliberately not persisted — it
describes the current frame, not a preference.

## Appearing and disappearing

The card keeps its width and only fades, on the slot's duration and curve
(`LAYOUT_ANIMATION_MS` and `LAYOUT_ANIMATION_EASING` through `useLayoutAnimationMs`; zero when the `layoutAnimations` setting is off); the slot animates the width. It stays
mounted wherever it could ever show, so the fade has something to animate;
its content is dropped once the fade finishes. A card whose sections all
reported nothing gives its column back. When it is shown again the presence
count starts optimistic, as on first mount, so the column is not given back
for the frames before the sections report.

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

## Provider status line

A provider with no windows shows its status (an error, "no rate limits") on its
own row, at the row's end. The status sits inside the label, not in the row's
`value`: a value never shrinks, so a long error such as an expired key with its
fix ran past the panel edge and pushed the provider name out. The status keeps
its full width while it fits, the name truncates first, and a status longer
than the row less a stub of the name truncates too, with the full text in the
row's tooltip.

## Actions

Rows that name something the app can already show are buttons:

| Row | Opens |
|---|---|
| Context | the context overview (`openContextOverview`), same destination as the rail's Context surface |
| Changes | working-tree diff (`openContextPanelTab`, `diffScope: 'working'`, no target path) |
| Branch | git surface (`openContextSurface(dir, 'git')`) |
| Pull request, Checks | The Tracker's branch tab (`openContextPanelTab(dir, { mode: 'pr' })`) |
| App icon (Project heading, right) | opens the project in the chosen app (`OpenInAppButton`, desktop with a local host only); its chevron copies the path or picks another app. The project name beside the title is plain text |
| Project action | runs or stops the selected project action (`ProjectActionsButton`); its chevron picks another action. The project's own actions come first and auto-discovery last, so with nothing picked the row offers the first configured action, or auto-discovery when there is none. The pick is stored per runtime and project (`lib/projectActionSelection.ts`) and survives remounts and restarts; a pick that no longer names an action falls back to the first one. A running action takes the row over an idle pick, and pressing the row acts on the action it shows, through the same shared-setup trust prompt as the menu. The row is a view: the runner lives in `ProjectActionsProvider` above the whole layout (see below). The header carries no action control, so a project without a repository still gets a Project section |
| Subagent | that child session's chat tab, read-only |
| Goal (row) | the composer's own `SessionGoalDialog` |
| Goal (pause/resume) | `setSessionGoalStatus(sessionId, directory, status)` |
| MCP switch | connects/disconnects the server |
| MCP status | the state doubles as the button that reconnects |
| Pinned (pin icon) | unpins the message |
| Pinned (text) | jumps the transcript to that message |

### Project actions outside the panel

Auto-discovery reuses a personal action when its name identifies a dev server or its command runs a conventional dev script. A shared action needs a matching script command as well as the same trust confirmation as choosing it from the menu: renaming an already trusted shared action does not change its trust hash. Arbitrary `start` substrings and unrelated `start:*` scripts must not launch through discovery.

The panel hides whenever a rail panel opens, so the actions cannot depend on
it. `components/layout/ProjectActionsProvider` mounts one runner
(`useProjectActionsRunner`) in `MainLayout` for the project
`useProjectActionsContext` resolves, which is the panel's own context. A managed
Chat resolves to none. A draft waiting for a new space has no actions until the
space runs, then runs them in the space (`useDraftSpaceTarget`). Three views read that runner through
`projectActionsRunnerContext`:

- the Work Status row;
- `ProjectActionsDialog`, opened by `open_project_actions` (`mod+alt+r`). It
  lists the actions with their state, opens with the row's action highlighted,
  and Enter picks the action and runs or stops it;
- the command palette's search-only "Run: name" / "Stop: name" entries and its
  "Project actions" entry.

Because the runner outlives the panel, a run keeps its output watch (URL
auto-open, exit tracking) while the card is hidden. The server terminal listing
still runs only on demand: each view calls `useObserveProjectActionRuns` while
it is on screen, and the runner polls only while at least one view asks.

The goal icon reproduces the **composer target button's** colour mapping, not
the goal strip's. The two disagree today — the strip paints `paused` muted and
`blocked` warning, the button paints them info and error — and the button is
where this panel's reader last saw the goal. Unifying them is a separate change.

Jumping to a message is a message-link request (`requestMessageFocus`,
`lib/router/messageFocus.ts`), the same one links and search use: the timeline
loads older history until the message is there and opens a collapsed turn
around it, so a pin far back in a long session is reachable. While older history
loads, the pin's row shows a spinner: `readMessageFocusInFlight` names the
message a request is still bringing to the screen, and the timeline marks it
shown (`markMessageFocusShown`) once it lands; settling or expiry clears it too.

Opening a subagent takes the same branch as the transcript's Task tool: an
embedded panel, mobile, or VS Code navigates to the session instead of nesting
a tab.

## Context sources

Linked issues and change requests first, then skills and MCP counts.

Agents are deliberately absent: an agent is who does the work, not material
loaded into the context. Tools are absent too — `Agent.tools` is a per-agent
override map rather than a registry, so its size would be a number that means
something other than "tools available".

### Linked issues and pull requests

Written by the flows that already attach a thread — sending a message with
issues, PRs or guest items attached in the composer, session creation from an
issue or PR in `NewWorktreeDialog`, and an agent calling the `openchamber`
tool's `session.link`. There is no manual "link this" control: attaching a
thread to the work *is* the act of linking it. A message's references are
written in one server operation (`sessionActions.addLinkedIssues`): each
operation sends the items to link, and the OpenChamber server decides the new
list from a fresh read inside the session's write queue, so a link an agent
made while the request was in flight survives it.

Detaching is a control on the row, not a side effect of another action. An
agent's link has no composer chip to dismiss once the message is sent, so
without a control here it would be permanent unless session metadata were
edited by hand. Each linked row carries a close control in its trailing value
slot, the place row actions already occupy, with the pinned rows' hover and
disabled styling; those pins are the behavioural precedent — the panel that
shows what is attached can detach it — not the visual one. Pressing it sends
the removal through the same server operation (`setLinkedIssue(…, false)`) the
attach flows use — one writer for the list, so a link cannot be dropped by a
path that does not know the others. The write
is deliberately user-initiated: an agent links but never removes, so it cannot
drop a link the user set (`packages/web/server/lib/openchamber-sessions/session-link.js`).
A failed removal reports `chat.workStatus.linkedIssues.unlinkFailed` rather than
leaving the row looking removed.

Stored in session metadata as a **snapshot** (`lib/linkedIssues.ts`, namespace
`openchamber.linked_issues`), persisted through the same server-owned metadata
store as pinned messages. Number, title, url, author and avatar only — the
body,
comments and state belong to their provider, and mirroring them would mean
owning their staleness. The stored title can drift; that is the price of a
store that never needs refreshing. A repository row opens its link in the
Tracker. Its live colour comes from the same repository thread the sidebar
follows (`getRepositoryThreadRef`, `repositoryThread`), whatever the provider,
and the heading speaks a provider's word for change requests only when every
attached change shares it, else pull requests. A tracker row (a Linear issue)
wears its tracker's mark and, once the server follows it, the tracker's own
state name in the colour of its category (`getTrackerItemStateLook`). It opens
as a Tracker tab beside the chat on desktop and web, on the issues and PRs
board on the phone, and in the browser otherwise (VS Code, a tracker the
server does not serve, or one that is disconnected).

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

The visible panel's initial quota load uses the background gate's active-session
priority. It runs ahead of queued metadata reads while keeping the same network
concurrency limit and instance-readiness rule.

### These readouts belong to the connected instance

Same-origin web pages and Electron's Vite proxy initialize a runtime identity
even when the API base is empty. Requests stay relative to the page origin.
Electron dev uses `local`; hosted pages use their HTTP origin. Without this,
the quota loader treats a working proxy as a transient disconnected runtime
and skips the initial load.

Quotas, MCP status, skills, agent memory and the tracker and source-control logins are all
served by whichever OpenChamber instance is connected, and each was cached
globally or by directory alone — which two instances can share. A switch left
the previous instance's answers on screen, and its tracker login usable against
a runtime that has no such tracker. The tracker list itself is per runtime
too (`lib/trackers/registry.ts`). `apps/runtimeEndpointReset.ts` now drops all of
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
`useUIStore`. Component state would not do: the content unmounts every time the
context panel opens, which would silently discard the user's arrangement.

The scroll offset is restored in the scroller's callback ref, at the moment it
attaches, and read through `useUIStore.getState()` rather than a subscription —
subscribing would fight the user mid-scroll. Writes are coalesced to one per
animation frame.

## Not implemented yet

- Test/build/dev-server status and LSP diagnostics — a separate track. Note
  that `state.lsp` already exists in the sync state.
