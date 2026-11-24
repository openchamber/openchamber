# UI store composition

## Ownership

`../useUIStore.ts` creates the single Zustand store, attaches devtools and
persistence, and preserves the public imports used by every UI runtime.
This folder owns its state contract, initial values, persistence, context-tab
transitions, and action groups.

Action factories receive the same store's `set`, `get`, and API. Calls between
groups go through `get()` so they use the current state and actions.
`contextTabs.ts` normalizes tab identities and targets. `contextPanelState.ts`
owns directory-panel transformations and saved-panel sanitization.
Neighbouring stores still own terminal state and the files view's open paths.

## Invariants

- There is one `useUIStore` instance for all action groups.
- Initial arrays, maps, templates, and keyboard preferences are created when
  the store initializer runs.
- Persistence keeps the `ui-store` key, version 30, migration ordering, and
  the same saved fields. A context panel window swaps only the storage
  (`contextWindowPersistOptions`): its zone layout and tabs go to its own
  record, and it writes back only the shared fields it changed.
- The context-panel actions listed in `lib/contextWindow/routing.ts` are
  wrapped when the store is composed; while the main window's panel is in a
  window of its own, they run there.
- Context-tab actions retain their terminal and files-view side effects.
- Browser tab IDs share one module-level sequence across user and agent tabs.
- Consumers continue to import the store, public types, constants, and helpers
  from `../useUIStore.ts`.

## Decisions

### Why action groups share the store

Each group needs current values from other groups, and callers subscribe to
the existing combined state. Separate Zustand stores would change subscription
and persistence behavior, so these modules only compose the original store.

### Why the zone return stack is transient and opt-in on close

`contextZoneReturnStack` records per-zone navigation history only in memory,
never in `ui-store` persistence, so a restart never reopens an old panel when
dismissing a current one. Programmatic jumps (`openContextPanelTab`,
`openTrackerItem`) push the zone's active surface while explicit rail switches
(`openContextSurface`) and plain `closeContextZone` calls clear the stack; only
the panel header close action passes `returnToPrevious: true`, so layout
displacement and shortcuts always close the zone immediately.
