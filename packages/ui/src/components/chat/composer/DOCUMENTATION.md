# Composer

The chat composer: the prompt language, the editor that renders it, and
everything between typing and sending.

`ChatInput.tsx` (one directory up) composes the hooks and render helpers in
`input/`. Those modules hold the composer's state and event handlers and wire
the language, editor, attachment and submission modules together.

### Why composer discovery follows the live session directory

Command and skill menus, token highlighting, submission and file search follow
the session record across live directory stores. A column's directory can still
name the worktree root after the record confirms a start subfolder, so it cannot
override that record or restrict its lookup. Catalog preload is limited to
worktree drafts once their start directory resolves; existing sessions keep
on-demand command and skill loading.

`ChatContainer.tsx` keeps one `ChatInput` mounted while a new-session draft
becomes its first session. Draft-only UI first fades for 120ms while the editor
stays in place. The parent then moves the editor to its final session position
with a 180ms transform-only FLIP animation. Reduced-motion mode skips these
transitions. `session-ui-store.ts` marks sessions materialized from a submitted
draft, so selecting an existing session while a draft is open switches without
animation. Do not restore separate draft and session composer branches:
remounting the editor loses focus and interrupts the transition. Keep the
existing mobile fixed-position rules unchanged.

`ComposerFloatingPanel` is the shared frame for `BtwPanel`, `PermissionDock`
and `FormDock`. They mount inside the composer form, outside both the
full editor and collapsed mobile pill, with one absolute `bottom-full`
anchor, input-column width, gap, and glass surface. Appearing, disappearing,
or collapsing a panel does not resize the transcript or composer.
One panel shows at a time, in this order: an expanded BTW (its sheet or
its unsent draft), a permission, a form, then a collapsed BTW strip. A collapsed BTW gives the
composer back to the parent session, so the parent's own request takes the
dock and the strip returns once it is answered (`btwHoldsDock`).
The frame also owns the header row through its `header` and `compact` props;
callers supply controls and content, not their own header padding.

`GlassPopupMotion` gives the frame and the autocomplete pickers one enter and exit motion, mostly a fade with a short
rise from below and no scale (from the wrapper's corner, scaling read as a
diagonal slide): the wrapper moves, the glass surface fades. Autocomplete
lists take the `brief` pace (90ms in, 60ms out), since they come and go with
typing; panels keep the standard 140/100ms. Text-field lists
(`components/inline-picker/`) play the same motion as a CSS animation on the
list itself, since they are fixed-position. The fade stays on the glass element itself, since an ancestor
with opacity below 1 is a backdrop root and the blur would go flat mid-fade.
Exit needs `AnimatePresence` around the conditional popup, so each dock keys
its panel there (BTW keys each stage, forms key the draft's identity: runtime,
directory, session and form id); switching panels cross-fades. The frame's clearance cleanup leaves the variable alone while
another panel is still mounted, because the outgoing panel unmounts after the
incoming one has written its own height.

`FormDock` is the agent's question (a v2 form request) for the composer's
session, one field per step with a segment row, Back / Next, and Submit in
place of Next on the last step; `when`-gated fields join or leave the steps
as answers change, an `external` field is an information step, Enter in a
text box moves to the next step and Cmd/Ctrl+Enter submits. Submit is
enabled only once every question is answered; a submit with a required
question still open jumps to it. It shows the
oldest pending form and counts the rest in its header. While the reader is
away from the transcript's end (the scroll-to-bottom pill shows,
`FormDockModeContext` from `ChatContainer` reads `reading`), the dock shrinks to its
header row and opens again when they come back. A dock whose text field has
focus stays open, since collapsing it would drop what is being typed. The
header toggles it by hand at any time: opened while reading, it stays open;
collapsed while reading, it opens again at the end like an automatic
collapse; collapsed at the end, it stays collapsed. The BTW sheet keeps
the inline `FormCard` for its child session's forms; both render a field
through `FormFieldControl`. A caller can choose a form's id, so another
session or directory can hold a form with the same id. The sheet stays
mounted when the chat moves to another parent session, so it keys each card on
runtime, directory, session and form id (`formCardKey`), and its live cards keep their
answer under the dock's draft key (`keepDraft`): a card keyed on the id alone
would carry the first fork's answers into the second fork's form, and a card
keyed on the full identity without a draft would lose its own answer when the
chat comes back to it. The card has no steps, so when it saves it leaves the
step a dock stored for the same form as it is. A draft stays until its form is
answered or cancelled on that surface, or until the form leaves the fork the
sheet shows (settled on another page) without staying on as a recovered
question: OpenCode can reuse an expired form's id, and a new form with the same
fields would open with the old answer. A form settled while the sheet shows
another fork, or is closed, keeps its draft until OpenCode creates a form with
that id again: `sync-event-dispatch.ts` drops every draft of a `form.created`
whose id is not pending in its session, so the new request starts empty, while
a fork whose form is still pending gets its answer back.

With Settings → Chat → Composer → Questions set to "In the chat"
(`questionsInChat` in `useUIStore`, a device-local key), `ChatContainer`
renders every waiting form of the dock's scope as a `FormCard` at the end of
the transcript (`TranscriptForms`, in the list footer), and the dock shrinks
to `FormDockPointer`: one line with the first question's title and the count,
whose click asks the timeline for that form's card by id
(`revealWaitingPage(sessionId, formId)`). A toast's "Open session" does the
same for the form it names. Answer, Dismiss and Cancel go through the same
`replyToForm` / `cancelForm` routes. The card in the chat keeps the dock's
rules: Submit, by its button or by Enter, waits until every question has an
answer, and the answer draft uses the dock's key, so it survives the card
unmounting and a switch back to the dock. A draft the dock left is taken with
its link steps acknowledged, since the card shows every link at once. A card
in a retained session that is shown again first takes up the draft another
surface saved meanwhile: a location-scoped form shows in every session of its
directory. Each card's block is keyed and named on session and form id
(`formWaitingBlockId`), since a parent and its child can recover questions that
share an id and the timeline remembers revealed blocks by that name; the dock's
line and a form's toast reveal the card by the same name. The choice applies only while the transcript is on screen and not
in a chat pinned in the side panel (`resolveFormsInChat`); an empty or
loading session, an expanded composer and a pinned chat show the dock as
before.

On a phone the dock's body is clamped to the room above the keyboard
(`useMobileAutocompleteMaxHeight`). iOS Safari raises the keyboard after the
answer box takes focus, so the clamp shrinks the body under a box Safari has
already revealed, and Safari does not reveal it again until the first
keystroke. The dock therefore scrolls the focused field back into view
whenever that height changes.

### Why questions in the chat sit at the end of the transcript and the dock keeps a line

The card goes in the list footer, after every row, and not at the form's
tool call: a plugin form (`ask_later`, any `POST /session/:id/form`) is
usually followed by the agent's explanation after its call returned, so a card
at the call would sit above the message it refers to, and a form with no tool
part (an MCP elicitation) has no call to sit at. The dock keeps one line
instead of disappearing: a reader who scrolled up gets no other sign of a new
question (no toast for the open session, no status row), and the next send
cancels a question the reader never saw. The line is not a collapsed
`FormDockPanel`, because that panel writes the shared draft from its own state
and would overwrite what the card saved. The full panel still shows beside or
instead of a card in three cases: a chat pinned in the side panel (see below),
a session whose transcript is still loading, and an expanded composer. There
it saves the shared draft when its own answers or its step change. Its draft
key follows the form's id and session, not the form object, so a reconnect
that hands it the same form again no longer saves over the card's answer or
another dock's. A second dock whose step moves (Next or Back) still saves its
own values over the shared draft. The panel is keyed on the whole draft
identity (`dockKey`: runtime, directory, session and form id), because a form
id alone does not name a form. Another session or directory can reuse an id,
and a panel keyed on it stays mounted when the composer moves to that
session: its answers and step carry over and Submit sends them to the second
form. The runtime is in the key for the same reason: App and MobileApp remount
on a runtime switch, VS Code and the desktop mini chat do not, and two
runtimes can hold a form with the same id, session and directory, so a switch
starts the panel over from the new runtime's draft instead of saving the old
runtime's answers into it. The directory stays in the key, so a form on screen
whose directory changes starts over as a different scope.
The setting is device-local, not a
synced preference: syncing it would need a server-side validator, and a phone
and a desktop can reasonably want different answers. A chat pinned in the
side panel keeps the full dock rather than a line of its own: the line asks
for its card through the app-wide waiting-page request, which only the main
timeline serves, so in the side panel it would move nothing, or move the main
chat when that shows the same session.

### Why the question dock collapses while the reader scrolls up

The dock floats over the transcript, and a question with described options
took about a third of a laptop window, covering the reply the question is
about exactly while the user went back to read it. The scroll position is the
reading signal the app already has, so no new control was added.

While the dock is collapsed for reading, the transcript's tail spacer keeps
the room it had for the open dock (`holdReserve`, published as
`--chat-floating-panel-reserve`). With the spacer shrinking, a scroll shorter
than the dock clamped the reader onto the end, which hid the pill and opened
the dock again, so the user could not scroll up less than the dock's height.
The overlays riding above the dock (the pill, the status row) keep following
its real height. A collapse by hand while reading counts as a collapse for
reading for the same reason: as a collapse that stays, it would give the room
back and clamp the reader the same way. The room therefore comes back only
together with the dock reopening, which the frame's resize observer already
measures, so the release needs no timer or extra effect.

The state reaches the dock through a context so the memoized composer does
not re-render on every scroll away and back. One context carries both ways
the column shapes the dock (`dock`, `reading`, `in-chat`, from
`resolveFormDockMode`), so the "In the chat" choice travels the same way and
the composer takes no prop for either. The collapse follows the
context's change during render, and the text-field focus comes from the
dock's own focus events; a field removed while focused (the next step) does
not count as focused. The next question, taking the slot while the reader is
away, mounts already collapsed for reading, so it starts from the room the
column already holds (`readFloatingPanelTailReserve`) instead of its own
header height. Panels that do not hold room (a permission, BTW) publish their
own height as before.

### Why answer textareas measure content in one layout pass

`FormFieldControl` resets the textarea height before measuring its content,
adds the border height and applies the capped height directly. A height-driven
React effect feeds the border-excluding `scrollHeight` back into a border-box
height; deleting a long answer then causes repeated shrinking updates and a
maximum-update-depth crash. Text changes trigger measurement; the measured
height and overflow never trigger another React update.
The field wrapper keeps its current minimum height during that measurement,
then restores its original minimum. This prevents a scrolling form body from
clamping its offset during the temporary collapse, while allowing genuine
shrinking after deletion.

Recovered questions appear on both surfaces with a warning that Submit starts
a new paid turn in the asking session. Dismissal is local; rejected sends keep
the card and its answer draft. Eligibility belongs to `sync/recoverable-questions.ts`,
which records each question by session and form id, not by form id alone.

`formCardState.ts` decides what both surfaces show and send, mirroring
OpenCode's `Form.validateAnswer`: fields are evaluated in declaration order,
a `when` clause reads only the answers of active earlier fields (an
unanswered target is false for `eq` and `neq` alike, so hiding a field hides
its whole chain of dependents), and the reply carries only active fields.
An `external` field must be answered `true` or the server refuses the whole
reply: the dock acknowledges it when its step opens, the card (all fields on
screen) from the start, and an unacknowledged link counts as missing.

An MCP elicitation is a form OpenCode files under the session id `global`
(`LOCATION_SCOPED_FORM_SESSION_ID` in `sync/location-scoped-forms.ts`): it belongs to the
directory, not to a turn. `useScopedBlockingForms` appends the directory's
`global` forms after the session subtree's own, so the dock (and the BTW
sheet's inline card) offer it from every session of that directory, and the
reply resolves its directory from the store that holds the form.

`PermissionDock` is the agent's permission requests for the composer's
session, its subagents' included, in the same frame: one dot per pending
request with the current one solid, the request's tool in the header, and
Deny / Always allow / Allow once through the shared response hook, so
Alt+Enter, Alt+Shift+Enter and Alt+Backspace answer the current request.
Always allow and its shortcut exist only when the request carries `save`
patterns: OpenCode remembers nothing from an "always" without them, so the
question tool's request offers Deny and Allow once. A
pending permission hides the form dock and the suggestion.
The BTW sheet keeps the inline `PermissionCard` for its child session's
requests; both render the request through `PermissionRequestContent` and
`PermissionActions`.

A read-only chat (a subagent session, an archived space) mounts no composer,
so `ChatContainer` mounts `PermissionDock` and `FormDock` itself above the
read-only banner. A subagent's requests then show in its own chat and in its
parent's; both read the same store entries, so answering in one clears the
other. The parent finds the subagent through the directory store's session
list, which is why trimming that list never drops a session with a pending
request and never drops the newest session first (session ids descend with
time; the reducer trims by creation time).

The composer's top rows render inside the box and inside the mobile pill, so
the surface stays one shape. Top to bottom: the session's folder being gone
(`SessionFolderMissingRow`), a folder the user declined to trust
(`SessionTrustPausedRow`), worktree setup, the session still
being created from a draft's first message, and a message waiting for its
space (`ComposerStatusStrip`; the creating line yields to the worktree line,
so one wait shows one line, and appears only once the creation has taken
300 ms, `useShownAfter`, so a fast server never flashes it), the goal (`SessionGoalRow`), a
review loop and, once it ends, its result until dismissed, a dispute unfolding in place (`AutoReviewStrip`), the pull requests the agent waits on with Stop watching, several collapsed into a count (`PullRequestWatchStrip`), background commands, a staged revert
(`RevertedMessagesStrip`), the queue (`QueuedMessagesStrip`),
the "looks done" hint or the review offer, the suggestion
(`SessionSuggestionChip`). BTW hides all of them. A pending form, a nonempty
queue, composer content and a new-session draft hide the suggestion; a
new-session draft also hides the queue.

A paused goal's row shows a hint ("Paused during chat") in place of the status
word, because sending a message moves the chat on while the goal stays paused.
While paused, the hint and Resume own the row: below a 28rem row (a phone,
Mini Chat) the token count leaves it, and the goal dialog keeps the full
used/budget numbers; on a wider row the count gives up its width first. The
objective keeps 40px either way. Other statuses keep their layout.
`scripts/perf/session-goal-row.browser.test.mjs` checks that every translation
shows whole beside Resume at 360, 375 and 390px with a long objective and a
token budget, in Liberation Sans and in a wider face standing in for DejaVu
Sans, and that a wide row shows the whole count.

While a session's first send is pending (`pendingDraftSends` in
`session-ui-store`, from Enter in the draft until the request that starts the
turn has left), the composer keeps what is typed and sends nothing: Send is
disabled, Stop is not offered, Enter and the pill's arrow do nothing, and
nothing is queued. A first send that fails restores its text under the
identity `DraftSendError` names: the created session's composer, or the
reopened draft's, with the text typed meanwhile kept above the sent text
(*A draft's first send* in `sync/DOCUMENTATION.md`).

A send the page did not live to see settled comes back after the next start.
On Enter the composer clears its draft and writes the sent text to
`lib/unconfirmedSends.ts`; `sendMessage`'s `progress` adds the session a draft
minted, the prompt's message id, and the moment its request leaves, and the
record goes when the send resolves or its failure path has restored the text.
A record left by a page that died (reload, app restart, PWA update, renderer
crash) is restored by the main composer on mount
(`hooks/useUnconfirmedSendRecovery.ts`) through the same `restoreDraft` a failed
send uses, so text typed meanwhile stays above it. The target follows the
failed-send rule: the created session's composer when the server has the
minted session, the draft's otherwise. A project draft reopens under a new id
after a reload, so its text goes to the new-session draft on screen when that
draft is in the same folder, and to the folder's key otherwise (the next draft
opened there claims it); the old draft is discarded from the shared drafts so
its row does not list the text a second time. A request that never left comes back
without asking anything; one that left comes back only when the server answers
that it has no message with that id, and a command or shell line that left
(no client-side id) is dropped. A server that cannot answer keeps the record
for the next start, and so does a runtime switch while the server is asked:
the answer came from another server. Files stay in memory, so only their
names come back, as the dashed chips a reloaded draft draws.

A new Chat's first send also leaves its prepared chat folder behind when the
page dies before the session exists. The record carries that folder
(`progress.sessionMinted` names it for a Chat draft only, never for a project
folder). A first send that failed while the page lived but before its request
left (the server down, say) leaves it too: the store's own removal waits in
memory for the next connection and dies with the page, so `settle` keeps such
a record, marked `textReturned` because the failure path already put the text
back. A send whose request left has its session and settles without a trace.

The folder goes on the start after the one that first found the minted
session missing (`orphanSeen`). The page that found it takes the record over
(its own page id, under its own lock), so a second client starting at the
same moment, the desktop window and Mini Chat say, leaves it until that page
is gone too. The folder goes once the server still answers 404 for it and
the global session list, loaded for the check, holds no session in it
(`isChatDirectoryStillReferenced`, the rule a deleted chat's folder follows).
The record stays until the folder is gone or a session is found in it; a list
that cannot load, a failed read and a runtime switch keep both for the next
start. A live sending page never gets here (its record is skipped).

A Chat draft prepares its folder when its first character is typed, and an
unsent draft's folder outlives a reload too: the page that prepared it is gone,
and the next page prepares its own. `prepareChatDraftDirectory` therefore
records each prepared folder under the page that prepared it
(`trackPreparedChatFolder`), and recovery treats a dead page's folder by the
same two-start rule: the first start takes it over, a later one deletes it
when the global session list holds no session in it, and drops the record
when one does (the draft's first send made it a session's folder). A live
page's folder, the draft on screen included, is never touched; a folder the
store already removed (draft closed, switched to a project) answers 404 to the
delete and its record goes. A folder a send record still names waits until
that record is settled, so the send's own grace start is never skipped, and a
session list that does not load keeps both folder and record.

No folder is ever deleted without Web Locks. There the records live in the
tab's `sessionStorage`, which a duplicated tab copies, so a record's owner
cannot be told dead: prepared folders are not recorded, and a send's leftover
folder is left on disk.

### Why a left-behind chat folder waits a whole start before it goes

A page that dies does not take back a create request already on its way: the
server can still make the session after the next start has read 404, and a
session whose folder is gone fails every prompt. No read on the client closes
that window, so the first start only notes the folder and the next one, a page
lifetime later, deletes it if the session is still missing. A leaked scratch
folder for one more start costs nothing; a stranded session cannot be
repaired. The global session list is the authority instead of a session list
scoped to the folder, because a scoped read makes OpenCode start a location in
a folder that is about to go.

### Why an unconfirmed send is its own record and not the draft left in place

Keeping the sent text in the draft until the send settles would show it in a
second window's composer while the first still sends, and the composer's own
flush on hide writes the cleared field over it anyway. The record names the
page that wrote it, and each page holds a Web Lock under its id while it lives,
so another tab or the Mini Chat window never restores a send that is still
going; recovery itself runs under one lock, so two windows starting together
restore a record once. Each record has its own storage key, so two windows
writing at once never overwrite each other's progress. Where Web Locks do not
exist (a plain-HTTP LAN address) liveness cannot be told, so the records go to
the tab's `sessionStorage`: a reload of the same tab still finds them, another
tab never does. A record is written to storage directly, not through the
deferred storage the drafts use, because the page can stop before a deferred
write flushes. Removing it, after a send settles or after recovery, first
flushes the deferred storage (`flushDeferredStorage`), so the restored draft is
stored before its record goes and a stop in between never loses both; recovery
removes it while it still holds its lock, so a second window cannot find it.

### Why a session whose folder is gone gets a row and keeps its text

OpenCode answers every request of such a session with `LocationNotFoundError`,
so the model list stays on Loading and a send can only fail. When the session
opens and when the window regains focus, `useFolderMissing` asks the server's
folder stat, and only if that says missing asks OpenCode
(`getLocationAvailability`): OpenChamber's stat alone would be wrong when
`OPENCODE_HOST` puts OpenCode on another machine, and a hold on sending must not
rest on it. `SessionFolderMissingRow` then names the folder and offers Move session.
While the row shows, Send and queueing keep the text, send nothing and look at
the folder again, so a raw error never replaces the row. VS Code has no folder
stat: there the row appears when a send comes back with `LocationNotFoundError`,
the next send asks OpenCode again because nothing else could lift the row, and
the same answer covers a folder that vanished while the window kept focus.
Isolated spaces take no row: the server's stat cannot see inside the container,
and a space's session cannot leave it. The move stays
manual (*Missing worktree directories* in `sync/DOCUMENTATION.md`): only the user
knows where the folder went. A running location outlives its folder and keeps
answering, so no row shows while sends still work; the row comes once it unloads.

### Why a folder the user declined to trust gets a row

After "Not this time" in the folder trust prompt (`lib/opencodeTrust.ts`) the
server refuses every OpenCode request for the folder, so the model and agent
pickers stay on Loading and a send fails on the missing model before it could
ask for trust again. `SessionTrustPausedRow` shows while the folder is paused and
reopens the prompt; once trust is saved it reloads the folder's sessions and
catalog (`useResumeOpenCodeFolder`). A paused folder stays paused when the user
opens another folder, unlike the decline that only silences background reads,
so the row and the sidebar line do not vanish while nothing changed.

`RevertedMessagesStrip` lists the user messages a staged revert hides (see
"Committing a revert" in `sync/DOCUMENTATION.md`). Its one action is Restore,
which clears the revert and puts the messages and the agent's file changes
back. Committing needs no button: the next prompt or compaction commits it on
the server. One message is its own row; several collapse into a count with
Restore on the header and a read-only list that expands in place, collapsed
again for a new revert point.

`QueuedMessagesStrip` shows one queued message as its own row with edit, send
and remove. Several collapse into a count that expands in place into a list
with drag-to-reorder, capped at four rows before it scrolls. Its open/closed
state is one persisted preference in `useUIStore` (`messageQueueExpanded`,
collapsed by default), shared by every session and surviving session switches
and reloads. It receives the composer's main-session queue target instead of
resolving the global selection, so a chat pinned in the side panel addresses
its own queue. It stays visible under the form and permission docks. A row
whose captured agent differs from the agent the composer would send as now
shows that agent before edit, because the item still sends as captured; the
strip compares against the composer's `currentAgentName`, the same value
queueing captures.

`selectComposerQueue` in the submission builder excludes server-scheduled items
before the composer counts manual content or reads captured send configuration.
Mixed queues use only ordinary items for manual send; a scheduled-only queue
cannot trigger an empty composer send. Enter and Ctrl/Cmd+Enter in an empty
composer send the whole queue now, as one visible message (#4746). While a turn
runs only Enter does this: the send button gives way to Stop until the turn
ends, and a row's own Send sends just that message. An empty-composer send
dismisses open permission requests and the forms that hold a turn, as a direct
composer send does, and defers the session's own waiting question when the send
goes out as a plain prompt to that session (`sync/DOCUMENTATION.md`, blocking
requests; a command, or a local prompt command such as `/summary`, leaves it
pending); a row's own Send is queued-only and dismisses nothing.
Scheduled items stay visible in the queue rows with reorder and remove, but no
edit or send action.

The action button (`ComposerActionButtons`, and the same rule in the
collapsed mobile pill) is one disc in one slot: 28px on desktop, the footer's
button size in VS Code, and a 28px disc at the end of the 32px touch target on
phones, where the footer and the collapsed pill take `pe-3.5` so the disc's
right edge lines up with the agent label in the row below. The pill's action
row is built like the expanded footer (`h-12`, the attach button in
`composer-mobile-actions` at a 10px inset, mic and Send in a `gap-x-1`
group), so no icon moves across the swap with 32px buttons or on the 36px
touch floor. It is drawn by `.oc-action-disc` in `design-system.css`: the
composer's text colour with the glyph cut out in the composer's own fill
(`--oc-composer-foreground` over `--oc-composer-background`), flat, no ring
or shadow. Disabled, it is a quiet tone step of the text colour with the
glyph in the muted text. Which glyph it shows:

- idle: Send (`arrow-up`);
- a turn running, input empty: Stop, its square in the theme's error colour
  (`--status-error`) on the quiet disc (`data-idle`): a bright disc for the
  whole length of a run pulled the eye; the bare Stop shown beside
  Send (below) takes the same red square;
- a turn running, input with content: Send again, taking the same path as
  plain Enter under the follow-up setting: with Queue it queues and is
  labelled "Queue message", with Steer it steers into the running turn.
  Ctrl/Cmd+Enter sends now instead of the setting's choice, as it does for
  Enter.

A run stays stoppable with the draft intact. Whether double Escape
(`abort_run`, `hooks/useComposerAbortEscape.ts`) reaches a composer's session
is decided in one place, `state/abortShortcutReach.ts`, which `ChatInput`
passes down as `escapeStops`:

| Surface | Running with a draft |
| --- | --- |
| Main window (and a chat pinned in its side panel), with a keyboard | One disc (Send); double Escape stops, named in the Send tooltip |
| Mini Chat, with a keyboard | The same: `useMiniChatKeyboardShortcuts` wires the gesture to Mini Chat's own session |
| BTW | A bare Stop icon before the disc: BTW's Escape collapses BTW, and the shortcut skips its composer |
| Touch (the mobile composers, or a device with no hover and a coarse pointer) | A bare Stop icon before the disc, at the touch-target size |
| Anything else (`unknown`) | A bare Stop icon before the disc, until the surface is wired |

The visible Stop appears only in that state and takes room from the row on
its left, so the disc does not move.

Only the glyph changes as a run starts or ends, so nothing beside it moves. On
desktop the footer's end padding is 8px, so the disc sits as far from the
composer's right edge as from its bottom edge.

`BackgroundShellsStrip` lists the commands that went to the background (not the ones
a turn is waiting for, see `background` in `sync/background-shells.ts`) of
the session and of its
subagents at any depth (`sessionsInTree` over the global sessions store, a
subagent missing from it keeps its commands out), each with its command,
elapsed time and Stop through `opencodeClient.stopBackgroundShells`, the same
flow as the command's row in the chat. One command is one row; several
collapse into a count that expands in place, collapsed again on a session
switch, and the count row carries Stop all. Stop all sends one call per owning
session, so each agent gets one note for all of its commands and their
completions arrive together; a stopping row stays disabled until OpenCode
reports its command ended, and a failed call makes its commands stoppable again. A command its chat row is stopping from the foreground (`foregroundShellStop.ts`) appears here once its call moved to the background; its Stop stays disabled and Stop all leaves it out, so the agent gets one note; Stop all itself is disabled while every listed command is being stopped, and comes back when such a stop fails. It shows whether the session runs or idles, and hides in BTW and
new-session drafts. The elapsed text is a leaf on the shared one-second
ticker, and the tree is compared as a string, so neither the tick nor
session-list updates re-render the composer. Images the session and its
subagents generate in the background (`sync/background-images.ts`) join the
same strip as rows with the image's name, its full path and model in a
tooltip, and the elapsed time, but no Stop: OpenCode has no route that
cancels an image job, so Stop all stops the commands only and hides when
there are none. A count that includes an image reads "In the background".

The "looks done" hint (`SessionDoneHintRow`) and the review offer
(`SessionReviewHintRow`, "Changes are ready to look over") take the same
slot, below the background commands. Both show only while the session idles
and Jev's hint is current (`lib/sessionWorkMetadata.ts`); the server writes
one or the other per turn, and a current done hint wins. The done hint
follows the In work setting, the review offer its own
(`sessionReviewOfferEnabled`), and needs no session in work. The review offer
opens the composer's review dialog (the one `/handoff-review` opens) or a
walkthrough of the whole working tree, and is not shown on a mobile layout,
where neither action is offered elsewhere either.

The shared frame measures its height and gap as
`--chat-floating-panel-clearance`, published through
`state/composerInsetReaders.ts` onto the elements that read it, never on the
chat column (inherited from the column, every resize of the frame restyled
the whole transcript). The floating status row, the recap hint and
`ScrollToBottomButton` translate upward by that amount, the end fade band
grows by it and the transcript's tail spacer by its reserve twin
`--chat-floating-panel-reserve` (equal to it except while a panel holds its
room, see the question dock above; so the frame never covers the last rows), and the column carries `data-floating-panel` while any frame is
mounted so the recap hint hides instead of landing over the transcript.
Unmounting clears the offset and the marker; resizing or collapsing the frame
updates it.

## Floating composer

In a normal session view the composer slot is an absolute layer over the
bottom of the transcript (`ChatContainer`), and the input box is an opaque
surface (`oc-surface-floating`): it is always on screen over the moving
transcript, and a blur there was redrawn on every streamed frame (see the rule
in `design-system.css`). The draft screen and the expanded editor keep the slot
in flow. A `ResizeObserver` on the slot publishes its height as
`--chat-composer-inset` and the timeline's tail spacer height as
`--chat-composer-tail-inset`, written onto the elements that read them (the
end fade band and the tail spacer, registered through
`state/composerInsetReaders.ts`), never on the chat column: inherited from the
column, every new composer line restyled the whole transcript. The tail
spacer height is the resting composer (the smallest height the
slot has measured) plus an 80px gap, or the current height minus an 8px
overlap into the gap, whichever is larger. With the last turn's own bottom
padding the visible band at rest is about 104px. A row appearing inside the
composer (suggestion, "looks done", background commands) or a few lines of
text grow into the band without moving the transcript; growth past 88px
(`FLOATING_COMPOSER_GROWTH_ALLOWANCE_PX`) pushes the transcript and keeps
about 16px between the last row and the composer. While the session works,
the composer gets no growth allowance and the spacer never drops below the
current height plus the full gap: the floating status row and the live end
fade sit in that gap, and a composer grown into it left the last line under
the row. The rule and the resting
height per column live in `state/composerTailInset.ts`; the mobile morph uses
the same rule to announce how far the transcript's end moves, which is less
than the slot's height change whenever part of it is taken from the gap. While the slot is taller than at rest
the column carries `data-composer-grown`, and the recap hint hides until the
composer is back at rest. Only the composer itself at its natural height sets
the resting height: what stands in for it in the slot (a subagent's read-only
banner, the mobile comment composer) carries `data-composer-transient`, and a
slot the pill morph pins carries an inline height; both are shorter than the
resting composer and, kept as the floor, left it "grown" until a reload. The hint lies under the latest answer's footer as an
overlay over this gap (`MessageBody`), taking no room, so its arrival and
leaving move nothing (maintainer, 2026-10-29); a composer grown into the gap
would cover it.
The transcript's end fade is a band in the chat background over the
scroller's end (`.chat-scroll-fade--end` in `index.css`; a mask on the
scroller made the GPU recomposite the whole transcript every frame). It reads
`--chat-composer-inset` (plus the floating-panel clearance and, while the
session works, the status row's height) through
`--scroll-shadow-end-inset`, so a row that
does reach the composer, as the newest lines of a live reply do while the
follow glide is still catching up, dissolves above the box instead of being
cut in half by its top edge. That inset applies only while a reply streams
and the view follows it (`data-live-tail` on the chat column, set by
`ChatContainer` from the timeline's `isFollowingProgrammatically`: no
scroll-to-bottom pill and no reader gesture); at rest and while the reader scrolls history the rows slide
under the composer, which is what makes the composer read as
floating. There the end fade is longer instead (`--scroll-shadow-end-size`):
it starts just above the box and runs to the scroller's bottom edge, so rows
under the box and beside a box narrower than the transcript (wide layout)
thin out gradually instead of running into the window's edge.
The variable is written straight to the DOM, so composer growth never
re-renders the timeline: the list's own footer observer extends the content
and the scroll hook's pinned-end observer keeps a reader on the end. The
mobile keyboard choreography is unchanged: the form inside the slot is still
the keyboard mover and the column shrinks around it at settle.

The box clips its contents, so popups anchor to the wrapper outside it. The
dictation overlay (`.oc-dictation-overlay`) never shows the composer's own
contents through it: a CSS rule in `design-system.css` hides them while it is
up, leaving the box as the single surface on desktop and the overlay itself on
mobile. On desktop the footer's
dictation reports its state and the box carries `data-dictating`; the
elements between the box and the overlay carry `data-dictation-chain`, so the
rule only targets their other children. A `:has()` over the box was
re-evaluated for every descendant on each editor mutation.

Typing re-renders nothing in React except what shows a value derived from the
text: `ChatInput` renders when the composer turns empty or non-empty, the
goal counter's length while a goal is armed, the snippet picker's draft while
it is open, and the collapsed phone pill. The draft text lives in
`state/composerText.ts`, which the editor's change handler updates on every
edit. Handlers read the current text from it (or from the editor), render
reads derived values through `useComposerTextValue`, and work that followed
the text in an effect (draft persistence and publishing, the file mention
check, session link reads, the picker's position, the new Chat's folder)
subscribes through `useComposerTextEffect`. The children that do not depend
on the text (footer, autocomplete popups, docks, BTW panel, draft target
selectors and preset chips) are memoized, and the props `ChatInput` passes
them keep their identity across its renders: callbacks are
`useStableHandler`s or read `composerText`, derived objects are memoized, and
`useBtwPanelState` and `useMobileComposerShell` return stable objects.
`useBtwPanelState` reads the parent and fork sessions as primitives, and
`useChatSearchDirectory` reads only the session's directory, so a streaming
turn's `session.updated` events do not re-render the composer. The editor is
memoized and every handler `ChatInput` passes it is a `useStableHandler`, so
it renders only when what it shows changes.
`__tests__/ChatInput.keystroke.test.tsx` counts the renders per keystroke and
per streamed session update, and sends a text whose Enter lands before any
render.

### Why a share waits for the draft to be the one on screen

A share (Android's share intent, or the iOS share extension's inbox) always
opens a new-session draft of its own
(`openSharedFilesSession` in `apps/deepLinkNavigation.ts`) in the last-used
project: the projects store's active project, which opening a session keeps
current, or the first project when none is active. A project draft is listed in
the sidebar under its project and can be reopened after the user leaves it; the
Chat target has no such list, so a share opens in Chat only when the app has no
project. An empty project cache before the server's project list arrives is not
"no project": `openSharedFilesSession` then returns false, the share queue keeps
the share, and a change of the project list, `hasServerSnapshot` or
`serverSnapshotFailed` flushes it on the next microtask, because
`synchronizeFromSettings` marks the snapshot before it writes the projects. The
wait has no deadline: until the page takes the share the native side keeps it,
so a relaunch hands it over again, and choosing Chat early would put it where it
cannot be reopened. Its work draft id is marked with `keepWorkDraftOwnSlot`
(`lib/chatDraftPersistence.ts`), so it never claims the folder's draft text, and
in the Chat case it gets its own work-draft composer key instead of the one slot
every chat draft shares. A draft the user was writing keeps its text and
attachments and receives nothing. The mark lives in memory: after a reload the
share's draft is an ordinary draft again.

The share leaves its files, text and the names the native side refused in
`input-store.pendingDraftContent`, addressed by the draft's id. Taking it there
calls its `accept`, which tells the native side the draft holds it.
`usePendingSharedDraftContent` applies it from the composer that renders that
draft, and only once the composer's column shows no session. The column renders
the deferred selection (`chatColumnSession`, `sync/DOCUMENTATION.md` "Session
switch commit"), so for one commit after `openNewSessionDraft()` it still names
the session the user left; taking the share there would file its attachments
under that session's draft and the draft would look empty.

Files go through `attachSharedFiles`, not `attachFilesWithCitation`, and reach
OpenCode only at Send:

- Every file names the share's draft identity and attaches with
  `addAttachedFile(..., { shared: true })`. It lands in that draft even when the
  user opened something else while it was read, and a HEIC the decoder cannot
  read is held for Send like a dropped one (`sync/DOCUMENTATION.md`). Each
  step resolves the draft's current identity by its work draft id
  (`resolveOpenWorkDraftIdentity`), so a destination changed mid-read takes the
  late files and their citations along.
- When the share's draft is no longer on screen, its text and citations go to
  that draft through `restoreDraft`, never into the editor that is showing.
- The names are fixed before any read and held in
  `pendingPastedAttachmentFilenamesRef` until each file lands, so a paste or drop
  into the same draft meanwhile cannot take one of them.
- Office documents follow the "Attach documents" setting and get the same
  choice a dropped document gets. "Convert to text" attaches them locally.
  "Attach as is" (and the Save setting) keeps the original in the draft with
  `saveOnSend` (`addAttachedFile`'s `saveOnSend: 'reference'`), as a dropped
  document attached as is does; `saveAttachmentsHeldForSend` writes
  it where OpenCode runs when Send or Queue is pressed and swaps it for the same
  path reference a dropped document gets; a message queued that way returns the
  document still held for Send when its row is edited. A write that fails keeps the message
  unsent with a toast naming the file. Each write is bound to the runtime the
  send started on, and when the user left that draft or instance during the
  writes the send stops instead of running in the composer now on screen. A
  choice that goes away unanswered (the user leaves the draft, or another offer
  replaces it and the offer's `onDismiss` runs) keeps
  the originals held for Send, the choice that loses nothing, so Send never
  waits on a choice nobody can answer.

The work is tracked like every other intake, so a Send that arrives while a
large file is still being prepared waits for it instead of going without it.
The call returns the files the composer's policy refused, so the share reports
them by name in the same toast as the native refusals; a share sheet gives no
second chance, and a file that vanished silently is the failure mode to avoid.
Shared text rides along as the attach call's `leadingText` rather than being set
first: the citation is inserted into the editor's document, which still holds
the text from before the commit, and that document overwrites `composerText` on
the next edit, so text set first is lost.

### Why the draft text lives outside React state

As `ChatInput` state, every keystroke rendered the whole composer: about
3.4 ms of a 10.9 ms keystroke at 4x CPU throttle into a 3,000-character draft
(`profile:composer --type`), and the worst keystrokes twice as long. Holding
the text in `composerText` leaves React only the values that change what is
on screen. Handlers must read `composerText.get()` or the editor, never a
value captured at render, or an Enter that arrives before the next render
sends the text without its last keys.

Text the app puts in goes through `setMessage`, which updates `composerText`
and bumps `valueRevision` on `ComposerEditor`. The editor's `value` prop is
`composerText.get()` read at render, so a remounted editor starts from the
current text; the revision makes the editor write a value equal to the one it
last rendered with, which happens because typing no longer renders it (type
after a render, then the app restores the text of that render).

A glass surface never carries its own shadow: the shadow sits on a wrapper
(or the glass moves to an inner layer). Chromium grows a backdrop-filter
layer by the shadow's blur, and that band painted a flat grey strip over
whatever was stacked above. This holds for the floating panels. The box, the
mobile pill and the dictation overlay are opaque and keep their shadow on a
wrapper all the same.

Context waiting for the next message (review comments, quotes, annotations,
terminal selections, PR context) lists as rows inside the box, right above
the input (`ComposerContextRows`), one row per item in the
order it was added. A row reads like the sent message will: the quote's first
line, or where it came from, behind the accent bar, then the comment. A click
opens the row in place with the whole quote and, on desktop, the comment field;
Enter or a click elsewhere saves, Escape drops the edit. On mobile the click
opens the comment shell (see "Mobile comment mode"). Four rows show; the rest
fold behind "+N more", and the unfolded list scrolls inside the box past 40%
of the window, so the input never leaves the screen.

### Why rows in the box and not chips with a preview

Chips grouped items by kind and opened a stacked preview above the composer on
hover. Reading what was attached meant hovering each chip, and editing meant
aiming at a pencil in a panel that closed when the pointer drifted. Rows show
every item's quote and comment at once, edit with one click, and need no
portal, hover grace or height cap above the composer.

An annotation's comment is the draft's own text, like every other comment, and
the prompt the model reads carries no `Comment:` line. The row and the sent
card read the page and element text out of the prompt
(`lib/browser/annotationPrompt.ts`); an annotation saved before keeps its
comment in the prompt and shows it all the same, and editing it moves it out.

### Why a composing draft is typed in its row, not a floating field

The float above the composer — a glass pill with the attach button, Enter to
save — was the chips design's field for a draft, and it left with the chips. A
glass surface inside the composer's own glass box stacks two blurs, and a field
that floats over the box needs the portal and the height cap the rows removed.
A composing draft opens where every other draft is read and edited, its row, and
the row's head states the file and line it anchors to.

## Invariants

- Drag payload reads are guarded individually because a host can reject
  `getData` during dragover. One unreadable type leaves the remaining types usable.
- Inline-mention attachments retain their shared ID prefix so send-time filtering
  can distinguish guessed paths from files the user deliberately picks.
- Mention existence checks fail open per directory. A missing parent proves a
  file absent; other listing failures cannot justify dropping its attachment.
- Mention checks allow case-insensitive matches because macOS and Windows can
  resolve differently cased names. On case-sensitive disks the server remains
  responsible for rejecting an invalid path.
- File identity includes a file URL's host. Dropped-path decoding alone loses
  that host and can merge different files.
- The mobile comment engine clears the wrapper engine's active flag when it
  takes over, so an unmounted recording cannot keep the shell expanded.
- A kept editor's compartments and callback ref outlive its component instance.
  Reconfiguration uses the original compartment keys, and callbacks reach the
  currently mounted instance. The store owner destroys the view.
- Reattaching a kept editor requests fresh geometry because measurements made
  while detached do not describe its mounted layout.
- Editor creation runs in a layout effect so a synchronous mobile expansion has
  a view available for focus before the tap returns.
- Deferred Enter modifiers expire if CodeMirror never dispatches its replacement,
  so a later keyboard Enter cannot inherit an unrelated keydown. Their listener
  belongs to the kept view and follows its callback ref across component mounts.
- The return-key hint has its own compartment so a setting change reaches the
  keyboard before its next opening. Waiting for another document update leaves
  the keycap one keystroke behind the selected behavior.
- Controlled writeback waits while the browser composes. A stale value echo can
  otherwise replace newer IME text and interrupt composition.
- External value rewrites put the caret after the inserted text. Bottom scrolling
  waits 2 frames for wrapped-line measurements and the observer's height cap;
  transaction-time scrolling can run before overflow exists.
- Height observers write only changed values to avoid resize feedback. Content
  remains observed after the host reaches its cap, and sub-half-line overflow
  counts as fitting so rounding cannot create a useless scrollbar.
- The failed-dictation height budget excludes the host, whose own minimum height
  changes with that budget. Expanded mode releases the collapsed editor's cap.
- Forwarded padding clicks preserve their horizontal position on the nearest
  text line. Clicks already inside the content keep native drag selection.
- Editor theme overrides match CodeMirror's selector specificity. The drawn
  caret takes its color through its border; unscoped `&light` and `&dark`
  selectors in `EditorView.theme` throw during module import.
- Placeholder text uses an absolutely positioned pseudo-element so an empty
  editor's IME context and caret geometry remain empty. Its quoted CSS string
  travels through a custom property because `attr()` reads the pseudo-element's
  own element. CSS custom property names retain kebab case.
- Placeholder opacity keeps a repeated hint quieter than draft text. Placeholder
  fit uses the editor's actual font and width, including completed web-font loads;
  a hidden editor has no usable width and retains the full hint.
- Shared-page draft storage keeps page identity without its key or content.
  Resolved reference content otherwise stays in memory because it is a potentially
  large attach-time snapshot. The server rebuilds a stored page's content.
- Message-reference context identifies the author separately from the person
  attaching it, so an agent's words cannot read as the user's request.
- Draft-target refreshes cannot overwrite a worktree creation that starts during
  their read. Failed refreshes retain the last known list, and bootstrap completion
  gates dirty checks so setup files cannot become a false dirty warning.
- A draft-target refresh waits while the login PIN window is active. Closing that
  window must leave the answer the user signed in for available. A project change
  resets its refresh throttle so the previous project's budget cannot delay it.
- File-mention checks debounce partially typed paths and bound folder lookups for
  pasted logs. Missing-name results belong to their directory and clear on a
  directory change.
- Shared draft publishing discards an empty draft only after this composer has
  published content. The empty render before restoration cannot delete a reopened
  draft; a failed save leaves its local copy available for retry.
- Comment snippet expansion changes only the comment's own text. Quoted evidence
  stays verbatim, and a failed expansion sends that comment as written.
- Parallel launches that create no sessions keep their prompt and armed goal for
  retry. The launch-settings dialog keeps disabled controls in place so changing
  options does not change its size.
- Context-row editing saves once after focus leaves the entire row. Its own
  controls retain focus, and a remount that returns focus inside the row cannot
  save it prematurely. Completion guards reject a later unmount blur.
- A composing draft's row is the open one while `composing` is set, and only an
  active surface opens it: a chat that is not on screen cannot take the keyboard.
  The row's head names the file and line a field with no text cannot.
- A composing draft owns its text: every keystroke reaches the store, so a
  reload, session switch or surface swap loses nothing. When the store refuses a
  write at its size bound, the field keeps the typed text, the storage-limit
  toast says why, and finishing waits until that text is saved.
- Finishing a composing draft clears `composing` and closes the row; Escape
  removes the draft, and one finished with no text goes with its field. Every
  other draft survives an empty edit.
- A composing row is never folded behind "+N more" (`foldContextRows`); it takes
  the last visible slot so its field stays mounted. When its row opens, the
  field is scrolled into view once: the field focuses with `preventScroll`, and
  a long quote can push it below the capped context list. Later scrolling is
  the user's.
- Arriving with a composing draft switches the layout to the chat, including out
  of a run overview. The reveal belongs to the arrival, so the user can reopen a
  run overview while the field is open, and a reload that restores an unfinished
  composing draft leaves the view where it was. Arrival is counted per draft id
  (`takeArrivedComposingDraft`), not by whether any draft is composing: a
  restored unfinished composition stays composing, and the next comment filed
  must still bring the chat forward.
- Collapsed context text before a chip keeps its width until its cap; fractional
  shrinking would ellipsize a word that fits. Space runs at chip boundaries remain
  explicit so truncation cannot collapse them.
- The project popup owns global shortcut suspension and accepts only visible
  results. Its ranked rows bypass cmdk filtering, and IME keys cannot navigate or
  dismiss it. Mobile uses sheets because native selects are unusable over a
  keyboard-resized viewport.
- A hidden draft timestamp uses visibility so it cannot intercept the remove
  control's click. Removing a draft stops the menu item's activation.
- Exiting popups reject pointer events so they cannot take clicks intended for
  content below them. A cancelled exit leaves a popup that reopened mounted.
- Non-interactive history-search padding retains field focus; otherwise a press
  inside the panel can close it before its pointer interaction finishes.
- Mobile dictation submit holds the editor until send assembly settles. Expansion
  and overlay-close focus holds bridge delayed React focus state, while the DOM's
  focused field prevents an idle collapse from unmounting an active editor.
- Overlay close uses a count because portal nodes can still exist during layout
  cleanup. Browser refocus happens inside the closing gesture; overlay chains
  debounce fallback restoration and cancel it when the next overlay opens.
- Mobile blur waits 120 ms in browsers so keyboard-dismiss reflow cannot move a
  tapped button before its synthesized click. Capacitor commits blur synchronously
  so the subsequent keyboard-hide intent sees current state.
- Browser viewport pins use the smaller visual and resized layout viewport bounds
  because visual metrics can be stale. They measure per frame during motion and
  switch to idle polling after settling, catching silent keyboard growth without
  rendering every frame on a still page.
- A tap on an already focused browser field wakes viewport measurement because
  reopening its keyboard can emit neither a focus nor a viewport event. Leaving
  fullscreen also re-reveals the still-focused form, and installed PWAs reset page
  scroll after dismissal to release a stuck viewport pan.
- An interrupted mobile morph measures its current geometry before cancellation.
  Resting geometry is measured without morph styles and re-read when the keyboard
  root class changes, so unpinning cannot jump by the form's changed padding.

## Layers

| Directory | Owns |
|---|---|
| `language/` | What the text *means*: `@` references, `/` and `#` tokens, markdown, and which picker a caret asks for |
| `editor/` | The CodeMirror view that renders the language and owns the caret |
| `state/` | Composer-local lifecycle state: ArrowUp/ArrowDown browsing, draft stash/restore, mobile shell, popup placement, draft targeting |
| `comment/` | Mobile comment mode: quoted-selection state, its scope ownership, and the shell that replaces the composer while a comment is written |
| `submit/` | Turning what the user has into what gets sent. `guestCommands.ts` routes an extension's slash command (`contributes.commands`) before anything is sent: `/name args` never reaches the model, the extension resolves it into a chip |
| `attachments/` | Files: paths, drop payloads |
| `ui/` | Presentation. `ComposerAttachmentControls` lists files, the repository's provider (issues and PRs in one picker), one row per signed-in tracker (`trackerPickers` from `useTrackerSources`, Linear's "Link Linear Issue"; a tracker nobody signed in to is connected from Settings, not offered here), then guests with `contributes.attach`; each source is one row. The repository and tracker picker is `components/references/` (see its `DOCUMENTATION.md`). `"panel"` opens the rail. `"dialog"` opens `GuestAttachDialog` with that guest iframe and `ready.surface: "dialog"` (loading `attachEntry` when the manifest declared one). `host.attach` writes the composer chip. Clicking that chip reopens the guest with the chip as `ready.item`: dialog guests get it as a prop, panel guests through `lib/guests/item-store.ts` and the rail. Message and session actions (`contributes.actions`) travel the same two roads with a `GuestMessageItem` / `GuestSessionItem` (`lib/guests/dialog-store.ts` `openGuestWithItem`); the dialog they open lives in `layout/GuestHosts.tsx`, not here, and an `attach` from it closes it through `handleGuestAttach`. The chip keeps the guest's opaque `data` (also on the `guest-issue` / `guest-pr` context part metadata and the session `LinkedGuestIssue` snapshot) so it comes back byte-identical; it is never part of the context text. VS Code and mobile skip that list. |
| `parallel/` | "Run in parallel": the launch state of a new-session draft (prompt variants, models per variant, worktrees, setup, auto-fusion) and the strip that renders it above the editor |
| `text.ts` | How inserted text meets the text already there |
| `largeTextPaste.ts` | Detect large plain-text pastes, own the double-paste gesture, and build virtual `.txt` files |
| `largeTextPasteOffer.ts` | Offer id begin/resolve for the choice above the composer, large paste or office documents (supersede + double-apply guards) |

`ChatInput.handlePaste` owns paste orchestration: URL-over-selection markdown
links, clipboard files, and large plain-text pastes. Pasted, dropped and picked files
share `attachFilesWithCitation`: every file attaches and is cited in the draft
as `[name]`; images get a generated unique name first, other files keep their
own name and are cited only after they attached. Pickers allow all file types;
binary formats no model reads stay local chips and become path notes at Send. A copied file's filename text
is suppressed so only the citation lands in the draft.

### Attachments are chips in the text

Every file the composer holds is a chip in the text, however
it came: paste, drop, the attach menu and VS Code's picker
(`attachFilesWithCitation`), VS Code's open-file suggestion and its editor and
explorer commands (an effect writes the chip of each new VS Code file at the
caret). There are no thumbnails above the input.

- The draft's files are a pool; a send, a queued message and a parallel
  launch take the ones their text cites (`attachmentsCitedIn`, `[name]` or the
  `[name](path)` link of an image or office document saved as a file), plus the screenshots of
  the browser annotations going with it. Deleting a chip drops its file, and
  undo, which only rewrites the text, brings it back. A send waits for files
  still being read.
- Each chip names one file: a name another file holds gets `-2`
  (`assignFileAttachmentFilenames`), and square brackets become parentheses.
- A draft put back into the composer (a revert, a queued message taken out to
  edit, a recalled prompt, a fork or a sidebar draft) gets a chip for each of
  its files the text does not cite (`withMissingCitations`): messages sent
  before every file had a chip never named theirs.
- Files live in memory, the text survives a reload. The names a draft had
  attached are kept apart (`lib/draftAttachmentNames.ts`), so after a reload a
  chip whose file is gone draws dashed with a tooltip saying so, instead of
  turning into bracketed text.
- A click on a chip opens what it stands for (`onChipOpen` in the language
  context): an image, a text file or a PDF in its dialog, as in a sent message,
  a file by path in the file viewer, an item in the Tracker. Where the Tracker
  cannot show the item (VS Code, a repository no open project reads, a tracker
  nobody signed in to) the chip opens its link in the browser
  (`useOpenTrackerItem`). The caret goes
  beside a chip by a click next to it or the arrow keys. A chip is at most 18rem wide and leaves room for a
  space and the caret beside it, so a long name truncates instead of filling
  the line.
- The collapsed mobile pill draws the chips in its one line.
- The sent message keeps a quick look at its images and files: one strip
  (`MessageFilesDisplay`, compact) of tiles of one height, images as
  thumbnails and files as small pages: the name on up to two lines, then the
  type and the size when the part carries it, scrolled sideways when they
  do not fit. Everything else the message carries is its chip in the text.
An Android image paste arrives from the input method rather than from a paste event, because
a WebView declares no content types on its `EditorInfo` and the IME refuses the paste before
the page can hear about it. The Capacitor Android shell declares image content on the editor
it exposes and sends what the IME commits to `lib/nativeImagePaste.ts`, which hands the
composer the same file a pasted image would be, and the composer runs it through
`attachFilesWithCitation` like any other. The declaration belongs to the composer alone: the
WebView is one input connection for every editable element in the app, so the composer
reports its focus to the shell and drops the declaration on blur, and the shell asks the IME
to read the declaration again when the composer takes focus, since the IME reads it when an
element takes focus and that can be before the report arrives. The paste handler re-checks
focus as a backstop for that window. Every other runtime pastes images through `handlePaste` unchanged, and an IME
without content insertion keeps refusing.
With the profile setting `savePastedImagesAsFiles` on, pasted, dropped and
picked images (`attachFilesWithCitation`, `attachFiles`) attach with an
ordinary `[name]` citation and stay in the draft; nothing is written while the
user composes. Send or Queue writes each into a new folder under OpenCode's own
temp folder (`saveAttachmentsHeldForSend`, through
`opencodeClient.writeOpenCodeTempFiles`: `GET /api/info` names the folder,
`POST /api/experimental/fs/write` writes it), so the model, a subagent or a tool
reads the file by path; OpenCode's agents may read that folder without asking.
`imageSaveModeForModel` picks one of three cases when the image lands. A model
whose metadata lists no `image` input gets only the path note, since it could
not read the attachment (#5087): the image is held with `saveOnSend:
'reference'` and swapped for its path note at Send, and the modality notice
says the images go as paths. Any other model, unknown metadata included, gets
the image itself plus a path note to the saved copy (`saveOnSend: 'copy'`): the
note shares the image's name, so the image's one citation sends both (#5218).
A HEIC the bundled decoder cannot read (Apple's HDR gain-map photos) goes as
its path note only in both cases, since providers refuse HEIC image parts, and
so does an image too large to attach inline (over 10 MB). A
write that fails at Send stops the send with a toast naming the file and keeps
the draft. With the setting off the image attaches as an image, and the send
step below covers a text-only model.
The browser annotation screenshot and comment-field image pastes keep
attaching. The bytes go through the active runtime's OpenCode route (the
OpenChamber server's proxy, the VS Code bridge, the relay for a phone), so the
file lands on the machine OpenCode runs on, which may not be the user's. Why
OpenCode writes the file and not the OpenChamber server: only OpenCode knows
its temp folder and its filesystem, and an external OpenCode or a space runs
elsewhere than the server.

A model whose metadata lists no `image` input never receives an image part,
whatever the setting says: an image part to such a model fails the turn. Every
image a send or a launch still carries (a pasted image attached with the
setting off or under a model picked earlier, the annotation screenshot, a
comment-field paste) goes through `sync/model-attachment-paths.ts` and arrives as a
text note naming the file under the same filename (`sync/DOCUMENTATION.md`).
The same send-time conversion saves PDFs and other attachments when the model
lacks their input type. The composer tells the user where the files will go
when the file lands or the model changes. Converting at send keeps the original
attachment in the draft and lets a later model choice accept the bytes directly.
Saving failure stops the send and restores the draft.
Large pastes (about 2,000 characters or 25 lines) follow the composer setting
`largeTextPasteBehavior` (`ask` / `attach` / `inline` / `inline-double-paste`). Attaching creates an
in-memory `text/plain` file named `pasted-context-N.txt`, inserts a bracket
citation, and sends it through the same attachment pipeline as a manually
picked `.txt` file. In `ask`, `ui/LargeTextPasteChoice` floats above the
composer's start edge, styled like the chat text-selection menu. In focus mode
the composer fills the surface, so there is no room above it and the choice
sits just inside the composer's start edge instead. Its actions read live composer/attachment state so
typing or other attaches between paste and choice stay consistent. Short text,
images, and URL wraps keep their existing paths.
In `inline-double-paste`, the first paste uses CodeMirror's native paste path.
Two distinct Ctrl/Cmd+V pastes with identical clipboard text, less than 1000 ms
apart, convert only the first inserted range into a file and citation. The
gesture records CodeMirror's normalized insertion, not the raw clipboard length.
Key repeat, other non-modifier keys, edits, selection movement, blur, draft/mode/setting or
runtime changes, and unmount invalidate it. Menu and touch pastes stay inline.
One candidate expires after 1000 ms; no timer delays insertion. Conversion keeps
the inline text until attachment succeeds and rechecks the live document,
selection and draft scope before replacement. Failed attachments keep the text.
If editing invalidates a conversion already attaching, its accepted file remains
in the source draft but the newer text is never replaced.
On desktop the choice takes focus with "Attach as file" selected: Enter picks
the focused option, arrows and Tab switch, Escape pastes inline, and a printable
key pastes inline and is then typed. Every answer returns focus to the editor.
Focus moving elsewhere in the window pastes inline and leaves focus there;
switching to another window leaves the choice waiting. On mobile the editor
keeps focus (taps do not move it, so the keyboard stays up); a choice restores
editor focus, expanding the collapsed pill if needed. Hosted mobile focuses
inside the tap; Capacitor uses the shell's existing next-frame keyboard timing
when the pill expands. A newer large paste replaces an unanswered choice, and a
draft, mode or runtime change drops it, so it never lands in another draft.
Office documents (docx, pptx, xlsx, odt, odp, ods) that arrive through
`attachFilesWithCitation` (an OS drop, a clipboard file, the attach menu, VS
Code's picker) follow the profile setting `documentAttachBehavior` (`ask` /
`save` / `convert`, default `ask`). The other files of the same batch attach at
once as before. `convert` sends the documents down the ordinary attachment
path, where the store extracts their text (`sync/DOCUMENTATION.md`). On the
desktop a document the store cannot convert (over 10 MB, or unreadable) still
attaches as its path note, and an info toast says the agent gets the path
instead of text: refusing it would leave the agent nothing. `save`
(shown as "Attach as is") attaches each document with `[name]` and holds its
original bytes in the draft (`saveOnSend: 'reference'`), as a share from
another app does; Send or Queue writes it where OpenCode runs and sends its
path note, and Edit of a queued message gets the document back still held.
The desktop holds the bytes too, even for a document with its own path: a
desktop app can run against an OpenCode on another machine, where that path
does not exist. A converted file or image never reuses a name
already in a `[name](path)` link in the draft, so a link's label cannot cite
an unrelated attachment. A document over the 20 MB send limit
(`MAX_ATTACHMENT_BYTES`) is refused by name before anything is read. No model
check applies: the path note replaces the extraction for every model. A draft
that changed while a document was read drops it, like any attachment read.
`ask` posts one choice for the batch's documents in the large-paste
slot (`kind: 'documents'`) with "Attach as is" first. The choice keeps its two
actions: `attach` keeps the content whole (Attach as is) and `inline` is the
fallback (Convert to text). Keys, focus, blur and the draft, mode and runtime
scope are the large paste's, with Convert as the fallback where a large paste
pastes inline. While a choice of either kind is unanswered, Send and Queue do
nothing and the draft stays: on touch the choice never takes focus, so a tap
on Send would otherwise go out without the documents or the pasted text.
A choice for files picked from a phone's collapsed pill expands the composer,
where the choice shows, and holds the mobile shell expanded until it is
answered, so a tap outside the editor cannot hide it behind the pill. A path-only drop (a Files panel row, a VS Code
explorer URI) still becomes an `@` mention and never reaches the setting.

### Why saved images and documents are written at Send and not when they land

The user may remove a pasted image or a document before sending, switch the
draft to another server, or never send at all. A write at attach time left a
copy on whichever machine was open then, and a link in the text that pointed
at it. Holding the bytes in the draft and writing at Send or Queue writes only
what is sent, on the runtime the send starts on, once (the maintainer's rule:
nothing is uploaded before Send). The path then reaches the model as a path
note attachment instead of a link typed into the text, because the path is not
known until Send.

### Why office documents ask in the large-paste slot and not a choice of their own

The maintainer asked for the document choice to look and behave exactly like
the large-paste one. Sharing the offer state gives it the same component,
keyboard, focus and scope guards with no second copy, and keeps one choice
above the composer at a time: a newer offer of either kind replaces an
unanswered one, whose files are dropped as an unanswered large paste is.

### Why the choice counts as a floating layer for the window-focus refocus

Files picked through a dialog (VS Code's open dialog, a native file chooser)
arrive after the window gets its focus back, so the document choice mounts
just as `useKeyboardShortcuts` runs the window-focus refocus. Without the
choice on `inputRedirect`'s floating-layer list, that refocus moved focus to
the editor two frames later, and the choice took the move for an answer and
converted the files. Listing it keeps the answer with the user; a click or
focus moved elsewhere still answers Convert, as for a large paste.

## The prompt language

`language/` is the single source of truth for composer syntax. Everything that
needs to know what a token means — highlighting, send-time resolution, and the
autocomplete triggers — goes through it.

**This is the invariant that matters most in this module.** Before it existed,
the `@` rule was written four times with divergent cleanup and the `/` rule
three times with different valid character sets, so a token could be painted as
a reference and then not resolve as one. Adding a construct meant finding every
copy.

- `mentions.ts` — `@` references. The `start..end` span is the reference
  itself and is what gets highlighted; in `see @a/b.ts,` the comma is sentence
  punctuation, not part of the file being referenced. A `@` token with a dot
  or a slash is only a candidate: it draws as a file once something confirms
  it (*Why a file chip needs confirming*). A send treats a candidate as a file
  either way and drops the ones that do not exist.
- `prefixTokens.ts` — `/command`, `$skill`, `#snippet`. Scanning is deliberately
  generous; **membership in the command, skill or snippet registry is the
  authority**, not the pattern. An unknown `/token` or `$token` stays plain
  prose, so `$5` is just money. The skill sigil also matches the yen and
  full-width dollar signs a CJK IME types for the Shift+4 key, so `¥5` is
  money for the same reason.
- `triggers.ts` — which picker a caret position asks for. Exactly one can be
  active, with precedence `command > skill > snippet > mention > emoji`. Commands open
  only on a `/` in the first column; skills open on `$` or its IME spellings at
  any word boundary, the start of the text included. The two never share a list: the `/` palette
  holds commands only. Emoji open on a typed `:` plus two letters of a name
  after whitespace (`matchEmojiTrigger` in `lib/emoji/shortcodes.ts`), never on
  a paste, so `12:30`, `http://` and `:)` stay text; choosing one writes the
   emoji itself, so the agent gets the character, not a shortcode. Before
   selection, a space ends an `@` query except while the whole query still
   matches a session title (`mentionContinuesPastSpace`, `hasSessionMention`);
   the picker then lists sessions alone and closes on the first word no title
   holds, so `@release notes are done` turns back into prose. An exact agent
   name in `@coder review` leaves that session query unfinished. This does not
   enable file or directory searches containing spaces. Only typing and pasting open a picker: text the app sets
   through the editor's `value` prop (a restored draft, a git conflict prompt)
   arrives with `ComposerChange.fromValueProp` and closes any open picker.
- `tokenize.ts` — one pass producing every highlight range. Adding a construct
   to the language means adding it here, once.

### Why completion follows selection and not chip rendering

Enter, clicking, tapping and the existing Tab route all use the shared mention
selection handler. Agent, file and directory selection replaces the query and
places the caret in one editor transaction. Its change callback records that
occurrence as completed before resolving another trigger; later prose cannot
reopen it even when a session title matches. A session selection keeps writing
its existing link over the query.

`state/mentionCompletion.ts` owns these transient occurrence ranges for the
mounted composer. `ComposerChange.changes` maps them through edits before the
reference. Editing the reference or its trailing boundary invalidates its range;
deleting it removes the range. A fresh `@` has its own offset and can query
normally. External value replacement and draft identity changes clear the state.
It is independent of persisted confirmed file paths, so selected paths containing
spaces remain intact references without changing draft or send formats.

Known names and chip appearance cannot establish completion: an unfinished
multiword session query can already contain an agent chip. Only the explicit
selection transaction records a completed occurrence. The shared flow applies
to web, Electron, VS Code, hosted mobile and Capacitor; VS Code continues to omit
session suggestions. Selection key routing and IME guards stay with their
existing owners.

### Why a file chip needs confirming

The shape of a token cannot tell `@README.md` from `@john.doe`, or `@src/app`
from `@types/node`. `NOT_A_PATH` drops what is plainly no path (calls, URLs,
versions), and everything else with a dot or a slash stays a candidate. A file
chip needs an entry in `confirmedMentions`: the picker, a drop and a restored
draft write one at once, and `useFileMentionCheck` writes one when a candidate
is found on disk. A typed or pasted mention therefore stays text for a moment.
A check that cannot run confirms the name, because a send keeps it too.

A send still resolves candidates, so pressing Enter before the check answers
attaches the same files.

`confirmedMentions` is read through a getter in the language context.
`useComposerDraft` puts a new set in the ref on every draft switch, without a
new context object.

### Why a dismissal lives in the confirmed set

A double click on a file or agent chip writes a dismissal for that name, so
every occurrence in the draft stays text and a send neither attaches it nor
routes to the agent. A name would chip again the moment its text was left
alone, so the dismissal has to be remembered. It is an entry with a NUL prefix
in `confirmedMentions` because that set is already saved, restored, cleared on
send and carried across a failed send; a second set would repeat each of those
paths. Choosing the name in the picker confirms it again. Dismissals stay out
of a published draft (`useSessionDraftPublishing`), which keeps only names
found in the text.

## The editor

`editor/bidi.ts` gives each rendered logical line the direction most of its
words run (`proseTextDirection` in `lib/i18n/textDirection.ts`, the count chat
prose uses), so a Latin-first Arabic line runs right to left beside an English
one; a line without letters gets `dir="auto"`. It enables CodeMirror's
`perLineTextDirection`, so browser layout and cursor movement use the same
direction. The content root stays LTR; automatic
direction there would depend on which lines virtualization has mounted.
Only visible lines get decorations, rebuilt on document or viewport changes.

`composerLanguage.ts` reuses the tokenizer's technical ranges to isolate code,
paths and references as LTR. The same merged ranges feed `outerDecorations`
and `bidiIsolatedRanges`: syntax colors cannot split a technical fragment, and
CodeMirror knows the boundaries the browser draws. Shell mode isolates the
whole input. Direction handling never inserts Unicode controls or changes the
source string. Browser checks must cover punctuation, cursor movement across
isolates, wrapped RTL lines and navigation through a virtualized document;
DOM-only tests cannot verify these.

`editor/` wraps CodeMirror. The document is a plain string: `getValue()` is
exactly what gets sent, so nothing downstream serializes a rich document model
back into a prompt.

### Why word gestures share a script-aware boundary

CodeMirror groups adjacent alphabetic characters into one word, so it treats
`检查openchamber的配置` as a single run. The composer keeps CodeMirror's
grouping and whitespace transitions and adds one stop: a word run never crosses
between Han and Latin (`editor/wordBoundaries.ts`). Digits, underscores, kana and
every other script are neutral and stay with the run around them, so `設定を確認`
or `إصدار٢` group exactly as CodeMirror groups them. Neutral characters between
Han and Latin go with the run on their left (`API2|中`, `中2|API`), so gestures
from either direction stop at the same offset. A double-click drag compares the
hit side as well as the offset, because one offset at that boundary is the edge
of two words. A broader per-script split
was rejected because it changed grouping in text with no Han/Latin boundary.
Double-click selection, word movement and selection extension, and word
deletion use the same rule.
Single and triple clicks still use CodeMirror's selection rules.
Chat and comment composers opt in when creating their editor. The source
control preview reuses the editor for Markdown with CodeMirror's word rules.

Word shortcuts use Ctrl, or Alt on macOS, plus CodeMirror's macOS Ctrl+Alt+H
word delete. Left and right follow
`textDirectionAt` to preserve visual direction. Word deletion keeps a single
adjacent space with the word, joins lines only from the line edge, and deletes
atomic chips whole.

Attachment citations (`[name.png]`) and finished skill tokens (`$name` followed
by whitespace) render in the editor as atomic replace widgets shaped like the
sent message's chips (`composerLanguage.ts`). The document keeps the source
text, so sending, copying and undo are unchanged; the caret steps over a chip
and one Backspace removes it. File and agent mentions, skills and snippets
chip the same way; a token whose last character was just typed stays text
until typing moves on, so a name is never chipped halfway. A double click on a
file or agent chip gives its text back with the caret at the end. Commands keep
their color only.

The `#` snippet picker (`chat/SnippetAutocomplete.tsx`) also creates
snippets. A typed name no snippet answers to offers "Create #name" and, in the
main composer, "Save draft as #name" with the draft minus the token being
typed; once saved, that token leaves the draft. Every create row opens the
quick dialog (`components/snippets/SnippetQuickCreateDialog.tsx`, mounted once
per app shell) and never writes on its own, so Enter on `fix #42` cannot make
a snippet. The same dialog backs "Save as snippet" on a user message.

Desktop comment fields in ordinary page DOM (chat quote comments, editing a
pending comment above the composer) are `components/comments/CommentTextEditor`:
this editor with comment keys (Enter submits, Escape cancels, both after an IME
composition), the `#` snippet picker and image paste, where a pasted image's
citation is a chip at once through `pendingAttachmentFilenames`.

A source-control item's own text is written in this editor too, through
`components/references/ReferenceMarkdownEditor`: no agent, file, slash or
snippet token resolves (they are the host's users and paths, not this
workspace's), no image paste, Enter breaks the line and Mod+Enter saves.

Diff, file editor and file preview line comments (`InlineCommentInput`) stay a
textarea with the same keys, snippet picker and image paste, and show the
citation as text until the comment is attached. Those fields live inside other
editors' DOM, an annotation slot in the diff viewer's shadow tree and a block
widget of the file editor, where this editor lost its caret and jumped to the
start of the line while typing.

The composer disables CodeMirror EditContext through `ComposerEditorView`:
on Android Chrome with Gboard (Thai input, #3514) the EditContext path moved
the caret into the middle of the draft and reinserted fragments. Generic
editors (Files, Plan, Skills) keep the base `EditorView` and its EditContext.

On iOS, a keyboard that cleans up dictation (WeChat, #5746) deletes its first
transcript and writes the cleaned text in batches: it inserts a paragraph `DIV`
and keeps writing into that same `DIV`. Stock `@codemirror/view` reads the
paragraph at once and replaces the `DIV` with its own line, so everything the
keyboard writes after the first paragraph break lands in a detached node and
never reaches the draft. A temporary Bun patch
(`bun-patches/@codemirror%2Fview@6.43.15.patch`) reads such a paragraph one
frame later, with the rest of its batch, and reads it early instead of dropping
it when the editor updates, takes focus or reads its layout within that
frame. It applies to every CodeMirror view on iOS, not only the composer. When
bumping `@codemirror/view`,
carry the patch over and rerun `editor/__tests__/iosNativeParagraph.test.ts`;
remove it once a CodeMirror release fixes this. The upstream report is
https://code.haverbeke.berlin/codemirror/dev/issues/1780; CodeMirror's GitHub
repositories are an archived mirror.

### Why patch CodeMirror and not work around it in the composer

The paragraph is replaced inside CodeMirror's DOM observer before any
transaction exists, and any view update in the waiting frame discards the
observer's unread records. Neither step is reachable through the public API:
two app-side attempts in #5739 (keeping the latest default transaction, then
deferring through `beforeinput` and `inputHandler`) each lost text in their own
checks, because CodeMirror's measure cycle and update path reset the DOM under
them. The patch is the smallest change at the place the text is lost, and it
goes away when CodeMirror ships the fix.

The document is not, however, the string it was given: CodeMirror normalizes
line endings, so a `\r\n` pair becomes one break and the document ends up
shorter than the inserted string. **Never derive a caret position from the
length of text you are inserting** — a caret past the end makes `dispatch`
throw, the transaction never applies, and the un-normalized text stays in React
state to crash again on the next restore. Every edit that moves the caret goes
through `replaceWithCaret` (`editor/documentEdits.ts`), which measures the
change instead of the string.

The composer previously painted a transparent `<textarea>` over a mirror
`<div>`. That restricted highlighting to styles which do not change glyph
advance width — colour, background, underline — because anything else made the
mirror drift out from under the caret. Bold and italic were impossible, and the
overlay was disabled outright on mobile, where wrapped text drifted anyway.
**Those constraints are gone**; adding a width-affecting style is now a
question of design, not of feasibility.

Selection rendering: every device runs CodeMirror's `drawSelection()` — it
keeps typing on the drawn-selection code path, and removing it makes
CodeMirror enforce cursor association on the native selection, which iOS
answers with severe input lag. **That much is not platform-specific and must
not be undone.** What differs is who paints the selection, and
`composerSelectionExtension` (`editor/theme.ts`) picks that per platform.

The drawn caret blinks from a 600 ms timer (`timerCaretBlink`,
`lib/codemirror/caretBlink.ts`). CodeMirror's own blink is an infinite CSS
animation that kept the compositor ticking every frame for as long as the
composer had focus: 4.1% of a core against 1.3% on the animation fixture.

When CodeMirror 6.43.9's iOS predicate does not match,
`composerNativeSelectionExtension` layers over `drawSelection()`: it re-shows
the native selection, and — only while a range is selected — the native caret,
hiding the painted layers those replace. The native selection is the one that
shows for two reasons: the painted layer sits behind the content, so tokens
with their own background (inline code, fences) cover it completely; and the
platform's selection drag handles attach to the visible native selection and
take their colour from the caret, so a transparent caret means invisible
handles. The range-only caret scoping is load-bearing — a native caret visible
while typing makes the browser re-render its caret UI after every keystroke,
felt as severe input lag.

When CodeMirror 6.43.9's exact iOS predicate matches,
`composerIOSSelectionExtension` leaves selection-handle geometry and appearance
to CodeMirror. CodeMirror puts the handles in `.cm-selectionLayer`, normally at
`z-index: -1`; the extension raises that layer above the content so opaque
token backgrounds cannot cover them, and leaves it transparent to touch.
The handle dots extend 8px past their range; matching scroller padding and
negative margin expand the clip area without moving the text or changing the
composer height. iOS still paints its taller system selection overlay even
when CSS makes `::selection` transparent. The extension therefore suppresses
CodeMirror's synthetic selection rectangles on iOS while leaving its handles,
cursor path and `nativeSelectionHidden` facet active. Otherwise the grey system
highlight and themed rectangle overlap with visibly different heights.
Do not add a second custom layer or custom handles here: overlapping translucent
rectangles make selection darker at their seams and imitated handles drift from
the geometry WebKit actually manipulates. What iOS avoids is installing the
native-selection workaround above: explicitly restoring native paint and caret
makes WebKit re-measure them after every decoration redraw, and the composer
rebuilds every decoration on every keystroke. That cost is felt worst during
IME composition.

The non-iOS native selection uses `--interactive-selection` directly, including
its authored alpha, with `--interactive-selection-foreground` for selected text.
Do not dilute it again or substitute the primary action color. Both composer
caret paths follow the elevated field foreground; the file editor/terminal cursor
color may belong to a different background. The iOS system overlay owns its visible selection fill.

The content element keeps the existing correction policy: on in the mobile UI,
off elsewhere. CodeMirror also reads the attribute and reverts Apple and
Android's insert-period-on-double-space only when its value is exactly `off`.
`editor/autocorrect.ts` uses the HTML standard's
[ASCII case-insensitive `autocorrect` keywords](https://html.spec.whatwg.org/multipage/interaction.html#attr-autocorrect)
to keep desktop word correction off while avoiding that CodeMirror-only
revert. Its platform checks deliberately match CodeMirror's own browser flags.

`composerLanguage.ts` retokenizes the whole document on every change. The
composer holds a prompt, not a source file: it is short enough that a full pass
is cheaper and far simpler than incremental mapping, and it keeps the editor
and the send path reading the same grammar.

### Why reference summaries shrink inside the editor

The content flex item has a zero minimum width, so a long message-link summary
cannot set the wrapping width of every line in the draft. Session-link widgets
cap their width at the available line width minus the shared chip's 2px inline
margins; the label's existing ellipsis then handles long summaries. This is local
to the composer and leaves the source string and sent-message chips unchanged.

### Why the hint is a `::before` and not `placeholder()`

The empty composer's hint is a `::before` on its first line, drawn by
`editor/theme.ts` from the `cm-composer-empty` class and the
`--composer-placeholder` property that `ComposerEditor` puts on the content
element. CodeMirror's `placeholder()` widget sat at the caret of an empty
document and broke the text probe that iOS smart-spacing keyboards run before
committing, so nothing typed arrived (#5093). A pseudo-element is not in the
DOM, so that probe sees an empty line.

### Why the hint's generated text has empty alternative text

Chromium on Android counts text a pseudo-element paints inside an editable as
the field's own text. Without alternative text, the empty composer reported
"Plan, build, or ask" with the caret after it to accessibility services, and
dictation apps that read the field inserted their text as a continuation of the
hint (#7096). `content: var(--composer-placeholder) / ""` keeps the hint on
screen and gives it empty accessible text. The DOM is unchanged, so the
keyboard text probe from #5093 still sees an empty line.

The rule sits behind `@supports (content: "" / "")` for browsers without
alternative text in `content`, Safari before 17.4 among them. A value with
`var()` always passes parsing, so such a browser keeps the declaration and only
finds it invalid after substituting the variable. `content` then falls back to
`normal`, the earlier rule does not step in, and the hint disappears.

The guarded rule lives in its own spec merged after
`COMPOSER_EDITOR_THEME_SPEC`, so it is emitted later than the rule it
overrides. Its selector has no `&`, because inside an @-block style-mod expands
`&` against the @-rule and the rule never reaches the page.

## Ordering rules worth knowing

### Why mention deduplication requires a full path

Send and queue skip mention conversion and extraction only when the composer's
attachments contain the same normalized full path. Restored `file://` URLs use
the shared dropped-path decoder. VS Code selections never suppress a whole-file
mention: their source path identifies only the selected excerpt. Path case is preserved because the remote
filesystem may be case-sensitive. Filenames alone cannot establish identity,
so data URLs without a retained source path and files in different worktrees
remain separate. Queue projections never suppress composer mentions because a
command can leave the queue untouched and delivery can take only part of it.

- `editor/ComposerEditor.tsx` forwards a click on the composer's padding by
  focusing the view *before* setting the selection: CodeMirror reveals its
  drawn caret through a class it only writes while applying an update, so the
  selection has to be the update that follows the focus.
- `submit/buildOutgoingMessage.ts` flattens queued messages, the composer text,
  context drafts and linked references into OpenCode's one-primary-plus-parts
  shape. Every text the user typed, the queued messages oldest first and then
  the composer text, joins the primary text with a blank line between them,
  and their files join the primary attachments: OpenCode 2.x delivers each
  additional part as a synthetic message the timeline does not show, so a
  typed message sent as a part would reach the model and vanish from the chat
  (#4746). **Every attached context
  item (inline comments, terminal selections, browser annotations, PR context,
  each linked issue, PR or guest item) becomes its own synthetic text part carrying structured
  metadata** built by `lib/messages/contextParts.ts`; the timeline reads that
  metadata back to render context blocks. An attached item is context only:
  no instructions guess what the user wants from it (the PR review
  instructions were removed); a queued message captured before that still
  delivers its `instructions` part first. A flow outside the composer hands
  references to a named session or draft through `pendingComposerReferences.ts`
  (New Worktree and the source board do); `ChatInput` consumes only the entries
  addressed to the draft it shows, and keeps the chips per draft in
  `linkedReferenceDrafts.ts` keyed by `chatDraftIdentity`. One `ChatInput` stays
  mounted across a session switch, so component-level chips followed the next
  session and were linked there (#5706); a draft's chips must outlive the
  composer showing another draft. A pinned column and an expanded `/btw` panel
  take no handoff: neither is the main draft, and a chip written there would be
   stranded. The entry waits for the main composer. Picker confirmation captures
   its draft identity before loading context. New Worktree likewise captures its
   opened draft before the read; an unnamed draft never takes a handoff.
   Draft handoffs use the runtime and stable `workDraftId`, so reopening a saved
   draft can receive context that finished loading after navigation away.
   A failed first send that created its session moves the draft's chips into
   that session for retry, merging chips attached while the request ran.
   Guest attaches are rejected in expanded `/btw`, and pending guest items wait
   for the normal composer before being consumed. A draft's first send with a
  tracker item attached posts that tracker's session-started
  status (`lib/trackers/sessionStatus.ts`), for a tracker whose descriptor
  offers `sessionComments`. Tracker chips are `tracker-item` references keyed
  `${provider}:${IDENTIFIER}`; a queued or restored message from before
  trackers carries `linear-issue`, which reads back as Linear's.
  The same module's `buildComposerContext` captures that context when a message
  is **queued** instead of sent: the chips leave the composer with the message
  (as `QueuedContextPart`s on the queue item), the server or the VS Code
  auto-send delivers them through `queuedContextToParts`, and editing the
  queued message puts them back. A queued message is placed as captured — its
  mention, file mentions, and skill names were resolved when it was
  queued, never at delivery — and its context follows it before the next
  queued message.
- **Skills named with `$name` are attached to the prompt, not hinted at.**
  `buildOutgoingMessage` reports the composer text's skill names (deduped, in
  order) as `skillNames`; `ChatInput` hands them to the send as
  `SkillMentions`, and `opencodeClient.sendMessage` maps each name to its
  OpenCode skill id (`GET /api/skill`; the id is the skill's folder and can
  differ from its frontmatter name) and sends them in the prompt's `skills`
  field. It reads `GET /api/model/default` first: OpenCode's skill list does
  not wait for a location's plugins and answers `[]` while a fresh location
  (a new worktree, the first send after a restart) is still booting, which
  silently turned the skill into the instruction, while the default-model read
  waits for activation (up to OpenCode's 5 s; past that the send goes on as
  before). OpenCode then loads each skill's content into that user message. It
  rides the prompt's delivery, so a new-session draft (after the session is
  created), a steer while the agent works and a `/btw` fork all activate the
  skill with their own message, never mid-turn. The separate
  `session.skill` route is deliberately not used: it appends a skill message
  immediately, outside the inbox, so while a turn runs it would land inside
  that turn ahead of the message that asked for it. The skill message it
  creates is hidden in the timeline anyway (`timelineRoles.ts`).
  Fallback to the old hidden instruction ("The user explicitly mentioned
  these skills…") is per skill and never blocks the send: a name OpenCode
  does not list, a failed skill list, or a prompt rejected with
  `Skill not found` (resent once with the same message id, since preparation
  fails before admission). A queued message carries the skill names captured
  at queue time (`QueuedMessage.skills`), and every delivery attaches them the
  same way: a manual send through `buildOutgoingMessage`, the VS Code
  auto-send through `sendMessage`, and the server queue by its own lookup
  (`packages/web/server/lib/message-queue/DOCUMENTATION.md`). An instruction
  alone is not enough: OpenCode keeps a skill with `disable-model-invocation`
  out of the model's skill list, so the model answers that the skill does not
  exist. A message queued by an older build still delivers its captured
  instruction. A `$skill` in a message that routes to
  `session.command` (a leading `/command`) keeps the instruction too: that
  route takes no skill attachments. A hand-typed leading `/name` that matches
  a skill and no command still attaches the skill (`session-ui-store`), so the
  old form keeps working; the composer just no longer offers or chips it.
- Extension rows in the `@` menu (`lib/guests/mentions.ts`) join the list when they arrive and never hold the files back. Picking one removes the `@` text and reads the row's content; the result lands as a chip through `useInputStore.setPendingGuestIssue`, and a failed read is a toast and no chip.
- Extension slash commands are routed first (`submit/guestCommands.ts`,
  entries from `useGuestCommands` minus every name the composer already
  knows, so an extension can never shadow a built-in or an OpenCode command;
  skills live under `$` and cannot collide). The command text is cleared and `runGuestCommand`
  (`lib/guests/run-command.ts`) asks the extension: the rail pane if it is
  mounted, otherwise a hidden headless `PluginPane` that `GuestHosts` mounts
  for the call. A returned chip lands through
  `useInputStore.setPendingGuestIssue`, the same slot a panel's `attach` uses;
  `null` is an info toast; an error or 20s of silence restores the text and
  shows an error toast. Queueing runs it instead of queueing, like a local
  command. `CommandAutocomplete` lists the same entries with the extension's
  name as their badge, and the language highlights them as known `/tokens`.
- Local slash commands are planned by `submit/slashCommands.ts` before any
  attached context is consumed. Commands that act on session or UI state
  (`/undo`, `/redo`, `/compact`, `/timeline`, `/handoff-review`, `/fork`) take
  only their command text and leave comments, files, and linked context attached;
   magic prompt commands send that
  context with the prompt they produce. Their text comes from one read of
  the Magic Prompts that apply in the directory the send lands in, chosen
  when the send starts: the `/btw` fork, the session, else the new-session
  draft; a new chat has no folder yet and reads the global prompts. A failed
  read sends nothing and restores the input. Session actions are planned only when
  a session exists, so typing one into a new-session draft stays on the normal
  send path. A local command is never queued as text: queueing runs it
  instead. `/fork [text]` (`submit/forkCommand.ts`) forks after the last
  finished turn (a running turn and its completed steps are skipped and left
  running), opens the fork, and sends the text there; a failed fork restores
  the command, a failed send puts the text into the fork's composer. `/compact`
  switches the session to its main-chat model and reasoning effort selection
  first when either differs from the session record, then compacts; a failed
  switch compacts nothing and restores the command. An open BTW keeps its own
  model and effort separate: `/compact` still uses the main session's selection.
  An Auto pick leaves the
  session as it is, because compaction carries no prompt for the router to
  resolve from. A failed prompt command restores everything it consumed: text,
  confirmed mentions, files, comment drafts, and pending synthetic context.
- `state/useComposerDraft.ts` — a draft belongs to a (runtime, directory,
  session) identity. Writes are debounced while typing but forced at every edge
  where the page may stop running, because a pending timer is not a saved
  draft. Two orderings are load-bearing: the debounced write is skipped once
  while a draft is being restored, and a deleted draft's empty signature is
  recorded before a queued write could resurrect it.
  When the open new-session draft changes its project or worktree, its
  identity changes while `newSessionDraft.draftId` stays the same
  (`ChatInput` passes the id). A session moved to another directory (the
  sidebar's move actions, an agent's `session_move`) keeps its session id
  while its directory changes. Either switch moves the draft: its attached
   files, linked reference chips and non-empty text go to the new directory, the old directory's text
  is cleared, and confirmed mentions are dropped because they name the old
  directory's files. A draft already saved for the new directory stays above
  the moved text, and the moved text is not selected as a restored draft.
  Opening another new-session draft gets a new id, so a feature that opens
  one elsewhere with its own prompt leaves the typed draft where it was.
  Fork replay text and files arrive in `input-store.pendingComposerRestore`,
  addressed to the fork's runtime, directory, and session. The hook consumes
  them after loading that identity's draft. Selection alone is not enough:
  the deferred chat column can still show the source composer. Ordinary
  pending text insertions go through `state/usePendingComposerText.ts`.
  Column-addressed insertions go to its visible composer, including an expanded
  BTW. A revert is session-addressed and waits until that session owns the
  composer, even in a pinned column with an expanded BTW. Its text waits in a
  separate session-keyed mailbox so later quotes and plugin insertions leave
  it intact. On return, the restore is applied before any column insertion.
  A `btw-pending:` identity holds text only in the hook's memory while the
  fork is being created. Collapse and navigation save that text in memory;
  failure recovery restores it there without writing the placeholder to storage.
  Successful creation moves the text to the real fork and empties the pending
  slot. Explicit discard clears it through the draft-deletion notification, so
  the next BTW for the same parent starts empty. Persisted placeholder drafts
  from older builds are ignored.
  The hook also selects the attachment draft before paint. `input-store.ts`
  owns its in-memory files and scoped send recovery, documented in
  `packages/ui/src/sync/DOCUMENTATION.md`.
- `state/useDictationOrigin.ts` — a dictation belongs to the draft that was on
  screen when recording started. The transcript arrives later, after the user
  may have switched sessions in the one mounted composer. `ChatInput` records
  the origin from `ComposerDictation`'s `onStart`, and a transcript whose
  origin is no longer the rendered draft is appended to the origin's draft
  through `restoreDraft`. It is not inserted or sent in the visible session,
  including for **Insert and send**, and a toast says where it went. The origin
  is the rendered draft, not the live store selection, so a draft the store has
  just opened must render in the same commit
  (`useShownSessionSelection`, see `sync/DOCUMENTATION.md`, "Session switch
  commit"): a deferred draft recorded the session still on screen (#6927).
  The transcript stays in the visible composer when its draft identity matches
  the origin, or when the composer still shows the new-session draft (same
  draft id, same runtime) where recording started. A new-session draft's
  identity includes its directory, so its identity alone makes a project or
  Chat/Project switch of the same draft look like another composer (#7529).
  Existing sessions and BTW match by identity only. Identity also counts for
  drafts on its own because two Chat drafts share one slot. While the dictation
  is pending, `useComposerDraft` reports the move that carries the draft's text
  and the origin follows it, so opening another session after a move keeps the
  transcript with the moved draft.
  **Insert** adds the text to that composer. **Insert and send** captures the
  identity on screen at confirmation: a draft moved before confirming sends to
  the new project, and a draft moved between confirmation and the transcript
  keeps the text unsent, because the user never confirmed sending it there. A
  draft moved away and back in that time counts as moved. Opening another
  session and returning does not, since the draft itself stayed put. The check
  compares the origin record: each carried move replaces it, so it is read
  before the transcript clears the origin.
  The hook closes over the rendered identity: `useDictation` and
  `ComposerDictation` keep their handlers in refs written after commit, so a
  render that suspends or is deferred cannot change the target. VS Code has no
  dictation (see `components/dictation/DOCUMENTATION.md`).
  The dictation shortcut starts in the focused composer's form, falling back
  to the main chat when no form has focus. Mobile mic triggers explicitly
  address their own form. One mounted dictation engine owns capture and
  keyboard confirmation per window; repeated shortcuts and Enter confirm
  that recording even if focus moves to the other chat. Idle and unmount
  release ownership. A mic in another composer cannot start a second capture
  or confirm the owner's recording.
- `state/useDraftTarget.ts` — the draft can target a directory that does not
  exist yet (a worktree being created). It must survive not appearing in the
  branch list, or the selector snaps back to the project root mid-creation. A
  draft opened on a given directory (Mini Chat, a worktree or space row) pins
  it with `preserveDirectoryOverride`: the app does not move the draft until
  the directory shows up as a known branch. The pin stops only the app. A pick
  in the project or worktree picker always applies and clears it, because a
  project without git never lists a branch and its pin never clears by itself.
  Re-picking what a pinned draft already shows changes nothing, so one click
  cannot drop an unlisted space or worktree directory. The project's isolated
  spaces are listed in a section of their own by name (`spaceBranchOptions`),
  and a space's directory keeps its pin: picked from the list it is pinned at
  once, and being listed never clears it, because it exists inside the space
  only and the host's directory probe at send would call it missing and start
  the chat in the project. The session store backs this up: a draft opened in
  a space's directory starts pinned, and the probe never runs for one. Only a worktree still being created (`pendingWorktreeRequestId`,
  `bootstrapPendingDirectory`) keeps both pickers inert. The hook also owns the
  advisory dirty state for the selected directory, clearing it as soon as the
  target changes so a warning never names a previous branch. It re-reads the
  project's branch list and worktree topology when the window regains focus or
  becomes visible and when the branch picker opens, throttled to one read every
  two seconds. The branch list's 30-second window has no timer of its own, so
  without these triggers a branch changed outside the app stayed on screen
  until the project changed.
- `ui/DraftTargetSelectors.tsx` owns the controlled project/worktree picker
  state and registers its application shortcuts locally. The desktop project
  picker is a searchable popup: it ranks the current projects with
  `rankByQuery` over display label and path, keeps the query and the active
  result as transient local state that resets on every close, and commits
  through the existing project-change flow only on explicit activation.
  Filtering changes the result area beyond the anchored input without moving
  the search field. When less than 240px is left under the trigger and more
  is above it, as in Mini Chat where the picker sits near the window's bottom,
  the popup opens upward with the search field at its bottom, next to the
  trigger, and the results above it. The side is chosen once per open
  (`usePopupSideOnOpen`, `components/ui/popup-side.ts`) and never flips while
  open. The worktree picker remains a Select and follows the same rule, with
  its items in the same order either way; mobile keeps its bottom sheets.
  Both end with the two ways to make a worktree: **Quick worktree**
  (`createWorktreeDraft`, auto-named, at once) and **New worktree…**, which
  opens `NewWorktreeDialog` for the draft's own project. `ChatInput` hosts
  that dialog, like the isolated-space one, because Timeline has no project
  headers to open it from; a plain worktree pins the draft to the new
  directory, one made for an issue or PR opens its session. `ProjectPickerSheet` shares the mobile project list and
  transient search state with the Settings selector. Settings passes its own
  directory selection callback, so choosing a project there leaves chat in
  place. Both callers use the same ranked label/path search and project icons.
  The selectors only consume their shared prefix while the
  draft target UI is mounted.
  Keyboard selection returns focus to the current form's composer, including
  when the selected value is unchanged.
- `input/createComposerKeyHandler.ts` maps Ctrl+N/P to the active command, skill, snippet, or
  mention picker after its IME guard.

## Autocomplete rows

A command, skill or `@` agent row reads as its name, then its description,
muted on one line and cut where it runs out of room, then at the end edge the
item's scope (`ui/AutocompleteRowParts.tsx`). The scope is the one badge a row
carries: `user`, `project`, `opencode` (OpenCode's own commands),
`openchamber` (OpenChamber's), or an extension's name. Nothing pops up on
hover or selection: a tooltip over the list covered the transcript, and an
info mark on every row read as noise. `ui/useAutocompleteSelectionScroll.ts`
keeps the keyboard's selection in view.

`../AutocompleteRows.test.tsx` mounts the command and skill pickers and covers
the row's parts, the absent popup on selection, and the list height below.

### Why a list placed at the caret skips the phone's height clamp

`useMobileAutocompleteMaxHeight` measures from the list's bottom edge, which
holds still only while the list hangs above its anchor. The caret placement
(`useAutocompletePosition`) already sizes the list against the same chat-area
and keyboard limits, and a list it puts below the line, as it does once the
phone's keyboard pushes the composer up, grows downward: every clamp moved the
edge the next clamp measured, and the chat crashed with "Maximum update depth
exceeded" (#5687). So each picker clamps only while its style carries no
max-height: on the first frame before the placement is measured, and for
callers that anchor the list themselves, like the scheduled task editor.

### Why the `@` list holds its last answer while the next query searches

The `@` list asks the server for files on each settled query (after a 180ms
debounce). It used to swap the whole list for a spinner row while a search
ran, so with the height morph the popup shrank and regrew by its full height
on every keystroke, and showed "no matches" for agents before the file search
had even started. Now the rows the user sees always come from one settled
query: from the keystroke until its search answers, the list keeps the last
settled rows, agents included, and fades them only if the wait passes 150ms.
The box therefore moves once per answer, by what the answer changed. The
spinner row shows only when there are no rows yet, and "no matches" only
once the current query's search has answered; the two rows share one height.
Server hits carry the key of the search they answer (`mentionSearchKey`), so
an older query's hits never show as the current one's. Enter picks the row on
screen, held or not; a new query's answer selects its first row.

A query has up to two answers. OpenCode's index answers at once and its hits
show as soon as there are any; the search behind the hidden and gitignored
toggles may walk the project for seconds, and the list does not wait for it, or
a large project shows only agents until it ends. A newer query or a closed list
stops that search, and its rows never join. Its extra rows join when it
answers, and new rows for the same query leave the selection on the row it was
on. Only a row pushed out of the list sends the selection back to the first
row. An index answer of nothing keeps the query searching until the second
answer, so "no matches" still means both finished.
`../FileMentionAutocomplete.test.tsx` covers these states.

### Why the `/` list is as wide as the `@` list

At the 420px every other list takes, command descriptions were cut after a
few words (#6160). The `/` list reads the `@` list's width constant
(`MENTION_LIST_WIDTH` in `state/useAutocompletePosition.ts`, with the matching
`max-w` class cap), so the two stay equal if either changes; a narrower
composer still narrows both.

## Effort label color

The effort after the model name (`ModelControls`, `MobileEffortButton` on the
phone) takes a status text color by level through `getEffortTone` in
`../mobileControlsUtils.ts`: grey only for `default`; info for `none`,
`minimal`, `low`, `thinking` and any unknown name; warning for `medium` and
`high`; error for `xhigh` and `max`. The level menu stays uncolored.

### Why the effort label is colored, unlike other composer metadata

Composer metadata is muted unless it shows a state (`openchamber-ui-guidance`,
*Quiet at rest*), and the effort followed that until #6160: a grey label at
every level hid that the next send goes out at `max`. The maintainer chose
status colors by level as the one exception. Colored labels sit at `opacity`
0.75 so they stay quiet beside the model name; plain opacity and the computed
`--status-*-text` colors are used because `color-mix` and Tailwind `/NN`
alpha break on old Android WebViews.

## Other sessions as context

Another session, or one message of it, is mentioned in the text itself: as
its link (`openchamber://session/<id>`, `?message=<id>` for a message, or a
web link to this server), which the composer draws as a chip with the
session's title or the start of the message, like a file mention
(`sessionLinkChips` in the language context, `composerLanguage.ts`). The
model reads the link where the user put it. Beside the text, each mention
goes as its own context part (`sessionReferences.ts`, kinds `session` and
`session-message` in `lib/messages/contextParts.ts`).

- `@` lists sessions by title once the user types (`sessionMentionResults.ts`):
  titles that hold the query, no typo-tolerant guesses, every project, the
  open project's first, at most five, without the session being written in or
  subagent runs. They come after the files, so Enter on `@pack` still picks
  `package.json`. The list is ranked from a snapshot per query, since other
  sessions update all the time. Choosing one writes its link over the typed
  `@query`.
- A pasted session or message link pastes as usual and draws as a chip once
  read. One this server cannot resolve, or a message that cannot be read,
  gets a toast and stays a plain link. A message with no text of its own
  names its session instead.
- A paste that is one `ses_…` id, apart from whitespace around it, lands as
  text and becomes the session's link once read, archived sessions included
  (`pastedSessionIds.ts`). The editor's changes carry its position through the
  read, so later edits survive. An id that was edited, now runs into the text
  around it, or names a session this server cannot read stays text, with no
  toast. Any other bare id, typed or inside longer text, is text.
- The text decides what is sent: each linked session or message once, in the
  order it appears; one deleted from the text is not sent. A link not read yet
  (typed by hand, or still loading) is read at send, so it never goes bare.
- The model reads a session by name and id, with the note that the openchamber
  tool reads its messages: a whole session is too long to send. A message goes
  whole, with no cut, since the tool lists a session's latest messages but
  cannot fetch one by id. Neither says what to do with it.
- In the sent message the links draw as the same chips
  (`message/parts/sessionMentionChips.tsx`, from the message's context parts;
  in Markdown mode through `MarkdownLink`), and open the session, or the
  session at that message, in the app. Mentions are not linked issues: sending
  one records nothing on the session.
- VS Code keeps session links inert (its sessions live on its own OpenCode),
  so it offers neither the `@` sessions nor the chips.

## Linked issues and PRs in the text

A pasted link to an issue, change request or tracker item (`referenceLinks.ts`)
is read the way the picker reads a chosen item (`resolveReferenceLink` in
`components/references/resolveComposerReferences.ts`), through the project the
picker uses, and then draws as a chip where it stands: its number and title.

- The text decides what is sent, as with session links: each linked item once,
  as the same context part the picker sends, and the session records it as a
  linked issue. An item the picker chose keeps the picker's version, so its
  diff choice stands. A link deleted from the text is not sent. The model reads the link where the user
  put it. A send waits for a paste still being read, so a quick Enter never
  sends the link bare; a second Enter meanwhile does nothing.
- Only a paste that lands in the text reads a link, afresh each time, as the
  picker does; a large paste that goes as a file reads none. A link
  typed by hand stays text: typing passes through `/issues/1` on the way to
  `/issues/12`, and a read per keystroke would attach the wrong item. This
  holds for an extension's review-portal address too (`urls.resolve`): only a
  paste asks the extension to convert it, and only a change request comes
  back as a chip, which opens that change request rather than the portal
  address. A pasted link read again that now finds no item, or another one,
  loses its earlier result, including the item a restored queued message
  attached to it (unless another link in the text still names that item); a
  failed read keeps it.
  A link this composer has read before draws as its chip again wherever it reappears
  (typed or restored), with that read.
- An item attached any other way (the issue, PR and tracker pickers, an
  extension's `attach`, a handed-over or restored item, a shared page) is its
  link in the text too: the draft keeps the item (`linkedReferenceDrafts.ts`),
  and its link goes in at the caret when it arrives, or into the saved text of
  a draft no longer on screen (a picker that finished reading after a session
  switch). Picking an item again with its link already there writes nothing.
  A click on the chip opens the item in the Tracker; an extension's item goes
  back to its extension, a shared page opens its card.
- The sent message draws the same chips where the links stand
  (`message/parts/referenceLinkChips.tsx`, from the message's context parts;
  in Markdown mode through `MarkdownLink`, by the link's `href`). A link names
  an item whatever page of it opens (`isSameRepositoryItemLink`, the tracker's
  identifier), so a picker item whose link the user also typed draws there too.
  A change request can also carry optional `sourceLinks` in its existing context
  metadata. These original portal addresses take precedence over template
  matching, so every address draws inline while the MR context stays deduplicated.
  Sending and restoring a queued message preserve this association without
  rewriting the user's text or adding source links to the model's context text.
  History display makes no resolver request; older messages without the field
  keep native-template matching.
  An item drawn inline leaves the message's preview strip; one the text does
  not link (messages sent before items were links in the text), or links only
  inside code, stays there. Both chips open the item in the Tracker
  (`useOpenTrackerItem`), Cmd or Ctrl its page.
- A link on another host than the project's, or one no account can read, stays
  text with the picker's attach-failed toast. A link past the project's fork
  network is read again as a linked item, as the Tracker does. Discussions stay
  text. A change request goes without its diff, the picker's default.
- `/btw` and VS Code read no links, as they take no picker chips.

### Why portal MR links stay with their context

The canonical MR address cannot recover the portal addresses that named it.
An optional source-link list on the existing MR context keeps that association
through send and reload, without another resolver, cache or persisted store.

### Why every item is a chip in the text

Picker chips used to sit above the text, apart from the sentence, while a
pasted link drew in place: two looks and two ways to remove the same item. A
pasted link is part of the sentence ("compare this with that"), and the
maintainer chose that one form for everything attached from outside: an item
is its link's chip where the caret was, and the text decides what goes. A
shared page is a chip like the rest; its PIN and status live in the card the
chip opens, so it needs no row of its own above the input.

### Why the files are a pool the text cites

Detaching a file the moment its chip leaves the text was the alternative.
Undo, a draft restore, history recall and the clear after a send all rewrite
the text, and each would read as "every chip deleted". Keeping the pool and
sending only what the text cites makes undo bring the chip and its file back
with no extra state. Keeping the file after its chip is gone was rejected
too: it would ride along with nothing on screen showing it.

### Why a plain click opens a chip

Cmd or Ctrl and a click would hide the preview behind a modifier the phone
does not have. The chip is atomic, so a click beside it or the arrow keys put
the caret next to it, and Backspace deletes it.

### Why a chip whose file is gone stays a chip

After a reload a file that lived only in memory is gone. Drawing its citation
as plain `[name]` text would make the chip vanish with no explanation; the
dashed chip says why it will not be sent and can be deleted.

### Why a browser annotation's screenshot is not a chip in the text

The screenshot belongs to its annotation: a chip in the prompt would separate
the two, and removing it left the prompt claiming the screenshot was
attached. It is a chip in the annotation's own row and leaves with it. The
chip's own remove button, shown on hover and always on a touch screen, drops
only the screenshot: the row keeps its comment and selection, and its prompt
says `Screenshot: not attached`.

### Why a sent message keeps its image and file previews

Every other attachment shows in a sent message only as its chip, but images
and files keep their strip: people rely on the quick look at what they sent.

## Paste routing

On Linux, a middle-click paste belongs to the editable field or terminal under
the pointer. The global capture pairs the native paste event with the recent
middle click and suppresses it when the pointer was over page chrome, so it
cannot land in whichever composer kept focus. A terminal canvas and its hidden
textarea count as one owner. For the composer, the capture moves CodeMirror's
caret to the pointer; the browser and `ChatInput.handlePaste` still handle the
text. Keyboard paste keeps the existing composer fallback and overlay rules.
Other platforms do not use this routing.

## Input recall ownership

Prompt recall has two owners on purpose.

- `packages/ui/src/stores/useInputHistoryStore.ts` owns the persisted source of
  truth. It keeps the runtime-scoped global bucket and the runtime + directory
  + session bucket, each capped by the configurable input-history limit. That
  setting defaults to 40 entries. Recall reads the current session's bucket by
  default; the Chat setting can widen it to every project on the runtime.
- `state/useMessageHistory.ts` owns only keyboard traversal through whichever
  bucket the composer was given. Moving away from a position stores the
  composer's current text and attachments as an overlay for that position, so
  the live draft and any edit made to a recalled prompt survive a round trip
  through history. Overlays never rewrite stored history; sending resets them.
- `input/useComposerDraftHistory.ts` applies the recalled text and attachments to the composer and
  places the caret.

Prompt history search uses the same history values as Arrow recall. The runtime
shortcut registers once and routes to the focused normal composer through its
form owner. Search state stays local to the panel. A runtime, draft, history
scope, mode, or BTW transition hides the panel before it can select another
composer's history. Picking a result validates the displayed value against the
current history entry, restores its draft-scoped attachments, and puts the
caret at the end of CodeMirror's normalized document.

Escape, a pick, and recall share one pending composer focus frame. Scheduling
replaces it, and opening the search or unmounting cancels it, so a late frame
never moves focus out of a search that opened after it was queued. In normal
layout the panel's anchor is a zero-height row above the composer box; in
expanded layout the anchor is absolutely pinned to the bottom edge of the
composer frame wrapper, which becomes the positioned ancestor only in that layout.

Search and its pending focus-return frame hold the mobile shell expanded, so
moving focus out of the editor cannot unmount the search or its return target.
The search caps the entire floating frame to the room above its anchor, including
the frame's gap. Flex layout leaves the list the space remaining after the header
and hint; it has no minimum height that can push the search field above the chat.

In session scope the composer merges two sources, oldest first: the visible
transcript's user prompts (`useUserMessageHistory` in `sync-context.tsx`), so
sessions that predate the persisted store still recall, and the persisted
session bucket, which adds attachments and keeps prompts a revert hid from the
timeline. A prompt present in both collapses to the persisted entry. Global
scope reads the persisted runtime bucket only.

## BTW composer

An empty `/btw` opens an unsent draft. `/btw <question>` opens BTW and sends
that question immediately after its own draft and model selection are active.
**By the way…** opens an unsent draft with Quote-formatted selection text.
The first send creates the fork; Enter follows the user's preference. Pending
text, references and selections then move to the fork's draft identity and
session, and the unsent panel's own key is cleared, so the next `/btw` in that
parent opens on Plan and the main composer's model again. Normal and BTW
drafts remain independent, including in memory when persistence is disabled.

Both modes reuse `ComposerEditor` and `ModelControls`; BTW transitions put the
caret at the end. BTW copies its chat's model/effort once, including explicit
Default (in a chat pinned in the side panel, that chat's, never the main
chat's), and uses `plan` or the first selectable agent. From then on the fork
keeps its own effort, also on the main chat's agent and model. The agent
control is in the composer from the first question on, so a side question can
run on another agent without collapsing the panel; the pick is saved for the
fork's session, and the main chat keeps its own agent. Its controlled model
path only writes BTW selections. The model, effort and cycle-favorite-model
shortcuts act on the BTW selection its chips show: the model shortcut toggles
the BTW model picker, whose open state `ChatInput` owns for that reason; the
effort shortcut steps the BTW model's level the way the main one steps
(`nextThinkingVariant`) and the favorite shortcuts step the BTW model, each
saved as the BTW picker saves it. The app-wide handlers decline while BTW is
open, so the parent's model and effort never move, and an open overlay stops
all of them. As with permission keys, a key pressed in a chat pinned in the
side panel acts only on that chat's BTW, and a key pressed anywhere else only
on the main chat's. The agent shortcut stays off in BTW. Files attach as in the normal composer
(picker, paste, drop) and live in the BTW draft identity's attachment slot,
so they never mix with the main draft's files; the attach control offers
only local files. Goals, expansion, shell, linked context (issues, PRs,
guests) and file/agent mention autocomplete are unavailable. Auto-accept is
applied before the first send.
On mobile, the model, effort and agent controls take the main composer's
bottom row below the footer, drawn the same way, and open the same bottom
sheets; the footer holds the files-only attach, auto-accept and send/stop
controls.

Escape closes menus first. Otherwise it returns to normal: an unsent BTW is
discarded with its text, references, selections and panel; a creating or real
fork is only collapsed. Neither exit sends, aborts, or deletes a server session,
nor consumes the main draft's files, queue, or linked context. Pending snippet
expansion belongs to the unsent panel. Discarding that panel invalidates the
send, and a runtime change prevents fork creation and stale UI recovery.

The unsent panel shows "Ask your question" until fork creation starts.
Existing panels hide titles. Promotion retains the existing internal title, without
transcript fetching or Small Model generation.

### Why a controlled agent pick carries the effort to the new agent

An effort is stored per session, agent and model, so an agent the fork has not
run yet has none for the model it is on. Left to inherit, as the main
composer's agent switch does, the level `/btw` copied from the main chat would
vanish the first time the user changes the agent, which is the move the agent
control exists for. `handleAgentChange` therefore writes the current level for
the newly picked agent when that agent has no level of its own for this model,
and an unchosen level still stays unchosen so nothing latches an explicit
Default the user never picked.

## Pinned composer

A chat pinned in the side panel has a composer of its own next to the main
chat's (see the sync documentation, *Pinned chat columns*). What used to be
one app-wide composer state is split per column:

- **Model, agent and effort.** The app-wide current model belongs to the main
  chat. A pinned composer sends with `usePinnedComposerSelection`: what was
  picked in it, saved for its session in the selection store the way the BTW
  composer saves its picks, otherwise the session record's model, variant and
  agent. A variant `"default"` is how OpenCode stores no effort, so the
  pinned composer shows it as Default, as the main chat does: from the record
  it is no effort, and saved as a pick (older pickers copied it there) it is
  an explicit Default that still wins over the record. Its picker is
  `ModelControls` in controlled mode, where the agent
  pick is saved for the picker's own session and never changes the main
  chat's agent. As in BTW, the pick carries the effort the composer shows to
  the new agent when the session has none saved for that agent and model, so
  switching the agent keeps the level on screen. A controlled picker lists the models and
  agents of its column's session folder (loading that catalog when it has not
  loaded), since a pinned chat can live in another folder than the main one. "Run in parallel" is offered only in the main
  chat. Picker changes record the chosen level for that model in the profile
  immediately, and a successful send records the level it carried; a later
  composer on the same model starts there when neither the session nor the
  model's configuration names a level.
- **Attachments.** Each draft's files live under its draft identity in the
  input store, and `useDraftAttachedFiles(identity)` shows a composer its own
  files. The selected slot (`attachedFiles`) belongs to the composer the user
  last worked in: pointer down, focus or drag-enter in a composer selects its
  draft, so its paste, drop, picker and remove act on its own files. A pinned
  composer does not take the slot on mount, so app-wide attachments keep
  landing in the main chat until the user works in the pinned one.
- **Composer address.** The composer publishes one address for the surfaces
  outside its column (`input-store`'s `composerAddress`, one layout effect in
  `ChatInput`): the inline-draft target and the attachment slot, both of which
  move to the `/btw` fork while that fork owns the input. `hooks/useComposerAddress`
  reads it for comments on files, diffs, plans, terminals, PRs and pages, and for
  the image or screenshot those comments carry. A comment filed under any other
  session key has no composer to render it, and an attachment filed elsewhere is
  a hidden file.
- **Pending text and context.** `setPendingInputText` and
  `setPendingSyntheticParts` take a target. Null is the main composer, which is
  the chat on screen and what every surface acting on it writes to (quotes,
  plugins, git dialogs, file selections, todo sends); a `/btw` fork, being that
  same composer, takes those while it is expanded and the parent takes them once
  it is collapsed. A session id addresses the composer showing that session,
  which is what text quoted inside a pinned chat and a reverted message's prompt
  use; text addressed to a session no composer shows waits until one does. The
  main chat's composer also waits until its deferred column shows the live
  selection (`state/usePendingComposerText.ts`): a new-session draft opened with
  a prompt, such as "resolve in new session" from a git conflict, leaves the
  prompt while the column still shows the previous session, and taking it then
  would save it into that session's draft. Preset
  submits, guest-issue attaches and pending composer references are main-chat
  only. The mode says how the text meets the draft: `replace`, `append` (a
  block on its own lines), `append-inline`, or `slash-command`, where the text
  is a command name the draft starts with and the rest of the draft becomes
  its argument (`withLeadingSlashCommand`; the command palette's extension
  commands). Taking one leaves shell mode. An expanded `/btw` fork leaves it
  pending for the parent, because the fork does not route extension commands
  and would send `/name` to its model as text.
- **Focus.** `focusChatInput()` focuses the main chat's composer and skips
  pinned ones; a chat focuses its own through `useChatColumnActions().focusInput`.
  A pinned composer takes focus on session entry only when the focus is
  already inside its column, so opening a subtask in the panel never pulls
  keystrokes away from the main chat.
- **Typing with nothing focused.** `editor/inputRedirect.ts` sends input that
  has no text field to land in to a composer, on desktop only: a printable key
  without Cmd, Ctrl or Alt is inserted at the end of the draft, a paste is
  replayed on the editor so attachments and large-text handling still apply,
  and coming back to the window puts the caret in the composer. The receiving
  composer is the pinned chat's when the user last clicked or focused into
  that column and it is still on screen, the main chat's otherwise. Input
  stays where it is when its target takes text or is a button, link, tab,
  list or menu item, while a dialog, menu, open select, settings, the BTW
  composer or the choice above the composer (large paste, office documents)
  is on screen, during IME composition, and while text is selected, because typing
  over a selection starts a comment on it. The window-focus refocus skips a
  focused field, terminal, editor or embedded page and keeps a selection.
  `useKeyboardShortcuts` calls it after the shortcut dispatcher, so a
  bare-key binding or sequence still wins.
- **Stop prompt.** `armAbortPrompt` arms for a given session. A composer
  clears the prompt of the session it leaves, never another column's.

## Mobile

`state/useMobileComposerShell.ts` and `state/useMobileViewportPin.ts` are
mostly not state machines but corrections for specific platform behaviors:
mobile browsers dismissing the keyboard before a tap's click lands, iOS
refusing programmatic focus outside a gesture, WebKit leaving the layout
viewport panned after the keyboard hides, overlay chains handing off through a
frame where nothing is open.

The keyboard pin also runs in the iPad Home Screen app (iPad, standalone, not
Capacitor) at every width, the tablet surface included: standalone Safari does
not reveal the focused field there. It lifts the composer by the part the
keyboard covers, so a hardware keyboard or an already revealed field means no
lift, and a composer too tall to fit above the keyboard stays put.

Typed text and salvage text shown after a failed dictation use the same measured
line and screen-height limits. Once the viewport reports usable space, content
scrolls inside the composer so the failed-dictation action row stays inside the
chat screen. A transient non-positive viewport measurement keeps the existing
line cap until the next resize instead of collapsing the editor to zero height.
The salvage reader follows the end only while already there; rewrapping text
keeps a reader who scrolled up in place. Expanding the composer releases this
height floor and uses the existing fullscreen layout.

Their timing and focus invariants live in this document. Platform behavior needs
verification on real hardware.

`state/mobileComposerMorph.ts` plays the pill ↔ composer swap as a FLIP morph
in the native iOS shell only. The swap commits synchronously (`flushSync`); the box
(`data-composer-box`) is then frozen at its old height and animated to the
new one (WAAPI) with its rows anchored to the bottom edge, so the footer and
model/agent rows stay where the pill's rows were; the prompt
(`data-composer-morph-prompt`: the pill's text line or the editor block)
travels from its old position to its new one, gained editor lines unfurl
beneath it, and footer controls that exist only expanded fade in over the
second half. The floating composer slot (`data-composer-slot="floating"`, in
`ChatContainer`) is pinned for the tween at the height the transcript should
see — the new one on expand, the old one on collapse — so its
`ResizeObserver` publishes one final inset instead of chasing frames. The
status row, recap hint and scroll-to-end button share one zero-height anchor
on the slot's top edge (`data-composer-riders`, class `oc-composer-riders`):
the keyboard choreography slides it as a mover and the morph moves it with the
box's top edge through the individual `translate` property, so nothing above
the composer jumps when the slot resizes. The
motion starts on the `oc:keyboard-anim` event for its direction, runs on the
shared keyboard timing (`lib/mobileKeyboardTiming.ts`) the composer slide
also uses, and ends on `oc:keyboard-settled`; a fallback timer runs it alone
without a keyboard. The keyboard's `keyboardWillShow` often crosses the
bridge after that timer (up to half a second after the tap in the simulator),
so the morph runs alone and the keyboard takes the transcript over: the
morph's `release` never ends a glide a keyboard leg started, only the
keyboard's settled event does. Ended by the morph, the glide snapped the
transcript to the end mid-rise. Waiting longer for the keyboard is worse: the
box growth then lands on the frames WKWebView drops as the keyboard starts,
and the composer sits under the keyboard for a few frames. The transcript rides it through
`lib/scroll/keyboardFollowGlide.ts` (owned by `useChatTimelineScroll`): the
morph announces `oc:composer-morph` (`hold` with how far the transcript's end
moves, `glide` and `release` when it runs without a keyboard), the glide holds every
automatic end write while a transition runs, lets the geometry land in one
step, and drives scrollTop on the same curve. Mobile browsers, Android and
reduced motion keep the instant swap.

### WebKit rules for the keyboard choreography

Each of these cost a debugging round on a device. The rules that reach beyond
the composer (compositor easings, inherited custom properties, large hidden
markup) and how to measure on an iPhone live in the `performance-engineering`
skill, `references/ios-webkit.md`; `lib/iosWebKitMotion.test.ts` guards them.

- **The keyboard is a spring.** Traced frame by frame from a recording, the
  iOS keyboard follows a critically damped spring with a 0.255 s response,
  settled in 375 ms (`lib/mobileKeyboardTiming.ts`). Everything that follows
  the keyboard runs on it: transforms, translates and opacity as Web
  Animations on `keyboardKeyframes` with `easing: 'linear'`, and only what
  cannot be composited anyway (a height, a `bottom`, a clip) on
  `KEYBOARD_EASING_CSS`, a `linear()` easing WebKit keeps on the main thread.
- **Movers slide as Web Animations.** The composer, the riders and
  `.oc-draft-center` get the final transform inline and a Web Animation from
  where they stand (`slideMovers` in `apps/mobileNativeChrome.ts`). A CSS
  transition through a custom property did not reliably start in WebKit.
- **The chat scroller is never transformed.** WebKit rebuilds composited
  scrolling layers for that, a multi-second stall on long chats.
  `.chat-scroll` keeps a constant `clientHeight` across keyboard transitions
  (`mobile.css`): it extends below its shrunken region by
  `max(--oc-kb-layout - --oc-app-bottom-safe, 0)` and carries
  `padding-bottom: --oc-kb-scroll-inset`, so opening or closing the keyboard
  moves over rows already mounted.
- **The transcript glides by a transform on its content.** scrollTop moves in
  whole CSS pixels, and written per frame it moves at 60 Hz: the end of a
  glide crept in visible one-pixel steps. `keyboardFollowGlide` sets scrollTop
  once and runs the travel as an upward transform on the list's content (an
  upward one adds no scrollable overflow), with the opposite one on a stuck
  user header. A leg on which one sticky header hands over to another cannot
  be shown by one offset, so it falls back to scrollTop per frame.
- **The shell follows only its own keyboard.** A keyboard opened for a field
  on a surface over the shell (a drawer's search, the Git commit box, a
  dialog) leaves the shell's strip, layout and movers as they are, and the
  glide does not run (`inShell: false` on `oc:keyboard-anim`): the covered
  transcript, following its end, chased every change of it. Focus moving out
  of the shell with the keyboard up gives back what the shell took.
- **Keyboard geometry is written through `lib/mobileKeyboardInsets.ts`.** The
  values (the keyboard's height from its start, the shell's and the
  surfaces' layout heights, the transcript's strip) are registered
  non-inherited and written on their readers only; a new reader joins the
  module's selector list. On the root they restyled the whole page on every
  open and close.
- **Swap first, then focus in the next frame.** WKWebView stops presenting
  frames once focus starts the keyboard transition and holds the last one until
  about mid-transition, so a swap committed in the same task as `focus()` stays
  invisible. `flushSync` the swap and call `focus()` in the first
  `requestAnimationFrame`.
- **The hide intent races React.** `oc:keyboard-intent {open:false}` arrives a
  few milliseconds after blur; the Capacitor blur branch commits
  `setFocused(false)` with `flushSync` so the collapse is not skipped.
- **Hide starts from `focusout`.** `keyboardWillHide` arrives late over the
  bridge; `isTextInput` counts `isContentEditable`, so CodeMirror qualifies.
- **The caret is held while things move.** The native caret ignores transforms
  and jumps after the motion; `.oc-kb-caret-hold` hides it until about 250 ms
  after settle, and targets `.cm-cursor` / `.cm-dropCursor` too, because
  CodeMirror draws its own.
- **Rows around the composer key off `oc-composer-expanded`**, set in the same
  frame as the pill swap. `oc-keyboard-open` lands with the bridge event about
  100 ms later and makes a second visible jump.
- **A composited child inside a sliding ancestor blinks.** Position it without
  compositing (`SortableTabsStrip`'s `nonCompositedIndicator`).
- **Programmatic `scrollTop` is ignored during momentum.** iOS overwrites JS
  writes while a fling runs; `setScrollTopDefeatingMomentum`
  (`hooks/useChatTimelineController.ts`) toggles `overflow: hidden` to kill the
  fling, writes, then re-asserts for about 20 frames until the next touch. Use
  it for any programmatic scroll whose writes do not stick on a device.

Mobile browsers have no choreography: Safari pans instead of resizing. The
fullscreen and draft composers are `position: fixed` and pinned to the visual
viewport, so no ancestor root may carry a `transform`, and the header is hidden
through `oc-browser-kb-fullscreen` instead of out-stacking it. The keyboard
opens only for a `focus()` inside the tap's own call stack.

When swap and keyboard timing looks wrong, measure on the phone before
guessing: `bun run profile:ios frames` records where the composer, its riders
and the transcript stand on every frame of a keyboard open, and
`profile:ios keyboard` times tap to keyboard. The simulator's timing is the
Mac's, not the phone's.

## Run in parallel

The desktop model picker offers "Run on several models" right under Auto
(`ModelPickerList.leadingAction`). It is a row of the picker's keyboard list,
not a separate button: arrows and the pointer highlight it like Auto, and Enter
runs it. On a new-session draft it turns the composer
into parallel mode; elsewhere it opens a new draft in that mode with the typed
text. The command palette and "Start new multi-run from this
answer" reach the same mode through `useUIStore.requestParallelComposer`, which
`useParallelComposer` consumes once. Mobile and BTW never enter it.

The state lives in `parallel/useParallelComposer.ts`, local to `ChatInput`.
The editor stays the one `ComposerEditor` and always shows the active variant's
prompt: switching a variant tab stores the editor text in the variant it leaves
and loads the one it opens, so autocomplete, drafts and attachments are the
composer's own. `ParallelComposerStrip` renders above the editor inside the box,
so the box grows upward and the text field never moves: one row of model chips
(each with its thinking effort; the same model at another effort is a separate
lane) plus a summary button that opens the launch settings dialog: two fixed
columns (where lanes work, base branch, setup | fusion, judge and its effort,
prompt variants) where options that do not apply are disabled, not hidden, so
the dialog keeps its size. Lanes share the project directory by default;
worktrees are opt-in, and a tab row only
once there are two or more variants. Model pickers there render through a
portal because the box clips its content; the footer drops the model button
but keeps the agent picker (`ModelControls` with `agentOnly`), because every
lane starts on that agent, and the ordinary send button
(`ComposerActionButtons` with a `sendLabel` naming the run count), disabled
below two runs or while launching. Enter and the send button launch instead of
sending. Launching goes through `useMultiRunStore.createMultiRun`, clears the
draft text and attachments, and opens the run overview. Attachments go to every
variant; prompt text is sent as typed, the way the old launcher sent it. An
armed goal button makes each lane a goal of its own, with its variant's prompt
as the objective and the default token budget per lane; a launch that created
sessions disarms the button.

## Chat quote highlights

A `chat-quote` draft carries an anchor (`lib/chatQuoteAnchor.ts`): the quoted
text in its message's rendered text stream plus the characters around it. It
is captured at selection time, persisted with the draft and sent in the
context part's metadata. `message/ChatQuoteHighlightLayer.tsx` (one per
`ChatContainer`, fed by the column's `hooks/chatQuoteHighlightStore.ts`) uses it
to paint with the CSS Custom Highlight API. The store lives outside React state
and the layer holds all hover and popover state, so none of it re-renders the
chat column. The
markdown DOM is never modified. While quotes wait as composer rows they stay
marked in their messages; the one under the pointer in the composer is drawn
stronger. Resting the mouse on a mark, or tapping it on touch, opens
`message/ChatQuoteMarkPopover.tsx` with the comment, edit (the selection
menu's input) and remove; the publisher's callbacks write the draft. Clicking
a quote in an open composer row, the arrow on a folded row, or the quote on a
sent card (the quote itself is the link, since the original shows it whole) scrolls to it
through the timeline controller and flashes it. Ranges are
re-resolved by text and context whenever the marked message re-renders or
remounts. Offsets only break ties. Quotes sent before anchors existed are
found only when their text appears once in the message.

A quote taken inside a page the agent showed (`openchamber_render`) has `page: { partId }` in its anchor: its text stream is the page's body, measured and re-found inside the page's frame. The layer does not paint those marks; it publishes them, asks for reveals and hears clicks through `message/pageQuoteBridge.ts` (see `message/parts/DOCUMENTATION.md`).

The selection menu's thumbs-up attaches a normal `chat-quote` draft to the
column's published comment scope, including an expanded BTW composer. Its
comment uses the trimmed `selectionApprovalText` setting, falling back to
`Sounds good`. Existing drafts, attachments and linked references stay in place;
the user sends them together through the normal Send action. The shortcut
focuses the composer on desktop and does not request keyboard focus on mobile.

## What a context row opens

A review comment row's head opens what the comment was written on, through
`components/comments/useOpenCommentSource.ts`; on the phone, where a tap on
the row edits the comment, the collapsed row's label is that opener. A comment
on uncommitted changes opens the file at its line (the Files drawer on the
phone). A comment on a commit, a branch comparison or a change request opens
that diff at the line, because the file on disk is another version. A comment on
an earlier agent turn opens that turn's diff the way a turn's changed-file chip
does; one on "Last turn" names no turn and gets no opener. The quoted code keeps
its own behaviour: only a chat quote's reveals its source.

The opener is withheld where the place cannot be shown: a branch comment while
another branch is checked out, a comparison comment in VS Code, and any comment
in the mini chat window, which has no file or diff viewer. A plan comment keeps
no opener: its label is the plan document, which may not be a file yet.

## Mobile comment mode

On mobile, "Comment" on a text selection does not open a floating input. The
selection menu (`TextSelectionMenu.tsx`) hands the quote to this column's
composer through `comment/MobileCommentComposerContext.ts`; `ChatContainer`
creates one controller per column so an embedded column's selections never
comment into a sibling. Desktop keeps its floating input in the menu and files
that attach into the same published scope.

`comment/mobileCommentDraft.ts` owns the lifecycle. The scope (runtime,
directory, session) comes from the visible composer's inline-draft target,
including an expanded or pending BTW composer. A collapsed BTW uses the main
composer's target. The hook publishes that scope before paint, on every
platform; the selection menu supplies only the quote and reads it back through
`getScope()`, while a quote's text goes to the column's own address, which the
composer on screen takes. Desktop's floating input lives
outside the composer, so it reads the live scope at attach and the comment
lands in the composer on screen then, including a fork that a `/btw` opened
over the parent session. Without a published scope the comment is dropped and a
quote falls back to this column's own rule (a pinned chat's session, the main
mailbox otherwise). A mobile comment captures the scope when it opens, and
that capture is the only
place its quote may land: attach writes a `chat-quote` draft into
`useInlineCommentDraftStore` at the captured target, never the currently
active session, and a scope change closes the comment instead of re-targeting
it. Attach also refuses at the boundary unless the authoritative scope still
matches the captured one. Every mutation carries the generation of its open,
so a repeated attach or a dictation transcript that arrives after cancel or a
reopen is rejected; `insertAndAttach` checks the generation once for both
steps, so a stale dictation completion neither writes text nor attaches the
newer comment that replaced its own. Attach is once-only; the comment text
itself is optional. The controller closes only after the inline-draft store
accepts the write. A size-limit rejection keeps the quote, typed text and any
inserted transcript open for editing or retry, with a localized error toast.
A stale runtime closes the comment without writing to the new runtime.
Desktop's floating comment input also remains open when the store rejects
an attachment, using the same localized error.

Editing an attached comment on mobile reuses the same shell. A tap on its
composer row calls `openEdit` with the draft's id, quoted text and
comment, inside the tap (`flushSync`, for the soft keyboard), and the shell
opens with the caret after the text, a Save (check) action and Cancel editing
on its close button. Save goes through the same attach path, but the plan
carries `draftId`, so `applyMobileCommentAttach` calls `updateDraft` with the
new text and writes nothing else; Cancel writes nothing. `openEdit` accepts
only a draft of the published scope. A rejected update keeps the shell open
with its own localized error, as a rejected attach does; a draft removed while
the shell was open closes it, since a retry could never succeed.

### Why the mobile pencil opens the comment shell and not the preview editor

The preview's in-place editor is a desktop field in a floating panel. On a
phone the comment was written in the shell above the keyboard, and the issue
asked that editing look and behave the same way, with save and cancel. The
shell already owns the scope capture, generation guards, dictation and
keyboard handoff, so an edit mode on it is one id more than a second mobile
field would be.

`comment/useMobileCommentComposerMode.ts` is ChatInput's seam: subscription,
scope ownership, and the attach/cancel transitions, flushed inside the tap and
followed by `useMobileComposerShell`'s `expand()` so the restored composer is
focused while the gesture is still live — the only focus iOS raises the soft
keyboard for. The opening tap does the same in reverse: `flushSync` mounts the
shell and its `useLayoutEffect` focus runs inside the gesture. `ChatInput`
swaps the normal composer (pill or expanded, plus its chips and footers) for
`comment/MobileCommentComposer.tsx` while the comment is open — the normal
draft is hidden, not cleared, and comes back unchanged — and keys the shell by
generation so a replaced open remounts it with fresh dictation callbacks.
Every send path (submit, queue, primary action) is inert during comment mode;
the form submit attaches. The return key follows the same policy as the prompt
composer (see "Enter preference"): its Send action attaches.

While the comment is open, the selection menu keeps the quoted range painted
through its existing highlight overlay (rAF on scroll/resize, no polling); the
Range lives in that menu component only and is released when the comment
ends or the message unmounts. A desktop inline comment moves to the next menu
of the same message instead (see the message module's invariants).

Voice: the comment shell mounts its own `ComposerDictation` whose insert
callbacks target the comment draft (insert-and-send attaches; it never sends).
While it is mounted, the composer's wrapper-level dictation engine is not:
the comment engine takes the form's addressed dictation events, and a
transcript meant for one editor must not reach the other. A
recording in flight when comment mode opens is discarded by that swap.

The comment editor reuses `ComposerEditor` with `dataChatInput="comment"` so
the `data-chat-input="true"` helpers (`focusChatInput`, shortcut guards) keep
meaning "the prompt editor".

Snippets are the one part of the prompt language comments speak. The desktop
floating input, the mobile shell and the diff/editor/file comment input
(`components/comments/InlineCommentInput.tsx`) open the snippet picker on `#`,
and the emoji picker on `:`, through `components/comments/useCommentFieldPicker.tsx` (placed at the caret by `components/inline-picker/`),
and the mobile editor highlights known triggers. Agents, commands and files stay inert. Comments
become synthetic context, which the send-time snippet expansion skips, so
`expandCommentSnippets` (`submit/buildOutgoingMessage.ts`) expands each
comment's own text before assembly, on the send and queue paths alike. The
quoted code or message stays verbatim.

### Why dictation uses a window-local capture owner

Main and pinned chats can both mount a dictation engine. The engine claims
ownership synchronously before starting capture, because React has not yet
committed its recording status when the next global listener runs. Keyboard
confirmation stays with that owner so one gesture cannot send both drafts.
Form-addressed mic actions cannot confirm another form's recording.

## Testing

Tests cover the language, submit assembly, path and drop handling, text splicing,
large-paste detection, paste-offer invalidation, input-history traversal, the
mobile comment lifecycle, and the CodeMirror language extension at the
`EditorState` level. The mobile comment hook also has a Happy DOM integration
suite for the mounted composer's target, stale callbacks, and failed attaches.

Rendering, focus, keyboard behavior, IME and WKWebView are **not covered by
tests** and are verified by hand. That includes ArrowUp and ArrowDown recall,
caret placement after recall, restored drafts, and any edited-entry overlay.
Do not report a change to them as validated on the strength of type-check and
unit tests.

Run tests per file (`bun test <path>`): `mock.module` is process-global, so
suites that install module mocks are order-dependent.

## Enter preference

`keyboardPolicy.ts` owns the submission decision. On mobile, Enter and
Shift+Enter insert a newline regardless of synced settings or CodeMirror's
deferred Shift modifier, unless the mobile "Return key sends" setting is on. Ctrl/Cmd+Enter remains available for external keyboards;
Send and Queue buttons retain their normal behavior. The Enter-to-send setting
and its search entry are hidden on mobile without changing the desktop preference.

The mobile "Return key sends" setting relabels the keycap with
`enterkeyhint="send"` and makes it submit. In both Return modes a deferred Enter
restores the real Shift only while a hardware keyboard is attached
(`shouldPreserveDeferredEnterShift`): iOS autocapitalization reports a phantom
Shift at sentence starts, so a soft-keyboard Send always submits and a soft
Return never continues a list, while a hardware Shift+Enter still inserts a
newline or continues the list. Alt/Option+Enter inserts a newline, and
Ctrl/Cmd+Enter is unchanged.

Comment fields use `components/comments/useCommentEnterSubmit.ts` for the same
policy. Enter attaches on desktop; on mobile it follows "Return key sends".
Shift+Enter and Alt/Option+Enter insert a newline, and Ctrl/Cmd+Enter attaches
regardless of the setting. This applies to selection comments, pending comments,
marked quote comments and diff/file/file-preview line comments. Attaching never
sends the message. CodeMirror comment fields inherit the IME cleanup below
through `ComposerEditor`; textarea fields keep native newline handling.

### Why IME cleanup requires DOM padding evidence

On iOS in Send mode, Sogou's long press can commit a newline followed by a
padding space and a cleanup Backspace. If the padding reaches only the DOM,
CodeMirror's replayed Backspace can delete the document's newline.
`editor/imeNewline.ts` consumes one deletion only after observing a DOM line
with exactly one extra leading space and a native caret after that space.
The mark belongs to the specific native newline insertion and expires after
400 ms. Other input, document edits, selection changes, pointer interaction,
blur and Enter clear it. Padding already in the document uses normal deletion.
The extension lives in the return-key compartment, enabled only for iOS Send
mode; switching to Return removes it. A time window alone would swallow an
ordinary Backspace. With confirmed padding, a user's Backspace within the same
window is still indistinguishable from the keyboard's cleanup.

The expanded desktop composer always inserts a newline with Enter, Shift+Enter
and Alt/Option+Enter, and sends with Ctrl/Cmd+Enter; it ignores the Enter-to-send
preference.

Outside mobile and expanded mode, desktop Enter sends by default. The Chat
setting controls plain Enter there: "Send with Enter" sends on Enter, "Send with
Ctrl/Cmd+Enter" inserts a newline. Shift+Enter and Alt/Option+Enter always insert
a newline, and Ctrl/Cmd+Enter always sends. Ctrl/Cmd+Alt/Option+Enter keeps
the Ctrl/Cmd+Enter send behavior.

Shift+Enter at the end of a numbered item continues the list: the next line
carries the following number with the same indentation and delimiter (`1.` →
`2.`, `1)` → `2)`). On an item with no text the key ends the list instead: the
marker and its indentation are removed, so a nested item leaves the list too,
and the caret stays on the empty line. Anywhere else Shift+Enter is the plain
newline above, including numbered text inside a code fence: `text.ts` reads
fences through `matchFenceOpen` and `isFenceClose`, the same boundaries the highlighter uses,
so an unclosed fence runs to the end of the prompt.
`getOrderedListContinuationEdit` in `text.ts` owns that rule and runs inside the
same markdown-source branch as auto-pairing, so autocomplete and Alt/Option+Enter
keep their own handling.
