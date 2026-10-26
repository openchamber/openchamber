# Inline pickers

## Ownership

This folder owns suggestions that open while someone types in a text field (emoji on `:`, snippets on `#` in comments) and where every such list sits, the composer's included:

- `placement.ts`: `placeCaretPopup`, the one placement rule, and `textareaCaretCoords`, which measures a caret a textarea cannot report.
- `useInlinePicker.tsx`: the host for any field that reports its own text and caret, such as the CodeMirror comment editors. It handles opening, keys, writing the choice and the portal.
- `useTextareaInlinePicker.tsx`: the same host wired to a plain `<textarea>` through native listeners, with no change to the field's props. The shared `Textarea` primitive and the hand-rolled textareas use it through `useEmojiPicker`.

A kind of suggestion is an `InlinePicker`: a match rule (where the trigger starts, and the query after it) and a list component. The list exposes `handleKeyDown` and, optionally, `hasResults`. The emoji picker lives in `components/emoji/`, the comment snippet picker in `components/comments/`.

The chat composer keeps its own trigger resolver (`chat/composer/language/triggers.ts`), because its triggers interact (commands, skills, mentions, snippets, emoji) and drive its chips. It places its lists with the same `placeCaretPopup`, through `useAutocompletePosition`.

## Adding a picker

Write the list component (the existing autocompletes are the model) and an `InlinePicker` beside it, then add it to the host's picker array: `COMMENT_PICKERS`, a field's own array for `useTextareaInlinePicker`, or a composer trigger kind. Placement, keys, the Escape and Enter precedence, writing and undo come with the host.

## Invariants

- A list rises right above the line being typed, starting at its trigger, and stays within the field's width. It drops below the line only when the room above is short of its full height and less than the room below, as near the top of the screen. The room below ends where the user can see: on the phone, at the top of the keyboard, which covers the page without shrinking the window. It may extend past the field vertically, for example over the transcript above the composer.
- It is anchored at the trigger, so it does not move while the query grows.
- Every list has the same shape, so they read as one family: 420px wide (the composer's `@` list, which also shows file paths, 560px; emoji, a glyph and a short name per row, 280px), a 4px inset around its rows, rows rounded one step less than the list, the description muted on one line after the name, and the scope at the end edge.
- The field's keys are untouched until the list reports results. After that, the list takes only the arrows, Ctrl+N/P, Enter, Tab and Escape, and none of them during an IME composition.
- A `typedOnly` picker opens only on typing. A paste, a drop or a caret move keeps an open list in step or closes it.
- The choice is written over the trigger and query that the field holds at that moment. If that text changed from outside while the list was open, nothing is written.
- On the phone the composer's lists take its whole width, still right above the line being typed.

## Decisions

### Why at the caret and not at the field's edge

A list pinned to the field's edge can open a whole composer away from the word being typed, and the eye has to travel there and back for every suggestion. Placed at the trigger, the list sits where the person is already looking.

### Why the textarea host listens natively and not through the field's props

Wiring it through each field's `onChange`/`onKeyDown` would touch every caller of `Textarea` and keep them in step forever. Native listeners on the element see input and caret changes just as well. Keys are read on the window in the capture phase, filtered to the field, which runs before every React handler, capture ones included. So with a list open, Enter does not also send a reply, and Escape does not close the panel around the field (the context panel closes on Escape from its capture phase).

### Why the choice is typed with `execCommand('insertText')`

It goes through the browser's own editing path, so the field's React `onChange` runs as it does for typing, and Cmd+Z undoes the choice. Writing `value` directly loses the undo step, so it is only the fallback where the command is missing.

### Why lists are portalled, into a dialog when there is one

Fields sit in glass popovers, where a nested backdrop filter renders transparent, and in panels that clip. A modal dialog treats the rest of the page as outside, so a field inside one portals its list into the dialog.
