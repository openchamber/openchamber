# Emoji autocomplete

## Ownership

This folder owns the emoji picker people get on `:` while typing: the list (`EmojiAutocomplete`), its `InlinePicker` (`emojiInlinePicker`), and `useEmojiPicker`, which offers it on a plain textarea. Opening, placement at the caret, keys and writing belong to `components/inline-picker/`. The table, the search and the trigger rule live in `lib/emoji/shortcodes.ts`, which also turns `:tada:` in item text into 🎉 for the references preview.

Every text area in the app offers the picker:
- The shared `Textarea` primitive mounts `useEmojiPicker` for all its callers.
- The hand-rolled textareas mount it themselves: commit message, project notes and memory, quote comments, form answers.
- Comment fields offer it beside snippets (`comments/useCommentFieldPicker.tsx`).
- The chat composer offers it as a trigger kind.

Single-line `Input` fields don't offer it. They are searches, names, URLs and keys, and many sit inside lists where the arrow keys and Enter already mean something.

## Invariants

- The list opens only on a typed `:` at the start of the text or after whitespace, followed by at least two letters of a name. `12:30`, `http://`, `key: value` and `:)` never open it, and neither does a paste.
- With nothing found, or a table that could not load, the list closes itself and reports no results, so Enter does what the field does with it.
- Choosing an emoji writes the emoji character and a space, never the shortcode.
- The table (`gemoji`, GitHub's names) loads on the first trigger, not with the app.
