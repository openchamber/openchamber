# Emoji shortcode lookup

## Ownership

This module owns lazy shortcode lookup and caret-query matching. The picker owns rendering and insertion.

## Invariants

- The emoji table loads only when text or an active picker needs it because most text contains no shortcodes. Failed loads expose failure and remain retryable on the next activation, so the picker can step aside without waiting forever.
- A caret query requires a colon at a text or whitespace boundary followed by at least 2 name letters, preventing times, URLs and ordinary punctuation from opening the picker. Unknown shortcode names stay verbatim.
