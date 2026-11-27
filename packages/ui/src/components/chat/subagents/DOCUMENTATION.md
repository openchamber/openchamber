# Subagents panel

## Ownership

The context panel's Subagents surface: every subagent of the session on
screen, with what it does now, and under each one what waits on the user, its
full report and the task it was given. Each subagent's row is the
work-status section's own (`SubagentStatusRow`): one component, the same
data from `useSubagentRows`, so the panel and the section never disagree; in
the panel a press opens the card under the row instead of the chat, and the
row shows the current tool call, which the section leaves out.
Workflow agents stay in the Workflows panel.

The children come from the live directory stores plus the global session
list. A session an agent started with `ownWork` often lives in another folder
(a worktree) that has no live store until the user opens it, and it gets its
agent and model by events after `session.created`; the list record carries
both, so such a child shows at once with its model
(`useSessionsWithListedChildren`; the parent's cost rollup reads the same
membership through `readSessionCostTree`, so the rows and the total add up). It takes them from the store's child index
(`structure.activeChildrenByParentId`), never by scanning the list: the store
calls `set` on every streamed step of any session (`noteDeferredSessionUpdate`),
and every subscriber's selector runs each time. Its permission and question state comes
from the cross-folder request index as well, and opening it gives the chat
tab the child's own folder.

## Invariants

- The surface is `has-content`: its rail icon shows while a Subagents tab is
  open, and the tab opens from the work-status section's heading. The rail and
  the digit shortcuts then count it the same way without a second, imperative
  count of subagents for the shortcut.
- A subagent with a permission request or a question starts open, with the
  request cards above its tile, so the answer takes one click. The user's
  toggle flips that default per subagent.
- The report is the newest subagent report (`<background-result kind="subagent">`) in the parent: the message
  OpenCode appends for a background run, or the call's own result for a
  foreground one (the Claude agent provider runs them that way). A later
  round of work replaces it when its report arrives.
- The card holds only what the row above it does not: the request cards,
  the report and the task. Who ran it, for how long and what it spent are
  in the row.
- The task is the prompt of the parent's first `subagent` call for the child,
  else the child's own first prompt, read once when the card opens. A prompt
  never changes, so the card does not follow the parent's every part. When
  neither is loaded the Task section is absent.
- The panel's body is mounted only while its zone shows it: from the moment
  it opens until its closing animation ends (`useOpenUntilSettled` in
  `ContextPanel`). A closed zone keeps drawing its last tab under `inert`,
  which for this surface would keep every row's store selectors running for
  nothing on screen.
- The panel exists on web and desktop. The phone and VS Code have no context
  panel; their work-status rows carry the same second line.

## Decisions

### Why a context panel surface and not a dialog

A dialog covers the chat it reports on and closes when the user reads
something else. A panel stays beside the chat while the subagents work, and
the work-status card yields to it as it does to every other surface.
