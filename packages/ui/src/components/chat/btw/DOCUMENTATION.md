# BTW panel

## Ownership

This module owns the `/btw` peek panel, its composer dock priority, and its parent-scoped live identity. Session creation, promotion, deletion, and inherited-history filtering belong to `@/lib/btw`; transient panel state belongs to `useBtwStore`.

## Invariants

- The main composer is also the BTW input. The panel docks above it on desktop and mobile and leaves it uncovered.
- Panel identity comes from the parent's authoritative metadata and requires the linked fork to exist in the live stores. Deletion from another client or the sidebar removes the panel without separate deletion tracking. The fork's directory can be server-canonicalized.
- Live data uses the fork's identity, and the transcript shows only messages after its inherited-history boundary.
- Collapse returns the composer to the parent while the fork continues running. Promotion makes the fork a normal session and navigates to it. Destruction leaves the parent conversation untouched.
- A collapsed panel yields the dock to a parent permission or question so the parent cannot wait on an invisible request.
- Composer and popup Escape handlers have priority. The panel owner decides whether exiting cancels or collapses.
- The working indicator keeps its row reserved to prevent a line-height layout shift. Its clock pauses while the row is invisible because the mounted clock otherwise continues stepping.
- The session error notice remains available when a turn fails before producing an assistant reply, so a lone question still has a visible failure explanation.

## Decisions

### Why primitive subscriptions and memoization and not whole-session updates

Live session readers return primitives, and the panel-state object keeps its identity until a field changes. Status and timestamp updates arrive throughout a turn without changing the BTW link; the memoized panel also avoids rerendering for composer keystrokes because it does not depend on draft text.

### Why the last conversation message and not the last record

Plumbing roles can trail an assistant message. Working-state completion follows the last conversation message so those records cannot hide an incomplete assistant turn.

### Why content observation and not message-count effects

Streaming grows an existing message without changing the record count, so tail following observes content size. Observation attaches when content becomes ready because the empty state has no message-list refs and stable refs alone do not rerun the effect.

### Why measured mobile room and not a viewport-height cap

The on-screen keyboard raises the composer anchor, so a viewport-height cap can push the panel under the app header. The scroll body uses the measured room above the anchor and reserves space for the frame header and bottom spacer.

### Why separate keyed panels and not one changing frame

Separate keyed stages and collapsed/expanded panels allow cross-fades. Exit propagation lets the whole sheet's exit reach whichever panel is visible.
