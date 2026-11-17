# Chat input composition

## Ownership

This directory owns the ChatInput composition, its local state, event handlers
and rendered form and dialogs. The parent composer directories own the prompt
language, editor, attachment conversion and outgoing-message builders.
`ChatInput.tsx` keeps its existing props and memoized export and connects these
modules through explicit dependencies.

## Invariants

- Hooks run unconditionally in the same composer instance. Effects retain their
  ordering, including draft restoration before pending text is consumed.
- The text store, editor view, refs and stable handlers keep the original
  composer lifetime. Moving state into a hook adds no subscription.
- Render helpers return the existing JSX without introducing component or DOM
  layers. The file picker stays mounted outside the pill/full-editor branch.
- Submission captures its target and recovery state before asynchronous work.
  Extracted action and failure handlers receive that same captured state.
- Dependency types select the fields a module consumes. Type-only imports do
  not introduce runtime dependencies between the composing hooks.

## Decisions

### Why hooks and render helpers share the composer instance

Keeping the existing state and effect lifetime preserves editor focus, pending
work and memoized child props. Separate stateful component trees or a new shared
context would change those lifetimes or their update boundaries.
