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
(CSV/TSV through `delimitedText.ts`, capped rows stated in the meta line),
and `BinaryArtifact` (name, type, size, download; never a decode attempt).
`FilesView.renderArtifactPreview` is the single switch both the docked and
the fullscreen viewer use. SVG, Mermaid (`.mmd`) and delimited files are text
with an artifact view: each has a per-path preview/source toggle, and opens
in preview regardless of the text-first setting because an agent-produced
artifact is opened to be looked at.

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

The Markdown preview renders the file's raw HTML the way GitHub does
(`SimpleMarkdownRenderer allowRawHtml`): right after marked, a separate
DOMPurify instance keeps a GitHub-like allowlist (`markdownSecurity.ts`:
`picture`/`source`, `img`, `a`, `details`, `sub`/`sup`, `kbd`, aligned
blocks) and drops author styles, classes, ids, data attributes, handlers,
forms and embeds. Chat keeps raw HTML inert. A numeric `img height` becomes
an inline height, because Tailwind preflight's `height: auto` would beat the
attribute.

A Markdown file's frontmatter shows above its body (`SimpleMarkdownRenderer
frontmatter="properties"`, also used by the plan view): a YAML mapping
becomes a key/value table, lists of scalars become chips, nested values show
as YAML; TOML (`+++`), invalid YAML and non-mapping YAML show as the block
was written. The skill editor hides it (`frontmatter="hide"`) because the
description has its own field there.

`useMarkdownLocalAssets` makes a rendered Markdown file's relative images and
links work: images and `srcset` candidates are fetched through the runtime
against the file's own directory (outside the workspace when the file is) and
swapped for object URLs that are revoked with the preview; relative links
open the target file through `useUIStore.openContextFile`, which the context
panel and the mobile files surface both consume. A `<source
media="(prefers-color-scheme: …)">` follows the app theme, not the OS: the
feature is rewritten to an always-true or never-true query and re-evaluated
when the theme changes.

An agent can ask for a file to be shown (`file.open` on the managed
`openchamber` tool). The server broadcasts `openchamber:file-open-request`;
`ContextPanel` answers it with `openContextFile`, `MobileApp` additionally
opens the files drawer. VS Code has no shared file viewer and no managed
tool, so the event never reaches it.

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
built-in view with a toast. The byte read judges the cap before and during
the read (`readCanvasResponseBytes` in `fileCanvas.ts`): a declared
`Content-Length` over `GUEST_FILE_EDITOR_CONTENT_MAX` refuses before the
body is touched, and a streamed body is cut off past the cap, so an over-cap
file is never buffered whole. The mount gate waits for the view's stat
while the size is unknown; a stat that settles with no size (no
`files.statFile`, or it failed) mounts and lets that bounded read judge. Its snapshot is bytes, written with
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
