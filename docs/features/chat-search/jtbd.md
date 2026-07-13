# Chat search JTBD

## Job statement

When a user needs to revisit a decision, result, or thought in a long chat, they
want to search the complete loaded history and move between exact occurrences,
so they can recover context without manually scanning or expanding every block.

## Flow

1. Open chat search with Cmd/Ctrl+F; selected text may seed the query.
2. Enter a literal, whole-word, case-sensitive, or regex query.
3. Optionally include reasoning, then use Enter/Shift+Enter or the arrows.
4. Older pages load serially while history remains available.
5. The active logical match scrolls into view; cross-markdown fragments are
   activated together.
6. Escape closes search without changing user-expanded reasoning blocks.

## Accessibility and edge cases

- Search controls are keyboard-operable and expose translated labels and live
  result counts.
- Fenced/preformatted content is excluded; inline formatting remains searchable.
- Virtualized rows may mount asynchronously, so scroll requests retry for up to
  30 animation frames before resolving as failed.
