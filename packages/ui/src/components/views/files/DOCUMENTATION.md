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
(fit or 1:1, natural dimensions), `MediaArtifact` (native audio/video
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

`useMarkdownLocalAssets` makes a rendered Markdown file's relative images and
links work: images are fetched through the runtime against the file's own
directory (outside the workspace when the file is) and swapped for object
URLs that are revoked with the preview; relative links open the target file
through `useUIStore.openContextFile`, which the context panel and the mobile
files surface both consume.

An agent can ask for a file to be shown (`file.open` on the managed
`openchamber` tool). The server broadcasts `openchamber:file-open-request`;
`ContextPanel` answers it with `openContextFile`, `MobileApp` additionally
opens the files drawer. VS Code has no shared file viewer and no managed
tool, so the event never reaches it.

## Excalidraw scenes

`.excalidraw` and Obsidian `.excalidraw.md` files open in the embedded
Excalidraw editor (`components/excalidraw/`). The editor is code-split:
`FilesView` imports only the pure `scene.ts` helpers, and the editor (with
`document.ts` and the ~4 MB vendor chunk) loads through
`lazyWithChunkRecovery` when such a file is opened. Exactly one instance is
mounted, in the docked chain or in the fullscreen overlay (two would share one
ref and the live scene); `shouldShowExcalidrawCanvas` in `scene.ts` decides
whether it mounts at all. Entering or leaving fullscreen moves unsaved strokes
through the text draft, as the source toggle does, and the other slot remounts
from it. The web build leaves `@excalidraw/excalidraw` to Rollup's own splitting
so its on-demand locales stay separate chunks.

`scene.ts` owns the file container. A plain `.excalidraw` is the scene JSON; an
Obsidian `.excalidraw.md` is markdown whose `## Drawing` section holds the JSON
in a ` ```json ` or lz-string ` ```compressed-json ` block. A drawing is parsed
and written back in place, so the frontmatter, the text elements, and the
trailing `%%` are preserved byte for byte. The Obsidian plugin wraps the base64
at 256 characters with `\n\n`, which is reproduced on write.

The editor's contract is one-directional content: Excalidraw reads
`initialData` once and resets the scene when that prop's identity changes.
The editor therefore parses the document at mount, and the caller remounts it
with a `key` of path plus `excalidrawRemountNonce` whenever the editor must
adopt content it did not author (a load, an external write, a toggle to the
source view, a discard). The editor's own save adopts content without a remount
so the viewport is not reset. The live scene is exposed through an imperative
`getContent()` handle and serialized only there, because `onChange` fires on
every pointer move of a drag.

Canvas edits never enter the text draft. A separate `excalidrawCanvasDirty`
flag feeds the shared `isDirty`, so autosave, Ctrl/Cmd+S (the keybind accepts
focus inside the canvas wrapper as well as the text editor), the
unsaved-changes prompt, `saveDraft`, and the external-change guard all see
canvas edits as text edits. `saveDraft` writes the scene when the canvas is
dirty and the text draft otherwise, in the line endings the file was loaded
with. It takes one snapshot (`getContent()` returns the document and its scene
signature) and marks that signature saved after the write, so strokes drawn
while the write ran keep the canvas dirty (`createExcalidrawSaveTracker`).
Drawing does not change the draft, so autosave's timer re-arms itself until the
canvas has been quiet for the full delay: one write after the user stops.

A file the editor cannot parse must never mount: a blank canvas would be
serialized over the user's drawing on the next save. The source→canvas toggle
refuses a draft that does not parse, and `ExcalidrawEditor` repeats the parse
and reports `onUnsupported`, which returns the viewer to the source view and
records that mode for the path. The canvas's dirty flag also joins the
external-change guard, so a poll never applies an external write over unsaved
drawing work.

`isExcalidrawFile` matches both extensions, and `isMarkdownFile` excludes
`.excalidraw.md` so the file never takes the markdown preview path. The source
view for `.excalidraw.md` is the markdown document, which is where its
non-drawing sections stay editable.

The editor's chrome follows the OpenChamber theme: `excalidraw-theme.css` maps
Excalidraw's palette variables (primary, islands, popups, inputs, selection
outline) onto theme tokens under the `.oc-excalidraw` wrapper, for light and
dark. The canvas background is left to the drawing, which saves it in the file.

Excalidraw fetches its canvas fonts and the optional "Text to diagram" bundle
from a version-pinned CDN (`esm.sh`, CORS-enabled) when no asset path is set.
Only the CSS-embedded Assistant font is bundled; the hand-drawn fonts are not,
which the desktop and web runtimes allow.

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
