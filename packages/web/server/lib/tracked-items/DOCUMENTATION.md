# Tracked items

Server-owned live state of the pull requests, merge requests and issues that connected clients show: linked GitHub PRs and issues, GitLab merge requests and issues, and Linear issues on sidebar rows, worktree headers and a session's Context sources, and the open pull or merge request of each branch on screen (sidebar, Git view).

## Contract

- A client announces what it shows with `POST /api/tracked-items/interest` `{ connectionId, visible, items }`, replacing its previous set. `connectionId` names its `/api/openchamber/events` connection (sent in `openchamber:event-stream-ready`); interest lives exactly as long as that connection. The answer carries what is already known (`{ states }`). A connection the server does not know answers `409`; the client resends after its next `event-stream-ready`.
- Changes arrive as `openchamber:tracked-items.changed` `{ states }`, only on connections that show the item, only when its state moved. A state is `{ key, item, state, fetchedAt }`; `state` is null when unknown (never answered, or the provider no longer answers it), never a guessed closed state.
- `POST /api/tracked-items/presence` `{ connectionId, visible }` is sent when the window's visibility flips; `POST /api/tracked-items/refresh` `{ items }` asks now (manual refresh, our own mutations). Clients never poll.
- Item keys (`items.js` `trackedItemKey`) must match `packages/ui/src/lib/trackedItems/model.ts`. A GitHub or GitLab item may name `accountId`, the account its repository is bound to (a branch's request); without it the host's current account reads it (a link). The same request read with two accounts is two items.
- `openchamber:source-control.activity` `{ directory }` goes to every client 3 s after an agent turn finishes there, so branches without a pull request are looked up again (discovery stays with the `pr/status` routes).

## Refresh

- Only items shown by at least one visible connection are asked. Cadence by state: open PR/MR 60 s (30 s while checks are pending), issues and closed PRs 5 min, open Linear issues 2 min, settled Linear issues 5 min, merged never, unknown 60 s. A connection turning visible refreshes its items older than 15 s.
- An agent turn finishing (`session.idle` / idle `session.status` on the global event hub) refreshes open items after a 3 s settle.
- Batches per provider and reading account: GitHub (`fetchPrSummaries` with the bound account or the current github.com account, up to 100), GitLab per instance (`resources.liveSummaries` with the bound or current account, up to 50), Linear (`getLinearIssueSummaries`, up to 50). `readers.js` maps each to `ok` / `disconnected` / `unavailable`.
- A failed or rate-limited provider keeps the last known states and is left alone with exponential backoff (30 s to 15 min); GitHub also honours the shared rate-limit cooldown. No account on a host waits 2 min before asking again.

## Persistence

`tracked-items.json` in the data directory holds the last known states (12 h retention, at most 500 entries, written 2 s after a change through a temp file and rename). It is a cache: a missing or malformed file restores nothing. Clients also persist what they received (`useTrackedItemsStore`), so a restarted app shows the last known colours at once.

## Runtimes

Web, desktop, hosted and native mobile use it over the event stream (relayed on mobile; idle traffic is the stream's existing heartbeat). VS Code has no OpenChamber event stream, so it follows nothing, as before.
