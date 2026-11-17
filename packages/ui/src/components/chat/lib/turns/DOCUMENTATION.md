# Chat turn projection

## Ownership

This module projects prepared message records into turns, activity summaries
and virtualized transcript rows. [Message preparation](../DOCUMENTATION.md)
owns context folding and notice classification. [Chat scroll](../scroll/DOCUMENTATION.md)
owns the viewport contract, including row identity, answer chunk spacing and
height estimates.

## Invariants

- Ordered messages establish turn ownership because assistant records have no
  parent ID. Replies before an opening message stay ungrouped. Windowed
  projection follows the full projection's opening rules so turn IDs agree;
  a skipped notice that opens an earlier turn requires the full pass.
- Re-projecting a single turn preserves its first non-assistant record as its
  opener, even when that record is a notice whose preceding answer lies outside
  the input. Full ordered records retain hidden user prompts merged into the
  turn, so their replies keep their ownership.
- Live-tail resolution reads live parts for every assistant message in the
  turn. A previous step's record can lag after the stream advances, and using
  it drops completed tool parts before remounting them with another reveal
  animation. An empty live array is ambiguous and cannot erase populated
  record parts; attached notice rows retain their placement around live parts.
- Unchanged message/live-parts pairs, history entries and timeline rows retain
  their object identity, and unchanged row arrays retain theirs. Display
  normalization and row memoization depend on these references. Earlier
  assistant text is cached by its settled parts array so live updates do not
  reread every completed step; the last assistant record carries that text for
  whole-reply copy and export.
- Projection cache entries hold weak references because projections contain
  message and part references and must not retain evicted transcripts. Cache
  versions use each message's info reference and parts-array reference; store
  updates replace these objects, so in-place mutation invalidates the contract.
- A queued prompt alone does not retire the preceding live turn. Final-answer
  lookup skips trailing compaction, synthetic, skill and shell records and
  uses assistant completion, because intermediate summary text is not proof
  that the turn finishes.
- A turn containing only subagent calls or session notices keeps those rows
  visible without an Activity fold. Pages, proposed workflow runs and earlier
  text containing a UI block remain visible in chronological order; the final
  answer's text remains the answer. An `openui-lang literal` fence stays a code
  sample.
- Answered forms normally fold like completed steps, but a form after retained
  text keeps its answered-summary line so the question still separates that
  passage from the reply. Settled secret cards have no such summary and fold.
- Tool metadata parsing accepts only fields with meanings established by the
  edit and patch renderers, including older MCP and plugin field names.
  Malformed fields cannot discard unrelated valid calls. Tool paths are already
  resolved and assistant messages supply no working directory; a write without
  a result diff still obtains its path from the input. Renames preserve an
  already touched file's identity and first-touch order.
- Answer chunk offsets are valid only when parsed Markdown blocks reconstruct
  the source exactly. Row cutting and size estimation agree with the parts
  MessageBody actually renders, including hoisted pages and settled forms, so
  estimates describe the content the list measures. Only visible user prompts
  supply sticky headers; notice-opened turns have no prompt to pin.

## Decisions

### Why turn details are lazy and not eager

Summary, activity and changed files are derived on first read because a long
transcript mounts only a few rows. Hydrated turn inputs stay fixed and changed
messages produce another record, so cached getters remain valid; patch parsing
waits for a finished answer because changed-file details appear only there.

### Why file pills open the turn diff and not a tool-only diff

The file list and available line counts come from the turn's own edit, write
and patch calls. Pills open the snapshot-based session turn diff, which can
also describe write results and delegated edits absent from those call patches.

### Why a whole-call patch replaces per-file counts

A top-level patch describes the whole call, so adding its counts to per-file
numbers double-counts edits. Its counts belong to a single file only when the
call touches one file; multi-file calls retain unknown per-file numbers.
