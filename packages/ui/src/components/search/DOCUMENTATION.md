# Search components

## Ownership

This folder owns what conversation search looks like wherever it appears: the result row, the field's one menu (`SearchInMenu`), the status mark, and the context contract. The sidebar, the phone's session sheet and Archive compose these; the field itself is `components/session/SessionSearchInput.tsx`. `conversationContextFromLocation` (`conversationResultContext.ts`) is the one builder of a result's context; the sidebar and Archive call it with their own project, root and folder inputs and do not build context themselves. Matching, the content request and the union of title and message matches belong to `hooks/useConversationSearch.ts`.

## Invariants

- A search needs no setup. Its only narrowing is one choice of where to look (`SearchScope`: titles and messages, titles only, my messages, agent replies, reasoning). There are no filter chips, typed filter flags, lifecycle, project, worktree or author filters, and nothing about a search is stored: text and scope reset together when the text is cleared.
- An author scope searches that author's messages only (`searchScopeQuery` gives `searchIn: 'messages'`), so title matches step aside.
- `SearchInMenu` offers a scope only where message search can run. With message search off or in VS Code it has no scopes and renders nothing unless the caller gave it actions; `effectiveSearchScope` then reads any stored scope as everything.
- The search field is one line at every width. Its controls (count, status mark, menu, clear) sit inside it and appear only while it holds text.
- Only a failed message search has a status. `SearchStatusMark` is an error mark with the words in its tooltip; a phone, which has no tooltips, shows the failure words in a line under the field. A search under way or an index still filling shows nothing. With an author scope the failure words promise no title search, because none runs.
- Archived conversations are always searched. A list shows them after the active ones under one Archived caption; a row carries no lifecycle tag of its own.
- Opening a result never restores an archived conversation: the title opens it, the excerpt opens it at that message.
- Search context uses separate elements with a drawn divider where needed. It never joins visible text with character separators.
- Branches and worktree folders render left to right. Other values resolve their own direction on the inner text span.
- Title matches that hold every query word as typed come first, the most recently changed on top (`rankConversationMetadata`); titles matched only by scattered letters list only when no title holds the words, as the fallback for an abbreviation. Conversations found only by a message follow. The sidebar and Archive match the branch besides the title and leave project and folder names out (`branchOnly`), since they already show the project; the command palette still matches all of them.
- A chat (a result in the chats root, or with no directory) gets an empty context on every surface: no project, folder or branch.
- A space replaces the branch; the worktree folder shows only when no branch is known and the directory is not the project root.

## Decisions

### Why one scope choice and not a set of filters

The first version had five filter groups (lifecycle, project, worktree, search in, author) shown as chips in the field, in a Filters menu and as typed flags, and remembered between searches. Each list already answers most of them by how it shows results: archived matches come as their own block, the sidebar marks every row with its project and Archive narrows by its project column. What is left is where to look for the words, and author only means something for messages, so the two became one choice. A remembered filter also made a later search come back narrower than the user expected.

### Why typed flags are gone

`in:archived`, `project:…` and the rest were documented nowhere in the app, repeated the menu, and made text such as `project:foo` impossible to search for. The field's text is now always the words to find.

### Why the status is a mark and not a line

A reserved line said "Message index ready" on every search. The mark takes no row, and the list under the field does not move when a search fails. It has no spinner for a search under way: with live search every keystroke starts one, so the spinner only flickered while typing.

### Why the row leads with a location mark

In a flat list the project is what the eye scans for, so its icon opens the title line as an identity mark and the age closes it. Lists that already group by project (Archive) pass a context line instead and no mark.

### Why direction sits on the inner text span

The icon stays at the inline start in right-to-left layouts while a branch or path keeps left-to-right text direction.

### Why one builder serves the sidebar and Archive

Both surfaces resolve the same location facts, and each had its own copy of the rules, which diverged: Archive showed a folder for a chat and for a directory it could not name. The builder takes the project (null when the list already names it) and the folder override (a deleted space's name) as inputs, so each surface states only what it knows.

### Why the context data and its icons are separate modules

`conversationResultContext.ts` holds the types and the data builder and imports no React; `conversationContextItems.ts` turns a context into icon items. The sidebar row model imports the builder and runs outside rendering, so it must not load icon and theme modules. Loading them from the row model also broke tests that install their DOM before importing UI modules.
