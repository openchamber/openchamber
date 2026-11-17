# Chat message preparation

## Ownership

This module owns the display records and prompt previews shared by the chat
timeline and its navigators, running-work context, streaming text boundaries,
and the visual kit shared by generated pages and UI blocks. Turn projection
belongs to [turns](turns/DOCUMENTATION.md); viewport behavior belongs to
[scroll](scroll/DOCUMENTATION.md). Transport and authoritative message state
remain with the OpenCode integration and sync modules.

## Invariants

- Composer context belongs only to the prompt sent with it. A contiguous
  synthetic run before that prompt supplies its attachments; context just after
  the optimistic prompt also belongs to it when its ID precedes the prompt's.
  Client and server clocks can order echoes differently, so minted IDs preserve
  attachment ownership and order while echoes arrive individually.
- Synthetic messages without user context stay hidden unless they represent a
  background report or a session notice. Notices remain available to turn
  splitting even when their role normally renders nothing. Composer-visible
  agent and model changes need no duplicate transcript row.
- A notice arriving during a step stays with that step after completion,
  including when another prompt is queued behind it. An outcome without an end
  time counts as finished, so old history cannot take later prompts' notices.
  Notices awaiting the first step stay in the prompt's turn until it arrives;
  notices after an answer remain between turns unless they open the next step's
  turn.
- Background reports and compactions open turns so the agent's reaction appears
  below them. The last skipped notice between an answer ending with `stop` and
  the next assistant message separates their turns; notices between `tool-calls`
  steps leave the run together. The splitter consumes every message in order.
- Prompt previews use the same folded context as user bubbles, so an
  attachment-only prompt has a label. A lone empty text part supplies no visible
  prompt. Change requests without a provider retain the GitHub pull-request
  caption, and React preview callers include the provider descriptor in memo
  inputs so a newly loaded provider registry updates the wording. Rail previews
  read context captions without depending on link-chip labels.
- Unchanged normalized messages, folded user and assistant entries, and preview
  parts retain object identity. Turn reuse and rail memoization depend on these
  references, so normalizing into a fresh array on every publish invalidates
  otherwise unchanged rows.
- Running-action notes accompany user sends and record delivery for the session
  that takes the message. They announce running browser actions and later stops
  without starting another turn, so the agent can reuse an existing stack.
  Delivery memory is local to the app lifetime; reloading can repeat a note,
  and a run that starts and stops between sends needs no note.
- Background subagent activity comes from busy child-session status because a
  background command has no parent transcript entry until its report arrives.
  Tool-call rows, delivered reports and workflow cards own their corresponding
  children, so the running-run list excludes them to avoid duplicate rows.
- Generated pages and UI blocks share visual-kit variables and CSS so their
  charts and badges agree. Pages supply the app's rem through `--oc-rem` and
  receive tile tones without requiring the app stylesheet; dark tile mixes
  stay smaller because the same mix is stronger near black.

## Decisions

### Why pending background records wait for the user's answer

While a page or secret card waits, background records stay out of the displayed
timeline until the wait ends. Showing them as a new turn removes the waiting
question from the active chat even though the agent reads them only after the
answer; an unchanged result retains the original array identity.

### Why streaming reveals completed blocks and not individual tokens

Completed blocks keep text stable while token-by-token updates rewrap words and
move the last line. A heading or bold-only title waits for its following block
so it never appears alone; the start of a new block can finish its predecessor
before that new line is complete.

### Why long streaming tails have a boundary fallback

A long fence or unbroken paragraph must still show progress. Once the held tail
exceeds the threshold, complete lines and then sentence or word boundaries
release text while the incomplete word stays held.

### Why chart series use a separate palette from syntax colors

Syntax colors can place near-identical hues beside the theme accent and make
adjacent chart series indistinguishable. The shared chart palette keeps series
separate, starts with the app accent and uses darker hues on light backgrounds.
