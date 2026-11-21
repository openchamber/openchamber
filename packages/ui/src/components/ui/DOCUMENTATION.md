# Shared UI primitives

## Ownership

This folder owns runtime-independent controls and their Base UI integration, including dropdown focus and dismissal. Feature-specific model filtering belongs to `components/model-picker`.

## Invariants

- A root dropdown opened by keyboard or controlled state stays open when the pointer leaves its popup. Hover dismissal applies only to a dropdown opened by trigger hover.
- Escape, outside presses, item selection, and window blur retain their normal dismissal behavior. Submenu hover behavior stays with Base UI.
- An open dropdown whose content changes (a filtered picker list, items that arrive late) eases into its new height (`useHeightMorph` in `DropdownMenuContent`); the edge facing the trigger stays where it was in every painted frame.
- Each opening has its own hover-dismissal eligibility; closing clears it.
- Command palette recent sessions and session-name search share the session
  admission filter. Their raw global cache remains complete; registering a
  destination updates the open palette through its project/worktree subscriptions.
- Command palette extension entries (session actions, slash commands) are
  search-only and run what the session header menu and the composer run: a
  session action needs a current session and reads it when picked; a command
  waits in the main composer for its argument and is sent by the user. The
  palette and the slash menu drop the same reserved names
  (`reservedComposerCommandNames`). An entry's `keywords` (the extension's
  name, a command's description) find it too, ranked below entries the query
  matches by their own text, so "task" lists the command `/task` before an
  action of the Task Board extension, and the highlight stays on the title.
- The command palette is its input and one list: no filter chips, tabs or
  typed flags, and nothing kept between openings. Text such as `project:foo`
  is searched as it is typed, and Tab keeps its default behavior.
- With a query the list has a Sessions group (active sessions, by title,
  project, worktree or folder) and right under it an Archived group (archived
  sessions, by title only, three at most). The other name groups sort around
  them by their best match, and Messages comes last.
- Message hits are a preview of three; "Show all" opens a view of message hits
  only, for the same query, with paging. Escape, Backspace on an empty input
  and the Back row return to the full list, and a second Escape closes the
  palette. The view is local state and resets on every opening.
- The palette asks for message hits of active and archived conversations alike
  (`lifecycle: 'all'`) and lists a hit only when its folder passes the session
  admission filter. A hit is marked archived when the archived-session cache
  has its session; the active cache clears a stale mark.
- A second request asks for archived conversations alone
  (`lifecycle: 'archived'`). Its hits that the first request has not listed
  follow the preview's three, three at most, and in "Show all" form an Archived
  group with its own paging.
- An archived session or message hit opens through `openSessionLink`, which
  selects the session and leaves it archived.
- Icon actions over a document (the Files editor, a plan, a page, image or diagram in the chat, diff headers) use `ToolbarButton` from `action-toolbar.tsx`: 24px, a 14px icon, colour-only hover, the selection fill while a toggle is on, faded while disabled. A toggle keeps one icon and one label naming the option; the fill says whether it is on.
- `ActionToolbar` takes the actions a document has, which depend on what the document is and never on its mode, so a mode switch moves no button. Its groups sit apart by space; with `fold`, unpinned actions move into "More actions" from the end of the row while it does not fit, after `start` gave up its width.
- `Textarea` offers emoji on `:` in both modes (`components/emoji/`, placed by `components/inline-picker/`); its forwarded ref is the textarea element itself.
- A bottom sheet's list is built from `MobileSheetList`: `MobileSheetRow` for every option and action, `MobileSheetSection` for its captions, and `MobileSheetSearch` in `MobileOverlayPanel`'s `subheader`, so the field stays put while the list scrolls. The chosen row takes the selection fill and a check. The model sheet draws its own rows to the same measures, because its list is virtual.
- On a phone `DialogContent` is a bottom sheet: `mobile.css` shapes every dialog through `data-slot`, so callers keep one markup for desktop and phone, and the layer's keyboard rider follows the whole keyboard. Tablet layouts and a dialog with `items-start` on its layer keep their centred window.
- A dialog that covers the whole window passes `fullWindow`, which leaves out `pwa-dialog-content` and `oc-window-corners` (an unlayered radius that beats a caller's `rounded-none`). In an installed app window 768 px wide or narrower, `mobile.css` gives that class a max height and padding outside any cascade layer, so it beats the caller's Tailwind classes and would shrink the dialog off the window's edges.
- Every scroller a user sees draws the app's overlay scrollbar, never the native one: `ScrollableOverlay` for a scroller the caller renders, `AttachedOverlayScrollbar` for one a library creates (CodeMirror's `.cm-scroller`), `PopupOverlayScrollbar` for a popup that scrolls itself (`DialogContent`, `DropdownMenuContent`, `ContextMenuContent`, the framed `Textarea`). A new `overflow-auto` element goes through one of them. Only fallback screens after a crash keep the native bar, so they depend on nothing that may have failed.
- `OverlayScrollbar` draws a thumb only on an axis whose computed overflow is `auto` or `scroll`: a scroller its owner switched to `hidden`, or a menu left at `visible`, overflows without scrolling and shows none.
- Tab strips keep their scrollbar hidden. `SortableTabsStrip` maps vertical mouse wheels to horizontal scrolling only when `scrollWithWheel` is enabled and the layout is scrollable. Scrolling never selects a tab. Horizontal gestures, Shift+wheel and Ctrl/Cmd+wheel keep their native behavior. The shared `tab-strip-wheel.ts` handler also serves the header session tabs.
- `AttachedOverlayScrollbar` needs a positioned ancestor sharing the library-owned scroller's top and right edges. Its track inset stays identical in rendering and drag calculations, and thumb drags notify the owner because the sibling thumb bypasses the scroller's gesture listeners.
- Scrollbar bindings follow the current container node on every commit because virtualized timelines replace that node on session switches. Prop changes update the existing binding; mounting and unmounting own browser resources.
- Scrollbar visibility remains separate from positioning. Suppressed programmatic motion does no DOM work, and revealing a thumb refreshes overflow and position; hover visibility spans both the scroller and its sibling thumb so the hide timer cannot fire between their pointer events.
- `useScrollShadow` tolerates fractional end offsets, avoids observing the attributes it writes, and clears those attributes when a retained scroller stops owning the shared fade. Opaque scrollers use sibling fade bands inside a positioned frame, with the same surface colour.
- `ActionToolbar` callers keep the status slot's width stable and report menu openings to focus owners. Button recognition attributes also reach folded menu items; `onMenuSelect` handles actions whose transient completion check would disappear with the menu.
- Checkbox and radio fill follows React props from the first paint. Their selected marks stay neutral, primary colour stays reserved for primary actions, and a real outline remains visible during hover and press.
- Dropdown trigger callers add layout classes only. Shared trigger geometry and interaction colours come from `dropdownTriggerVariants`; raised controls use the canvas tone in light themes because the elevated tone is darker than the page.
- Exact Ctrl+N/P remain dropdown navigation commands during composition; other composing keys pass through. Physical key codes preserve those commands on non-Latin layouts.
- Dates use local ISO dates, and a date picker that becomes disabled closes its calendar so an answer from another device cannot change a frozen field. Mobile sheet search stays above the list and avoids autofocus so the keyboard does not cover the choices.
- CodeMirror read-only mode disables both direct editing and state-changing commands. Widget containers belong to the editor instance and survive viewport disposal; detached edits map the remembered scroll snapshot through document changes.
- KeepAlive hides a null key without creating a cache entry. Cache updates stay in component state so an abandoned concurrent render cannot evict committed entries or replace their stored JSX; recency promotion preserves DOM order because moving an iframe can reload it.
- Code, JSON and file paths stay left-to-right in every locale. JSON chevrons follow the tree's local direction; an HTML-level RTL rotation would point them upward. Palette paths retain direction marks so leading dots and trailing slashes survive start truncation.
- Context usage after compaction is unknown until a response reports tokens. Displayed percentages remain unrounded to agree with work status, while colour thresholds use the store's rounded value.
- Heap snapshots stay on the OpenCode machine and are never uploaded because they can contain API keys, prompts and file contents.

## Decisions

### Why wheel scrolling checks the DOM target

React wheel events from a tab's portalled context menu bubble through the strip even while the pointer is over the popup. The shared wheel handler checks DOM containment so scrolling the menu leaves the tabs behind it unchanged.

### Which tooltip a control takes

`Tooltip` is the base, for anything that is not a plain button, such as a whole row or a label. `ButtonTooltip` (`action-toolbar.tsx`) is one button that sits alone, disabled or not: its span takes the hover a disabled button refuses, and a menu trigger goes inside it. `HoverTooltip` (`row-tooltip.tsx`) is a button repeated in a list that mounts and unmounts rows, such as the transcript: it mounts a root only while hovered, adds no DOM, and needs no provider. `DelegatedTooltip` (`row-tooltip.tsx`) is the buttons of a list that keeps its rows mounted: controls carry `data-row-tooltip`, and one tooltip listens on the list. A `Tooltip` per row in either list would keep thousands of roots for a label that shows at most once.

`HoverTooltip` and `DelegatedTooltip` run their own delay, 300 ms as in the app's `TooltipProvider`, because a tooltip with no trigger of its own never reads the provider.

### Why KeepAlive snapshots before hiding

`onBeforeHide` runs for the outgoing non-null key in React's before-mutation
snapshot phase. Consumers can capture measurable DOM before Activity or a
placeholder host hides it. Layout-effect cleanup can already see hidden nodes,
so it cannot provide the same capture guarantee. Same-key updates do not capture.

### Why the toolbar folds by trying, not by arithmetic

`ActionToolbar` hides actions from the end of the row through a `data-folded` attribute set on the DOM until the row stops overflowing, then renders the menu from what it hid. Counting fixed 24px slots, as the Files toolbar did before, breaks on anything that is not a button: the save status, the inline go-to-line field, labels in other languages. React never renders `data-folded`, so a render keeps the fit until the next one runs on a resize or a changed set of actions.

### Why hover dismissal follows the opening reason

Base UI 1.4 has no opening DOM event when a caller changes the controlled `open` prop, so it treats that popup as hover-dismissible. Filtering can shrink it away from a stationary pointer and close it during typing. The shared dropdown root cancels that hover close unless a trigger-hover event opened the menu, preserving explicit hover menus without caller-specific workarounds.

### Why archived results are a separate group and not a setting

Archived sessions and their messages are always part of the palette's search.
Sessions get an Archived group of their own under the active ones, and a
message hit from one carries an "Archived" tag. A synced setting
"Show archived sessions in command palette", off by default, did this before:
a search that found nothing gave no hint that the answer sat in the archive,
and the setting brought typed flags, a Filters menu and a status line to
explain why results were missing. A separate, short group keeps archived rows
from crowding active ones without anything to configure.

### Why archived message hits get a request of their own

Hits come newest first, and archived conversations are usually the oldest: in
one list they sat pages below every active hit, and the preview of three never
showed one. The first request still asks for every lifecycle, so hits of
unknown lifecycle stay listed; the archived request only adds what that list
has not reached, and an archived hit the list reaches later is shown there
once. A server that ignores the lifecycle parameter answers the archived
request with unmarked hits, and the palette then drops that answer whole.

### Why a message hit of unknown lifecycle is shown as active

A server older than the lifecycle fields sends hits without `archived` and
ignores the lifecycle parameter. The palette asks for everything, so nothing
has to be hidden: the session caches mark the hits they know, and the rest
are listed without the tag. Hiding them, as an active-only request once
required, would drop every hit from a session the caches have not loaded.

### Why a scrolling popup gets a sibling frame and not a wrapper

A dialog window and a menu are their own scroll containers: Base UI renders the popup, and callers size, pad and lay it out through its `className`. A thumb placed inside it would scroll away with the content, and wrapping the content in `ScrollableOverlay` would move every caller's padding, gap and overflow classes onto a new element. `PopupOverlayScrollbar` instead renders next to the popup in the same positioned parent and keeps a frame on the popup's `offsetTop/Left/Width/Height`. Offsets ignore the open and close scale, so the frame lands where the popup comes to rest; client rects read during the opening animation were 2% small.

### Why the height morph watches content and leaves the position to Base UI

The popup's height follows a `MutationObserver` on its content, not a `ResizeObserver` on the box: the animation itself resizes the box every frame, and a flex child such as the model list shrinks with it, so a size observer would restart the move on every frame. The hook also does not hold the anchored edge itself. Base UI's positioner re-places the popup from its animated height before paint in the same frame, so the edge facing the trigger stays put; a per-frame offset tried first doubled that correction and threw the edge up to 60px off.

### Why loading indicators keep a shared clock and fixed geometry

Spinners step on the shared clock at 4 frames per second, avoiding a continuously active 60-frame compositor animation for each visible spinner. Busy dots keep their width and always show at least 1 dot so labels stay still and activity does not appear stopped; spinner bars use paths because the button WebKit styles unfill rectangles and circles.

### Why startup overlays mount with the real shell

Authentication and connection loaders hand off without fading; the mobile shell fades the startup overlay through `ready`, while desktop unmounts it as soon as the interface is available. Each restart gets its own slow-start delay, and the hint stays through the fade below the centred logo so the logo never shifts; config updates use only the animated logo because their internal status text adds jargon.

### Why About reserves version rows before lookup finishes

Both version rows occupy space from the first frame so asynchronous lookups leave the dialog height unchanged. An undefined version means loading and null means a completed lookup without a version; server failure can fall back to the native shell version.

### Why the logo shares generated geometry with startup splashes

`scripts/brand/generate.mjs` derives `openChamberLogoArt.ts` from `scripts/brand/geometry.mjs` and also writes the pre-React splashes, keeping the handoff's pose identical. Levitation starts and ends in that pose, uses the logo's isometric projection and a larger canvas for lifted plates, and startup variants keep the pre-paint palette while the theme hydrates.

### Why celebrations keep their own colours and deterministic spread

Holiday ornaments depict real objects whose colours stay constant across themes, and small white details need an outline to remain visible on light backgrounds. Particle spread stays deterministic across renders; detailed ornaments get more room than hearts and flowers, and the overlay lifetime covers the final volley and the longer ghost drift.

### Why layout animation defers toolbar and shadow measurements

A side column resizes these controls on every animation frame. Toolbar fitting and scroll-shadow layout reads wait for the animation to settle so they do not force repeated page layouts; scrolling still updates shadows immediately.

### Why the palette resets on opening and keeps search results stationary

Resetting on opening leaves content visible throughout the closing animation. A fixed-height, top-anchored palette keeps the input stationary as results and the Back row change, and idle git loading avoids flooding the first render and file search with store updates.

### Why palette searches distinguish names, metadata and hidden content

Commands, Settings pages and projects match word starts, and English Settings titles stay searchable alongside translations; file names rank first but the full relative path remains searchable. Name matches precede message content, archived sessions match titles only to avoid filling a project match with its entire archive, and highlights use the exact matcher input's offsets so metadata-only matches leave titles plain.

### Why palette file search excludes nested worktree copies

Nested worktrees hold duplicate project files that usually lead to the wrong copy. Filtering them consumes result slots, so the request limit increases when exclusions exist; without a query, already-open files come first because switching between them is the common use.

### Why message search avoids unsupported empty claims

Reasoning hits appear only when reasoning is both indexed and visible, so every hit leads to visible content. Disabled message search stays silent, and loading or unavailable search cannot justify a global "No results" claim; reply and reasoning hits keep distinct row identities even when they belong to one message.

### Why confirmation uses the app dialog and always settles

Native confirmation can leave Electron text input unfocusable on Windows and does not open in a webview. Dismissal, owner unmount and replacement by another question resolve the pending answer as false so no caller waits for an answer that cannot arrive.

### Why popup placement and dismissal stay explicit

Searchable popups choose their side once before paint and hold it until close so filtering cannot move the input; upward popups put search next to the trigger. Window blur closes menus, and an open menu disables the desktop title bar's drag region so title-bar clicks reach dismissal; Shift+F10 explicitly opens context menus on browsers that lack that translation and cancels the original key event to avoid duplicate opening.

### Why popup integration preserves the parent's layout and focus

Command content lets its parent paint the background so inset shadows remain visible, and select portals use `display: contents` so dialog flex gaps do not gain another row. Native safe-area insets participate in select collision sizing and can update after viewport resize; merged dropdown refs preserve React 19 cleanup callbacks, and dialog initial focus preserves an already-focused control before choosing a text field or the window.

### Why glass and nested dialogs dim as whole layers

Open glass popups temporarily enable the full-viewport blur guard to prevent Chromium stale-blur redraws, and closed popups pay no cost for that layer. Nested dialogs dim the whole parent popup through brightness, including scrolled content, and dialogs opened from docked panels clear the panel's surface context because they float over the app.

### Why mobile overlays separate keyboard travel from entrance

During entrance the keyboard anchor snaps and only the panel rise animates; following a simultaneously closing keyboard makes the entrance jerky. After entrance, compositor translation follows the keyboard curve from the current position because animating `bottom` forces stepped main-thread layouts; centred dialogs ride half the keyboard travel, phone sheets ride all of it, and top-held windows stay still.

### Why mobile overlays close within the gesture and newest layer

The close notification runs in layout-effect cleanup during the closing click so iOS still permits keyboard-restoring focus within that gesture. Each panel keeps a stable back-stack identity calling its latest closer, Escape and Android Back target the newest layer, and sheets centre over the chat column while the scrim covers the whole app; virtual lists own their scrolling and other sheets contain overscroll so the page behind them does not bounce.

### Why CodeMirror detaches hidden DOM and snapshots before hiding

Hiding the editor in place costs Chrome accessibility clients a 200 to 300 ms frame, while removing its DOM costs a few ms. Scroll events capture snapshots before detached or hidden scrollers report zero offsets, and a layout effect removes the DOM in the same commit that hides its host so the browser never lays it out hidden in place.

### Why editor measurements and reconfiguration stay selective

CodeMirror's measurement phase reads gutter and visible widths for unwrapped widgets and keeps the last real sizes while hidden; measuring on each update forces layout on each keystroke. Only changed inputs reconfigure compartments because reconfiguration rebuilds gutters and measures again; the scrollbar frame excludes bottom panels, and widget field focus is tracked through both focus and pointer events so redraws restore the active field without reviving focus after an unfocusable press.

### Why overlay scrollbars cache geometry and own their dynamic DOM

React owns stable thumb elements while the binding owns their attributes and styles, avoiding React renders during scrolling. Cached conversions keep the scroll path to offset reads and transform writes; a read-before-write pass coalesces signals, resize callbacks measure immediately while layout is current, and writes skip unchanged values because `:has()` gutter styles invalidate even on redundant hidden writes.

### Why scroll shadows have a hook outside their wrapper

The virtualized chat list owns its scroll element, so it cannot hand that element to a `ScrollShadow` wrapper. The shared hook keeps that path and the wrapper's fades consistent.

### Why provider logos pair masks with load detection

Uploaded and extension logos keep their own colours, while app monochrome logos can follow the text colour through a mask. Masks provide no load-failure signal, so a hidden image detects failures using matching CORS mode to share the request; bundled logos remain during replacement loads to avoid a wasted models.dev request, and URL-plus-attempt image state avoids an effect clearing a fast cached load.

### Why number inputs keep the latest committed value

Back-to-back steps can arrive before the parent renders the new value, so the committed-value ref is the next step's source. Controlled parents must accept those commits without rejection or debounce because the ref can otherwise lead the prop; touch handling swallows the follow-up click even after layout shifts, and the control matches the mobile button height floor to avoid clipping.

### Why textareas measure their full minimum height

The resize floor includes the rendered textarea minimum, caller overrides, footer row, gap and padding, and also clamps stored heights because a full-height inner column prevents CSS alone from enforcing that floor. Wrapper disabling depends specifically on the textarea, since a disabled footer action must not make the field unclickable or prevent that action from becoming enabled again.

### Why tab geometry avoids scaling and unwanted motion

Dragging applies translation only so tabs retain their width over differently sized neighbours; touch requires a long press so swipes still scroll, and RTL uses rectangle sorting because later tabs lie to the left. Indicator placement uses offsets unaffected by popup scale, first measurement and membership changes snap, real tab switches animate with a duration matching `.pill-tabs__indicator--is-animated`, and a non-composited indicator avoids WKWebView flicker inside a transforming ancestor.

### Why tab sizing preserves labels and clears fades

Content-sized parents need intrinsic strip width because a container query cannot derive usable width from a parent that depends on its children. Scrolling strips do not shrink their tabs, folder-qualified labels remain uncapped, and active tabs clear edge fades where possible; oversized tabs keep nearest scrolling and the first and last tabs reach the track ends. Close buttons clear inherited native titles so custom tooltips do not appear beside browser titles.

### Why tooltip state stays local and respects dismissal

Repeated-row tooltips keep state in the tooltip leaf so hovering never renders the entire row, and delegated tooltips stay dismissed after a press or scroll until the pointer leaves so they cannot cover a newly opened menu. Dragging and touch do not start hover, grouped tooltip moves skip a second wait and entry animation, and a caller-cancelled state change leaves the tooltip unchanged.

### Why toast observation stays inside the toaster

Observing the whole document would query on every streamed token, so only the toaster section is observed. Style pinning compares serialized values before writing because its observer watches styles and redundant writes can trigger itself; app toast classes use rem and the interface font because Sonner's built-in pixel styling ignores interface sizing, and the countdown ring follows the same duration and hover pause as dismissal. Explicit toast type aliases keep declarations from expanding Sonner types it does not export.

### Why animated text uses one CSS sweep

Per-character spans and JavaScript animations consume a quarter of main-thread work in a measured agent run because streaming tool rows mount continually. One CSS sweep runs on mount, and later title updates change text in place without replaying it.

### Why compact controls preserve text and keyboard meaning

The JSON tree keeps a small arrow with an expanded invisible hit area because the mobile button floor would make its row taller than neighbouring rows. Diff counts retain a literal space for copying and screen readers even though flex layout draws the visible gap; Help lists only currently bound actions, and fixed-width seconds with tabular figures keep memory legends from jittering as values change.

### Why update actions follow installation ownership

Web fallback commands apply only to package-manager installations because they cannot update a manually installed copy. Linux desktop-host installations request their password on the host's own screen, every Canary build links to the shared `canary` prerelease, and long Canary groups fold so a night with hundreds of commits does not fill the dialog before the reader chooses to expand it.
