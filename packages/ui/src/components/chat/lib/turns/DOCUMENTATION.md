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
- Grouped (`activityRenderMode: 'grouped'`) has no Activity fold: a turn is its
  parts in order, with runs of calls of one phase (`activityGroups.ts`) behind
  one line. Text, notices, subagents, questions, background commands and what is
  shown in place stand alone. A group's key is its first part, so it stays open
  while it grows. While the turn runs, the last phase draws exactly its
  latest rows below its line (cut inside a message when needed: whole messages made
  its height, and so the followed end, jump), and the last piece of the last message always draws, because
  live parts, the error and the footer belong to it.
- An exchange (`exchanges.ts`) runs from what the user wrote to what they write
  next. Only its newest finished answer stays whole; earlier turns become lines.
  A turn without a finished answer replaces nothing;
  of failed turns after it only the last stays whole. What opens an exchange (a
  prompt, a digest or page reply, a compaction) keeps its own row above its line. A turn showing a page, a
  waiting form or a UI block never becomes a line. A prompt of another session
  stays inside the exchange, except in a session that works for another one.
- Nothing folds under the reader: a turn seen unreplaced during the visit stays
  open until attention leaves, the user writes next, or the session is opened
  again, and a selection or open comment in it holds it longer
  (`timeline/useSupersededTurns.ts`). A line the user opened stays open.
- `depth` counts the folds a row sits in (an opened group, reply line or Activity);
  `NestedRow` draws its indent and lines. Turn rows keep that wrapper at depth 0,
  so a live call joining a group is not remounted.
- `keepEarlierReplies` folds nothing: replaced turns stay whole in every activity
  mode, with their wake rows.
- A line is unread when its answer finished after `readVisitBaseline`, the view
  watermark from before this visit; the visit's own views do not move it.
- A report that wakes the agent after an answer opens the turn it starts, also
  when its call has a row of its own, so the turn's duration starts at the wake.
  A report the agent picks up on the way stays with its call.
- A UI block's text shown outside its message streams as long as the message that wrote it streams (the phase
  `ChatMessage` gives that message, `ShownPartStreamPhaseContext`); the part's
  own end time only finishes it earlier. A finished step's part can lack an end
  time, and a short note read as still streaming draws nothing.
- Text shown outside the message that wrote it, kept text and text holding a
  UI block alike, carries that message's id and a quote root of its own. A
  selection in it is quoted and commented as that message's text, also while
  it is drawn inside the answer's body, and the comment resolves again when
  the text returns to its step. A quote root's stream leaves out the quote
  roots nested in it, so the answer's stream is the same with the fold closed
  and open. Kept text is drawn one root per part, so its roots are pieces of
  the message's stream with the step's tool rows missing between them: a quote
  taken there reads context only inside its own piece, a selection across two
  pieces takes no anchor, and a quote resolved there compares context only as
  far as its piece reaches, the match nearest where it was taken winning
  (`lib/chatQuoteAnchor.ts`).
- With no message in the viewport (a prompt stuck to the top edge or a message
  mounted below it does not count), kept text is the scroll anchor, named by
  the row that draws it and its part (`MessageViewportAnchor.kept`), so leaving
  the session and coming back returns to it. Restoring finds the part wherever
  it is drawn now (the answer may have arrived and taken it) and gives up once
  the saved row is mounted without it; it never opens the fold around the step
  that wrote it, as navigating to that step does.
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

### Why Grouped splits by phase and not only by text

Most turns of 20 to 50 calls write nothing between them, so groups cut only by
text come out as one line, which Collapsed already is. Up to 5 look-ups between
two edits belong to the edits, or every edit would be its own group. Grouped
replaced Show notes, which kept the notes in view away from the work they
followed; a stored `text` reads as `grouped`.

### Why a replaced turn reads like the event that woke it

A line that showed only the reply hid that background work caused the turn and
that it was not the final one. It has the shape of a finished subagent or session
row, names its cause first and then, after an arrow, how the agent replied. The
answer to the message that opened the exchange is no event: it has a bubble and
its muted text only. Every fold shows its kind at rest (a stacked sheet with
what the calls did for a group, the bubble for a reply) and its chevron on hover or when open: chevrons at
rest on every row filled the transcript.

### Why one answer stays whole and not the direct answer too

The reader sees the direct answer until something newer arrives. Keeping it as a
second rule left two open replies of which the first was often out of date.

### Why a reply folds out of sight and not when a newer one finishes

The newer one often finishes while the reader is inside the older one. Folding on
the same attention signal that decides what counts as read keeps the two in step.

### Why Activity yields while the reader acts on it, and not the other way round

Both automatic behaviours unmount content: a settled fold renders nothing under
its header, and the live window drops the messages older than its newest rows.
The inline comment editor lives in the message body it quotes, so folding under
it closed the box and lost what was typed. Holding the fold instead of moving
the editor into the composer keeps one comment surface and one draft, and it
keeps a plain text selection mounted while the reader copies it. The hold
freezes the window where it was rather than clearing the trim, because letting
the dropped rows back in would move the content the reader is pointing at.
