# Diff helpers

## Ownership

This module owns patch preparation, rendered-line lookup, whitespace filtering, and retained change-request snapshots. Diff components own rendering and actions; source-control APIs own fetching and applying patches. `workerFactory.ts` is loaded dynamically by `DiffWorkerProvider`.

## Invariants

- Patch-backed line arrays contain hunk lines back to back. File-line lookup goes through the covering hunk; lines outside the hunks are unavailable.
- An empty side represents an absent file and cannot establish that a comment's quoted code has disappeared.
- Search spans and word-lookup offsets index the rendered row's original text without trailing CR/LF. Case folding changes matching only; file line numbers remain 1-based and character offsets remain 0-based.
- Search follows rendered reading order. Unified context has only an additions row, so a context match appears once on that side; split context has a row on each side. Changed rows retain their own side in both layouts.
- Whitespace filtering preserves each side's text and file line numbers. Recut hunks stay within the original hunk because a partial patch has no content beyond it.
- Trimming a partial diff also compacts its line arrays and remaps block indices. The renderer joins hunk lines, so retaining dropped lines shifts later content and loses trailing rows.
- Standalone hunk patches retain the original file header and hunk bytes. A CR before LF inside a hunk belongs to file content and survives apply/reverse round trips.
- Change-request files retain their original patches, including binary and metadata-only changes. Labels for earlier revisions include that revision so the comparison cannot appear current.
- Snapshot identity includes the bound read context. The same change request under another binding cannot reuse the entry.
- Snapshot caches belong to one retained comparison view, with no persistence or background refresh. Eviction releases completed cache entries only; it leaves mounted diffs and pending requests intact, and an oversized current snapshot stays complete.

## Decisions

### Why full object IDs and not abbreviated hashes or change totals

Patch action identity uses the full object IDs requested by `getDiff`. Abbreviations cannot establish full identity, and changed-line totals can remain equal after partial staging.

### Why bounded alignment and not an unbounded whitespace comparison

Matching prefixes and suffixes handles re-indented code without a matrix. The remaining alignment runs only within the cell limit because hiding whitespace does not justify unbounded memory use.

### Why empty hunk sides use a boundary and not a first-line number

A zero-length side identifies the line before an insertion, while a nonempty side identifies its first included line. Hunk placement preserves that distinction so insertion positions and collapsed gaps stay aligned.
