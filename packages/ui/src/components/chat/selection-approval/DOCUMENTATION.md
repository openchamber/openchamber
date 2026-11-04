# Selection approval

## Ownership

Selection approval owns the desktop and mobile approval buttons, the action that attaches a chat quote, the Settings field and its locale data. The selection toolbar owns selection tracking, anchor capture, placement, eligibility and dismissal. The composer owns its published target and draft storage; the Settings page owns navigation and page layout.

## Invariants

- Read the selection and the column's published composer scope when the user acts. Reject a missing scope, a scope from another runtime, or a rejected draft without clearing the selection.
- Attach the selected Markdown and anchor as a chat-quote draft. Preserve the existing composer text, attachments and other context. Trim the saved approval text and use `LGTM` when it is empty.
- After attachment, synchronously consume and clear the selection. Desktop requests composer focus in a microtask; mobile does not request focus.
- The public namespace explicitly exports the component entries and satisfies `SelectionModule`. Consumers control where each entry mounts.
- Locale dictionaries import this module's pure data directly, without importing its React entries. The existing Settings preference, search anchor and synchronization stay with their current owners.

## Decisions

### Why a namespace re-export and not an aggregate object

The direct namespace re-export lets the bundler remove unused entries and keep a separately loaded Settings entry out of the eager approval-button graph. The explicit entry list limits the public components.
