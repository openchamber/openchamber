# Sidebar pages

## Ownership

This module projects the available main-area pages and renders their sidebar
entries. The UI store owns navigation and mutual exclusion between pages. The
Suggested tasks store owns the runtime-scoped server summary and inboxes.

## Invariants

- Suggested tasks sits between Scheduled tasks and Archive, with its existing
  localized label and lightbulb icon. VS Code exposes no Suggested tasks entry
  or summary demand. Phone navigation remains outside this module.
- Each entry reflects the UI store's open state, including navigation from
  elsewhere. Pressing an open entry closes its page through the existing setter.
- The count is the sum of confirmed open suggestions across projects. Zero or
  an unknown summary leaves the plain label. A failed refresh keeps the last
  confirmed count; the store retires it when the runtime changes.
- Only a mounted, visible Suggested tasks row observes the summary and control
  events. Hidden rows release their demand; another visible inbox may continue
  observing through the store's shared subscription. No polling is introduced.

## Decisions

### Why the count belongs to the row rather than the page projection

Both the row model and its renderer consume the page projection. Observing the
count there would read the summary twice and keep observation alive with Pages
hidden or collapsed. The row owns demand and updates its label without rebuilding
the page metadata or session row model. Its renderer passes sidebar visibility
because the sidebar keeps its rows mounted while closed.
