# Tracked items

Server-owned live state of the change requests, issues and tracker work items that connected clients show: linked pull and merge requests and issues on any registered source-control provider, and tracker work items (Linear issues) on sidebar rows, worktree headers and a session's Context sources, the open pull or merge request of each branch on screen (sidebar, Git view), and the open items listed by the issue picker, the issues and PRs board and Tracker tabs while they are on screen (read with the list's account).

## Contract

- A client announces what it shows with `POST /api/tracked-items/interest` `{ connectionId, visible, items }`, replacing its previous set. `connectionId` names its `/api/openchamber/events` connection (sent in `openchamber:event-stream-ready`); interest lives exactly as long as that connection. The answer carries what is already known (`{ states }`). A connection the server does not know answers `409`; the client resends after its next `event-stream-ready`.
- Changes arrive as `openchamber:tracked-items.changed` `{ states }`, only on connections that show the item, only when its state moved. A state is `{ key, item, state, fetchedAt }`; `state` is null when unknown (never answered, or the provider no longer answers it), never a guessed closed state.
- `POST /api/tracked-items/presence` `{ connectionId, visible }` is sent when the window's visibility flips; `POST /api/tracked-items/refresh` `{ items }` asks now (manual refresh, our own mutations). Clients never poll.
- Items (`items.js`): a source-control item `{ provider, instance, kind: 'pull' | 'issue', owner, repo, number, accountId? }`, parsed by its provider's descriptor (`trackedItems.nestedOwners`, `instance.form`; a host-form instance may be missing and means `trackedItems.defaultInstance`, github.com), or a work item `{ provider, kind: 'work-item', identifier }`. The legacy `{ provider: 'linear', identifier }` without `kind` is still accepted and parses to the work-item shape. A work item's provider is any well-formed id that is not a source-control id or a reserved one; whether a tracker answers is decided at read time. An unregistered source-control provider parses as nothing and is dropped, from requests and from the persisted file alike.
- Item keys (`items.js` `trackedItemKey`) must match `packages/ui/src/lib/trackedItems/model.ts`: `${provider}|${IDENTIFIER}` for a work item, `${provider}|${instance}|${kind}|${owner}/${repo}#${number}[@accountId]` otherwise. A source-control item may name `accountId`, the account its repository is bound to (a branch's request): on GitHub that bound account resolves with its own octokit on github.com and on a trusted enterprise host alike, falling back to the host's current account only when it is absent or no longer resolves; without `accountId` the host's current account reads it (a link). The same request read with two accounts is two items.
- `openchamber:source-control.activity` `{ directory }` goes to every client 3 s after an agent turn finishes there, so branches without a pull request are looked up again (discovery stays with the `pr/status` routes).

## Refresh

- Only items shown by at least one visible connection are asked. Cadence by state: open PR/MR 60 s (30 s while checks are pending), issues and closed PRs 5 min, work items 2 min, settled work items (`state.category` `done` or `canceled`) 5 min, merged never, unknown 60 s. A work item's state read from a file written before categories (only Linear's `state.type`) counts as open until the next answer. A connection turning visible refreshes its items older than 15 s.
- An agent turn finishing (`session.idle` / idle `session.status` on the global event hub) refreshes open items after a 3 s settle.
- A change made through the app's provider routes (a merge, a comment, a state change, a sign-in) and the board's refresh (`POST <provider>/read-cache/refresh`) refresh that provider's open items at once (`refreshProvider`, reported by `provider-read-cache`'s `onChange`).
- Batches per provider, instance and reading account, up to the descriptor's `trackedItems.batchLimit` (GitHub 100, GitLab, Gitea and Gerrit 50); work items batch per tracker, up to 50. `readers.js` has two readers. `sourceControl` calls the source-control module's `readLiveSummaries`, which resolves the bound or current account and calls the provider's `resources.liveSummaries` (GitHub: `fetchPrSummaries` with the bound account on github.com or a trusted enterprise host, else the host's current one; GitLab and Gitea: their resources). `workItems` calls the tracker registry's `liveSummaries(identifiers)`; a tracker the registry does not know answers `disconnected`. Both map to `ok` / `disconnected` / `unavailable`. A GitHub item's instance is its host (missing means github.com), so the same owner/repo on github.com and an enterprise host never shares a batch, a cooldown or a login.
- A failed or rate-limited provider keeps the last known states and is left alone with exponential backoff (30 s to 15 min); GitHub also honours the per-host rate-limit cooldown, which its `liveSummaries` reports as `{ status: 'unavailable' }` (a refused token as `{ status: 'disconnected' }`). No account on a host waits 2 min before asking again.
- `refreshItem(provider, item)` (the read cache's scoped refresh) names a work item by `identifier`, anything else by project and number.

## Persistence

`tracked-items.json` in the data directory holds the last known states (12 h retention, at most 500 entries, written 2 s after a change through a temp file and rename). It is a cache: a missing or malformed file restores nothing. Clients also persist what they received (`useTrackedItemsStore`), so a restarted app shows the last known colours at once.

## Runtimes

Web, desktop, hosted and native mobile use it over the event stream (relayed on mobile; idle traffic is the stream's existing heartbeat). VS Code has no OpenChamber event stream, so it follows nothing, as before.

## Decisions

### Why one source-control reader and not one per provider

Batching, grouping and backoff are the service's; how an account is chosen and what a refused token or a rate limit means are the provider's. One reader over the source-control module's `readLiveSummaries` keeps the service free of provider names, and GitHub's per-host cooldown and 401 rule live behind its own `liveSummaries` as a `{ status }` answer instead of in this module.

### Why work items keep the legacy Linear shape on the wire

Older clients send `{ provider: 'linear', identifier }` and older files hold it. Parsing it into `{ provider, kind: 'work-item', identifier }` keeps the key (`linear|ENG-12`) unchanged, so the same item is followed once whichever shape asked, and nothing needs migrating.

