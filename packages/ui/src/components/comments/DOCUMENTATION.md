# Comments

## Ownership

This module owns comment fields, cards, selection placement and the controller
that connects file and diff comments to composer drafts. Draft persistence
belongs to the stores; prompt editing and submission belong to the
[composer](../chat/composer/DOCUMENTATION.md). Review state and submission belong
to [review](../review/DOCUMENTATION.md).

## Invariants

- Attaching a comment creates composer context without sending a message.
  Review actions are available only where the host accepts that comment kind.
- A refused save keeps the field and its text because the comment has no other
  saved copy. A review field closes only after its host accepts the comment.
- Saving retains a snapshot of the selected range and stops event propagation
  so parent selection clearing cannot change the comment's destination.
- Drafts match their diff origin as well as their path. A pull request's lines
  and the working file's lines can differ at the same path.
- `lineSource` returns the same object for unchanged content and null while
  lines are unavailable or a range has no single line source. `contentVersion`
  changes with that content. Effects read current host callbacks because hosts
  can supply fresh closures on every render.
- Reanchoring updates stored line numbers so cards, composer context and agent
  context agree. An open field retains the code anchor captured on selection
  through subsequent moves; a rewrite must not replace it with unrelated code.
  Saving an edit replaces old neighbouring context and clears its changed-code
  mark, including when replacement context is unavailable.
- Whole-file comments have start and end 0. Switching files cancels an open
  whole-file editor because the files view reuses its hook instance.
- Comment shortcuts wait for IME composition to finish because Enter and Escape
  also confirm or abandon candidates. Mobile submission follows the prompt's
  Return key setting; desktop keeps the field's Enter preference.
- Picker hosts report text and caret changes, mark pastes and caret moves as
  untyped, and give the picker first refusal on keydown. Replacement leaves the
  caret after inserted text, coordinates use the viewport, and the picker stays
  within the field wrapper's width. Snippet expansion happens on message send;
  agents, commands and file mentions do not resolve inside comment fields.
- Pasted images remain local until the comment attaches. Only images still
  cited in the saved text join composer attachments, so cancelling leaves no
  attachments behind. Clipboard file and file-item entries can describe the
  same image and require deduplication.
- A gutter drag follows the pointer on the window so selection survives leaving
  the gutter or editor. Its config retains identity to avoid rebuilding the
  gutter. Edge scrolling inside the editor starts only after the range grows,
  so a wobble on the first or last visible line stays a click.
- The click dispatched in the mouseup task after a drag counts as its release,
  even over the code or outside the gutter. Hosts must not clear selection as
  though that click starts an unrelated outside interaction.

## Decisions

### Why embedded fields use a textarea and not the composer editor

Diff annotation slots and file-editor block widgets nest the field inside
another editor's DOM, where CodeMirror caret ownership causes jumps to the
start of the line. A textarea keeps its own caret and selection; ordinary page
DOM uses the composer editor so comments render prompt syntax consistently.

### Why rendered previews use partial source anchors and not exact matching alone

Markdown markers interrupt rendered-text matches, so preview mapping tries
shorter anchors. A multiline fragment needs both ends located; a partial match
omits the range because a single-line range would misidentify the quoted code.

### Why mobile highlights share the popup layer and not a body-level overlay

The mobile files panel is a z-50 overlay that covers a separate body-level
highlight. The highlight stays inside the popup layer while only the field
follows the keyboard, keeping the quoted selection visible and stationary.
Opening the field preserves the selected quote through the activating tap.

### Why comment bands use selected-row fill and not hover fill

Diff bands inherit the selected row's computed fill, including its addition
tint. The selected-line variable excludes the transient hover tint left by
clicking the plus button.

### Why mobile actions use words and not tooltip-only icons

Phones have no hover tooltips, so context sits above the field and actions use
labels. When suggestion, review and attach share a row, attach uses its
paperclip alone because 3 worded actions do not fit.

### Why the whole-file label stays fixed and not the path

The short whole-file label stays readable in narrow cards by allowing the
longer path to truncate.

### Why the whole-file editor lives in the sticky header and not at the file top

Opening the editor while scrolled down keeps it visible below the header.
Saved cards stay under that header so the file's diff does not move.

### Why soft Send drops deferred Shift and not hardware Shift

iOS autocapitalization can report phantom Shift on the soft Send key. Deferred
Shift is ignored only for mobile Return-key sending without a hardware keyboard;
hardware and desktop input retain their modifier semantics.

### Why the open annotation comes last and not between saved annotations

Pierre keys annotations by index, so inserting a transient field in the middle
rebuilds every later annotation. The open field stays after saved annotations
to preserve their identity.
