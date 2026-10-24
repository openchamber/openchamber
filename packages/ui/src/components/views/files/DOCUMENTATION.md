# File tree loading and visibility

`FilesView` and `SidebarFilesTree` keep directory snapshots in component state.
`DirectoryRequests` owns shared in-flight reads and supersession. Repeated
same-path callers await the same request; an explicit mutation refresh can
replace it. Scope changes and unmount clear the coordinator, so old completions
cannot publish or remove a newer request's slot. Callers also check runtime
identity at completion.

Directory arrays retain their references when every rendered field and ordering
matches. `fileTreeStatus.ts` builds path and ancestor indexes once per Git
snapshot. Open-file membership has its own set, so changing tabs does not
rebuild the Git index.

Directory listings follow the "Show gitignored files" setting: `SidebarFilesTree`,
`FilesView`, and the mobile `MobileFilesSurface` ask the runtime for
`respectGitignore` unless the user has chosen to show gitignored entries, so the
server's `git check-ignore` filter decides what appears inside a Git repository.
Outside a repository no entries are ignored, so the hardcoded `node_modules`
name filter remains as a fallback. Search already follows the same setting.

## Searching

The field above the sidebar tree searches file names, as it always did. Where
the runtime has `files.searchContents` (web and desktop; VS Code has its own
search and the mobile browser keeps name search), the search icon is a menu
that switches the field to file contents. In that mode the placeholder changes,
a `.*` toggle at the end of the field makes the query a regular expression, and
the results replace the tree as one card per matching line: the file and its
folder on top with the line number, the line below with the matches marked and
an ellipsis where the server cut its start. A click opens the file at that line
as a preview, a double-click as a pinned tab (`openContextFileAtLine` with
`preview`), and a card drags into the chat like a name result. The hook
(`useFileContentSearch`) sends the debounced query with the tree's hidden and
gitignored settings, aborts the request a new query replaces so the server ends
its ripgrep process, and never lets a late answer land. "Showing the first N
matches" follows the list when the server's limit was hit, and the row says so
when the server stopped at its deadline, when the regular expression is invalid
(with ripgrep's reason), when the server has no ripgrep, or when the search
failed; none of these is shown as an empty result. The server side is in
`packages/web/server/lib/fs/DOCUMENTATION.md`.

Desktop `FilesView` in editor-only mode neither loads nor constructs its unused
tree. In the context panel the panel's tab strip owns the open files: closing
a file from the editor (Cmd/Ctrl+W in the desktop app, which the window menu
turns into `openchamber:close-tab` through `lib/closeTabTarget.ts`, or the
unsaved-changes prompt that may come first) goes through `onCloseFile` to
`closeContextFile`, which closes that tab exactly as its close button does. Mobile retains its tree. The context panel passes actual visibility,
including the panel's open state, its active tab, and the editor toggle, to each file surface.
Hidden surfaces retain drafts, loaded content and scroll state. They stop
directory and file metadata polling; reopening checks freshness once before
normal polling resumes. Autosave is independent of visibility.

Background polling never supersedes an in-flight directory read. Explicit
refresh after file mutations does. Each directory failure remains local and
preserves its previous successful snapshot.

Opening a file outside the workspace reads it directly through the active
runtime, in both editor-only and full Files modes. Chat navigation and file
loading do not request native file grants. Server-backed text reads and metadata
requests have a 30-second deadline, including response-body reads, so a stalled
request reaches the existing error handler instead of leaving loading pending.

A file that cannot be read, a missing one included, stays selected and shows
the read error; the host's tab still names that path, so the editor never falls
back to another open file. A pending line jump or focus for that path ends
there. The metadata poll treats a file deleted while open the same way: without
unsaved edits it shows the error, with unsaved edits it keeps them. It keeps
polling a failed file and loads it again once a missing file is back; a file
that exists but fails to read is never reloaded by the poll
(`openFilePollStep`). Pruning stale open paths (`removeUnselectedOpenPath`)
never removes the path on screen.

A pending line jump (`pendingFileNavigationStep`) selects its file only until
that file has been on screen. If the user then switches tabs while it loads,
the jump leaves the other tab alone and runs when its file is selected again.
A read-only text file, one outside the workspace for example, opens in the
read-only code editor, because the selection effect resets the text mode after
the effect that switches read-only files to the view mode; the jump runs there.
If no editor is on screen the jump ends, so the waiting mask never hides a
loaded file.

Sidebar root/runtime changes remount the scoped tree. Its bounded module cache
provides continuity between mounts; request cancellation for collapsed paths
stops queued batches, while already-started reads may populate the same-scope
cache. Runtime changes and unmount invalidate those active reads.

The sidebar tree is virtualized (`@tanstack/react-virtual`): the expanded
folders flatten into one list of rows (`fileTreeRows.ts`, a folder's load error
right under it), and only rows in and near view are in the document. With every
row mounted, a large repository put thousands of elements under the context
panel, and opening the panel restyled all of them and added them to the
accessibility tree inside its animation. The dragged row and the row holding
focus stay mounted wherever they scroll, so a drag still ends and focus does
not fall to the page. Selecting a file scrolls its row into view through the
virtualizer once the row exists. Only mounted rows are in the tab order. Rows
keep an explicit height (the meta line height, the icon minimum and vertical
padding), so a font change re-measures them. Search results and the root
error are plain lists. Reopening still refreshes directory contents.

## Row look

The sidebar tree, `FilesView`'s own tree and the changes tree in `DiffView`
draw rows from `FileTreeRowParts.tsx`, so the three look the same: flat rows
indented 12px per level, one faint guide per ancestor level under its
chevron, a chevron instead of a folder icon, and the git state as a coloured
letter on the right. A blue dot before the letter marks a file open in a tab;
it no longer hides the file's git state. Change the look there, not per tree.
The JSON tree viewer (`components/ui/JsonTreeViewer.tsx`) takes the same
indent and guides and copies the chevron's look; keep the copy in step.

## Refreshing after file changes

The sidebar tree and the phone browser re-list folders when the agent changed
them, with no watcher and no timer: an idle client sends nothing. OpenCode 2.x
has no file events (`filesystem.changed` covers the repository HEAD only), so
`lib/fileTreeChanges.ts` derives changes from what the event stream already
carries, fed from `sync-context` and the revert actions:

- a finished `write` or `patch` names its files, so only their parent folders
  change (`toolListingChanges` in `lib/opencode/tools.ts`; `edit` never
  creates a file and counts as no change);
- a finished `shell`, `execute`, MCP or plugin call could touch anything, so
  its session waits for the step's end: the step's snapshot `files` decide.
  An empty list costs nothing (read-only commands); a non-empty or missing
  list (snapshots off, not a Git repository, a failed step) is an unknown
  change. The snapshot skips Git-ignored files and untracked files over 2 MB;
- a finished user shell command, staging a revert and clearing one are
  unknown changes.

`useFileTreeChanges` collects changes for two seconds after the first one and
delivers them as one batch, so a surface re-lists at most once per two seconds
however fast the agent works; it holds the batch while the window is hidden.
A folder whose last listing had more than 1000 entries
(`AUTO_RELIST_MAX_ENTRIES`) is never re-listed on its own, because each
re-list resends the whole listing; the refresh button and expanding it still
read it. The sidebar drops changes while its tab is
hidden, because reopening re-lists everything anyway; the phone browser holds
them and reloads the folder on screen when the drawer shows it again, keeping
the listing if that reload fails. In the sidebar a listing on screen reloads
(forced, superseding an in-flight read); a loaded folder out of sight is only
forgotten so expanding it reads it again; a new folder re-lists its nearest
loaded ancestor. An unknown change re-lists the root and every expanded folder
on screen. Changes made outside the agent (an editor, a terminal) still need
the refresh button or reopening the tab. VS Code has no file tree, so nothing
subscribes there. Desktop `FilesView` keeps its own 8-second poll of expanded
folders.

## Artifact previews

`previews/` holds what the viewer shows instead of text: `ImageArtifact`
(natural dimensions; fit, which never upscales, or a zoom from 10% to 1600%
through −/+ steps, Ctrl/⌘ + wheel or trackpad pinch, Safari gesture events,
a two-finger touch pinch, and double-click between fit and 1:1, anchored at
the pointer; a zoomed image larger than the viewer pans by mouse drag;
`imageZoom.ts` holds the scale math; round arrows fixed to the viewer's
edges, and the arrow keys while the viewer has focus and the image is at fit,
show the previous and next image of the same folder, see below),
`MediaArtifact` (native audio/video
element, duration and dimensions once metadata loads, a stated failure when
the runtime cannot decode the codec), `FontArtifact` (a specimen under a
throwaway `FontFace` family removed when the tab closes), `TableArtifact`
(CSV/TSV through `delimitedText.ts`, parsed on the thread of the preview when
the file is small enough and in a worker otherwise, with a loading state until
the worker answers, capped rows stated in the meta line, the
rows and columns in view mounted unless the grid of the file is small enough
to be kept whole), and `BinaryArtifact` (name, type,
size, download; never a decode attempt).
`FilesView.renderArtifactPreview` is the single switch for artifact views.
SVG, Mermaid (`.mmd`) and delimited files are text
with an artifact view: each has a per-path preview/source toggle, and opens
in preview regardless of the text-first setting because an agent-produced
artifact is opened to be looked at.

The CSV/TSV preview stays mounted when it enters fullscreen. Its existing
viewer panel fills the Files surface and hides the tree and docked toolbars;
the fullscreen controls stay over the same scroller. A fullscreen transition
therefore does not start another parse, and the worker's single held parse is
not competed for by a second table instance. Other preview kinds keep their
existing fullscreen viewer.

The table preview mounts only the rows and the columns in view, unless the
grid of the file is small enough to be kept whole. A wide export holds far
more cells than a screen can show, and mounting all of them froze the viewer
for seconds: 2,000 rows with 50 columns ask for 100,000 cells. The rows
outside the window are carried by spacer rows that take their height, and
the columns beside the window by spacer cells that span them, so the table
keeps its own layout, its column widths and its text selection.
`tableLayout.ts` holds the model: the width of every column, the range of
rows and columns a scroll position lands on, the size of the grid of a file
and the cells that carry the columns beside the window. What has to stay
true:

- the preview is a real `<table>` with a sticky `<thead>`, because the table
  semantics and the native text selection depend on it;
- the row cap of the parser and the notice about it in the meta line stay as
  they are;
- a file whose grid is small enough is kept whole and a file whose grid is
  large enough is windowed. The decision is a property of the file, so the
  same file is kept whole in a narrow panel and in a wide one;
- the mounted cells stay bounded by the viewport on both axes, so the cost of
  drawing a file does not grow with the file. The files that are kept whole
  are the exception, and the limit bounds what they cost. Two things grow
  with the file anyway: the `<col>` the table holds for every column of the
  file, because the parser does not bound the number of columns, and the rows
  the cache of the cut rows holds, because a row of a file with many columns
  holds many values. The parse of the file and the count of the widths again
  with the measured characters, which only a file that holds a character
  wider than the count pays for, run in a worker when the file is large
  enough, so they cost the worker and not the thread the user is looking at;
- the widths of the columns come from the data and from the font, and a resize
  of the panel does not count them again;
- the column widths stay the same while scrolling, and a column is as wide as
  the text the browser lays out for its longest value, so nothing that fits
  today is cut short;
- only the rows and the columns in view are in the document, so the browser's
  find-in-page, a selection of the whole file and a screen reader see the
  window and not the file. A value outside the window is in the document only
  while the window is over it. A file that is kept whole holds every row and
  every column of it, so those three see the file;
- the table states how many rows and how many columns it has, and every
  mounted row and cell states where it sits in the file, so a screen reader
  is told the size of the table and not the size of the window;
- the cells of the window sit in the columns the model names, for a file of
  any number of columns. HTML limits the `colspan` of a cell to 1000, and a
  cell that claims more is laid out over fewer columns, so a range of
  columns that is wider than the limit is carried by more than one cell. No
  cell of the table claims a span above the limit, the cell of a row that
  stands for the rows outside the window included;
- a right-to-left table keeps its columns in the order the file has them,
  with the first column on the right. Its scroll offset is read the way the
  browser reports it: 0 at the right edge of the box, and negative from
  there as the box is scrolled towards its left edge;
- the columns in view are the ones the viewer can see, in the direction the
  document is laid out in at the time;
- a new file mounts its own rows and columns from the first commit, so the
  window of the file before it is never in the document;
- the rule under a row runs across the whole width of the table, and the
  stripe of a row runs behind the columns beside the window, so the table
  looks the way it did when every cell of the file was in the document;
- the header row is as tall as a row of the body, so the header cells in view
  cannot change its height and the content below the header does not jump
  while the window moves over columns whose header is empty;
- a file is measured when it opens, whatever file was open before it. A file
  without columns has no table to measure, so the next file is measured from
  scratch.

How much each of them costs was measured on one machine, so the figures below
describe that machine and say nothing about the code itself. The parse counts
the width of every value as it reads it and finds the characters outside latin
in the same walk, so the open of a file costs one walk over its text. A
2,000-row file with 50 columns took 18 ms of parse on the machine the figures
below were taken on, and a file with 5,000 columns in 2,000 rows, which is
124 MB of text, took 504 ms. The parse is the largest single item on both,
and a file that is large enough is parsed in a worker, so it costs the worker
and not the thread the user is looking at.

The walk over the cells the preview used to make is gone, and with it the
measurement of the widths the preview did for every file. A file that holds a
character the browser lays out wider than the count pays for the count of the
widths again with the measured characters, and that count walks over the text
of the kept rows: it took 15 ms for the 2,000-row file with 50 columns, 105 ms
for one with 1,000 columns and 611 ms for the one with 5,000 columns. The
walk over the cells it replaces took 11 ms, 93 ms and 457 ms, and the preview
made that walk twice for every file, because the layout starts on guessed
metrics and the measurement replaces them. The count of the widths is a
little dearer than one of those walks, and it is paid once, by the files that
hold a character the browser lays out wider than the count.

The widths are written in the font's own character unit, so the browser
resolves the characters against the font it has, and the padding and the
border of a cell are written from the measurement of the document. The height
of a row is measured from the document as well, and every row is given that
height, the header row included, so the mapping from a scroll offset to a row
stays exact and the last row can be reached.

### Why a small file is kept whole and a large one is windowed

The preview held every cell of the file before the windowing, and the
browser's find-in-page, a selection of the whole file and a screen reader saw
the file. The windowing took that away from every file, and it only had to
take it away from the files that are large enough for the window to matter.
So a file whose grid is small enough is held whole, and the size of the grid
is the number of cells the table holds, the header row included. The limit is
one number, `TABLE_WHOLE_GRID_CELL_LIMIT`, and the file decides: the same
file is held whole in a narrow panel and in a wide one, because a decision
that changed with the size of the panel would hold a file in one panel and
window it in the next.

The limit was measured in Chromium against the markup of the preview. The
machine was busy with other work during the measurements and the figures
moved by about a third between runs, so they are given as ranges: holding
1,000 cells took 20 to 60 ms of layout, 2,000 cells 30 to 90 ms, 4,000 cells
75 to 120 ms, 10,000 cells about 300 ms and 100,000 cells 3 to 4 s. The
rendering of the cells is on top of the layout the browser does for them. A
pause of a tenth of a second is where the viewer starts to notice one, so
2,000 cells is the largest grid whose cost stays around it. The window itself
holds about 800 cells and costs 15 to 25 ms, so holding a file of that size
whole costs little more than opening any windowed file.

### Why the file is read in one place

The preview reads the file in one place, and everything else reads the table
from there: the parse, the rows that are cut out of the source and the widths
of the columns. The preview held the cells of the file before, and a file
with millions of cells put millions of strings in the memory of the tab, and
the walk over them to measure the columns cost more than the parse of the
file itself.

One place also means that the parse can be moved off the main thread without
the rest of the preview knowing: the preview asks for the table and gets one,
and where the parse ran is not its business. The parse of a file that is large
enough runs in a worker for the reason below.

### Why a large file is parsed in a worker

The parse of a file walks its text once, and a wide export is tens of
megabytes of text: 145 MB of it took about 900 ms of the main thread, and the
viewer was frozen for all of it. The parse and the count of the widths of
such a file are therefore done in a worker, and the main thread only renders
what the worker sends back. The preview shows a loading state until the
worker answers.

A runtime without a worker, a worker that cannot be created, one that crashes,
one that does not take the request and one that does not answer within its
budget all end the same way: the file is parsed on the main thread, which is
slower for the user and the last resort. The budget grows with the size of
the file, because the parse walks the text once and a big file takes longer
than a small one. It covers worker startup, including the VS Code fetch and
response-body read, and the worker response. A worker that starts after the
budget is retired and cannot replace a newer worker.

The worker keeps the text of the parse it answers, so the count of the widths
does not have to carry the text of the file again. Only the newest parse is
kept: the preview has one file open at a time, and the text of a file the
user has left is of no use to the file that is open now. When a preview closes
or changes to source, it releases its parse; the worker clears it only if that
parse is still the one held. A parse that finishes after its preview leaves is
released when its response arrives. A count for a parse the worker does not
hold any more is answered as a failure, and the preview counts the widths on
the main thread instead.

A count for a file the user has left is dropped instead of counted on the
main thread: that walk is over the text of every row the preview holds, and
it would hold the thread of the preview for as long as it takes, for a file
nobody is looking at.

### Why a small file is parsed on the thread of the preview

A file of at most 200,000 characters is parsed on the thread the preview is
on, in the first render, and the preview opens without a loading state. The
parse of a file of n characters costs about 15 ms per megabyte in Chromium, so
a file of that size is parsed in a few milliseconds, and a round trip through a
worker costs more than that: the worker is made, the text is copied into it
and it answers. The file used to open in the first frame, and a spinner and a
meta line that change are a worse trade than a parse of a few milliseconds.

The limit is the preview's own decision. The editor has a limit of its own for
a different reason, and the two are not the same number by accident: the
editor opens a large file in the view instead of the editor, and the preview
pays for a parse it can afford to make.

A file that is larger is parsed in the worker, and the preview shows its
loading state until the worker answers.

### Why the widths are counted as the rows are read

A column is as wide as its longest value, and the count of a value decides
the width of its column and nothing else. The parser counts the values as it
reads them, so the preview never holds the cells of the file and never walks
over them to measure them.

The walk over the cells went over every column of every row, and a file with
few fields per row and many columns paid for the whole width of the table on
every row: 2,000 rows with one field each took 25 ms to measure with 5,000
columns, 290 ms with 20,000 and 520 ms with 50,000 on a busy machine. The
parser counts the fields a row has and not every column of the file, which
took 1 ms, 1 ms and 2 ms for the same three files. The widths are the same,
because a row that does not reach a column cannot narrow it.

### Why a row is cut out of the source when it is mounted

The values of a row are cut out of the text when the row is mounted, and a row
that was cut is not cut again, so a scroll that comes back over a row does not
pay for it twice. The rows that were cut are held in a cache.

The rows that are on screen are held whatever they cost, and the rows beside
them are held as long as the cache holds fewer cells than its budget. A bound
by the cells alone held one row of a file with 5,000 columns, so every change
of the window cut all the rows on screen again: about 34 rows, 0.8 ms each,
roughly 28 ms on every scroll step. A file with 5,000 columns holds the 34
rows of its window, which is 170,000 values, and a file with 50 columns holds
the same 34 rows of 50 values, which the bound by the cells held as well. The
memory the cache holds does not grow with the number of rows of the file: the
rows on screen are as many as the panel is tall, and the rows beside them are
bounded by the budget.

A file whose whole grid is kept in the document holds all of its rows at once.

The cache is dropped when the file changes, because the rows of the file
before it are of no use to the file that is open now.

### Why the widths are counted again only when a character is wider than the count

The parser counts the columns with the counted rule, because it runs before
the browser has measured a single character. A file whose characters are all
counted right, which is every file without Greek, an emoji or another
character the font does not cover, has the exact widths already, and nothing
is counted again. A file that holds such a character would have its values cut
short, so its widths are counted again with the measured table.

The count again walks over the text of the rows the preview holds and stops
at the end of the last of them, because the rows it holds are a prefix of the
file and the rows after them are not counted. It runs when the measured table
changes, and not when the panel is resized, scrolled or rendered again.

A count belongs to one table and to one set of measurements. A file that is
opened again is parsed again, and the table of the new parse starts from the
widths the parser counted, so the widths that were counted for the file before
it are not the widths of the new table and are counted again. A count that was
asked for with other measurements does not publish its widths either: the
measurements changed while it ran, and its widths belong to a font that is not
the one on the screen.

It costs a little more than the walk over the cells it replaces, because a
walk over the text cannot use the early-out that walk had: the length of a
value is only known after its characters have been read, so every value has to
be counted.

### Why the table states its size and the place of its rows and cells

A table whose rows and columns are only partly in the document tells a
screen reader the size of the window and not the size of the file: it said
there were seven columns where the file had fifty. The table states how many
rows and columns it has with `aria-rowcount` and `aria-colcount`, and every
mounted row and cell states where it sits with `aria-rowindex` and
`aria-colindex`, counted from one and with the header row counted with the
rows. The places follow the file and not the document, so the row under the
top-left corner of the viewport carries the number its place in the file gives
it. The spacer rows and the spacer cells stand for the rows and the columns
outside the window and are hidden from the accessibility tree, so they are
counted nowhere.

The count of the rows is the number of rows the table holds and not the
number of rows the file has: the parser keeps the first rows of a large file
and the meta line says so, and a row the file has and the table does not is
no row of the table.

### Why the window is written here and not taken from `@tanstack/react-virtual`

The virtualizer in this repo positions rows in a list of its own height. A
table has no such list: its height comes from the header, the rows and the
spacer row that stands in for the rows above, and the height a row is
planned with has to match the height the rows really take, or the mapping
from a scroll offset to a row drifts and the last row cannot be reached. The
window here is a pure function of the parsed table, the measurements and the
scroll offset, which is what the tests check, and it covers both directions
of the same table at once.

### Why the model of the window is written after the commit and not during the render

The window is computed from the model of the last commit: the plan of the
columns, the measurements, the number of rows and the number of columns. A
render React throws away must not leave a plan in that model, because a
scroll event landing in that window would ask for the rows and the columns of
a table that never reached the document. The model is therefore written in
the layout effect that moves the window, and not in the body of the render.

### Why every row is the measured height and not the height its own text takes

A row whose cells are all empty has no line in it, so it is shorter than a
row with text: the padding and the border are all that is left of it. Such a
row is a real row, because a record that holds delimiters is not a blank
line, and one height for all the rows is what keeps the mapping from a
scroll offset to a row exact. A row without text is therefore as tall as a
row with text, and it carries the stripe of its own index like every other
row.

The height is measured from a probe that holds the same box a cell holds, so
the measurement does not depend on which row happens to be first in the
window. A file whose first row is empty would otherwise be planned with the
height of that row, the rows below it would sit higher than the plan says,
and the last row could not be reached at all.

The header row is given that height as well. Its height would otherwise be
the height of the tallest header cell in view, and a header cell without text
has no line in it, so the header would shrink to its padding and its border
while the window moves over the columns whose header is empty, and the content
below it would jump. A header cell holds the same box as a cell of the body,
so the height of a row is the height to give the header row.

### Why the widths of the columns are measured apart from the room of the panel

A column asks for the width of its longest value, and the room the panel has
left over is shared out over the columns afterwards. The two are counted in
two steps, because only the second one has anything to do with the panel: the
count of the widths of the file is the expensive part, and repeating it for
every frame of a sidebar drag made the cost of a wide export grow with the
file. The widths are counted once for every open of a file and once more for
every change of the font, and a resize only shares the room out again.

### Why the first file of a session is measured against guessed metrics

The layout starts on guessed metrics, because the font is only measured from
the document after the first commit, and the widths of the columns are needed
for that first commit. The first commit therefore carries the counted widths,
and the layout effect then replaces them with the measured ones. The counted
widths of the first commit are the ones the parser counted, and they are
exact unless a character is wider than the count, so a file is only counted
again when it holds such a character. Every file after the first one is
counted once, because the metrics do not change and the memo holds.
Measuring the widths without the metrics would take the cap on a cell off the
count and put it in a second pass, which changes the width model. Leaving the
first commit without column widths would show the table with the wrong widths
for a frame.

The characters outside latin are counted at the counted width in that first
commit as well, and the layout effect measures them with the font. The count
of the widths is repeated only when one of them is wider than the count, and
that count walks over the text of the kept rows.

### Why the width of a value is counted on its own

A value of plain latin characters takes one cell per character, and a value
with characters outside latin takes the width they are measured at. The count
decides the width of the column the value sits in and nothing else, so the
preview counts every value on its own and never asks what the rest of the
file holds.

It used to ask. The preview read a flag over the kept cells that told it
whether the file held nothing but latin characters, and the flag decided how
a value was counted. The flag repeated, over every kept cell, a decision the
counter makes on its own over the cells it reads, and it cost more than the
measurement it was meant to make cheaper: the counter stops reading a column
once that column cannot get any wider, and the flag read every cell of the
file. A 2,000-row file with 5,000 columns paid 2.1 s for the flag and
0.17 s for the measurement on the machine the figures above were taken on.
The open of that file is 1.55 s shorter without the flag, and the widths it
measures are the same to the pixel.

A file of 50 columns paid 16 ms for the flag and 7 ms for the measurement,
and pays for the walk for the characters and for the count of the widths now. The check it gave up grew with the number of cells and the counting
does not, so a file with 5,000 columns gains what a file with 50 columns
gives up.

### Why the characters outside latin are found in the text of the file

The preview has to know which characters outside latin the file uses, because
the browser measures each of them in a hidden probe. The parser finds them in
the walk it makes over the text of the file, because a cell is a string of its
own and a file with millions of cells costs more to walk over than its text
does: the same 2,000-row file with 5,000 columns spends 1.5 s on a walk over
its cells and 0.13 s on a walk over its 75 MB of text.

The text holds the characters of the cells in the order the cells have them,
so the list is the one the cells would give. A character of a row the parser
dropped is in the list as well, and such a character is in no value that is
counted, so it changes no width. The preview draws those characters in the
probe as well, which costs the measurement of a few more characters and
nothing else.

### Why the measurements keep the object they have

The widths of the columns are counted from the data and from what one
character and one cell cost, and the preview keeps them in a memo that runs
again when one of those inputs changes. A resize of the panel changes none of
them, but it does build a new layout, and a new object for the same numbers
would look to the memo like a change of the font and ask for the count of the
widths again, on every frame of a drag. The measurements therefore keep the
object they have while their values stay the same, and only a new font, a new
interface size or a new file counts the widths again. The measured widths of
the characters outside latin are kept the same way: a resize measures them
again in the browser, finds the same numbers and leaves the map the preview
holds as it is.

### Why the border of a cell is read on its inline end

The border of a cell sits on its inline end, which is the left edge of the
document in a right-to-left one. Reading the right edge instead counts no
border there, and the error grows with the number of columns: 500 columns
miss 500 px, which is ten columns of a wide table, and the columns the
viewer can see are then not in the document. The computed style resolves the
logical side, so the border is read as the inline end and the number of
columns does not change the answer.

A runtime that does not resolve the logical side counts no border at all,
and the error grows by a pixel with every column. The physical side the
direction of the document puts the border on is read as well, so the model
holds on a runtime that knows only the physical sides.

### Why the columns are measured in characters and not in pixels

A column is as wide as the text the browser lays out for its longest value,
and the browser's own automatic table layout can only measure that with every
cell in the document, which is what the window avoids. The width is therefore
a number of characters in the font's own unit (`ch`), which the browser
resolves against the font it actually has. A character in plain latin takes
one cell and a full-width character takes two, the way a monospace font lays
them out, and a character outside latin takes the width the browser measured
for it, or the counted width where the measurement found less room. A value
in Japanese still fits its column, and so does a value in a script the
monospace font does not cover.

### Why the characters outside latin are measured in the browser

A character the browser has no font for falls back to another one, and that
font can lay the character out wider than the monospace font of the preview.
Counting every such character as one cell made a column narrower than the
text in it, and the cell cut the value short. Counting them as two cells
would have fixed that and made every column in such a script twice as wide
as it has to be.

The characters the file uses are therefore measured in the browser: each of
them is drawn on its own in a hidden probe, and the width it takes there is
the width it is counted at. The model needs to know the width of a character
only to count a value, and the count of a value only decides the width of
its column, so a value in such a script is now as wide as the text the
browser lays out for it. A character the browser lays out narrower than the
monospace font keeps the counted width, so a column is never padded with room
the text does not need, and a character the measurement did not reach keeps
the counted width as well.

The figures here were measured in Chromium with the fonts of the application
on the machine the check ran on, where a latin character takes 7.5 px. Sixty
greek characters took 460 px in the automatic layout of the browser and 450
px in the counted width, so the tail of the value was lost. A greek letter
takes 7.797 px on its own and 7.665 px in a run of sixty, and the column of
sixty of them is 468 px wide, which covers the text and is 8 px more than it
needs. A cyrillic letter takes 7.219 px, less than a latin character, so its
column keeps the counted width of 450 px.

A character in the wide list is measured like any other character, and it
keeps at least the two cells of the counted width. A full-width character is
1em against a monospace advance of about 0.6em, so two cells leave a column
of Japanese a fifth of room to spare. A colour emoji is usually a little
wider than two latin cells, so on a platform that has a font for it the
column is a little wider than the text in it, and on a platform without one
the character falls back to a box of the width of the monospace font and
keeps the two cells of the counted width.

What the model cannot know is the width of a character the measurement did
not reach, and the width a font gives a character in the middle of a word,
such as a letter of an Arabic word, which the browser shapes.

The walk that finds the characters stops at 1,024 of them, because the list
is only used to measure them in the browser and a file with more distinct
characters than that costs more to measure than the width it gains. A
character the walk did not reach keeps the counted width.

### Why the padding and the border of a cell are written from the measurement

The width of a column is written into the `<col>` of the table, and the model
counts that width again to find out where the columns sit. The two have to
be the same number, and a width that is written as a fixed number is not:
the padding and the border of a cell come from the stylesheet, and the error
is one column wide and it grows along the row. A table of 24 columns whose
cells changed from `px-2` to `px-3` drifts by 184 px over the row, which is
nearly three of its columns, and the columns the viewer could see are then
not the ones in the document.

Both are built from one measurement of a probe that carries the classes a
cell carries, so the width the browser is given and the width the model
counts are the same number. The last column has no border on its inline end,
so its width is smaller than the others by exactly the border, and the model
counts that as well.

### Why the cap counts one layout step of room and not the exact room

A cell is capped at 32 rem, and the cap is the number of characters that fit
in the room the cell has left. The browser keeps its lengths in whole
1/64 px and rounds a text box's width to the nearest one of those steps, so
a value that needs a fraction more than the room still fits, and the text box
the measuring probe reads is rounded up to the next step, so the advance the
probe measures is a hair wider than the one the layout uses. Counting the
characters against the exact room drops one character that fits, so one step
of room is added before the count. The column then stays within a step of
the cap, which no eye can see.

### Why the direction is watched on the root element and not on the preview's size

The window holds the columns the viewer can see, and a right-to-left document
lays the table out from the other end, so a scroll offset means the opposite
of what it means in a left-to-right document. The application sets the
language's direction on the root element, and nothing about the preview's
size changes with it, so the resize observer never fires and the preview
would keep the direction it measured when it opened. The root element's
direction attribute is watched for it, and the preview measures again and
reads the scroll position with the rest of the layout, because the scroll
position follows the direction too.

### Why the probe's text is watched and it has to be a box of its own

The preview watches the probe's text for a change of the font and of the
interface size, because both decide the width of a character, the height of a
row and the padding and the border of a cell. The root element's style is not
watched instead: the app writes to it on every frame of a sidebar drag, and
the measurement would then run on every one of them.

The observer reports the content box of the element it watches, and an inline
box has no content box of its own. The browser reports an empty one for it
and never reports a resize for it, whatever the text inside it measures, so
the probe's text is an inline block: a box of its own, whose width follows
the font. The advance the preview measures is the same either way, because
the width of the text does not change with the display.

### Why the measurement runs for every file and not only when the preview opens

The measuring probe is only in the document while the file has columns, so a
file that opens without columns leaves the preview unmeasured: there is no
probe to read the font from and no observer to watch. The measurement
therefore runs again for every file, and the observers are made for the probe
that is in the document at that moment, so a font or an interface-size
change is still noticed after a file without columns.

### Why the skipped rows and columns are spacers and not placed outside the flow

A table row that is taken out of the flow lays out on its own and no longer
shares the table's columns: the header cells keep their widths while the
body cells collapse. The skipped rows stay in the flow as a spacer row that
takes their height, and the skipped columns as a spacer cell that spans
them, so the header and the body keep the same column widths.

The height of a spacer row is written on the row itself. A cell's own padding
would make the cell taller than the height it asks for, and the rows would
sit lower than the model says.

A spacer cell carries the border of a cell of the table, so the rule under a
row runs across the whole width of the table and not only across the columns
that are in view. The spacer that stands for the columns before the window is
an interior boundary and keeps the border on its inline end, and the spacer
at the end of the file is the table's own last column and keeps the missing
border. A cell takes the height of its row, so the rule of a spacer sits on
the same line as the rule of the cells beside it.

The spacer rows carry no background of their own, so the region they cover is
one flat colour where the preview stripes every row. They stand at least
five rows beyond the edges of the viewport, so the region they cover is never
on screen and the stripes of the mounted rows carry on unbroken.

### Why a range of columns wider than a cell may span is carried by more than one cell

HTML limits the `colspan` of a cell to 1000. The attribute keeps the value
that was written, but the browser lays the cell out over 1000 columns at the
most, and the cells of the window end up in the columns before the ones the
model names. Measured in Chromium against the markup of the preview: a file
with 2,000 columns, scrolled to its end, put the cells of the window 53,572
px to the left of where the model named them, outside the visible part of the
table, and a file with 5,000 columns put them 81,640 px off in the middle
of the file. The table was wide enough and the scroll reached the end of it;
the cells simply were not where the model said they were.

A range of columns that is wider than the limit is therefore carried by more
than one cell, and the spans add up to the number of columns the range
holds. The cells of the window then land in the columns the model names, for
a file of any number of columns, and a range that fits in one cell is still
carried by one cell. The limit is a property of HTML and not of the preview,
so it is a named constant of the model (`HTML_MAX_COLSPAN`) and the cells
that carry a range are computed from it (`tableSpacerSpans`).

The row that stands for the rows outside the window is carried by cells in the
same way. Its cells hold no text, no padding and no border, so they add
nothing to the height of the row, and the height of the row is written on the
row itself. Splitting the cell of a row that stands for 144 rows of a file
with 1,200 columns adds a cell to the document and nothing else: the row was
3,888 px tall with a cell that was laid out over 1,000 of the 1,200 columns,
and it is as tall with the two cells that cover the 1,200 columns between
them.

### Why the striping and the last column's border follow the index

`odd:` and `last:` follow the position in the document, and a windowed table
has a document position that no longer matches the logical one. The rows are
striped and the last column keeps its missing border by their index.

Stepping through a folder's images: `FilesView` reads the shown image's folder
with the tree's hidden and gitignored settings for every image shown, so
files added or removed meanwhile count, and keeps the last listing's arrows
on screen while it reads; an image the listing leaves out gets no arrows.
`imageNeighbors.ts` picks the images before and after it in the tree's order,
wrapping at the ends. SVG counts, since it opens in the image preview. A step
opens the neighbour the way a single click in the tree does (`openContextFile`
with `preview`): on desktop one preview tab follows the steps while the tab
the user started from stays; on the phone the Files surface shows the
neighbour in place and Back still leads to the folder being browsed. The
viewer unmounts while the next image loads, so a step remembers its target and
the viewer showing it within five seconds takes the focus back for the next
key. A folder that cannot be read shows no arrows.

Non-text artifacts the browser must own (PDF, audio, video, fonts) are loaded
through `getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', …)` with
the scoped URL token; the server streams byte ranges so playback can seek.
Images keep the object-URL/data-URL path.

An HTML file's preview is untrusted content. `useHtmlPreviewUrl` asks the
server for a grant (`POST /api/fs/preview`) and loads the page from
`/api/fs/preview/<grant>/<path>`; the frame's `sandbox` has no
`allow-same-origin`, so the page runs as an opaque origin with no session and
cannot reach the app's API, DOM or terminal. Its neighbouring images, styles
and scripts load through the grant in the path. A page outside the workspace
asks for its grant with `allowOutsideWorkspace`, and the server scopes it to
the page's folder. VS Code renders `srcDoc` in the same sandbox. The server
side (read root, CORS, CSP) is described in
`packages/web/server/lib/fs/DOCUMENTATION.md`.

The preview toolbar has the browser panel's "Annotate page" toggle
(`useHtmlPreviewAnnotation`, a thin use of `components/browser/useFrameAnnotation.ts`,
which pages in the chat share) on web and desktop; phones and VS Code do not
show it. The server puts a bridge into every previewed HTML page, and
`lib/browser/previewFrameHost.ts` turns the frame into an `AnnotationHost`, so
`runAnnotationSession` runs the same overlay and the result attaches to the
composer through `useAnnotationAttach`, with an intro naming the file preview.
Before starting, the host probes the bridge; a page that never answers (it
navigated away, or its own CSP blocks inline scripts or `eval`) ends in the
"could not annotate" toast. The prompt names the file path: the preview URL
carries the grant, which is a credential and stays out of prompts. On desktop
the screenshot is the on-screen part of the frame's area of the window
(`visibleFrameArea`, `desktop_capture_page_rect`),
taken after the overlay has torn itself down; a browser cannot photograph a
frame, so on web the annotation goes without one. A reload or another file
ends a running session.

### Why a bridge in the page and not a webview

The browser panel annotates through a `<webview>`, which the app can script
directly. Showing the preview in a webview on desktop would have reused that
as is, but left web without annotation and given the Files view two preview
engines. The bridge works the same in both, and gives the app no reach into
the page that the page's own scripts lack.

The Markdown preview uses `SimpleMarkdownRenderer allowRawHtml`, sharing
Streamdown processing with reference descriptions and comments. The policy in
`chat/markdown/streamdownPlugins.ts` enables raw parsing, a restricted rehype
sanitizer and Streamdown hardening. It permits document elements such as
`picture`/`source`, `img`, `a`, `details`, `sub`/`sup`, `kbd` and aligned blocks.
Author styles, application classes, handlers, forms and embeds are excluded.
Chat keeps raw HTML inert. Media components own safe image dimensions so an
HTML height or aspect ratio is not lost to Tailwind preflight.

A Markdown file's frontmatter shows above its body (`SimpleMarkdownRenderer
frontmatter="properties"`, also used by the plan view): a YAML mapping
becomes a key/value table, lists of scalars become chips, nested values show
as YAML; TOML (`+++`), invalid YAML and non-mapping YAML show as the block
was written. The skill editor hides it (`frontmatter="hide"`) because the
description has its own field there.

`useMarkdownLocalAssets` supplies the file path, workspace scope, file-open
callback and app color scheme before rendering. `MarkdownMediaContext`
resolves relative images and `srcset` candidates through the runtime against
the file's own directory, including files outside the workspace. React media
nodes receive the resulting object URLs; their owner revokes them when the
preview changes or unmounts. Relative links open through the supplied
`useUIStore.openContextFile` callback, shared by the context panel and mobile
files view. Fragment links find a heading within the Markdown root. A source's
`prefers-color-scheme` condition follows the app theme through its rendered
`media` prop. Content, file and runtime changes retire older asset results.

A document image is read once it comes within one height of the preview's
scroller of its visible part (`useNearMedia` with the nearest ancestor that
scrolls vertically as root; a table that scrolls sideways does not count). A `<picture>` is watched as a whole, since its sources have
no box, and a source whose `media` does not hold, the other theme's for one,
is read only once it does. The candidates of one `srcset` are all read when
their image is near.

### Why a document image waits until it is near the view

The preview read every image when it opened: a README with 100 screenshots of
2.8 MB read 280 MB and grew the browser by about 600 MB while two pictures
were on screen (#5320). The observer's root is the preview's scroller, because
a margin on the viewport is clipped by that scroller and an image would start
loading only once already visible. Read files stay until the preview closes:
releasing one far away would collapse its height and move the text being read.

### Why document assets resolve before node updates

Media and link components own their resources and cleanup. Rewriting the
rendered Markdown's `src`, `srcset` or `media` attributes would compete with
React and could publish an old document's assets after a preview switch.

An agent can ask for a file to be shown (`file.open` on the managed
`openchamber` tool). The server broadcasts `openchamber:file-open-request`;
`ContextPanel` answers it with `openContextFile`, `MobileApp` additionally
opens the files drawer. VS Code has no shared file viewer and no managed
tool, so the event never reaches it.

## Editor aids

The text editor's helpers live in `lib/codemirror/` and need no language
server; `FilesView` assembles them. What the syntax tree or git can answer
is shown, nothing that needs type information.

- **Git changes.** `gitChangeGutter` diffs the document against the file's git
  baseline after typing pauses. A click on a bar opens that change in place:
  the changed lines are tinted, the baseline lines show under them, and
  Revert puts them back as an ordinary edit, so undo, autosave and the
  external-change guard treat it like typing. Escape or the close button
  hides it; a later diff keeps it open while the change still exists.
  Read-only files show no Revert.
- **Indent guides** draw one faint line per indent step on the lines in view,
  at multiples of the width the file itself uses (the most common step
  between lines), so a 4-space file does not get guides every 2 columns.
- **Sticky scope** (desktop) pins the first line of each function or class
  whose body fills the top of the editor, up to three, innermost kept.
- **Import links.** Cmd+click (Ctrl+click elsewhere) on a relative import path
  in JS/TS opens the file it names, trying the extensions a bundler tries;
  holding the key underlines the path. Elsewhere that click still adds a
  cursor.
- **JSON errors** (`.json`, `.jsonc`, `.geojson`) underline the first place the
  file stops parsing.

### Why import links stop at relative paths

`./` and `../` paths name a file; aliases (`@/lib/x`) and packages need the
project's resolver settings, and a jump that guesses was ruled out. Go to
definition for symbols needs a language server, which was ruled out as too
heavy; OpenCode's own LSP served the agent only and is not a source for it.

### Why JSON errors accept comments and trailing commas

tsconfig, VS Code settings and `opencode.json` allow them under a `.json`
name. Flagging them would be wrong far more often than missing a trailing
comma in a strict file, so the check blanks both before parsing, keeping
offsets, and reports only the first error: the parser's recovery after it is
noise. JSON5 and JSON Lines are not checked. The JSON tree view parses every
file the same way, so a tsconfig opens as a tree.

## Canvas editors

A "canvas" is an editor with its own document model instead of the text
editor: an extension's file editor (`contributes.fileEditors`, see
`packages/sdk/DOCUMENTATION.md`). It exposes `FileCanvasHandle`
(`fileCanvas.ts`); `getContent(purpose)` returns a `FileCanvasRead`: a
snapshot, `null` for nothing yet, or a failure message. A failure fails the
save or keeps the canvas open on a source or fullscreen toggle; it never falls
back to the stale text draft.

An extension editor claims a file when an active extension's pattern matches
its name (`useGuestFileEditor`, `lib/guests/file-editors.ts`), ahead of every
built-in preview: a text editor only text files, a binary editor
(`content: "binary"`) any file, images and PDFs included. `GuestFileEditor.tsx` mounts `PluginPane
surface="file"` with a per-mount channel (`lib/guests/file-editor-channel.ts`)
holding the draft at mount; the frame gets the file on `hello` / load, answers
snapshot requests within `GUEST_REQUEST_TIMEOUT_MS`, and reports changes. VS
Code and mobile keep the extension catalog empty, so there nothing matches.

The contract is one-directional content. The frame reads the file it was
handed at mount, so `FilesView` remounts it with a `key` of path plus
`canvasRemountNonce` whenever it must adopt content it did not author (a load,
an external write, a toggle back from the source view, a discard). Its own
save adopts content without a remount so the viewport is not reset. Exactly
one instance is mounted, in the docked chain or in the fullscreen overlay;
entering or leaving fullscreen moves unsaved edits through the text draft, as
the source toggle does, and the other slot remounts from it.

`isDirty` (draft differs from file) is not proof of a user edit. The context
panel keeps one FilesView that follows the selected path, so during a file
switch the draft and the file briefly belong to different files. React to real
edits through CodeMirror transactions (`isUserEvent('input' | 'delete' | 'undo'
| 'redo' | 'move')`). Autosave refuses to write an empty draft over a non-empty
file (`shouldScheduleFileAutosave`); an explicit save still can.

Canvas edits never enter the text draft. A separate `canvasDirty` flag feeds
the shared `isDirty`, so autosave, Cmd/Ctrl+S, the unsaved-changes prompt,
`saveDraft`, and the external-change guard all see canvas edits as text edits.
Key events inside the frame never reach the host, so Cmd/Ctrl+S arrives as the
frame's `file-save` and runs the same `saveNow` as the keybind. `saveDraft`
writes the canvas snapshot when the canvas is dirty and the text draft
otherwise, in the line endings the file was loaded with. It takes one snapshot
and marks its version saved after the write; `markSaved` clears the dirty flag
at once and the frame's answer to `file-saved` sets it again when edits landed
during the write. A canvas that went away with its extension clears the flag
instead of keeping autosave writing. The frame's `edited` notices hold
autosave's timer back until the canvas has been quiet for the full delay.

A canvas never mounts over a draft it cannot take (`shouldShowFileCanvas`): a
draft over `GUEST_FILE_EDITOR_CONTENT_MAX` stays in the source view, and a
frame that cannot read the file reports `file-unsupported`, which returns the
viewer to the source view and records that mode for the path.

A binary editor has no text draft. `GuestFileEditor` reads the file's bytes at
mount (`/api/fs/raw` through `runtimeFetch`, `loadCanvasBytes`) and loads the
frame once they are here; too many bytes or a failed read fall back to the
built-in view with a toast. Its snapshot is bytes, written with
`files.uploadFile(..., { overwrite: true })`, the same atomic temp-and-rename
write uploads use, with the stat baseline cleared so the poll does not take
the write for an external change. The binary guards (`isBinaryFile`,
`contentDetectedBinary`) that refuse text saves step aside only while a binary
editor owns the file (`binaryCanvasRef`). There is no source toggle; moving to
or from fullscreen saves unsaved changes first, because bytes cannot travel
through the draft. An external change reloads the file and remounts the
editor with the new bytes, unless it has unsaved changes.

## Excalidraw drawings

`.excalidraw` and Obsidian `.excalidraw.md` files open in the Excalidraw
extension (`github.com/openchamber/openchamber-excalidraw`), offered on the
Integrations page (`components/sections/integrations/CatalogExtensionsSection.tsx`).
Without it, where the runtime loads extensions, the file shows its text under
a one-line notice whose Install button opens that card. `isExcalidrawFile`
matches both extensions, and `isMarkdownFile` excludes `.excalidraw.md` so an
Obsidian drawing never takes the markdown preview path; its source view is the
markdown document.

## Moving and renaming

Dropping a row of the sidebar tree on a folder moves the entry there
(`SidebarFilesTree`, drop rules in `components/layout/fileTreeMoveDrag.ts`).
It is the same native drag that attaches a file to the chat, so the drop
target decides what happens. A file row stands for the folder it is in and
the empty space below the tree for the root, as in VS Code. The entry's own
folder, the entry itself and a folder's own subfolders refuse the drop, and a
drop within the click slop of where the drag began stays a click (#2368).
Touch-only devices do not move: the tree scrolls under the finger. A dialog
asks first unless the user turned it off (`confirmFileTreeMove`, Settings >
General). The server refuses a name that already exists in the target and the
tree says so in a toast; nothing is replaced or renamed. VS Code has no file
tree, so nothing moves there.

A move and both rename dialogs (the sidebar tree and `FilesView`'s own tree)
go through `moveWorkspacePath`. It renames through the runtime and then
points the context panel file tabs and `useFilesViewTabsStore` (open, selected
and expanded paths) at the new path with `moveContextFilePaths`. A file tab's
id comes from its path, so the tab is rebuilt in place and stays active. The
two are kept under different folders in a draft waiting for a new space: the
tabs under the draft's folder, the tree's paths under the space it shows.

The open editor keeps unsaved edits through a move (`lib/filePathMoves.ts`).
While the rename request is in flight, `FilesView` refuses saves of paths
under the source, so autosave cannot recreate the file at its old path. When
the move commits, the editor notes it before the tabs move; once the selected
path becomes the new one, it adopts that path instead of re-reading the file,
which would replace the draft. Editors stay keyed by the path the file was
opened under, so the text editor, a canvas or a diagram is not remounted and
keeps its edits and undo history. The draft reset that normally follows a
change of the selected path is skipped for a moved file, and the open-file
poll does not report the old path as a deleted file while the move is in
flight or not yet adopted.

## Uploads

`useFileTreeUpload` owns uploads for every file browser: `FilesView`,
`SidebarFilesTree`, and the phone browser `MobileFilesSurface` (the mobile app
never shows `FilesView`'s tree; it only hosts `FilesView` as the editor). Files
arrive through desktop drag-and-drop or through the system picker, which folder
menus ("Upload Files"), the tree toolbar, and the mobile browser header open.
On mobile the header button uploads into the folder currently on screen. A single upload runs at a time, in batches of three. Existing
names are never replaced silently: they collect into a replace-confirmation
dialog, which is dropped when the workspace or runtime changes. The feature is
present only when the runtime exposes `files.uploadFile`.
