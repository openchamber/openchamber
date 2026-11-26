# Chat messages

## Ownership

This module owns message bodies, transcript notices, selection menus, quote
highlights, attachment previews and message exports. `body/` composes message
actions and renderers. [Message parts](parts/DOCUMENTATION.md) owns individual
part rendering and tool rows; the neighbouring timeline owns virtualization,
turn projection and scroll-follow policy.

## Invariants

- Quote highlights use the CSS Custom Highlight API without modifying rendered
  Markdown. Each column publishes and removes only its own marks; named browser
  highlights merge all owners because several columns can share a document.
- The highlight layer owns hover, popover and scroll-follow state so highlight
  activity does not re-render the chat column. Streaming mutation observation
  covers marked messages and row mounting, avoiding unrelated live text.
- Revealing a quote uses the timeline controller to release live follow and
  mount virtualized rows. Page frames and lazy Markdown can appear later, so
  resolution waits for them. Long answers advance through their mounted slices
  after releasing the first-row navigation hold to avoid competing scrolls.
- Desktop mark popovers wait for a resting pointer and remain open across the
  corridor between mark and popover. Position checks cross portals reliably.
  Touch taps ending a selection leave it to the selection menu. Page marks use
  click reports because the host cannot observe the pointer inside a frame.
- A page can be inline and full screen at once. The most recently registered
  frame answers reveals, and a page opens only popovers for its own marks.
  Full-screen menus and popovers portal inside the modal to escape its inert
  outside content.
- Only one page selection is active. Dropping the tracked selection clears its
  frame highlight without echoing another selection report. A column removing
  its marks leaves every other column's marks intact.
- A selection spanning long-answer rows belongs to the row where it starts.
  Quote anchors count the entire message text across slices. Page anchors count
  the page's own text and retain the source message and render-part identity.
- Captured quotes survive native selection collapse while a comment input or
  its voice overlay owns focus. Mobile composer comment mode keeps the quote
  until attach, cancel or a scope change; changing sessions or starting a new
  draft closes the menu even when no selection event fires.
- An open desktop comment on message text follows its message when the timeline
  remounts the body in another row, as when a working step becomes the final
  answer: the leaving menu hands its quote, typed text and pasted images to the
  next menu of the same session and message that can resolve the quote
  (`selectionCommentHandoff.ts`), within two seconds; every leave and take
  drops the drafts past that deadline, so abandoned ones do not pile up. The next menu takes the draft in a
  passive effect, because it renders inside the body whose ref it reads and
  React attaches that ref after the menu's layout effects. A menu hidden with
  its session and shown again does not take back its own draft, so hiding
  still closes the comment.
- Attachment focus belongs to the column's composer before comment images are
  attached. Images from an abandoned comment never enter the composer.
- Hidden user continuations are determined by display normalization, keeping
  neighbouring visible turns continuous. Linked-item display parts preserve
  their context identity and stay client-only; their backing data stays outside
  the ordinary file shape. Provider descriptor changes refresh chip labels.
- Message comparison includes assistant error identity, tool output, synthetic
  shell-action state, pending inbox state and compaction summaries, so
  error-only, delivery-only and streamed changes reach memoized rows.
- A steered prompt (Steer, or Send now from the queue) that OpenCode still
  holds in the inbox (`isWaitingSteer`: `pending` with the client-only `steer`
  mark from the optimistic send or the inbox item's `steer` delivery) hides
  history-only actions (revert, fork, context pin) and the enqueue timestamp
  until delivery, and keeps local actions (copy, save as snippet, selection)
  available. Once the steer has waited past 1.5 seconds, counted
  from the creation time the row first rendered with (`useShownSteerWait`), its
  bubble gets a dashed border and its live region, mounted while the steer is
  pending, says it is waiting; after a reload a long-held steer gets both at
  once. A later echo with a server-stamped time does not move the deadline, so
  clock skew cannot skip or restart the grace period.
  Delivery clears both in the same render. An ordinary Send keeps its usual
  bubble however long the inbox holds it: `pending` alone never changes it.
- Image preview measurements belong to their URL. An effect-based reset can
  race the load event of a cached image and leave the viewer incorrectly sized.
- A quote popover's shadow belongs to the outer box that hugs its card. Keeping
  it off the backdrop-filter element preserves the card's matching radius.
- Image downloads read an owner-supplied loader or an inline data/object URL.
  The viewer does not fetch arbitrary remote or runtime asset URLs, and VS Code
  offers no download. Export geometry and runtime save contracts are documented
  in [message parts](parts/DOCUMENTATION.md#turn-footer-copy-and-image).

## Decisions

### Why a steer's wait shows after a grace period and on the bubble

Most steers reach the agent at its next step, within a second, so marking every
steer at once flashed a status on nearly every follow-up. The mark waits out
1.5 seconds and then changes the bubble's border to dashed. The
earlier text row under the bubble added a line that came and went, and a border
change moves nothing in the layout.

### Why the waiting outline is an SVG path and not border-style: dashed

A 1px `dashed` border draws dashes a few pixels long, which read as dots, and the
browser fits them to each side separately. `SteerWaitOutline` draws one path
around the bubble with its measured corner radii, the small tail corner
included, and sets `pathLength` to a whole number of dash-and-gap tiles, so the
dashes run continuously around the corners and the pattern closes without a
seam. A CSS mask over a solid border was tried first; it can only stripe each
side on its own.

### Why HTTP Mermaid sources use runtime URL classification

A Mermaid source URL can name the UI origin, the active remote server or an external host. `runtimeFetch` owns that distinction so active-server reads retain authentication even when the UI has another origin; external URLs keep their destination without runtime credentials. Inline data/blob image reads use `fetchBypassingRuntimeBridge`.

### Why selection overlays use text rectangles and not whole Range boxes

Comment focus removes the native selection, so the captured quote uses overlay
rectangles from text nodes merged per visual line. Whole Range rectangles also
include block boxes whose translucent overlaps create dark bands.

### Why selection placement uses the scroller and not the message bounds

The chat or BTW scroller bounds the menu so it stays away from the desktop drag
zone without covering the message's first lines. Placement prefers space above
or below the quote, hides while it is scrolled out of view, and remeasures when
editing changes the menu size. Whole-pixel coordinates keep text sharp on
non-retina screens.

### Why mobile comment focus is synchronous and not deferred

The editor mounts and focuses inside the tap's synchronous call stack because
iOS raises the soft keyboard only during that gesture. The visible composer's
scope is captured at the same time so later target changes cannot retarget it.

### Why quote capture waits for commenting and not every selection change

Anchoring reads the full message text. Capturing when the user commits to a
comment avoids repeating that work while they adjust the selection.

### Why animation choice is latched and not updated mid-transition

Virtualized history suppresses entrance animations while new content can animate.
The mount-time choice stays fixed because removing the wrapper mid-transition
cuts its translation short and makes the content jump.

### Why touch actions use sheets and not an always-visible row

Touch has no hover, and several minimum-size buttons push footer metadata onto
extra lines. Touch sheets reuse the pointer handlers; clipboard success uses a
toast because the sheet closes before a button can show its copied state.
Extension actions share one desktop menu to keep the hover row bounded.

### Why user expansion releases follow and not the sticky header

Expanding a regular prompt releases end-follow so its beginning stays visible.
A sticky turn header expands over its turn and keeps following the reply.
Only that header contains overscroll, since containing ordinary prompts prevents
wheel events from reaching the chat.

### Why user parts use positional keys and not optimistic part IDs

The server echo replaces optimistic part IDs. Positional keys keep the text
subtree mounted through that replacement, avoiding a blank frame and height jump.

### Why message containment avoids a compositor transform

The transcript scroller already has a compositor layer. Giving each message its
own layer with `translateZ(0)` adds GPU tiles without improving containment.

### Why full-answer images render source and not the visible row

A long answer can span several virtualized rows, and earlier text can be folded
or unmounted. Export renders every text part afresh so it includes the whole
reply and settled highlighting.

### Why the PNG carries the app's loaded fonts

The export SVG runs outside the chat document. Its font scanner can read
stylesheet rules, but the app loads its appearance fonts through `FontFace`.
The font loader registers each URL-based face at once and reads its data for
the SVG in the background, so the exporter can add it alongside stylesheet
fonts such as KaTeX, usually without another request on Save. The screen face
never waits for that read, so startup and terminal refits keep their timing.
Without the embedded copy, longer fallback glyphs can wrap inside a code chip
measured with the original font. A failed read is not kept: the image still
saves without that face, and the next Save reads it again. A face still loading when Save starts is waited for, up to 2 seconds, so the PNG embeds the face the layout was measured with.
The VS Code webview retains its existing font policy and skips the CDN prefetch.

### Why plan dialogs mount lazily and not on every streaming message

The dialog first mounts when opened, then stays mounted for its closing
animation. Unopened dialogs add no rendering work to streamed messages.

### Why footer facts use measurement and not width breakpoints

The model name's actual truncation determines whether lower-priority facts fit.
Container breakpoints cannot account for name length, and clipping a wrapped
second line leaves holes. Refitting follows text, container and font changes;
unchanged renders avoid the forced layout.

### Why copied links use runtime identity and not every window's address

Desktop and Capacitor window addresses do not open their sessions elsewhere, so
they copy native deep links. Web copies its own address. VS Code supplies no
message link because its private OpenCode sessions may be absent from desktop.

### Why dynamic diff previews use unified and not split layout

A chat preview's column is too narrow for side-by-side content. Dynamic layout
therefore resolves to unified, matching the walkthrough.
