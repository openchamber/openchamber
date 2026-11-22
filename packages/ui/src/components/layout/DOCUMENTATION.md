# Layout

## Ownership

This module owns the shared layout's header, session sidebar, workspace zone
frames, file tree, project-action controls and extension hosts. The tab store,
its scopes and seeding belong to `stores/DOCUMENTATION.md`
(`useSessionTabsStore`); surface implementations own their content and editors.

## Context panel file tab menu

The menu of a file tab in `ContextPanel.tsx` acts on the right-clicked tab,
including when it is inactive. Copy relative path uses the current project
directory (`contextPanelPaths.ts`, which also labels same-named tabs); reveal
shows only where the file tree offers it (`files.revealPath` outside a browser
client). VS Code does not mount `ContextPanel`, so it has no such menu.

## Context panel file tabs

`ContextPanel` owns the open-file strip in each workspace zone. Its editor mounts `FilesView`, which has no tab row of its own. The file strip enables `SortableTabsStrip`'s `scrollWithWheel` option, so a regular vertical mouse wheel reaches tabs past either edge without changing the open file or showing a scrollbar. Other context panel tab modes keep their existing wheel behavior.

## Context panel window

`ContextWindowLayout.tsx` is the context panel in a window of its own: the
rail and three zones, with the bottom zone as the center column where a main
window has the chat. `ContextPanel` `variant="center"` fills that column with
no resize handle; `variant="side"` marks the side zones there. No zone in
that window expands, since the center already takes the room. The mode
itself, routing and following the main window live in `lib/contextWindow`
(`DOCUMENTATION.md` there). While a main window is detached, `MainLayout`
mounts no zones, panes, drop overlay or fit arbiter, and keeps only the
closed right zone, whose slot holds the work-status card. In the rail's place
it shows `DetachedPanelRail`: a pressed button that brings the panel window
to the front, and in the slot of the detach control a button that brings the
panel back to this window, so the panel is never out of reach from the chat
window. The rail and
the zone header (`ContextZoneWindowButtons`) carry the control that detaches
the panel; in the panel window the rail's control sends it back.

- The three zone cards in the panel window start at one top edge and share
  one header height: the center card takes no top gutter (the side cards
  have none), and without the desktop header the row is padded by the
  cards' bottom gutter so no card touches the window's edge.
- The center is a destination everywhere a zone is chosen: the zone menu
  (`ZoneMoveMenuItems`) names the bottom zone "center" there with its own
  icon, and the drop overlay labels its target the same way.
- Drop targets follow the layout direction: in a right-to-left layout the
  measured physical sides map to the mirrored zones. Their labels are not
  swapped again, because right-to-left dictionaries already name the start
  zone by the side it shows on.
- Drop target frames are opaque, so the zone's content does not read through
  behind the label. An open zone's frame is its card cut to its target
  (`computeZoneDropFrames`): in the panel window a closed side's strip is
  carved out of the center column, and the center card would otherwise run
  under that strip's frame.
- A file surface with no editor beside its tree fills a bottom or center
  zone with the tree; side zones shrink to the tree's width instead.

## Header session tabs

`SessionTabsStrip.tsx` is the header's horizontal working set of sessions, in
the web and desktop header while `sessionTabsEnabled` is on. VS Code and the
setting turned off keep the plain session title (`Header.tsx`). The VS Code
chat header (`VSCodeHeader` in `VSCodeLayout.tsx`) keeps the title as the
session switcher and puts a "⋯" menu beside it with Rename only; the other
session actions stay in the session list. The `rename_current_session`
shortcut opens the same field there; only the chat header on screen takes it,
so the compact layout's chat header, mounted behind the sessions list, and a
new-session draft decline it.

- The store keeps ids and order only. An id whose session is not in the
  loaded list stays stored and does not render, so a partial session list
  never destroys the working set.
- Every tab has the same fixed width (`w-44`); tabs that shrink as more open
  were considered and rejected by the maintainer. Overflow scrolls, with an
  edge fade while tabs hide behind it.
- A long title fades out at its end (`.session-tab-title` in `index.css`)
  rather than ending in an ellipsis, which read as clutter next to the state
  mark.
- The running or unread mark sits at the tab's end and takes room only while
  shown. The project icon sits at the start; on hover or keyboard focus the
  close button takes its slot, so the tab reserves no room for a control.
- The session menu opens on right-click only, without changing the active
  tab. It is the sidebar row's session menu (`SessionActionsMenuItems` in
  `components/session/sidebar/sessions/`, through
  `HeaderSessionActionsMenuItems.tsx`), with Close other tabs first, and acts
  on the clicked tab's session whether it is active or not. The title's "⋯"
  menu, with tabs off, is the same menu for the current session. A per-tab
  "⋯" button and controls visible at rest were removed and stay out. A new tab affordance follows the sidebar row patterns
  (`components/session/sidebar/DOCUMENTATION.md`): revealed on hover, menu on
  right-click.
- A "+" right after the last tab, outside the scroller so it stays in view,
  opens a new draft in the folder the tabs belong to. While tabs are shown the
  titlebar's New session button is hidden (`TitlebarLeftControls.tsx`), since
  it would be a second button starting the session in the project root; a
  full-page surface hides the tabs and brings it back.
- An open new-session draft is a tab at the end, titled with the first line of
  its saved text, else "New session". Leaving the draft removes the tab; the
  draft stays in the sidebar.
- In the desktop app Cmd/Ctrl+W closes the open session tab and activates its
  neighbour, and with nothing to close it closes the window. Web keeps the
  configurable `close_session_tab` shortcut (Alt+W by default), since the
  browser owns Cmd/Ctrl+W.

## SidebarFilesTree modules

`SidebarFilesTree.tsx` only composes; its parts live in `sidebarFilesTree/`:
`useFileTreeListing` (per-root listing cache, loading, re-listing on file changes),
`useVirtualFileTree` (rows, virtualizer, list width, reveal of the selected file),
`useFileTreeToggle` (expand/collapse motion), `useFileTreeDragDrop` (uploads dropped
in, row moves and their confirmation), `useFileTreeDialogs` (create, rename, delete),
`useFileTreeOpening` (opening files and find-in-files matches), `useFileNameSearch`,
`useFileTreeGitMarks`, and the row, search field, toolbar, fallback list, error row,
drop indicator and dialog components. The tree cache is module-scoped in `treeCache.ts`
so it survives the sidebar closing and reopening. A folder change remounts the tree
(the content component is keyed by runtime and directory), so no state is reset on a root change.

## Invariants

- Zone placement belongs to a whole surface. A rail icon, panel tab, header or
  nested terminal strip moves that surface once on drop. Targets are measured
  at drag start; only hover state changes before release. A gesture outside its
  source consumes the source action even when it misses a target.
- A zone renders only its own tabs. During closing it keeps the last visible
  tab, because store reconciliation can already select another surface.
- Zone frames register body and toolbar hosts and start layout animations
  before keep-alive panes attach. Settle hooks run after the effect that starts
  the animation, so detachment and interactivity settle in the same commit.
- A toolbar receives a header slot only while its pane is visible. Other hosts
  render it inline, and an empty or loading toolbar leaves the zone label visible.
- Docked sizes stay fixed across folders and surfaces. Expanded zones preserve
  the chat's size as the window changes. Both leave a usable chat column or row;
  side tree-only zones shrink to the tree while the bottom zone keeps its width.
- Fit calculations use the workspace row, the other zone's stored size and the
  sidebar's pending width. Measuring a departing zone mid-animation otherwise
  clamps a surface moved to the other side and makes it grow a second time.
- The fit arbiter restores displaced zones only in their original project and
  restores a folded sidebar only while the user has not toggled it. Expanded
  folds survive restart; transfers between zones retain the fold until its
  current owner releases it. Bookkeeping updates precede reentrant store writes.
- Cross-window synchronization adopts placement without changing what each
  window has open. A save lacking placement carries no placement update, so
  older clients cannot reset another window's moves.
- The right slot interpolates one width for the context panel and work-status
  card. Card eligibility is calculated while the panel is closed too, so opening
  has its final destination immediately. Gutters belong to card margins and
  disappear when the slot closes; the slot establishes its own stacking context.
- Full-page surfaces hide the chat, its floating controls, the work-status card
  and the bottom zone. Selecting a session or draft closes the page, including
  switching between drafts whose open boolean stays true. Desktop Close acts
  on that page before session tabs or the window.
- File and terminal Close handlers belong to their own editors or strips. File
  closure must retain the unsaved-edits prompt and reconcile the panel's tabs.
- A file surface always shows its tree or editor. A hidden tree forces the
  editor back, so hiding one column cannot leave a blank panel.
- Chat-tab titles read all live directories, select the most recently updated
  duplicate session and retain stored fallbacks for unloaded directories.
  Closed zones and zones showing other surfaces subscribe to no session titles.
- Browser tabs use the current page identity before the stored opening label.
  Their identity includes directory and tab id, so equal ids across projects
  cannot reuse a view or a space's session in another project.
- Restored browser tabs sleep until shown or explicitly opened or woken by an
  agent. Agent tabs expire after idle time; user tabs share one cross-project
  recent-use limit. Only Chromium hosts offer agent wake actions they can run.
- Agent browser opens and screenshots stay in the background under the calling
  session's project. Browser control reads the remembered user tab from the
  store even when the zone is closed, subject to that project's ownership.
- Loaded browser views retain stable directory/id order across project switches
  because moving a webview reloads its page. Background agent views retain
  layout for snapshots; changing a space session or browser profile remounts
  the view because its session and profile are fixed at creation.
- Drafts awaiting a space keep tab ownership under the project while files,
  browser sessions, branches and action execution use only the running space.
  Until it runs, host files and commands remain unavailable. Cross-project
  chats carry their own directory; tabs lacking one use the panel's directory.
- Knowledge tabs resolve their owner through the shared ownership hook. Unknown
  directories own nothing; a display-label lookup cannot borrow the active project.
- Rail visibility stores hidden surfaces, so newly added surfaces appear by
  default. Hidden entries leave digit shortcuts too. Settings retain temporarily
  unavailable extensions and runtime-filtered entries; groups remain contiguous.
- Rail modifier badges reset on release, blur or digit consumption. A digit
  stays consumed until the next hold, and the configuration control takes no
  digit or sortable position. Disconnected integrations close their surfaces.
- The Git rail badge uses the same root and nested repository selection as
  GitView. A remembered nested repository refreshes independently because the
  chat keeps only its root warm. Git activity does not leak to other surfaces.
- Guest badges clear when the visible panel opens, while microphone activity
  remains visible on that panel. Counts stay in accessible labels and tooltips;
  state indicators remain steady and selection remains neutral.
- Context fill uses the final round-trip's reported window, because accumulated
  multi-step token fields count cached prompts repeatedly. Cache hit rate includes
  non-cached input, cache reads and cache writes in its denominator.
- Context breakdown shares the readout's window denominator, growing to the
  character estimate when it exceeds that window so the unattributed remainder
  stays non-negative. Unknown fill, including completed compaction, uses the
  estimate even when the compaction record still carries old turn tokens.
- Session cost prefers the live session total because loaded messages may be
  only a history tail. Their sum is temporary until the live record arrives;
  persisted snapshots omit that total. Omitted tool results still contribute
  their server-reported length, and instruction text comes from system messages.
- Message measurements and raw rows use message-record identity, which sync
  replaces when parts change. Unchanged rows stay stable and removed records
  remain collectible. Context-fill subscribers update only on fill changes;
  the rail tooltip mounts its all-session cost reader only while open.
- Raw previews show message-id suffixes because the prefixes are shared. Text
  remains React-escaped, and zero token counts remain visible before streaming.
- The header leaves context usage to the visible card's Session section when
  that section shows it, and leaves project/branch metadata to visible Work
  Status. Each reading appears once; hiding the card restores the header's copy.
- Session-tab seeding waits for a complete session list. Multi-run lanes share
  one preview tab. Active-tab reveal leaves room for edge fades so hover
  controls remain readable; physical scroll geometry accounts for negative RTL
  scroll offsets. Activation colors snap to avoid suggesting a slow switch.
- Rename retains the requested session id across activation and session changes.
  A stable field ref selects text once; menu focus restoration yields to that
  field. VS Code begins editing after menu closure returns focus.
- Native window-control clearances and height floors stay in physical pixels
  because interface font scaling must not place content under traffic lights.
  RTL mirrors layout while native controls remain on their physical edge.
- The titlebar control cluster mounts once above the sidebar and header. Both
  reserve its measured footprint, including overflow through scrollWidth; its
  width is capped to the sidebar so larger interface text cannot cover the chat.
- Sidebar content stays mounted while closed and skips rendering after its close
  animation. Only its content landmark becomes inert; the surrounding column
  keeps its accessibility state, avoiding transcript accessibility reserialization.
- A sidebar drag resolves its overlay once and invalidates that reference on
  disconnection. Its local width override leaves React's maxWidth intact and
  clears only when the stored width and root variable commit together. Closing
  the sidebar mid-drag must release the drag even after its handle disappears.
- Sidebar transitions remain in classes so reduced-motion styles can override
  them. Hover peek leaves the column at zero width and accepts only a mouse;
  a file or selection drag at the edge is not a peek.
- Peek detection measures the edge below the titlebar without an intercepting
  element. Portalled menus and focused rename fields hold the sidebar open;
  matching roles inside the app root do not, because ordinary page controls use
  them too. Document exit handles a sidebar that slides under a stationary pointer.
- Project actions share one runner above header, dialog and palette, preserving
  output watches across views. Run observation is reference-counted, detects
  other clients' runs and pauses while hidden; a running action wins the header
  pick so its Stop control remains reachable.
- Action settings and trust belong to the project, while execution and discovery
  use the session checkout. Session lookup uses the store's own directory key
  normalization to avoid Windows path mismatches. Transient fetch failure retains
  known actions, and an unavailable saved pick falls back to the first action.
- A run an agent started through its tool comes from the server's listing with
  `agentSessionId` in its purpose; the run carries `startedByAgent` while it runs,
  and the header, menu and dialog mark it, so the user does not start a second
  copy. The user can still stop it from here.
- Repository actions require shared-setup trust before execution; declining runs
  nothing. The action chooser sets its highlight only on opening so updates
  cannot move the user's selection.
- Auto-discovery collects announced addresses without guessing one from a command.
  It waits for staggered servers, opens a sole candidate and offers multiple
  candidates. While offering multiple candidates it keeps listening so late
  servers remain selectable; opening a sole candidate ends collection.
- Extension frames derive identity from the mounted guest and current
  contentWindow. Payloads cannot choose another guest, overlay entry or directory;
  overlay children inherit their owner's actual directory. Paused or unapproved
  guests keep frames and effects down, including teardown toasts.
- Only the rail panel consumes parked items and clears badges. Strict Mode's
  second mount effect preserves the first consumption; off-screen execution
  neither consumes items nor clears badges, retains generation answers or
  acquires a microphone. Visible entries use panel/page entries; hidden execution
  prefers background.entry with panel.entry as the compatibility fallback.
- Closing the rail zone drops the item handed to its panel, so a reopen hands
  `null` instead of a stale item. Switching tabs, covering the panel, or the
  fit arbiter closing the zone to make room and giving it back keeps it;
  the mobile drawer does not pass `panelOpen` and keeps its item.
- A new guest document retires the previous document's generation waiters.
  Answers arriving after a document leaves are retained for the next listening
  frame. File delivery and command registration wait for hello or load; theme
  and session pushes cannot reload a file editor's contents.
- Catalog reparse alone does not request a new account. Package changes reload
  ordinary frames, but file editors defer them until reopening to preserve
  unsaved edits. Scoped authentication renews on navigation after expiry while
  healthy documents keep their in-memory state.
- Project switches retire header callbacks while mounted workspace observers and
  unrelated requests survive. Strict Mode reattachment precedes unmount cleanup;
  OAuth polling stops only when the frame truly leaves, so re-rendering during
  authorization cannot lose its result.
- A frame starts an agent turn only from focused user interaction inside that
  frame. Window activation alone is insufficient. A microphone ticket retires
  permission requests after closure, while active audio may continue behind
  another tab until the document, grant or extension ends.
- Shared extension surfaces acknowledge every received frame after attempting
  drawing, including decode failure, because withholding acknowledgment blocks
  later frames. Input batches and clipboard reads preserve socket order; copy
  reads after its chord and paste sends text. Focus suppresses host shortcuts,
  hover alone never takes agent control, and touch cancellation releases buttons.
- An unseen shared picture unmounts so it holds no socket and the service can
  idle; its docked extension page stays mounted. Page thickness respects its
  minimum and half-panel limit so the picture remains visible. Mobile popovers
  use modal sheets and close through user dismissal or an overlaid host dialog.
- VS Code owns its work-status column without mounting ContextPanel. Its
  bootstrap catches up with connection state posted before listener registration
  and completes only after live provider and agent loads; persisted catalogs
  cannot mark a cold start complete.

## Decisions

### Why lazy surfaces and not eager imports

Git, files, diffs, walkthroughs, settings and guest hosts load on demand because
their editor and view dependencies otherwise enter the startup graph. Successful
loads stay mounted where state must survive, and failed settings or surface
loads close so the next open can retry.

### Why movable keep-alive panes and not remounts

Editors, terminals, walkthroughs and extension pages retain undo, sessions,
reading position and unsent form state in one detached host element. Moving
that element between zone bodies preserves their React state; moveBefore also
preserves DOM state where supported, while Electron webviews still reload on moves.

### Why conditional measurements and not resize state on every frame

Zone area enters React state only while expansion or a binding ceiling needs it.
Sidebar-animation changes otherwise wait for settlement, avoiding repeated
renders of surfaces whose chosen size cannot change.

### Why direct drag styles and not inherited variables

Resizing writes the slot and card dimensions once per frame with transitions
disabled, measures once at drag start and holds dependent layout work until the
stored size commits. Inherited size variables would restyle the entire surface
on every pointer frame; interpolated updates would trail the pointer.

### Why a drag shield and not a document cursor

A window overlay supplies the cursor and intercepts embedded pages that would
swallow pointer events. Window-level release, cancel and blur handlers end the
gesture because capture alone can fail over iframes or disappear with a handle.

### Why settled interactivity and not immediate inert toggles

Most surfaces enter and leave inert after animation, keeping inherited restyles
and accessibility work out of its first frame. CodeMirror enters interactively
in the same commit as DOM reattachment and leaves with detachment at settlement;
separating these operations causes expensive accessibility rebuilds. Rendered
files follow the ordinary deferred path, and self-focusing surfaces wait for
interactivity. Inert alone supplies accessibility hiding without a second pass.

### Why a separate focus target and not focus on the zone

An empty target outside the inert card receives opening focus. Focusing the
zone itself activates descendant focus-visible selectors across a large tree.

### Why clip overflow and not a hidden scroll container

The right slot clips both axes so tab reveal cannot scroll its wider hidden
content and drag the work-status card sideways. A size data attribute conveys
the target size without an inherited CSS variable that restyles descendants.

### Why local titlebar width publication and not a root variable

The changing control-cluster width is published only to its two spacer readers,
including readers that mount later. Sidebar open width and header height need
root publication, but only when their settled value changes, because inherited
root variables restyle the entire transcript. ResizeObserver supplies header
height directly so sidebar animation does not force layout reads.

### Why native header drag listeners and not React bubbling

Portalled toolbars sit in the header DOM while their React events follow a
different ancestry. Native listeners cover the header's empty drag regions
without taking buttons, fields or strips that already own their gestures.

### Why grouped hidden settings and not a visible allowlist

A hidden set lets future surfaces appear for existing users. The editor retains
unavailable registry entries so runtime differences do not erase choices, and
its keyboard bridge forwards arrows that the popup stops before dnd-kit sees them.

### Why a virtual file tree and not every expanded row

Only nearby rows enter the DOM, keeping large repositories' restyle and
accessibility work outside zone-opening animations. Dragged, focused and
animating rows remain mounted to retain dragend delivery, focus and continuity;
the virtualizer owns anchoring, so browser scroll anchoring stays disabled.

### Why the tree hook returns rows and not the virtualizer

React Compiler skips `useVirtualFileTree`, which calls `useVirtualizer`, but
compiles `SidebarFilesTreeContent`. Reading `getVirtualItems()` from the stable
virtualizer object inside the component let the compiler cache the row list,
so a rerender the virtualizer asked for drew the old rows: the tree stayed
empty after its tab came back. The hook hands the component values that change
with the range (`virtualRows`, `totalSize`) and the stable `measureRow`.

### Why a zero row height keeps the last size and not the measurement

An inactive context tab hides its pane with `display: none`, and the rows'
ResizeObserver then reports a height of 0. Cached, those zeros stacked every row
at the top of the tree once the tab came back, and the shared measured height
fed 0 into the estimate of rows never mounted. A row is never 0 px tall while
shown, so a 0 measurement keeps the row's cached size (or its estimate).

### Why remembered tree widths and not mounted-row widths alone

Widths remain keyed by path while rows leave view so horizontal scroll cannot
snap back. Width writes wait a frame outside ResizeObserver; row changes prune
old paths and remeasure from the pane width, restoring clamped scroll before
paint. Virtualization waits for its scroller, new rows use measured heights,
and selected files reveal once after ancestors load and the tree is visible.

### Why independent cached listings and not resetting the tree

Per-root cached children survive close and reopen, with independent state
references and synchronously retained loaded-path metadata. Cache reads reflect
user attention for LRU eviction; render writes do not. Unpopulated roots leave
on unmount, while populated roots retain their data. Refresh keeps visible
children, loads parents before children with bounded concurrency and invalidates
stale scopes; cancelling a queue still allows started same-scope reads to cache.
File changes reload visible eligible listings and invalidate hidden ones for
their next expansion, preserving unrelated folders.

### Why native drag recovery and not delayed draggable activation

File rows stay draggable because Chromium fixes eligibility on the first mouse
move. A targetless micro-drag ending near its origin becomes exactly one click,
and drops within that slop cannot move a neighboring row. One native drag at a
time permits shared drag state; drop-time data must match the recorded source
so an abandoned gesture cannot move an entry. Search results only attach to
chat, and touch retains scrolling and opens pinned tabs without double-click.

### Why row-local menus and precomputed Git marks

Each row owns menu state so opening one menu leaves sibling renders unchanged.
Git path and directory marks are indexed per status update so rendering each
node does constant work, even in deeply expanded repositories.
