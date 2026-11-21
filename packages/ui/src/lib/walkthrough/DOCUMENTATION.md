# Walkthrough client

## Ownership

This module owns the walkthrough wire contract, HTTP reads and mutations, and pure presentation model. The server owns generation, hunk identity and the current diff; the panel owns rendering and navigation.

## Invariants

- Hunk IDs are opaque and resolve only against the server's current index. Missing anchors mark changed code, and uncovered current hunks remain in the tail; clients never invent replacement identity.
- A failed authoritative read preserves the existing walkthrough. Non-JSON 2xx or 404 responses identify an unsupported route, while non-JSON 5xx responses retain their own failure. A revision ignored by an older server cannot satisfy a revision-specific read.
- Leaving the panel does not cancel paid generation. Explicit cancellation owns that action, and progress polling reads server memory instead of rerunning the full Git pipeline.
- Consecutive hunks of one file share a diff block and one file header so the reader sees continuous code. Phase labels describe only work with meaningful wait time; observations remain facts accepted with the change, separate from findings.
- Export writes model text as literal text in both formats. Markdown flattens
  text blocks to one line, escapes markup, emphasis and code markers, writes URLs
  and emails as code spans so no viewer autolinks them, and uses diff fences
  longer than any backtick run in the patch. A file header covers only
  consecutive hunks of one scope and patch header, so a staged and a working
  edit of one file stay separate diffs. HTML treats lines as file metadata only
  before a patch's first hunk; inside a hunk the first character is the diff
  marker, so an added `++count;` is an addition. The standalone HTML escapes
  text, has no scripts or external resources and sets a `default-src 'none'`
  policy.

## Decisions

### Why export uses the view model and not the DOM

`export.ts` uses `buildWalkthroughView` to get the same stale stops and uncovered
hunks as the panel. The stream mounts only visible diffs and keeps the uncovered
tail collapsed, so the DOM does not contain the whole walkthrough.

### Why URLs become code spans and not escaped text

GFM viewers find literal autolinks in text after backslash escapes are decoded,
so `https\://` still turns into a link. A code span is never autolinked, keeps
the address intact for copying and needs no invisible characters.
