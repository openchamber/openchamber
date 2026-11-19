# Pierre diff integration

## Ownership

This module owns the Pierre instance lifecycle, shadow-root integration, line
gestures, annotations, find marks and context expansion used by
`PierreDiffViewer`. The viewer shell owns its options and markup; callers own
loading full file contents and storing comments. Shared viewer contracts,
including hook order, stable comment hosts, focus restoration, line metrics and
comment anchoring, live in [the views documentation](../DOCUMENTATION.md).

## Invariants

- An expansion request is replayed once per request object after the full diff
  renders. Its additions-side line identifies the gap because loading the full
  file can merge hunks and change their indices.
- A trailing expansion is offered only when the last hunk leaves the file end
  unknown: at least 3 context lines and no no-newline marker. Its annotation
  uses the deletions side to align with the separators in split view.
- Pierre and the comment controller retain separate selections. User selections
  already originate in Pierre; clearing must reach both copies so the next
  click does not toggle an invisible selection. Programmatic moves and rebuilds
  repaint the selection with callbacks suppressed to prevent feedback loops.
- Text copying leaves the comment editor closed. A multi-line content drag
  suppresses native selection and its release click's find request so the same
  gesture does not produce competing selections or actions. Unfinished comment
  text survives incidental selections and clicks elsewhere.
- A cross-side range has 2 line-number spaces, so it cannot be re-anchored as a
  single-side comment or submitted as a review comment. Review suggestions apply
  only to additions because they replace the new file's lines.
- Find spans and clicked words share zero-based offsets across the row's ordered
  text nodes; line numbers are one-based and include a side because deletions
  and additions can share a number. Marks stay inside syntax tokens so clearing
  and normalizing restores the row without accumulating token fragments.
- Highlight updates preserve observer records queued before the update and
  discard their own records afterward. Otherwise text splitting and merging
  schedules another highlight pass. Matching indexes rendered rows once because
  the virtualized window can serve thousands of matches.
- Hunk controls mount only for rendered annotation slots. Geometry reads finish
  before offset writes to avoid repeated layout, and positions stay inside the
  code column because its clipping can hide the controls.
- Find navigation aligns the active mark when available so a wide row does not
  scroll its match sideways under the line numbers. Virtual scrolling refreshes
  its clamping geometry after expansion; `scrollToLine` returns false until a
  rendered row can be aligned, so callers retry on a later frame.

## Decisions

### Why sampled cache keys and not full-file hashes

Content keys combine the length with a hash of the first and last 200 characters
to avoid hashing an entire large file. The sample is not a complete-content
identity: equal-length edits confined to the middle can share a key.

### Why highlighted swaps and not immediate full-diff replacement

A context reload keeps the partial diff visible while the worker primes the full
diff, avoiding a flash of unhighlighted text. A missing worker or a 2-second
timeout permits an immediate replacement so highlighting cannot block display.

### Why injected CSS and not application utility classes

Find marks live inside Pierre's shadow root, where application utility classes
do not apply. Theme custom properties cross that boundary, and the shared base
CSS keeps plain Pierre file consumers and the diff viewer at the same mobile
font scale.

### Why ordinary painting and not containment hints

The injected diff styles omit `will-change` and `contain: paint` because those
hints break resizing.
