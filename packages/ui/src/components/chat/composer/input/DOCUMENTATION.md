# Chat input composition

## Ownership

This directory owns the ChatInput composition, its local state, event handlers
and rendered form and dialogs. The parent composer directories own the prompt
language, editor, attachment conversion and outgoing-message builders.
`ChatInput.tsx` keeps its existing props and memoized export. It connects named
domain objects; each consumer's dependency type selects only the fields it uses.
Draft text, editor lifetime, completions, drag state, history search, mobile
panels and pending attachment work have separate owners. Runtime detection and
preferences are inputs to these owners.

## Invariants

- Hooks run unconditionally in the same composer instance. Effects retain their
  ordering, including draft restoration before pending text is consumed.
- The text store, editor view, refs and stable handlers keep the original
  composer lifetime. Moving state into a hook adds no subscription.
- Render helpers return the existing JSX without introducing component or DOM
  layers. The file picker stays mounted outside the pill/full-editor branch.
- Submission captures its target and recovery state before asynchronous work.
  Extracted action and failure handlers receive that same captured state.
- Dependency types select the fields a module consumes. Type-only imports do
  not introduce runtime dependencies between the composing hooks.
- `useComposerSending` creates and publishes both outgoing handler refs. Queue
  and submission mechanics receive those refs, and external submit requests
  follow draft restoration. Dictation handles only recorded transcripts.
- Abort prompt ownership follows the session being left. Abort acknowledgement
  and shortcut reach belong to controls; file-drop eligibility belongs to drop.

- New Chat text keys on its Chats bucket while its prepared directory changes,
  so the first keystroke's directory preparation cannot clear or strand text.
  VS Code keeps per-folder drafts because it has no shared draft list.
- Draft restoration precedes pending-input consumption. Deferred focus is
  replaceable and cancelled when history search opens, so an old frame cannot
  steal search focus; pinned chats focus only when already being worked in.
- Input handlers read the live document even before React renders the previous
  key. IME composition bypasses autocomplete interception, including WebKit's
  keyCode 229 fallback.
- Shell-mode entry consumes its trigger in the same transaction, including
  mobile keyboard and paste paths, so a later caret write cannot use stale text.
- Empty-composer history recall edits the newest queued message when present;
  recalling a copy would queue it twice. Local and extension action commands
  execute before attached context or queue items are consumed.
- A new worktree stays pinned while its list refreshes so target validation
  cannot reset the draft to the project root. Target dialogs retain the project
  they opened for even if the draft changes.
- Attachment and reference callbacks retain the draft they started with.
  Completion after a switch updates that draft's saved state, never whichever
  composer now owns focus. References that fail to load leave no empty chip.
- File intake reserves a citation before inserting its text, follows converted
  filenames, and cites rejected files only after successful attachment. Sends
  and queue writes wait for current intake to settle.
- Text and attached comments determine which files leave with a send, with
  annotation screenshots included. Deleting a citation omits its file while
  undo can bring it back; names survive reload as unavailable chips.
- Mentioned documents and images convert at send or queue time because later
  queue delivery cannot read those sources. Queue capture resolves confirmed
  mentions, snippets and context against what the user saw when typing.
- Session-link and reference resolution publishes results synchronously to refs
  so an immediate send sees them. A second send cannot overtake an outstanding
  resolution, and an unreadable link remains literal text.
- Shared-page keys go only to server intake and never remain in queued or sent
  text. A pasted shared page replaces a selection directly; wrapping it as a
  Markdown link could leave its key in the draft.
- The outgoing send captures identity, selections, effort revision and recovery
  context before any asynchronous preparation. A later session switch cannot
  redirect either the send or its bookkeeping.
- Every failed send restores consumed text and context under its captured owner
  while preserving newly typed content and new attachments. A failed queue
  write restores its captured items by the same rule.
- Editing a queued message removes it from the queue and restores its complete
  content from the owner, including attachments and armed goal. Scheduled or
  already-delivering items stay outside manual delivery to prevent duplicates.
- A queued goal travels with its captured message. A queued-only send leaves
  the normal composer's armed goal and remembered effort unchanged.
- A question that still holds a turn requires inbox delivery because waiting
  for idle would deadlock the queued reply. Deferral follows successful message
  admission, while shell and local action commands cannot defer that question.
- Comment mode's only submit attaches the comment. Normal sends and queue
  actions remain inert, normal draft state stays intact, and the comment's
  recording cannot deliver a transcript to the normal draft.
- Dictation belongs to its starting draft. Its composed text reaches draft state
  before submission so failure recovery retains it; an absent mobile editor
  cannot stand in for the pending draft. All dictation exits release submit holds.
- Mobile panel state publishes before blur so keyboard dismissal cannot collapse
  the editor beneath the sheet. Native picker handoffs avoid briefly restoring
  the keyboard between overlays, and iOS focus restoration stays inside the tap.
- The mobile dictation engine and model-sheet hosts stay outside pill/editor
  conditionals so a morph cannot interrupt a recording or hide an open sheet.
  Salvage text height respects editor and screen bounds before becoming a floor.
- Reference-picking and large-paste choices remain scoped to their original
  draft. Delayed paste actions read live text and attachments, and unmounting a
  focused composer disables native image commits for the next keyboard field.
- An explicit large-paste choice restores the post-insertion selection after
  focusing the editor, so the choice's focus handoff keeps subsequent typing
  beside the inserted text or file reference.
- Programmatic text restoration does not open typed-token pickers. Completion
  marks its occurrence before the synchronous edit callback resolves another
  trigger, and caret edits place text and selection in one transaction.
- A native first-message request waits for the target project's defaults. Existing
  draft content receives its text without auto-send, and a request for a different
  draft is dropped so a shortcut cannot clear or send user-owned content.
- Pending form and permission scope follows the column and descendant sessions.
  BTW sends and Stop use the fork's activity while queue actions still belong
  to the parent; promoted forks explicitly retire their retained boundary text.
- A stopped isolated space is rejected before catalog checks because its catalog
  cannot load. Folder probing skips container paths because host stat cannot
  establish their existence.
- Bookkeeping references are attach-time snapshots whose failures cannot turn an
  accepted send into an error. New-session bookkeeping reads the minted ID only
  when the captured send had no session, preventing a switch from redirecting it.
- Extension chips reopen the declared panel or dialog with their item; opening an
  already open panel cannot toggle it closed. Removed or unsupported extensions
  report unavailability rather than opening an empty host.
- Model metadata, visible-agent arrays, language registries and controlled
  selections retain identity when their content is unchanged so typing cannot
  repeatedly scan catalogs, retokenize the editor or rerender controls.
- The goal counter passes changing text length only while armed so ordinary
  typing cannot rerender the footer. Acknowledging an abort clears the previous
  run's hold so working feedback can resume for the next run.

## Decisions

### Why the file picker keeps one node and not one per composer variant

The input stays outside pill and full-editor branches so variant changes cannot
detach an open native picker or clear its shared ref. Its memoized wrapper also
avoids React reapplying unchanged name and type attributes during streamed updates.

### Why optional dialogs mount on first open and not merely render closed

Attachment previews bring the diff and Shiki stacks, and guest dialogs bring the
extension bridge. A closed lazy component still loads its chunk, so these bodies
mount only after their first open and remain available for closing animation.

### Why mobile composer state outlives the editor node

The collapsed pill has no editor node, so preset and dictation submissions carry
explicit text and read pending draft state. The kept CodeMirror view avoids
rebuilding an editor inside the expansion tap before the browser can paint.

### Why queued sends return to the live edge and not a user-row anchor

Queue acceptance creates no user row for an anchor to claim. Direct sends arm
their anchor before the optimistic row can commit, while queued sends explicitly
return the viewport to the live edge.

### Why stable callbacks are event-only and not render helpers

Their identity lasts for the composer lifetime while the closure updates with
the latest render. Calling one during render can observe the previous closure;
event-time draft reads use the live text store or editor.

### Why hooks and render helpers share the composer instance

Keeping the existing state and effect lifetime preserves editor focus, pending
work and memoized child props. Separate stateful component trees or a new shared
context would change those lifetimes or their update boundaries.

### Why dependencies travel as domain objects

The composition connects owners without destructuring and reassembling their
implementation fields. Render helpers consume the same typed slices, keeping
form and dialog wiring independent of a state's internal declaration order.
