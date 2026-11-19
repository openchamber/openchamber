# Search matching

## Ownership

This module owns local query matching, ranking and match ranges. The server owns full-text message indexing; callers own grouping and presentation.

## Invariants

- Subsequence matches prefer word starts and unbroken runs; scattered matches start on a word boundary so incidental interior letters do not dominate. Lowercasing preserves per-position offsets, and highlight ranges identify exactly the chosen letters.
- File-name matches rank before folder-only matches, except that a slash explicitly asks about the full path. Conversation search prefers complete query words in recent titles and uses scattered matches only as fallback; an excluded title cannot return through project matching. A list already grouped by project matches branches instead of duplicating every project conversation.
- Dropdown matching requires every query token across ordered fields, with punctuation-insensitive matching and a single-token typo fallback. Punctuation-only compact tokens cannot match everything. Sidebar title conditions require word starts, while dropdowns retain interior matches.
- Match ranges are half-open offsets; highlighting tolerates overlapping or out-of-bounds ranges from other processes. Equal-ranked results preserve original order, and equal or missing conversation dates preserve match order.
