# Change request review

## Ownership

This module lets a person review a change request from its diff: the comments under its lines and the form that sends the review. It owns the read of the review state and the writes to it, and the cards and the button. The comment field is `components/comments/InlineCommentInput.tsx`, shared with every surface that comments on code. The host-side mechanics are each provider's (`packages/web/server/lib/<provider>/`, contract in `source-control/review-position.js`).

## Invariants

- The draft lives on the host. Nothing here stores it, so a review started on a phone, on the host's own site or by an agent through `gh` shows in the same draft.
- `ChangeRequestReviewContext` is null outside the diff of an open change request's current revision and on a host without `features.reviewDrafts`. Every shared surface reads null as "draw what you always did", so the comment field gains its review actions only where a review can take them.
- A failed read leaves the last state in place and sets `readFailed`; it never reads as an empty review.
- Every write reads the review again, a refused one too. A refused comment keeps the field and its text open.
- A review goes out for the commit the diff was read at; a push since is refused, and the draft stays.
- A verdict on a draft begun on an older commit is refused, since the host would record it against that commit. The draft still goes out as a comment, and the verdict follows on the commit read.
- `owner` may be empty: a top-level project on a path-style host (Gerrit) has none.

## Decisions

### Why the draft is on the host and not in the app

A local draft would need its own sync across devices and would hide what an agent wrote through `gh`. The host already keeps one draft per person, which is what the reviewer sees on its own site too.

### Why Attach stays the primary action of the comment field

The field talks to the agent everywhere else, and most comments in a diff are for the agent. Add to review sits beside it, the same on your own change request and on someone else's, so nothing changes under a hand that knows the field.

### Why the review button and not a bar over the files

The toolbar already holds the actions of a diff, and the local Review button leaves that spot free on a change request's diff. A bar would take a row of height from the code.
