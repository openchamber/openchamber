# Reference picker

The picker for GitHub issues and pull requests and Linear issues, used by the
composer (any number of items, attached together) and by New Worktree (one
item, which names the branch). Extensions are not inside it: they draw their
own search in an iframe and attach through `host.attach`, so the + menu lists
every source, GitHub, Linear and each extension, as its own row.

## Files

| File | Owns |
| --- | --- |
| `ReferencePickerDialog.tsx` | Tabs (GitHub only), search, filter chips, the list, keyboard, checked items, confirm. Desktop shows the list and a preview side by side; mobile opens the preview in place of the list. |
| `ReferencePickerRow.tsx`, `ReferencePreview.tsx` | What a row and the preview show. State colours are the theme's PR tokens, as in the sidebar. |
| `referenceSources.ts` | Which cache a list or a Linear preview comes from, and its key. |
| `referenceCache.ts` | Stale-while-revalidate lists and values. |
| `resolveComposerReferences.ts`, `useAttachReferences.ts` | Turning confirmed items into composer chips with their full context. |
| `referencePickerItems.ts` | Item union, keys, state looks, filters. |

## GitLab projects

The GitHub source is the project's repository source. When the project's read
context is GitLab's (`useGitHubReadContext` prefers GitHub, then GitLab), the
same tabs list its issues and merge requests (`gitlabReferences.ts`): pages
come from the provider-neutral `issuesList` / `changeRequestsList` (open items,
page number as cursor, no filter chips), the preview from `issueComments` /
`changeRequestContext`, and items carry `provider: 'gitlab'` so rows read `!N`
for a merge request. GitLab gives no close reason, so a closed issue reads as
done. The + menu, the picker title and New Worktree name GitLab for such a
project.

## Lists and the cache

- A list is cached per key `[runtime, account or Linear workspace, project, kind, filter, search text]`. Switching tabs or filters, or reopening the picker, shows the cached list at once; one older than 60 s refreshes in the background and is replaced when the answer lands.
- A failed first load is an `error` state with Retry. A failed refresh keeps the shown items and shows the error above them. Failure never becomes an empty list.
- Every first-page request bumps the key's generation; an answer or a later page from an older generation is dropped.
- Keys someone is subscribed to are never evicted; the 40-entry bound is a soft target.
- GitHub pages come from `GET /api/source-control/github/references` (server: `packages/web/server/lib/github/DOCUMENTATION.md`), read with the project's GitHub read context (`useGitHubReadContext`): the account its binding names, or the current github.com account for a repository nobody bound. List and preview cache keys carry that account. Linear lists use `linear.issuesList` with `assignee=me` for the Assigned chip.

## Preview and attach

- The preview shows the list item at once and asks for the rest of the item the highlight rests on (250 ms after it stops moving): GitHub comments, and a PR's size, review and checks, from `references/detail` with the same read context; a Linear issue's description and comments from `linear.issueGet`. Both land in value caches, and attaching a previewed Linear issue reuses the answer.
- Descriptions and comments render with `allowRawHtml`, the Files preview's allowlist: GitHub's `<img>` screenshots, tables and `<details>` show, scripts, styles and author classes are dropped. An image with both `width` and `height` scales by its ratio. The Linear panel and the Git view's PR section render GitHub and Linear text the same way.
- Attaching reads the full context the agent receives through the provider-neutral source-control reads (`issueGet` + `issueComments`, `changeRequestContext`) with the same read context: issue with all comments, PR context with the diff only when "Also send the diff" is checked for that PR, Linear issue with comments. Chips and context parts use the provider-neutral kinds `repository-issue` and `change-request` (with its provider). Each item resolves on its own; the ones that fail stay checked in the picker with the reason, the rest attach.
- The composer keeps attached items as a list (`chat/composer/composerReferences.ts`). The same item attached again replaces its chip in place.

## Keyboard

Arrows and Ctrl+N/P move the highlight from the search field. Enter attaches the
checked items, or the highlighted one when nothing is checked; Shift+Enter
checks the highlighted item. Double-click attaches a row.

## Runtimes

Web, desktop and hosted mobile use it as above; Capacitor mobile gets the
in-place preview layout. VS Code never opens it: the composer offers only files
there.
