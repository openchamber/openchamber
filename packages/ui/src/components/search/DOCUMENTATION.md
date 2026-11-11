# Search components

## Ownership

This folder owns shared search result presentation, filter chips, and its context contract. `conversationContextFromLocation` (`conversationResultContext.ts`) is the one builder of a result's context; the sidebar and Archive call it with their own project, root and folder inputs and do not build context themselves. `SearchFilterChips` renders the non-default query filters and owns their presentation and removal controls.

## Invariants

- Search context uses separate elements with a drawn divider where needed. It never joins visible text with character separators.
- Branches and worktree folders render left to right. Other values resolve their own direction on the inner text span.
- Kind icons speak their kind, then the visible value follows in DOM order.
- A chat (a result in the chats root, or with no directory) gets an empty context on every surface: no project, folder or branch.
- A space replaces the branch; the worktree folder shows only when no branch is known and the directory is not the project root.
- Filter chips omit category and default-valued filters. Their order stays project, worktree, lifecycle, search scope, then author.
- Project and worktree chips show a short label with the full path in their native title. Worktree paths stay left to right.
- Remembered filters use `openchamber.search.filters.v1.<surface>` and are written only when a user action changes filters. Defaults and category are never stored. A remembered project that is not registered is dropped, and the removal stored, once the project list is known, including when it arrives after search opened; other filters stay. Desktop sidebar and phone sheet share the `sidebar` surface.
- Archive, sidebar and Cmd+P apply a filter the same way. Titles only (`search:titles`) matches the session title alone, never the project, worktree or folder text, and sends no message request. A worktree filter names one registered worktree by its full path or its exact label, name or branch (`matchesConversationWorktreeScope`), never a substring, so `/worktrees/task` leaves out `/worktrees/task-old`. Cmd+P also counts a folder below the worktree; the sidebar and Archive take the worktree folder itself.
- The sidebar's Filters menu shows wherever its search field does, including the always-open field in VS Code. VS Code offers Show and Search in only (one workspace, no message search); web and desktop add Project and Author (`sidebarSearchScopeOptions`).

## Decisions

### Why direction sits on the inner text span

The icon stays at the inline start in right-to-left layouts while a branch or path keeps left-to-right text direction.

### Why icons speak their kind

The same second line can combine project, folder, space, and branch values. The icon wrapper gives assistive technology the missing kind before each value.

### Why one builder serves the sidebar and Archive

Both surfaces resolve the same location facts, and each had its own copy of the rules, which diverged: Archive showed a folder for a chat and for a directory it could not name. The builder takes the project (null under its own header) and the folder override (a deleted space's name) as inputs, so each surface states only what it knows.

### Why filters live outside the text

Filters are structured state. Keeping them as chips leaves the text field for the words a person typed while preserving each filter's separate removal action.

### Why the sidebar shows a Filters button, not scope segments

The filter button opens the existing menu and shows how many active chips affect the result. Scope segments repeated values already visible in chips and crowded the sidebar search controls.

### Why the context data and its icons are separate modules

`conversationResultContext.ts` holds the types and the data builder and imports no React; `conversationContextItems.ts` turns a context into icon items. The sidebar row model imports the builder and runs outside rendering, so it must not load icon and theme modules. Loading them from the row model also broke tests that install their DOM before importing UI modules.
