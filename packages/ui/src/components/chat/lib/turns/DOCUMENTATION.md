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
- A busy/retry status or explicit retry notice suppresses only the latest
  same-session assistant error with OpenCode `retry` evidence when its completed
  time, or retry time when completion is absent, is newer than that session's
  last idle time. A missing idle marker means no settled boundary is known, so
  active retry evidence is accepted. Busy alone adds no fallback; only explicit
  retry notices retain fallback or synthetic notices. The display copy retains
  its parts and leaves the stored error alone; previous and unmatched errors
  remain terminal.
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
- Activity holds its fold open and stops moving its row window while the
  reader acts on its text: a shown selection menu or an open inline comment
  editor holds it, and the last release returns it to the turn's current state.
  A turn that settles under an open comment keeps the step it quotes mounted,
  steps below a shown page stay outside the collapse instead of joining it, and
  no row leaves the seven-row live window between the selection and its
  release. The hold holds on the phone too, where the comment is written in the
  composer. When the answer lands, the page moves to the answer row and steps
  below it shift up without a scroll; the fold's hold context reports that
  (`pagesShown`) so an open menu remeasures its position and quote highlight.
  When the quoted step itself becomes the final answer it moves to its own
  row, and the comment moves with it (message module).
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

### Why retry suppression checks the current assistant and idle time

A retry status can overlap the failed assistant message's saved error, and a
stopped message can retain retry metadata. The latest same-session message's
completion or retry time and the session idle marker share OpenCode's event
clock. The message time must follow the authoritative idle time; without an idle
marker, active retry evidence has no settled boundary to compare against.
Clearing only the display copy's error preserves sync state, partial content and
terminal notices for unmatched messages.

### Why a whole-call patch replaces per-file counts

A top-level patch describes the whole call, so adding its counts to per-file
numbers double-counts edits. Its counts belong to a single file only when the
call touches one file; multi-file calls retain unknown per-file numbers.

### Why Activity yields while the reader acts on it, and not the other way round

Both automatic behaviours unmount content: a settled fold renders nothing under
its header, and the live window drops the messages older than its newest rows.
The inline comment editor lives in the message body it quotes, so folding under
it closed the box and lost what was typed. Holding the fold instead of moving
the editor into the composer keeps one comment surface and one draft, and it
keeps a plain text selection mounted while the reader copies it. The hold
freezes the window where it was rather than clearing the trim, because letting
the dropped rows back in would move the content the reader is pointing at.
