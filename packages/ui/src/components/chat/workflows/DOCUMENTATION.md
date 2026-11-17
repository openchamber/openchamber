# Workflow cards and panel

## Ownership

Shared chat approval cards and the desktop/web Workflows context panel. The
server owns run state and report delivery in `packages/web/server/lib/workflows`.

## Invariants

- Every awaiting-approval run of the session is reachable in chat, including
  runs whose proposing tool result has not arrived or is outside loaded history.
- A loaded proposing call renders its own card. The transcript footer renders
  only pending runs without that call, keyed by run ID. Other sessions' runs
  never appear there. Once the call arrives, its inline card replaces the footer card.
- Footer deduplication overlays the same nonempty live part arrays for the same
  tail messages as `TimelineRowContent`. The active message's snapshot pauses
  part updates during streaming; reading only that snapshot duplicates cards.
- A run card reads its state from the server's run, never from the proposing
  call, so it is current after a reload and on every device.
- The panel offers both approve and decline while waiting. Both actions use the
  chat card's action hook and server routes, with both buttons held during a request.
- An action never sets a run's state locally. Buttons hold for the run whose
  action is in flight, the new state arrives as an event, and a refusal shows
  the server's reason.
- Run detail, its failed read, and the log refresh wait are kept per run.
  Switching runs never shows another run's detail or failure, and only the same
  run's reads are throttled. A running run's log reads again at most once per
  `LOG_REFRESH_MS`, driven by its newest log line.
- A run without args reports `{}`. The script view hides exactly that and shows
  any other value.
- Running a saved workflow belongs to the session on screen, or to a new
  session the panel opens when none is open.
- A deleted run leaves the panel as soon as the delete succeeds. The server
  event removes it too, and the local removal only avoids waiting for it.
- A running or awaiting run is stopped or declined before it can be deleted;
  the picker hides delete while either is open. Switching to a run's own
  session selects that run first, because the panel remembers a run per session.
- Spend columns appear only when measured: sessions gone leave no numbers, and
  a provider on a subscription reports a cost of zero that is not shown as a price.
- An open agent's detail reads again when the agent's state changes, so a
  finished answer replaces the no-answer placeholder.
- A workflow answer nests as inset tiles one step above the container holding
  it, never as a card inside a card.
- Run and agent states use one icon and label in the chat card and the
  work-status panel, and agent icons match the Subagents rows.
- The panel exists on web and desktop. Mobile uses shared chat cards and its
  work-status view. VS Code has no Workflows context panel or injected workflow
  tool. Where workflows are unavailable or turned off, a card renders that
  notice and reads no run.

## Decisions

### Why pending approvals also read the session's runs

Tool results and workflow events arrive independently, and loaded chat history
can omit the proposing call. Reading only completed tool results can leave a
pending run visible solely in the panel. The footer fills that gap from the
authoritative session run list without duplicating calls already in the transcript.

### Why the header drops labels in steps

The header row clips its overflow and does not scroll. The view strip keeps
its width, so the row overflows instead of the strip sliding under the buttons
that follow it. Overflow sets one of three steps in `index.css`: the view
labels go first and keep their icons, then the action's label, then the run's
name, which keeps its state icon and chevron. Every label shows while there is
room, so choosing a view changes no widths.

### Why a finished phase folds during a run

A running run folds a finished phase by default, which keeps the work in
progress in view. A click expands that phase.

### Why the run picker reads the global session list

A project's runs can belong to sessions in other worktrees, which the project
session list may not carry. The global list supplies their titles.
