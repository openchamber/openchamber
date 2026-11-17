# Shared code highlighting

## Ownership

This module owns static code rendering and per-line highlighting results for tool output, permission previews, diffs, and file viewers. The Markdown highlighting backend in `../chat/markdown/highlightedCode.ts` owns tokenization and its cache.

## Invariants

- A render reflects the current code and language even before the effect for changed props commits. Async results from an obsolete request do not replace it.
- Loading and permanent highlighting failure remain distinct so callers can decide when to reveal plain text.
- Carried HTML belongs only to unchanged text at the same line index in the same language. Changed and new lines remain undefined while loading.

## Decisions

### Why whole-block tokenization and not independent row highlighting

Diffs, gutters, and virtualized layouts consume per-line HTML from a single block tokenization. Independent row highlighting loses syntax context for multiline strings and comments.

### Why carry previous highlights and not reset every line

Keeping the latest ready result across loading states lets unchanged lines retain their colours during streaming writes and in-place edits. Resetting every line makes those lines flash to plain text.

### Why host syntax variables and not theme-specific tokenization

Highlighted colours resolve through the host's `--md-syntax-*` CSS variables, so a theme change needs no new tokenization.

### Why synchronous first paint and not effect-only highlighting

Highlights runs on the main thread, so cached highlighted HTML can paint synchronously. Escaped plain code covers the interval before its import finishes.
