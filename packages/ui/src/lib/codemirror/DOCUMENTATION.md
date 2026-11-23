# CodeMirror editor extensions

## Ownership

This module owns file-editor extensions, language selection, syntax colors and editor-local navigation. Editor callers own file access, persistence and runtime-specific extension selection. The shared Highlights engine owns lexer loading and language fallback.

## Invariants

- Caret blinking keeps the 1.2 second cycle and restarts visible after edits or selection changes. Both editor and document focus are required for its timer, because editor focus alone survives window deactivation.
- Recreate the highlight extension when its language or theme changes. Tokenizer edits use pre-edit document coordinates; a line-count mismatch resets from the editor document to avoid coloring unrelated text.
- Visible syntax lines finish tokenization before paint, because background batches otherwise leave stale colors on screen. Highlights compiles WebAssembly during import, so the editor stays plain text until loading completes.
- Multiple-cursor selection drawing is desktop-only because it replaces native selection and its touch handles. Vim retains Ctrl+D for half-page scrolling; modifier-click on a relative import takes precedence over adding a cursor.
- Symbol outlines and sticky scopes share the editor's syntax tree. They cover declarations available from parsing; cross-file definitions and references require type information outside this module. Symbol lines are 1-based, navigation offsets point at names, and heading depth is its level minus 1.
- Git hunk offsets and baseline replacement text include line breaks so reverting restores the exact baseline. Markers map through edits until the delayed diff completes; an overlapping refreshed hunk keeps its preview open.
- Git preview actions preserve editor selection and focus. Deletion markers straddle the removed-line boundary, including removals above line 1.
- Import links accept relative specifiers only, because package and alias resolution needs project resolver settings. An unreadable directory leaves resolution failed unless another candidate exists; it cannot establish that a file is missing.
- Indent guides stay inside leading whitespace and use character-width units for font alignment. Blank lines use the deeper neighboring indentation so guides continue through gaps; their tone derives from editor text because the page border tone barely shows on the code background.
- Search-panel space scrolls with the content so line 1 remains accessible while the panel floats over later text. Scroll compensation compares actual applied padding, preserves visible text farther down and returns to the file top when added space would still cover line 1. Panel lookup waits for DOM mounting; its gap matches the default content padding.
- Sticky scopes measure the first visible line again below their own overlay, because pinned rows cover the initial measurement. The overlay covers the gutter and shows each pinned line's own number aligned with the line-number column.
- Vim mappings are page-global. Replacing a mapping set removes the previous set first, including when multiple editors share the page. Only key-to-key map lines are supported; unsupported lines receive 1-based error positions instead of partial interpretation. The accepted silent, nowait, buffer and unique modifiers have no effect in this editor.

## Decisions

### Why a timer caret and not the CSS blink

CodeMirror's stepped CSS animation keeps the compositor ticking every frame despite changing visibility only twice a second. A timer avoids that continuous work and leaves a steady caret with no timer in an inactive window.

### Why Highlights colors and not a second syntax color source

Inline Highlights marks match file-view colors while the Lezer language extension remains available for indentation, folding and brackets. Disable theme syntax colors when Highlights supplies them to avoid competing token colors.

### Why configurable find and not the default Mod-f binding

Find reads the Settings override on every key press and runs ahead of editing commands, because users can rebind it onto an editing key. Fold-all shortcuts remain absent because their Ctrl+Alt bracket chords cycle favorite models.

### Why bounded git diffs and not markers for every file

The gutter skips files beyond its size limit because repeated line diffs cost more than the markers are worth. Preview actions stay at the start of the line because an unwrapped widget can extend beyond the viewport; Close uses a word because a bare cross beside Revert suggests discarding the change.

### Why permissive JSON checks and not strict JSON parsing

Configuration files commonly allow comments and trailing commas under a `.json` name. Replacing those spans with spaces preserves diagnostic offsets, and reporting only the first parse error avoids recovery noise.

### Why selective language imports and not loading every parser up front

Common languages load statically and less common languages load on demand to limit the initial bundle. Language lookup also uses the chat and diff highlighter's extension names to cover files beyond CodeMirror's filename table; Make-like files use shell syntax when a dedicated mode is unavailable.

### Why neutral occurrence fills and not the selection tint

A warm selection tint beneath red keywords resembles an error box, so other occurrences use a neutral text-color fill and the primary occurrence uses an outline. Translucent Markdown code backgrounds keep selection and match highlights visible.

### Why scalable search controls and not fixed input heights

Search input height follows interface text size so fields grow with their neighboring controls. Toggle icons use absolute positioning so collapsing the original label text does not shift the icon; matching input widths reserve space for the action buttons.
