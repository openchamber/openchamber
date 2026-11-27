# Chat column

## Ownership

The column binds one shown session to its transcript, composer, navigation, loading state, and work-status placement. The sync layer owns session records and history loading; the timeline controller and scroll hook own row navigation and viewport positioning. Composer state owns inset calculation and publication, and the layout right slot owns the shared width animation for work status and the context panel.

## Invariants

- Session ID and directory travel together through deferred selection so timeline keys, subscriptions, and loader targets always refer to the same session. The live selection updates the sidebar, URL, and tab before the interruptible transcript transition finishes.
- A pinned column navigates locally and resets only when its owner supplies a different origin. Its timeline dialog is local; the main column uses app state so the global shortcut can open it. Returning to a parent is hidden at the pinned origin because that parent is already in the main chat, but remains available in deeper subtasks.
- Mobile message selections use a controller owned by their column so quoted comments reach that column's composer.
- A pinned session demands bootstrap for its own directory because app bootstrap covers only the current directory and globally selected session. History retention follows the actually rendered session through the deferred switch until commit.
- Automatic draft opening reads the live selection and rechecks the store inside the effect because routing or effect replay can select a session after render. The automatic flag preserves the persisted last-session pointer used by cold-launch restore.
- Archived space sessions are read-only, with execution also refused by the server. A new draft can still inherit the archive directory before sending, so archive read-only state requires a session ID.
- Read-only chats keep permission and form docks answerable even though they do not show `ChatInput`. Parent and child views share those requests, so answering in either clears both; a running subagent also remains stoppable.
- A dictation started in the column's composer survives opening a session that cannot be prompted. While the recording runs, transcribes or waits after a failure, `ComposerSlot` keeps `ChatInput` mounted and hidden, and the read-only row shows the recording with the same controls a panel field shows (`DictationStatusControls`). Finishing there acts like the overlay's check: the transcript goes to the draft the recording started in. While hidden, Enter and the dictation shortcut confirm as insert even with auto-send on, because the session on screen may be the recording's own session that just became read-only (an archived space, a removed folder). The composer is unmounted once the recording ends. Message selection in a read-only chat shows the same recording in its bar (`../messageSelection/DOCUMENTATION.md`).
- Prompt ownership falls back to the global session record when the selected directory's live store has no record. Cross-worktree workers can read their transcript through the parent's directory; they stay read-only until Take over removes their operator-child metadata, regardless of the subagent prompting setting.
- Blocking requests cover the current session and descendant subagents. Unrelated sessions in the directory cannot block this column.
- Once the directory status snapshot arrives, an absent session status means idle because stopping OpenCode can leave an incomplete persisted turn. Before authoritative status arrives, the incomplete-turn fallback uses the last conversation message because synthetic, skill, shell, and switch records can follow it.
- Part-update suspension applies only to the streaming message while no page waits for the user. Only the live tail overlays suspended parts, so waiting pages and opened Activity rows need current record parts.
- A failed initial history load shows its error and retry even if live notices already arrived. Partial records cannot hide an unresolved transcript's load failure.
- Only command subagent reports create separate transcript turns. Call reports finish their tool row, runs predating loaded history remain in the subagent list, and commands launched from reply code blocks stay in those blocks, preventing duplicate rows and transcript shifts.
- History trimming reacts to both turn starts and ends because queued prompts and agent loops can immediately start another turn. Its delay exceeds the send and turn-end glide windows; prepending history does not rearm it, and a reader away from the end retains history across columns.
- Loading older history releases live follow before prepending so content growth cannot pull the reader back to the end. Short, non-scrollable histories remain manually pageable, and hash navigation releases follow while its handler owns positioning.
- Linked-message probing precedes history traversal to avoid paging through a session for a nonexistent target. Only a 404 establishes absence; other failures leave existence unknown.
- Work-status readouts follow a draft's pending worktree or directory override so they describe where the draft runs. Pinned columns leave app-wide work-status flags to the main chat, which clears them on unmount so the header can restore its own readouts.
- A lead with a digest shows it as one row between the header and the transcript (`LeadDigestRow`, main column only): what needs the user as a count in the waiting colour, then the first line of its current work and how long ago it was written. The row sits in the column's flow, so the transcript's top fade stays right under it and no line separates them. Opened, the full digest is a popover over the transcript, which keeps its height and position. The popover lists what waits on the user first (questions, then suggestions), then what changed since the user's last message, then where each strand stands. It is a form: each question offers the lead's answers as chips, its recommendation first in the primary text colour, plus a field for the user's own answer; each suggestion has Accept and Decline. Choices stay local until the reply goes out as one synthetic input with `openchamberLeadAnswer` metadata (`{ answers, suggestions }`; older messages hold a single `{ question, answer }`), which wakes the lead, shows in the transcript as a notice and marks those items answered until the lead next writes its digest. The reply goes out when a click settles the last open item, or on Send or Enter in an answer field for a partial one. The text tells the lead that accepted suggestions join its queue behind the work in progress. Declined suggestions are also recorded in `lead.dismissed`, which the server keeps the lead from offering again. The draft belongs to the `updatedAt` of the digest it was made on, so a rewritten digest starts clean even where an item kept its text. Items this client sent stay closed from the moment the request succeeds, before the synthetic message arrives through the event stream, so they cannot be sent twice.

### Why the digest sends one reply and not one message per click

A message per answer woke the lead once per click and each wake read as a new instruction, so an accepted suggestion interrupted the work in progress. One reply gives the lead every answer at once, with accepted work framed as queued.
- Transcript edge fades track the scroller. Dragging its overlay scrollbar transfers ownership from automatic follow to the reader.
- `ChatTranscriptContext` marks the main transcript as eligible for settled assistant table expansion. Each table finds its own nearest chat scroller in the DOM, so retained timelines never measure against the currently selected session's scroller. Pinned columns mount the same viewport with the context off, so their tables keep the message-width layout and controls; the context is also absent from Btw transcripts and other Markdown surfaces.

## Decisions

### Why the compact draft label wraps with its trailing text

The heading takes its width from the padded column so a long project name cannot widen it. The name wraps in its own box. Punctuation right after the name, such as the `?` in `{project}?` or the comma in `{project}, bevor das Jahr endet?`, shares that box and stays with the last character even when the name has no spaces; the words after it follow the box as ordinary text. The box keeps one line and clips during its width animation so the heading does not gain extra lines at intermediate widths, which is why words after the name stay outside it. A wrapped name can make the heading taller than a short draft area, so the column scrolls and centers only while its content fits.

### Why prompt ownership also reads the global record

A cross-worktree worker can load its transcript through its parent's directory without joining that directory's session list. The global record already carries its ownership metadata, so a missing live record cannot expose an editable composer.

### Why the digest popover's scroller is a block and not a flex column

On touch screens `mobile.css` gives every `.flex.flex-col` `min-height: 0`. With the scroller as a flex column under the popover's height cap, each section is a flex item that can shrink, so on a phone a long section shrank below its text and the next one was drawn over it. As a block, the sections keep their full height and only the scroller scrolls; `space-y-3` spaces them 12 px apart, the same as `gap-3` in a column.

### Why hold the previous transcript and not immediately show a skeleton

A bounded hold avoids a skeleton flash between conversations while an uncached session loads. It ends when the target is renderable or the hold expires, and applies only when a previous session is visible and the target is not a newly materialized draft.

### Why close search during render and not in a passive effect

Search results belong to the session that opened them. Synchronous closure prevents a commit from focusing an old hit under a new session ID and producing a false missing-message notice.

### Why route search by focus and not a global chat shortcut

The focused editor retains its own search; an unfocused page routes the shortcut to the last pressed chat column. Disabled search leaves the shortcut alone, and VS Code skips chat search because it has no OpenChamber server index.

### Why share the reply's speech key and not create an automatic-reading key

Automatic speech uses the reply message ID so its message button shows playback and can stop it. Busy and retry status keep the automatic-reading baseline active during permission waits even when `sessionIsWorking` pauses; pinned columns do not start automatic speech.

### Why retain timelines by session ID and not the full session key

The directory can settle after opening, so caching by the full key can retain a second hidden copy of the same session. The list still remounts on a full-key change; mobile retains only the open timeline because retained DOM increases web-view memory pressure, while other surfaces reuse recent timelines.

### Why transcript eligibility uses context and geometry follows the table

The context marks only the main transcript. A table reads the nearest chat scroller that contains it, so a retained timeline cannot borrow the active session's viewport through a shared ref.

### Why keep a fixed history header and not toggle its slot

The load-older button toggles inside a permanently reserved header. Changing the height above the rows shifts an end-pinned transcript during sends and reverts.

### Why reserve composer space in the footer and not add list overlay height

The footer reserves the floating composer, its gap, and docked panels so the last line stays readable. Passing additional composer overlay height to the list double-counts that space; while working, the footer also covers the full composer height because the status row and live fade occupy its growth allowance.

### Why publish insets to readers and not through column state or inheritance

Resize observers write `--chat-composer-inset` and `--chat-composer-tail-inset` directly to registered readers so composer growth resizes the footer without rerendering the timeline or restyling every transcript descendant. The list's footer observer then accounts for the new height.

### Why observe the slot node and not only component mount

The session gate can mount the composer slot after the first commit. Node-based observation attaches when the element actually exists.

### Why learn resting height from the natural composer and not transient content

Read-only banners, mobile comment composers, and morph-pinned inline heights cannot establish the resting height. Their shorter measurements can otherwise leave the natural composer permanently classified as grown, hiding the recap until reload.

### Why place the recap in the tail spacer and not an answer row

Row paint containment clips content outside each row. The recap is absolutely positioned in the spacer so showing it never shifts the transcript, and it hides while work, composer growth, or a docked panel occupies that band.

### Why anchor composer riders together and not position them independently

A shared zero-height anchor on the slot's top edge makes the status row and scroll button follow keyboard movement and the mobile pill morph without jumps. The status row shares the pill's column and distance from the input; its glass chip lives inside `StatusRow` because the size-container root cannot shrink-wrap.

### Why reserve status height before measurement and not only after it appears

A fixed minimum reserve keeps the transcript end stationary when the status row appears a commit after opening. Measurement only extends that reserve and includes the external 8 px margin that the node's box omits.

### Why settle geometry before reveal and not fade an unsettled timeline

Each opened session has a reveal gate held until viewport positioning completes; the timeline then stays end-pinned unless the reader releases it, while measured row heights settle. A bounded settle still reveals continuously growing content, and immediate visibility after settling avoids delaying reading with a fade; Markdown highlighting only recolors its already laid-out geometry.

### Why close the reveal gate in a microtask and not directly in the layout effect

Rows can acquire holds in layout effects during nested synchronous mounts. A microtask runs after those effects and before paint, so the gate includes every hold for the commit.

### Why wire the history loader during render and not in a passive effect

The scroll hook needs history loading while the timeline controller needs scroll commands, so a ref connects them. Entry restoration runs in a layout effect of the same commit; the current loader must already be assigned, and linked-message traversal retains browsing history so trimming cannot restart its search.

### Why jump between turns and not smooth-scroll across virtual rows

Virtualized row remounts can cancel a long smooth scroll before its target. Prompt navigation uses an immediate jump; synthetic turns select the preceding real prompt to keep the rail stable, and its mark requires 3 real prompts because shorter rails look like a stray dash. Mini chat omits the navigator panel because it is too narrow.

### Why preserve layout capacity and not measure the visible work-status card

The containing row supplies width independently of panel visibility, preventing visibility from changing its own fit measurement. Eligible panels stay mounted for animation, the right slot reserves the column while the context panel covers it, and an enabled panel that cannot fit remains available as an overlay.

### Why hold stopped-space loads and not wait for request timeouts

Session messages live inside the space, so stopped or unreachable spaces show their placeholder while loading is held. Space recovery and reauthentication retry held or failed loads so the error view ends with its cause.

### Why blink loading rows and not continuously pulse them

Hydration can wait minutes for OpenCode startup. Loading rows use the shared 1 s blink and stop animating behind the expanded composer.

### Why keep a minimum scroller width and not allow it to collapse to zero

The scroller keeps a 1 px minimum width because zero-width rows lose scrollable height and their saved scroll position.

### Why a read-only chat keeps a recording composer mounted and not move the recording to the app root

The recording, its keys, its failure salvage and the transcript's routing to its origin draft all live in the composer's `ComposerDictation`. Moving them to an app-root host like plain fields have would rebuild that machinery for one case. Keeping the composer mounted, hidden, only while a recording is active leaves every path the same as a switch between two editable sessions.
