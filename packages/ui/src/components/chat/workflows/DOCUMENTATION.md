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
- The panel offers both approve and decline while waiting. Both actions use the
  chat card's action hook and server routes, with both buttons held during a request.
- The panel exists on web and desktop. Mobile uses shared chat cards and its
  work-status view. VS Code has no Workflows context panel or injected workflow tool.

## Decisions

### Why pending approvals also read the session's runs

Tool results and workflow events arrive independently, and loaded chat history
can omit the proposing call. Reading only completed tool results can leave a
pending run visible solely in the panel. The footer fills that gap from the
authoritative session run list without duplicating calls already in the transcript.
