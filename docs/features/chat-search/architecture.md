# Chat search architecture

## Component flow

`ChatContainer`
→ `useChatSearchMatcher(sessionMessages)` and serialized search pagination
→ `ChatSearchWidget`
→ `useChatTimelineController.scrollToMessage`
→ `MessageList` imperative handle and the current TanStack virtualizer.

Message parts create a part-scoped `SearchContext`. Markdown parts highlight at
the marked/morphdom DOM boundary; plain user text uses the same DOM helper.
`ReasoningTimelineBlock` consumes the active `MatchRecord` and only search-opens
the matching reasoning part.

## Data model

`MatchRecord` is `{ messageId, partId, partType, occurrenceInPart }`. A logical
match that crosses inline text nodes creates multiple marks with the same
`data-search-occurrence`; ordinary and cross-boundary matches are discovered in
one concatenated inline sequence.

The data matcher normalizes structural markdown without removing literal
punctuation from prose, while the DOM highlighter walks the rendered inline text.
This keeps occurrence order aligned across both layers. Fenced and preformatted
content is excluded by both paths.

## State and failure handling

- Zustand owns query, flags, ordered matches, active index, and pagination
  loading state.
- Matcher scans each eligible text/reasoning part independently and preserves
  the active logical record only across content updates, not query/flag changes.
- Pagination keeps an in-flight request key in a ref. Settlement increments a
  retry version so a session/query change observed during the old request is
  evaluated immediately afterward.
- Message scrolling reports success only after a real message/turn element is
  found; virtual index requests are retried with bounded animation frames.
