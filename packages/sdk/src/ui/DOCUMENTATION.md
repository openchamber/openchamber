# Guest UI kit

## Purpose

`@openchamber/sdk/ui` is the guest drawing kit. Issue chrome plus three public primitives. The guest owns the data. The host still only sees `attach`, `startSession`, and `request`.

Do not import this from `packages/ui`. The iframe is not the host React tree.

## Entrypoints

- `page.ts`: `mountIssuePage`. Task list with compact filters and a search icon. Same chrome Linear uses on the rail. Jira and ClickUp pass the same rows. A row may carry `badge` (`owner/repo`) and `subtitle` (`feature → main`).
- `card.ts`: `mountIssueCard`. Issue detail. Back, identifier, title, status picker, metadata, description, comments, footer action. Same chrome Linear uses after a row click.
- `attach.ts`: `mountAttachIssues`. Attach picker. Search stays open. Filters are optional. `hasMore` / `onMore` is the GitHub load-more control. `toggle` is one checkbox. The guest owns what it means, like include-diff. `session` is a second checkbox, like create-in-worktree. `action` is a page button, like New merge request.
- `pull.ts`: `mountPullRequest`. Host PR window. `mode: 'create'` is title, description, head, base, draft. Pass `create.branches` to pick head and base from a list. Omit it and those stay text fields. `mode: 'view'` is state, `head → base`, tabs Overview / Changes / Checks / Comments, and footer callbacks the guest passed. Pass `changes` as `{ path, diff }[]` for the Changes tab. Merge and ready fire those callbacks. The kit does not call GitHub.
- `button.ts`: `mountButton`. `default` matches the card footer tint. Also `secondary`, `ghost`, `destructive`.
- `field.ts`: `mountTextField`. Label plus input. Optional password.
- `empty.ts`: `mountEmpty`. Title, body, optional button. The disconnected ClickUp screen uses this.
- `theme.ts`: `applyHostReady(ctx, document.documentElement)`. Writes the host token bag, including font and radius, and `data-oc-surface`.
- `filter.ts`: `filterIssueTasks`. Both components use this. Export it when a guest already narrowed a remote list and still wants the same match rules.
- `media.ts`: `splitIssueCardMedia`. Description and comments use this. Images and http(s) markdown links.

Search, filter menus, and rows live under `chrome.ts`. They are not a public API.

## Invariants

- Pass `items` and `onSelect`. Filters are optional. `value` on a filter is the initial choice for that id. Kit keeps the live choice across `update()`. `onFilterChange` tells the guest so it can pass that value again after a remount. The host does not persist guest filters. `hasMore` without `onMore` does not paint a button.
- `mountIssueCard` takes one `item`. Description and comments keep remaining text as `textContent`. `![alt](https://…)` becomes an `img`. `[label](https://…)` becomes an `a`. Other HTML stays text. `onOpenUrl` is how those links leave the iframe. Guest swaps the list for the card on select. `onAction` is the footer (Attach writes the composer chip). `onStatusChange` is the guest write. The kit only paints the picker.
- A filter without `value` is `all`. Set `value: "all"` when the guest wants that label on first paint.
- `mountPullRequest` takes `mode`. Create needs `create.onSubmit`. View needs `pull`. Callbacks that are omitted stay off the footer. Title, body, checks, comments, and change diffs are `textContent`. `create.branches` turns head and base into pickers. An update in create mode merges `create.values` and does not wipe a title the user already typed.
- `slot` is `start` or `end`. `start` grows and stays labeled. `end` packs after it and becomes an icon under 520px. Omit it and the first filter is `start`, the rest are `end`.
- Rows use `textContent`. Titles never go through HTML parse.
- Call `applyHostReady` from `onReady` before the first mount. Without those tokens the chrome cannot match the host.
- Dispose removes the mounted node. A later catalog from another instance is the host's problem.
