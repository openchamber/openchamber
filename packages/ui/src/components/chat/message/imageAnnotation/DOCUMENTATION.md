# Image annotation

## Ownership

The editor opened from a composer image's preview, the vector model behind it,
the geometry that maps pointers and view transforms, and flattening the marks
into a PNG. `message/ToolOutputDialog.tsx` owns the preview and decides when to
offer annotation; the composer and `sync/input-store.ts` own the attachment
that is replaced.

## Invariants

- Marks are stored in natural image pixels. Display size, zoom, and device pixel
  ratio never enter a mark. The SVG uses the image's natural `viewBox`, and
  pointer positions invert the CSS transform through the surface's
  `getBoundingClientRect`.
- One mark is one history entry. A mark being drawn is a draft, not history,
  until pointer up; a text label joins history on Enter. Undo and redo replace
  the present array and never mutate an existing annotation.
- Annotation is offered only when the image popup carries the composer's
  callback. Sent images, tool output, and images opened from a file path stay
  read-only.
- Apply flattens at the natural image size, capped at 16 megapixels. A PNG that
  would exceed the composer's inline limit is encoded as JPEG, then downscaled.
  Failure tells the user and leaves the editor open.
- The flattened file keeps the attachment's filename, so the draft's `[name]`
  citation still finds it. The input store gives the replacement a new id and
  clears path fields, so the draft uploader sends the marked bytes and the
  agent does not reopen the original file.
- While annotating, the gallery arrows, download action, backdrop close, and
  Escape close the editor first. A text field's Escape cancels only the label.
- Panning and zooming clamp to the image edges; the view never shows a gap
  beside the image.

## Decisions

### Why Apply replaces the attachment instead of adding a second image

The composer sends the files its text cites. A second image would need a second
citation and would send both the original and the marked copy to the model,
doubling the image context. Keeping the filename makes the existing citation
correct. The source file on disk is never modified; undo lives in the editor
before Apply. A non-destructive mark history saved with the draft would be a
separate product decision.

### Why marks use SVG and Canvas 2D instead of a drawing dependency

The tools are lines, ellipses, arrows, text, and freehand strokes. SVG keeps
them crisp while zooming and serializes directly for flattening, and Canvas 2D
writes the final PNG without adding a package to the shared UI. The pointer and
history code stays small enough to test as pure functions.

### Why the toolbar floats over the image instead of taking a row

The composer is not in this dialog, and the image is the canvas. A toolbar row
would shrink the image and move it when a tool changes. A floating toolbar sits
at the inline end on desktop and along the bottom on a phone, so the image keeps
its size and the controls stay under the thumb or pointer.