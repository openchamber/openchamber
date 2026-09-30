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

Desktop `FilesView` in editor-only mode neither loads nor constructs its unused
tree. Mobile retains its tree. The context panel passes actual visibility,
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

Sidebar root/runtime changes remount the scoped tree. Its bounded module cache
provides continuity between mounts; request cancellation for collapsed paths
stops queued batches, while already-started reads may populate the same-scope
cache. Runtime changes and unmount invalidate those active reads.

Sidebar rows use browser `content-visibility: auto` to skip layout and paint for
offscreen row contents without unmounting them. The explicit row height follows
the meta line height, the icon minimum and vertical padding, so remembered
offscreen dimensions cannot retain an old font size. Expanded child lists
sit outside each row's containment, so expansion, scrolling, focus and menus keep
their existing DOM structure. Reopening still refreshes directory contents.

## Artifact previews

`previews/` holds what the viewer shows instead of text: `ImageArtifact`
(natural dimensions; fit, which never upscales, or a zoom from 10% to 1600%
through −/+ steps, Ctrl/⌘ + wheel or trackpad pinch, Safari gesture events,
a two-finger touch pinch, and double-click between fit and 1:1, anchored at
the pointer; a zoomed image larger than the viewer pans by mouse drag;
`imageZoom.ts` holds the scale math), `MediaArtifact` (native audio/video
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

Non-text artifacts the browser must own (PDF, audio, video, fonts) are loaded
through `getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', …)` with
the scoped URL token; the server streams byte ranges so playback can seek.
Images keep the object-URL/data-URL path.

The Markdown preview renders the file's raw HTML the way GitHub does
(`SimpleMarkdownRenderer allowRawHtml`): right after marked, a separate
DOMPurify instance keeps a GitHub-like allowlist (`markdownSecurity.ts`:
`picture`/`source`, `img`, `a`, `details`, `sub`/`sup`, `kbd`, aligned
blocks) and drops author styles, classes, ids, data attributes, handlers,
forms and embeds. Chat keeps raw HTML inert. A numeric `img height` becomes
an inline height, because Tailwind preflight's `height: auto` would beat the
attribute.

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
