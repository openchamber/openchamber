# Composer

The chat composer: the prompt language, the editor that renders it, and
everything between typing and sending.

`ChatInput.tsx` (one directory up) is the orchestrator. It holds the composer's
own state and wires these modules together; it should not grow logic that
belongs to one of them.

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

`GlassPopupMotion` gives the frame, the autocomplete pickers and the
context-chip preview one enter and exit motion, mostly a fade with a short
rise from below and no scale (from the wrapper's corner, scaling read as a
diagonal slide): the wrapper moves, the glass surface fades. Autocomplete
lists take the `brief` pace (90ms in, 60ms out), since they come and go with
typing; panels keep the standard 140/100ms. Text-field lists
(`components/inline-picker/`) play the same motion as a CSS animation on the
list itself, since they are fixed-position. The fade stays on the glass element itself, since an ancestor
with opacity below 1 is a backdrop root and the blur would go flat mid-fade.
Exit needs `AnimatePresence` around the conditional popup, so each dock keys
its panel there (BTW keys each stage, forms key the form id); switching panels
cross-fades. The frame's clearance cleanup leaves the variable alone while
another panel is still mounted, because the outgoing panel unmounts after the
incoming one has written its own height.

`FormDock` is the agent's question (a v2 form request) for the composer's
session, one field per step with a segment row, Back / Next, and Submit in
place of Next on the last step; `when`-gated fields join or leave the steps
as answers change, an `external` field is an information step, Enter in a
text box moves to the next step and Cmd/Ctrl+Enter submits. Submit is
enabled only once every question is answered; a submit with a required
question still open jumps to it. It shows the
oldest pending form and counts the rest in its header. The BTW sheet keeps
the inline `FormCard` for its child session's forms; both render a field
through `FormFieldControl`.

On a phone the dock's body is clamped to the room above the keyboard
(`useMobileAutocompleteMaxHeight`). iOS Safari raises the keyboard after the
answer box takes focus, so the clamp shrinks the body under a box Safari has
already revealed, and Safari does not reveal it again until the first
keystroke. The dock therefore scrolls the focused field back into view
whenever that height changes.

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
the card and its answer draft. Eligibility belongs to `sync/recoverable-questions.ts`.

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
the surface stays one shape. Top to bottom: worktree setup, the session still
being created from a draft's first message, and a message waiting for its
space (`ComposerStatusStrip`; the creating line yields to the worktree line,
so one wait shows one line, and appears only once the creation has taken
300 ms, `useShownAfter`, so a fast server never flashes it), the goal (`SessionGoalRow`), a
review loop and, once it ends, its result until dismissed, a dispute unfolding in place (`AutoReviewStrip`), the pull request the agent waits on with Stop watching (`PullRequestWatchStrip`), background commands, a staged revert
(`RevertedMessagesStrip`), the queue (`QueuedMessagesStrip`),
the "looks done" hint or the review offer, the suggestion
(`SessionSuggestionChip`). BTW hides all of them. A pending form, a nonempty
queue, composer content and a new-session draft hide the suggestion; a
new-session draft also hides the queue.

While a session's first send is pending (`pendingDraftSends` in
`session-ui-store`, from Enter in the draft until the request that starts the
turn has left), the composer keeps what is typed and sends nothing: Send is
disabled, Stop is not offered, Enter and the pill's arrow do nothing, and
nothing is queued. A first send that fails restores its text under the
identity `DraftSendError` names: the created session's composer, or the
reopened draft's, with the text typed meanwhile kept above the sent text
(*A draft's first send* in `sync/DOCUMENTATION.md`).

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
ends, and a row's own Send sends just that message. Like any send, it dismisses
open permission requests and forms. Scheduled items stay visible in the
queue rows with reorder and remove, but no edit or send action.

While a turn runs and the composer has content, a follow-up button sits above
Stop (inside the pill on collapsed mobile). It takes the same path as plain
Enter under the follow-up setting: with Queue it queues and shows the rotated
icon labelled "Queue message"; with Steer it steers into the running turn and
looks like the ordinary send button.

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
reports its command ended, and a failed call makes its commands stoppable again. It shows whether the session runs or idles, and hides in BTW and
new-session drafts. The elapsed text is a leaf on the shared one-second
ticker, and the tree is compared as a string, so neither the tick nor
session-list updates re-render the composer.

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
`ScrollToBottomButton` translate upward by that amount, the transcript's tail
spacer and the end fade band grow by it (so the frame never covers the last
rows), and the column carries `data-floating-panel` while any frame is
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

Typing re-renders `ChatInput` and its editor, nothing else. The children that
do not depend on the draft text (footer, autocomplete popups, docks, BTW
panel, draft target selectors and preset chips) are memoized, and the props
`ChatInput` passes them keep their identity while the user types: callbacks
read the text through `messageRef` or `useStableHandler`, derived objects are
memoized, and `useBtwPanelState` and `useMobileComposerShell` return stable
objects. `useBtwPanelState` reads the parent and fork sessions as primitives,
and `useChatSearchDirectory` reads only the session's directory, so a
streaming turn's `session.updated` events do not re-render the composer. The
editor is memoized and every handler `ChatInput` passes it is a
`useStableHandler`, so it renders only when what it shows changes.
`__tests__/ChatInput.keystroke.test.tsx` counts the renders per keystroke and
per streamed session update.

A glass surface never carries its own shadow: the shadow sits on a wrapper
(or the glass moves to an inner layer). Chromium grows a backdrop-filter
layer by the shadow's blur, and that band painted a flat grey strip over
whatever was stacked above. This holds for the floating panels and the
context-chip preview. The box, the mobile pill and the dictation overlay are
opaque and keep their shadow on a wrapper all the same.

Context chips (review comments, quotes, annotations, terminal selections, PR
context) sit in the attachment row inside the box, shaped like file and linked
reference chips. Their preview cannot open inside the box, which clips its
contents, so `ComposerContextChips` portals it into a
positioned host outside the box: the autocomplete wrapper on desktop, the
dictation host on mobile. The preview opens above that host, at the menu level
(`z-50`), above the docks that share the band above the composer (`z-30`), and
its scrollable content is capped by the space between the host and the chat
column's top edge, so a long preview does not hide its entry actions behind the
chat header.

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
| `largeTextPasteOffer.ts` | Large-paste choice offer id begin/resolve (supersede + double-apply guards) |

`ChatInput.handlePaste` owns paste orchestration: URL-over-selection markdown
links, clipboard files, and large plain-text pastes. Pasted and dropped files
share `attachFilesWithCitation`: every file attaches and is cited in the draft
as `[name]`; images get a generated unique name first, other files keep their
own name and are cited only after they attached. A copied file's filename text
is suppressed so only the citation lands in the draft.
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
picked images (`attachFilesWithCitation`, `attachFiles`) are written into a new
folder under OpenCode's own temp folder (`opencodeClient.writeOpenCodeTempFiles`:
`GET /api/info` names the folder, `POST /api/experimental/fs/write` writes it)
and cited as `[name](absolute path)` (a plain link: a draft starting with `!`
turns into a shell command), so the model, a subagent or a tool reads the file
by path; OpenCode's agents may read that folder without asking.
`imageSaveModeForModel` picks one of three cases. A model whose metadata lists
no `image` input gets only the link, since it could not read the attachment
(#5087), and the modality toast says where the images went. Any other model,
unknown metadata included, also gets the image attached under the link's name,
with no second `[name]` citation (#5218). An image that could not be saved
attaches as before, with an error toast. With the setting off nothing is
saved. One setting covers both cases: a split by model kind read as a puzzle of
exceptions in Settings, and nobody needs the files for one kind of model only.
The browser annotation screenshot and comment-field image pastes keep
attaching. The bytes go through the active runtime's OpenCode route (the
OpenChamber server's proxy, the VS Code bridge, the relay for a phone), so the
file lands on the machine OpenCode runs on, which may not be the user's. Why
OpenCode writes the file and not the OpenChamber server: only OpenCode knows
its temp folder and its filesystem, and an external OpenCode or a space runs
elsewhere than the server.
Large pastes (about 2,000 characters or 25 lines) follow the composer setting
`largeTextPasteBehavior` (`ask` / `attach` / `inline` / `inline-double-paste`). Attaching creates an
in-memory `text/plain` file named `pasted-context-N.txt`, inserts a bracket
citation, and sends it through the same attachment pipeline as a manually
picked `.txt` file. In `ask`, `ui/LargeTextPasteChoice` floats above the
composer's start edge, styled like the chat text-selection menu. Its actions read live composer/attachment state so
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
  punctuation, not part of the file being referenced. Mentions are plain
  editable text: deleting a character edits the token and reopens the mention
  picker, the same way `$skill` tokens behave — not an atomic delete.
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

## The editor

`editor/bidi.ts` gives each rendered logical line native `dir="auto"` and
enables CodeMirror's `perLineTextDirection`, so browser layout and cursor
movement use the same direction. The content root stays LTR; automatic
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

Attachment citations (`[name.png]`) and finished skill tokens (`$name` followed
by whitespace) render in the editor as atomic replace widgets shaped like the
sent message's chips (`composerLanguage.ts`). The document keeps the source
text, so sending, copying and undo are unchanged; the caret steps over a chip
and one Backspace removes it. File and agent mentions, skills and snippets
chip the same way; a token whose last character was just typed stays text
until typing moves on, so a name is never chipped halfway. Commands keep
their color only.

The `#` snippet picker (`chat/SnippetAutocomplete.tsx`) also creates
snippets. A typed name no snippet answers to offers "Create #name" and, in the
main composer, "Save draft as #name" with the draft minus the token being
typed; once saved, that token leaves the draft. Every create row opens the
quick dialog (`components/snippets/SnippetQuickCreateDialog.tsx`, mounted once
per app shell) and never writes on its own, so Enter on `fix #42` cannot make
a snippet. The same dialog backs "Save as snippet" on a user message and on a
text selection.

Desktop comment fields in ordinary page DOM (chat quote comments, editing a
pending comment above the composer) are `components/comments/CommentTextEditor`:
this editor with comment keys (Enter submits, Escape cancels, both after an IME
composition), the `#` snippet picker and image paste, where a pasted image's
citation is a chip at once through `pendingAttachmentFilenames`.

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
  references to the next draft through `pendingComposerReferences.ts`
  (New Worktree does), which `ChatInput` consumes into its chips; a draft's
  first send with a tracker item attached posts that tracker's session-started
  status (`lib/trackers/sessionStatus.ts`), for a tracker whose descriptor
  offers `sessionComments`. Tracker chips are `tracker-item` references keyed
  `${provider}:${IDENTIFIER}`; a queued or restored message from before
  trackers carries `linear-issue`, which reads back as Linear's.
  The same module's `buildComposerContext` captures that context when a message
  is **queued** instead of sent: the chips leave the composer with the message
  (as `QueuedContextPart`s on the queue item), the server or the VS Code
  auto-send delivers them through `queuedContextToParts`, and editing the
  queued message puts them back. A queued message is placed as captured — its
  mention, file mentions, and skill instruction were resolved when it was
  queued, never at delivery — and its context follows it before the next
  queued message.
- **Skills named with `$name` are attached to the prompt, not hinted at.**
  `buildOutgoingMessage` reports the composer text's skill names (deduped, in
  order) as `skillNames`; `ChatInput` hands them to the send as
  `SkillMentions`, and `opencodeClient.sendMessage` maps each name to its
  OpenCode skill id (`GET /api/skill`; the id is the skill's folder and can
  differ from its frontmatter name) and sends them in the prompt's `skills`
  field. OpenCode then loads each skill's content into that user message. It
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
  fails before admission). Queued messages keep the instruction captured at
  queue time, because the server and the VS Code auto-send deliver them
  without the composer's registry. A `$skill` in a message that routes to
  `session.command` (a leading `/command`) keeps the instruction too: that
  route takes no skill attachments. A hand-typed leading `/name` that matches
  a skill and no command still attaches the skill (`session-ui-store`), so the
  old form keeps working; the composer just no longer offers or chips it.
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
  the command, a failed send puts the text into the fork's composer. A failed prompt command restores everything it consumed: text,
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
  files and non-empty text go to the new directory, the old directory's text
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
  including for **Insert and send**, and a toast says where it went.
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
- `ChatInput.tsx` maps Ctrl+N/P to the active command, skill, snippet, or
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
  names its session instead. A bare `ses_…` id is text.
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
- `ChatInput.tsx` applies the recalled text and attachments to the composer and
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
The first send creates the fork; Enter follows the user's preference. Pending text and references then
move to the fork's draft identity. Normal and BTW drafts remain independent,
including in memory when persistence is disabled.

Both modes reuse `ComposerEditor` and `ModelControls`; BTW transitions put the
caret at the end. BTW copies the main model/effort once, including explicit
Default, and uses `plan` or the first selectable agent. Its controlled model
path only writes BTW selections. The cycle-favorite-model shortcuts step the
BTW model from the one its chip shows and save it as the BTW model picker
does; the app-wide handlers decline while BTW is open, so the parent's model
never moves, and an open overlay stops both. As with permission keys, a key
pressed in a chat pinned in the side panel moves only that chat's BTW model,
and a key pressed anywhere else only the main chat's. The other model, effort and agent
shortcuts stay off in BTW. Files attach as in the normal composer
(picker, paste, drop) and live in the BTW draft identity's attachment slot,
so they never mix with the main draft's files; the attach control offers
only local files. Goals, expansion, shell, linked context (issues, PRs,
guests), agent selection and file/agent mention autocomplete are
unavailable. Auto-accept is applied before the first send.
On mobile, model and effort controls sit in the input's upper-left row; the
footer only contains auto-accept and send/stop controls.

Escape closes menus first. Otherwise it returns to normal: an unsent BTW is
discarded with its text, references, selections and panel; a creating or real
fork is only collapsed. Neither exit sends, aborts, or deletes a server session,
nor consumes the main draft's files, queue, or linked context. Pending snippet
expansion belongs to the unsent panel. Discarding that panel invalidates the
send, and a runtime change prevents fork creation and stale UI recovery.

The unsent panel shows "Ask your question" until fork creation starts.
Existing panels hide titles. Promotion retains the existing internal title, without
transcript fetching or Small Model generation.

## Pinned composer

A chat pinned in the side panel has a composer of its own next to the main
chat's (see the sync documentation, *Pinned chat columns*). What used to be
one app-wide composer state is split per column:

- **Model, agent and effort.** The app-wide current model belongs to the main
  chat. A pinned composer sends with `usePinnedComposerSelection`: what was
  picked in it, saved for its session in the selection store the way the BTW
  composer saves its picks, otherwise the session record's model, variant and
  agent. Its picker is `ModelControls` in controlled mode with
  `agentSelectable`, so the agent pick is saved for the session and never
  changes the main chat's agent. "Run in parallel" is offered only in the main
  chat.
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
  only.
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
  list or menu item, while a dialog, menu, open select, settings or the BTW
  composer is on screen, during IME composition, and while text is selected, because typing
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

**Every timeout and `flushSync` in them has a reason recorded next to it, and
none of them is verifiable outside a real device.** Change them only against
hardware.

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
- **Keyboard geometry is written through `lib/mobileKeyboardInsets.ts`.** The
  three values are registered non-inherited and written on their readers
  only; a new reader joins the module's selector list. On the root they
  restyled the whole page on every open and close.
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
and keeps the ordinary send button (`ComposerActionButtons` with a
`sendLabel` naming the run count), disabled below two runs or while
launching. Enter and the send button launch instead of sending. Launching goes through `useMultiRunStore.createMultiRun`, clears the
draft text and attachments, and opens the run overview. Attachments go to every
variant; prompt text is sent as typed, the way the old launcher sent it.

## Chat quote highlights

A `chat-quote` draft carries an anchor (`lib/chatQuoteAnchor.ts`): the quoted
text in its message's rendered text stream plus the characters around it. It
is captured at selection time, persisted with the draft and sent in the
context part's metadata. `message/ChatQuoteHighlightLayer.tsx` (one per
`ChatContainer`, fed by the column's `hooks/chatQuoteHighlightStore.ts`) uses it
to paint with the CSS Custom Highlight API. The store lives outside React state
and the layer holds all hover and popover state, so none of it re-renders the
chat column. The
markdown DOM is never modified. While quotes wait as context chips they stay
marked in their messages; the one hovered in the chip preview is drawn
stronger. Resting the mouse on a mark, or tapping it on touch, opens
`message/ChatQuoteMarkPopover.tsx` with the comment, edit (the selection
menu's input) and remove; the publisher's callbacks write the draft. Clicking
a quote in the preview, or the arrow on a sent quote card, scrolls to it
through the timeline controller and flashes it. Ranges are
re-resolved by text and context whenever the marked message re-renders or
remounts. Offsets only break ties. Quotes sent before anchors existed are
found only when their text appears once in the message.

A quote taken inside a page the agent showed (`openchamber_render`) has `page: { partId }` in its anchor: its text stream is the page's body, measured and re-found inside the page's frame. The layer does not paint those marks; it publishes them, asks for reveals and hears clicks through `message/pageQuoteBridge.ts` (see `message/parts/DOCUMENTATION.md`).

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
the form submit attaches.

While the comment is open, the selection menu keeps the quoted range painted
through its existing highlight overlay (rAF on scroll/resize, no polling); the
Range lives in that menu component only and is released when the comment
ends or the message unmounts.

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
`enterkeyhint="send"` and makes it submit. Its deferred Enter restores the real
Shift only while a hardware keyboard is attached: iOS autocapitalization reports
a phantom Shift at sentence starts, so a soft-keyboard Send always submits, while
a hardware Shift+Enter still inserts a newline. Alt/Option+Enter inserts a
newline, and Ctrl/Cmd+Enter is unchanged.

The expanded desktop composer always inserts a newline with Enter, Shift+Enter
and Alt/Option+Enter, and sends with Ctrl/Cmd+Enter; it ignores the Enter-to-send
preference.

Outside mobile and expanded mode, desktop Enter sends by default. The Chat
setting controls plain Enter there: "Send with Enter" sends on Enter, "Send with
Ctrl/Cmd+Enter" inserts a newline. Shift+Enter and Alt/Option+Enter always insert
a newline, and Ctrl/Cmd+Enter always sends. Ctrl/Cmd+Alt/Option+Enter keeps
the Ctrl/Cmd+Enter send behavior.
