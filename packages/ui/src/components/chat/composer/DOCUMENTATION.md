# Composer

The chat composer: the prompt language, the editor that renders it, and
everything between typing and sending.

`ChatInput.tsx` (one directory up) is the orchestrator. It holds the composer's
own state and wires these modules together; it should not grow logic that
belongs to one of them.

`ChatContainer.tsx` keeps one `ChatInput` mounted while a new-session draft
becomes its first session. Draft-only UI first fades for 120ms while the editor
stays in place. The parent then moves the editor to its final session position
with a 180ms transform-only FLIP animation. Reduced-motion mode skips these
transitions. `session-ui-store.ts` marks sessions materialized from a submitted
draft, so selecting an existing session while a draft is open switches without
animation. Do not restore separate draft and session composer branches:
remounting the editor loses focus and interrupts the transition. Keep the
existing mobile fixed-position rules unchanged.

`ComposerFloatingPanel` is the shared frame for `BtwPanel`, `PermissionDock`,
`FormDock` and `QueuedMessageChips`. They mount inside the composer form, outside both the
full editor and collapsed mobile pill, with one absolute `bottom-full`
anchor, input-column width, gap, and glass surface. Appearing, disappearing,
or collapsing a panel does not resize the transcript or composer.
The frame also owns the header row through its `header` and `compact` props;
callers supply controls and content, not their own header padding.

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

`formCardState.ts` decides what both surfaces show and send, mirroring
OpenCode's `Form.validateAnswer`: fields are evaluated in declaration order,
a `when` clause reads only the answers of active earlier fields (an
unanswered target is false for `eq` and `neq` alike, so hiding a field hides
its whole chain of dependents), and the reply carries only active fields.
An `external` field must be answered `true` or the server refuses the whole
reply: the dock acknowledges it when its step opens, the card (all fields on
screen) from the start, and an unacknowledged link counts as missing.

An MCP elicitation is a form OpenCode files under the session id `global`
(`LOCATION_SCOPED_FORM_SESSION_ID` in `sync-context.tsx`): it belongs to the
directory, not to a turn. `useScopedBlockingForms` appends the directory's
`global` forms after the session subtree's own, so the dock (and the BTW
sheet's inline card) offer it from every session of that directory, and the
reply resolves its directory from the store that holds the form.

`PermissionDock` is the agent's permission requests for the composer's
session, its subagents' included, in the same frame: one dot per pending
request with the current one solid, the request's tool in the header, and
Deny / Always allow / Allow once through the shared response hook, so
Alt+Enter, Alt+Shift+Enter and Alt+Backspace answer the current request. A
pending permission hides the form dock, the queue chips and the suggestion.
The BTW sheet keeps the inline `PermissionCard` for its child session's
requests; both render the request through `PermissionRequestContent` and
`PermissionActions`.

`SessionSuggestionChip` is not a frame: it renders as the composer's own top
row, inside the box and inside the mobile pill, so the surface stays one
shape. Visibility priority is BTW, then a pending form, then a nonempty
queue, then suggestion. Every BTW frame, including its collapsed strip,
creation state, and pending draft, hides the other three. Composer content
also hides suggestion; new-session drafts hide form, queue and suggestion.
Hiding the queue does not pause its delivery.

The queue header toggles an `aria-expanded` disclosure with the current count.
Its open/closed state is one persisted preference in `useUIStore`
(`messageQueueExpanded`, open by default), shared by every session and
surviving session switches and reloads.
The expanded list retains its drag sensors, ordering, edit, send, and remove
actions, and clamps to available space above the composer. It receives the
composer's main-session queue target instead of resolving the global selection,
so embedded chat columns address their own queue.

The shared frame measures its height and gap into the chat column's
`--chat-floating-panel-clearance`. The floating status row and
`ScrollToBottomButton` translate upward by that amount, the transcript's tail
spacer grows by it (so the frame never covers the last rows), and the column
carries `data-floating-panel` while any frame is mounted so the recap hint
hides instead of landing over the transcript. Unmounting clears the offset
and the marker; resizing or collapsing the frame updates it.

## Floating composer

In a normal session view the composer slot is an absolute layer over the
bottom of the transcript (`ChatContainer`), and the input box is glass
(`oc-glass-composer`). The draft screen and the expanded editor keep the slot
in flow. A `ResizeObserver` on the slot writes its height into the chat
column's `--chat-composer-inset`; the timeline's tail spacer reads that
variable plus a fixed gap, so the last row always ends above the composer.
The variable is written straight to the DOM, so composer growth never
re-renders the timeline: the list's own footer observer extends the content
and the scroll hook's pinned-end observer keeps a reader on the end. The
mobile keyboard choreography is unchanged: the form inside the slot is still
the keyboard mover and the column shrinks around it at settle.

Glass does not nest: a `backdrop-filter` element is a backdrop root, so a
glass child only blurs its parent's content. Popups therefore anchor to the
wrapper outside the box, and the dictation overlay (`.oc-dictation-overlay`)
never stacks glass on glass: a CSS rule in `design-system.css` hides the
composer's own contents while it is up, leaving the box as the single glass
surface on desktop and the overlay itself on mobile.

## Layers

| Directory | Owns |
|---|---|
| `language/` | What the text *means*: `@` references, `/` and `#` tokens, markdown, and which picker a caret asks for |
| `editor/` | The CodeMirror view that renders the language and owns the caret |
| `state/` | Composer-local lifecycle state: ArrowUp/ArrowDown browsing, draft stash/restore, mobile shell, popup placement, draft targeting |
| `comment/` | Mobile comment mode: quoted-selection state, its scope ownership, and the shell that replaces the composer while a comment is written |
| `submit/` | Turning what the user has into what gets sent. `guestCommands.ts` routes an extension's slash command (`contributes.commands`) before anything is sent: `/name args` never reaches the model, the extension resolves it into a chip |
| `attachments/` | Files: paths, drop payloads |
| `ui/` | Presentation. `ComposerAttachmentControls` lists files, GitHub, Linear, then guests with `contributes.attach`. `"panel"` opens the rail. `"dialog"` opens `GuestAttachDialog` with that guest iframe and `ready.surface: "dialog"` (loading `attachEntry` when the manifest declared one). `host.attach` writes the composer chip. Clicking that chip reopens the guest with the chip as `ready.item`: dialog guests get it as a prop, panel guests through `lib/guests/item-store.ts` and the rail. Message and session actions (`contributes.actions`) travel the same two roads with a `GuestMessageItem` / `GuestSessionItem` (`lib/guests/dialog-store.ts` `openGuestWithItem`); the dialog they open lives in `layout/GuestHosts.tsx`, not here, and an `attach` from it closes it through `handleGuestAttach`. The chip keeps the guest's opaque `data` (also on the `guest-issue` / `guest-pr` context part metadata and the session `LinkedGuestIssue` snapshot) so it comes back byte-identical; it is never part of the context text. VS Code and mobile skip that list. |
| `text.ts` | How inserted text meets the text already there |
| `largeTextPaste.ts` | Detect large plain-text pastes and build virtual `.txt` files |
| `largeTextPasteOffer.ts` | Ask-toast offer id begin/resolve (supersede + double-apply guards) |

`ChatInput.handlePaste` owns paste orchestration: URL-over-selection markdown
links, clipboard files, and large plain-text pastes. Pasted and dropped files
share `attachFilesWithCitation`: every file attaches and is cited in the draft
as `[name]`; images get a generated unique name first, other files keep their
own name and are cited only after they attached. A copied file's filename text
is suppressed so only the citation lands in the draft.
Large pastes (about 2,000 characters or 25 lines) follow the composer setting
`largeTextPasteBehavior` (`ask` / `attach` / `inline`). Attaching creates an
in-memory `text/plain` file named `pasted-context-N.txt`, inserts a bracket
citation, and sends it through the same attachment pipeline as a manually
picked `.txt` file. Ask-toast actions read live composer/attachment state so
typing or other attaches between paste and choice stay consistent. Short text,
images, and URL wraps keep their existing paths.

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
  picker, the same way `/skill` tokens behave — not an atomic delete.
- `prefixTokens.ts` — `/command`, `/skill`, `#snippet`. Scanning is deliberately
  generous; **membership in the command, skill or snippet registry is the
  authority**, not the pattern. An unknown `/token` stays plain prose.
- `triggers.ts` — which picker a caret position asks for. Exactly one can be
  active, with precedence `command > skill > snippet > mention`.
- `tokenize.ts` — one pass producing every highlight range. Adding a construct
  to the language means adding it here, once.

## The editor

`editor/` wraps CodeMirror. The document is a plain string: `getValue()` is
exactly what gets sent, so nothing downstream serializes a rich document model
back into a prompt.

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

- `editor/ComposerEditor.tsx` forwards a click on the composer's padding by
  focusing the view *before* setting the selection: CodeMirror reveals its
  drawn caret through a class it only writes while applying an update, so the
  selection has to be the update that follows the focus.
- `submit/buildOutgoingMessage.ts` flattens queued messages, the composer text,
  context drafts and linked references into OpenCode's one-primary-plus-parts
  shape. The oldest queued message becomes primary. **Every attached context
  item (inline comments, terminal selections, browser annotations, PR context,
  linked issue/PR) becomes its own synthetic text part carrying structured
  metadata** built by `lib/messages/contextParts.ts`; the timeline reads that
  metadata back to render context blocks. PR instructions precede the PR diff.
  The same module's `buildComposerContext` captures that context when a message
  is **queued** instead of sent: the chips leave the composer with the message
  (as `QueuedContextPart`s on the queue item), the server or the VS Code
  auto-send delivers them through `queuedContextToParts`, and editing the
  queued message puts them back. A queued message is placed as captured — its
  mention, file mentions, and skill instruction were resolved when it was
  queued, never at delivery — and its context follows it before the next
  queued message.
- **Skills named inline (`/name`) are attached to the prompt, not hinted at.**
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
  without the composer's registry. A leading `/skill` that routes to
  `session.command` keeps the instruction too: that route takes no skill
  attachments.
- Extension slash commands are routed first (`submit/guestCommands.ts`,
  entries from `useGuestCommands` minus every name the composer already
  knows, so an extension can never shadow a built-in, an OpenCode command, or
  a skill). The command text is cleared and `runGuestCommand`
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
  context with the prompt they produce. Session actions are planned only when
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
  Fork replay text and files arrive in `input-store.pendingComposerRestore`,
  addressed to the fork's runtime, directory, and session. The hook consumes
  them after loading that identity's draft. Selection alone is not enough:
  the deferred chat column can still show the source composer. Ordinary
  pending text insertions keep their existing path in `ChatInput`.
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
- `state/useDraftTarget.ts` — the draft can target a directory that does not
  exist yet (a worktree being created). It must survive not appearing in the
  branch list, or the selector snaps back to the project root mid-creation. It
  also owns the advisory dirty state for the selected directory, clearing it as
  soon as the target changes so a warning never names a previous branch.
- `ui/DraftTargetSelectors.tsx` owns the controlled project/worktree picker
  state and registers its application shortcuts locally. The desktop project
  picker is a searchable popup: it ranks the current projects with
  `rankByQuery` over display label and path, keeps the query and the active
  result as transient local state that resets on every close, and commits
  through the existing project-change flow only on explicit activation.
  Filtering changes the result area below the anchored input without moving
  the search field. The worktree picker remains a Select; mobile keeps its
  bottom sheets. `ProjectPickerSheet` shares the mobile project list and
  transient search state with the Settings selector. Settings passes its own
  directory selection callback, so choosing a project there leaves chat in
  place. Both callers use the same ranked label/path search and project icons.
  The selectors only consume their shared prefix while the
  draft target UI is mounted.
  Keyboard selection returns focus to the current form's composer, including
  when the selected value is unchanged.
- `ChatInput.tsx` maps Ctrl+N/P to the active command, skill, snippet, or
  mention picker after its IME guard.

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
path only writes BTW selections. Files attach as in the normal composer
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

## Mobile

`state/useMobileComposerShell.ts` and `state/useMobileViewportPin.ts` are
mostly not state machines but corrections for specific platform behaviors:
mobile browsers dismissing the keyboard before a tap's click lands, iOS
refusing programmatic focus outside a gesture, WebKit leaving the layout
viewport panned after the keyboard hides, overlay chains handing off through a
frame where nothing is open.

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
in the native iOS shell only. The swap commits synchronously (`flushSync`); the glass box
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
without a keyboard. The transcript rides it through
`lib/scroll/keyboardFollowGlide.ts` (owned by `useChatTimelineScroll`): the
morph announces `oc:composer-morph` (`hold` with the slot's height delta,
`glide` and `release` when it runs without a keyboard), the glide holds every
automatic end write while a transition runs, lets the geometry land in one
step, and drives scrollTop on the same curve. Mobile browsers, Android and
reduced motion keep the instant swap.

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

## Mobile comment mode

On mobile, "Comment" on a text selection does not open a floating input. The
selection menu (`TextSelectionMenu.tsx`) hands the quote to this column's
composer through `comment/MobileCommentComposerContext.ts`; `ChatContainer`
creates one controller per column so an embedded column's selections never
comment into a sibling. Desktop keeps its floating input in the selection
menu; only the mobile path changed.

`comment/mobileCommentDraft.ts` owns the lifecycle. The scope (runtime,
directory, session) comes from the visible composer's inline-draft target,
including an expanded or pending BTW composer. A collapsed BTW uses the main
composer's target. The hook publishes that scope before paint; the selection
menu supplies only the quote. The scope is captured when the comment opens and
is the only place the quote may land: attach writes a `chat-quote` draft into
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
While it is mounted, the composer's wrapper-level dictation engine is not —
two engines would both answer the global `openchamber:dictation-toggle`
event, and a transcript meant for one editor must not reach the other. A
recording in flight when comment mode opens is discarded by that swap.

The comment editor reuses `ComposerEditor` with `dataChatInput="comment"` so
the `data-chat-input="true"` helpers (`focusChatInput`, shortcut guards) keep
meaning "the prompt editor".

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
deferred Shift modifier. Ctrl/Cmd+Enter remains available for external keyboards;
Send and Queue buttons retain their normal behavior. The Enter-to-send setting
and its search entry are hidden on mobile without changing the desktop preference.

The expanded desktop composer always inserts a newline with Enter, including
Shift+Enter, and sends with Ctrl/Cmd+Enter; it ignores the Enter-to-send preference.

Outside mobile and expanded mode, desktop Enter sends by default, and
Shift-modified Enter does not send until the Chat setting is changed.
An explicit choice controls Enter and Shift+Enter there;
Ctrl/Cmd+Enter sends in either configured mode.
