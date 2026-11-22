# Linear Module Documentation

## Purpose

This module owns Linear OAuth, issue lookup, Linear-team-to-project mapping, issue status updates, and session status comments on Linear issues. Credentials live on the OpenChamber server, so web, desktop, and a phone paired to that host share them. You can store more than one Linear workspace; exactly one is current. Issue list, mapping, and new OAuth default to the current workspace. Session status comments use the workspace that started the session. The right-hand context panel lists issues for the current workspace, can switch workspace, filters the list, shows a read-only card, changes status or closes the issue, and starts a session or worktree. Start session stays visible in a footer while the issue card scrolls. The chat picker lists issues and attaches them to a message. New Worktree can also start from a Linear issue: it opens a draft in the new worktree with the issue attached, and sends nothing. A session started from a Linear issue, or whose first message carries one attached in the composer, posts started (the composer's send path calls `postLinearSessionStarted`), then completed/failure comments, each with an OpenChamber session link. Those comments are opt-in and only appear when this server has a publicly reachable address.

VS Code omits Linear (`RuntimeAPIs.linear` is optional). Hide Linear UI when the API is missing.

## Entrypoints and structure

- `packages/web/server/lib/linear/index.js`: public server entrypoint. `routes.js` loads it lazily with `await import('./index.js')`.
- `packages/web/server/lib/linear/routes.js`: Express registration for the public callback, `/api/linear/auth/*`, `/api/linear/issues/*`, `/api/linear/mapping`, and `/api/linear/session-status`. It returns the operations behind the status, workspace, disconnect, mapping and preference routes, which the `openchamber` agent tool's `linear.*` actions run (`../openchamber-control/integration-service-actions.js`).
- `packages/web/server/lib/linear/auth.js`: auth file, client id, scopes, redirect URI.
- `packages/web/server/lib/linear/oauth.js`: authorization-code + PKCE S256, public callback broker handoff, refresh, revoke.
- `packages/web/server/lib/linear/client.js`: GraphQL helper, viewer/organization lookup, and access-token refresh. GraphQL errors prefer `extensions.userPresentableMessage` / validation constraints over the generic `Argument Validation Error` label. User-facing Linear errors set `LinearApiError.userError`. Requests send `public-file-urls-expire-in: 3600` so file URLs in issue descriptions and comments are temporarily readable in the panel. Each request carries the 10s `LINEAR_GRAPHQL_TIMEOUT_MS` deadline and reads at most 16 MiB of response data while streaming.
- `packages/web/server/lib/linear/issues.js`: list/search/get issues, team workflow states, `issueUpdate`, and `commentCreate`. Parses identifiers and Linear URLs. `issueUpdate` resolves identifiers to UUIDs first because Linear's mutation does not accept `ENG-12`. List/get include `state.id`, `priority` (0–4), and the first 50 labels (`id`, `name`, sanitized hex `color`) with `labelsMore` when Linear has another page, so the panel can show them and update status without presenting a partial list as complete. Every issue also carries `parent` (the issue's own fields without labels) and `subIssueProgress` (`{ total, done, more }`, done counts completed, canceled and duplicate states, null without sub-issues). Linear has no sub-issue count and every connection multiplies a query's complexity by its page size (one query may not exceed 10,000 points), so a list asks only the first 20 sub-issue states per issue; `more` says there are others. Get and update add `subIssues` (first 100, related-issue fields, in Linear's `subIssueSortOrder`) and `subIssuesMore`, plus the first 50 comments and `commentsMore`. `commentsMore` mirrors `subIssuesMore`: one comments page per issue read, and Linear offers no comment count, so the comments connection's `pageInfo.hasNextPage` is the only truncation signal.
- `packages/web/server/lib/linear/teams.js`: list Linear teams for mapping UI.
- `packages/web/server/lib/linear/mapping.js`: persist default and per-team OpenChamber project paths. Separate from the auth file so disconnect does not wipe maps.
- `packages/web/server/lib/linear/status.js`: persist per-session started/completed/failure flags and post the matching Linear comment with an open-session URL. Posts nothing unless the user opted in and the session origin is public; `isPublicSessionOrigin` rejects loopback, private LAN, carrier-grade NAT, link-local and single-label hosts. The dedupe file keeps the newest 500 sessions.
- `packages/web/server/lib/linear/status-runtime.js`: on the OpenCode event hub, first `session.status` idle after started posts completed once; `session.error` (except abort) posts failure once.
- `packages/web/src/api/linear.ts`: web client wrapper. Electron and hosted/Capacitor mobile reuse it. VS Code omits `linear`.

## Public routes

- `GET /linear/oauth/callback`: public fallback for an explicitly configured direct redirect URI. The built-in flow uses the stable callback broker instead, because desktop and self-hosted instances may have private or dynamic addresses.
- `GET /api/linear/auth/status`: connected flag, current user/organization/scope, and `workspaces` (id, name, current, user, authorizedAt). Never returns tokens. A 401 on the current workspace drops that workspace only; if another remains, status returns that one instead of disconnected. Identity refresh does not bump `authorizedAt`.
- `POST /api/linear/auth/start`: returns `{ authorizationUrl, expiresIn, scope }`. Body may include `origin: "desktop"` so the callback page can raise the desktop window. The authorize URL uses `prompt=consent` so Add workspace can pick a different Linear org. Completing OAuth stores or replaces that org and makes it current.
- `POST /api/linear/auth/activate`: body `{ organizationId }`. Makes that stored workspace current. 400 if the id is missing, 404 if it is not stored.
- `DELETE /api/linear/auth`: revokes the current workspace refresh token when present, then drops that workspace only. Other stored workspaces stay. Mapping is kept.
- `GET /api/linear/issues/list?query=&cursor=&status=&assignee=&teamId=&priority=`: issues from the current workspace. Omitted `status` is incomplete states (same as the chat picker). The panel sends `all`, `backlog`, `todo` (Linear `unstarted`), `started` (In Progress, excluding the In Review name), `inReview` (state name In Review), `completed` (Done), `canceled` (excluding the Duplicate name), or `duplicate` (state type or name Duplicate). `assignee` is `any` (default) or `me`. `teamId` limits the list to that Linear team. `priority` is `all` (default), `none`, `urgent`, `high`, `medium`, or `low`. An identifier or Linear URL returns that issue even if it is completed and ignores the other filters. Each issue includes `state.id` when Linear sends it, plus `priority` (0 none through 4 low), the first 50 `labels` with `labelsMore`, and `updatedAt`. Never returns tokens.
- `GET /api/linear/issues/get?id=`: one issue by UUID or identifier, including description, the first 50 comments with `commentsMore`, team, `state.id`, priority, and the first 50 labels with `labelsMore`. The host Linear guest panel uses this route for the issue card so comment images keep public file URLs. Guest request does not add Linear headers.
- `getLinearIssueSummaries(ids)` (no route of its own): live `{ identifier, title, state: { name, type } }` of linked Linear issues, read by the tracked-items service (`../tracked-items/`) for the sidebar and the chat's Context sources. One aliased query per call, at most 50 identifiers. Linear's `issue(id:)` is non-null, so one identifier the current workspace lacks fails the whole query; that case is asked one issue at a time and the missing identifiers are left out of batches for 10 minutes, per workspace. Missing issues are absent from `issues`. Disconnected is `{ connected: false }`.
- `GET /api/linear/issues/states?teamId=`: workflow states for that Linear team (`id`, `name`, `type`, `position`), ordered like Linear's workflow, plus `statesMore` when the team holds more than the one page of 50. A team holds a handful of states; 50 covers every real team, and the flag says when it did not. Missing `teamId` is 400. Linear not-found or validation errors are 400 with Linear's presentable message. Disconnected is `{ connected: false }` with HTTP 200.
- `POST /api/linear/issues/update`: body `{ id, stateId }`. `id` may be a UUID, identifier, or Linear URL; identifiers are resolved before `issueUpdate` because Linear's mutation requires a UUID. Returns the updated issue. Closing an issue is this same call with the team's first `type: completed` state. Missing `id` or `stateId` is 400. Linear validation (for example a non-UUID `stateId`) is 400 with Linear's presentable message. A GraphQL 401 clears that workspace only. Disconnected is `{ connected: false }` with HTTP 200.
- `GET /api/linear/mapping`: stored default project plus live Linear teams with their mapped paths. Missing file is empty mapping. Malformed file is 500, not empty success. Disconnected is `{ connected: false }` with HTTP 200.
- `PUT /api/linear/mapping`: replace default project and per-team paths. Body `{ defaultProjectPath, teamProjectPaths }`. Failed write does not touch tokens. Disconnected is `{ connected: false }` and does not save.
- `GET /api/linear/preferences`: `{ sessionComments }`. `PUT /api/linear/preferences` with body `{ sessionComments: boolean }` replaces it and returns the stored value. A non-boolean body is 400. The preference is server-side because the event hub posts completed/failure without going through the interface.
- `POST /api/linear/session-status`: post a started/completed/failure comment on the linked Linear issue. Body `{ kind, sessionId, issueIdentifier?, sessionOrigin? }`. `started` requires `issueIdentifier`. `completed` and `failure` reuse the stored issue and open URL from `started`. Each kind posts at most once per session. Answers in this order: disconnected is `{ connected: false }` with HTTP 200; comments turned off is `skipped: 'disabled'`; a `sessionOrigin` nobody else can reach is `skipped: 'origin-not-public'`. `sessionOrigin` must be `http` or `https` with no path, and must resolve to a public host — loopback, private LAN and desktop deep links post no comment at all rather than a link only its author can open. Comment bodies are one markdown link: `[OpenChamber session started](url)` so Linear keeps the `?session=` query. The comment carries no issue or session title: it already sits on the issue, and titles routinely contain brackets that would break the link. Invalid body is 400.

`POST /api/linear/auth/start`, `PUT /api/linear/mapping`, `POST /api/linear/issues/update`, and `POST /api/linear/session-status` parse JSON on the route (`16kb`). They are not on the `/api` 50mb allowlist.

Disconnected list/get/states/update/mapping/session-status return `{ connected: false }` with HTTP 200 so the picker and panel can show an empty state. Missing `id` on get is 400. Missing `teamId` on states is 400.

## Auth storage and config

- Auth storage: `~/.config/openchamber/linear-auth.json` (or `$OPENCHAMBER_DATA_DIR/linear-auth.json`). Shape is `{ workspaces: [ { accessToken, refreshToken, user, organization, workspaceId, current, authorizedAt, ... } ] }`. `workspaceId` is the Linear organization id, or `user:<id>` when there is no org, or `legacy` for a migrated token with neither. A legacy single-object file is rewritten to this list on read. Reconnecting the same org replaces that slot.
- Mapping storage: `~/.config/openchamber/linear-mapping.json` (same data dir). Shape is `{ workspaces: { [workspaceId]: { defaultProjectPath, teamProjectPaths } } }`. Reads and writes use the current workspace slice. A legacy flat file is wrapped under the current workspace id on read. Disconnect does not wipe maps. Writes are atomic and file mode is `0o600`.
- Session status storage: `~/.config/openchamber/linear-session-status.json` (same data dir). Writes are atomic and file mode is `0o600`. Dedupes started/completed/failure per OpenChamber session id.
- Writes are atomic and file mode is `0o600`.
- Client ID: `OPENCHAMBER_LINEAR_CLIENT_ID` -> `settings.json` `linearClientId` -> baked-in public default.
- Client secret: `OPENCHAMBER_LINEAR_CLIENT_SECRET` -> `settings.json` `linearClientSecret`. Optional with PKCE. Do not commit a secret.
- Scopes: `OPENCHAMBER_LINEAR_SCOPES` -> `settings.json` `linearScopes` -> `read,write,comments:create`.
- Session comments: `settings.json` `linearSessionComments`, boolean, absent means off. Written only through `PUT /api/linear/preferences`.
- Broker URL: `OPENCHAMBER_LINEAR_BROKER_URL` -> `settings.json` `linearBrokerUrl` -> `https://api.openchamber.dev/v1/oauth/linear`.
- Redirect URI: `OPENCHAMBER_LINEAR_REDIRECT_URI` -> `settings.json` `linearRedirectUri` -> `<broker-url>/callback`. Setting an explicit redirect URI bypasses the broker for custom/self-hosted OAuth applications.

Linear requires an exact callback match. The built-in application registers `https://api.openchamber.dev/v1/oauth/linear/callback`; the broker holds only the short-lived authorization code. The local OpenChamber server keeps the claim secret and PKCE verifier, exchanges the code for tokens locally, then acknowledges the handoff. Custom brokers must expose `/start`, `/callback`, `/poll`, and `/complete` with the same contract.

## OAuth contract

- Authorization code + PKCE S256. Linear has no device flow.
- The broker stores hashes of OAuth state and a separate claim secret for ten minutes. It never receives the PKCE verifier or Linear tokens. The local status polling path claims a completed broker result and persists tokens on the OpenChamber server.
- Access tokens expire in 24 hours. Refresh tokens rotate; persist the new refresh token from every successful refresh. Concurrent refreshes share one in-flight promise per workspace.
- `invalid_grant` / 401 on refresh clears that workspace only so a dead token cannot loop. If it was the last workspace, status becomes disconnected.
- A GraphQL 401 after a valid-looking token also clears that workspace. A network failure while a token is stored does not: status stays connected with the last known user.
- Every Linear fetch has a named `AbortSignal.timeout`: 10s for GraphQL in `client.js`, 15s for token exchange, refresh and revoke, 5s for broker start, poll and complete in `oauth.js`.
- Hitting a deadline rejects with `LinearApiError` (`status: 504`) or `LinearOAuthError` (`LINEAR_OAUTH_TIMEOUT`, `LINEAR_BROKER_TIMEOUT`), with a message saying the request timed out. This covers a stall before headers and one during the body read.
- A timeout keeps the stored workspace and never reports disconnected.

## Project mapping

OpenChamber has projects (directories), not accounts or organizations. Mapping is how create-session (picker and the right-hand panel) picks a directory:

1. If the issue's Linear team has a project path, use that.
2. Otherwise use the default project path.
3. If neither is set, the UI tells the user to map the team in Settings → Integrations. It does not fall back to the currently active project.

A worktree started from the panel or picker is created in that mapped project. New Worktree from Git is different: it stays in the currently active project.

## Shared UI

- `RuntimeAPIs.linear` is optional. Hide Linear settings, the chat picker, and the panel when it is missing (VS Code).
- Store: `packages/ui/src/stores/useLinearAuthStore.ts`. App start refreshes it from `App.tsx` and `MobileApp.tsx`, not `VSCodeApp`.
- Settings: first-party section on the Integrations page. Connect opens the authorization URL and polls status until the workspace list or current `authorizedAt` changes, so Add workspace is not treated as done just because a workspace was already connected. When connected, map a default project and optional per-team projects for the current workspace. Other stored workspaces appear in a list with Switch to. Disconnect removes the current workspace only. The board can also switch the current workspace when more than one is stored.
- Board: Linear issues list on the issues and PRs board (`packages/ui/src/components/sourceBoard`, desktop/web), next to the repository's issues and PRs. It filters by team, state, whose issues (`assignee=me` or `created`) and priority together, changes an issue's state from its state pill (`issueUpdate`), switches the workspace from the team menu, and starts a session or worktree with the issue attached to the message box. The team's mapped project is where the session starts unless the user picks another. VS Code and the phone shell have their own surfaces (the phone shell opens the board from the sessions menu).
- Chat: composer attach menu "Link Linear Issue" attaches body and comments as `linear-issue` context on the next send. Exclusive with a linked GitHub issue or PR. The attached issue is stored on session metadata (`kind: 'linear'`) so work status can show it. Clicking that work-status row opens the board searched for the issue when Linear is connected on desktop/web; otherwise the Linear URL. Managed Chats do not offer start-from-issue; those sessions have no project directory.
- Worktree: New Worktree can start from a Linear issue. It uses the currently active project and does not consult team-to-project mapping. It shares the reference picker with GitHub (single choice); one issue, PR or Linear issue names the branch.
- Status comments: off until the user turns them on in Settings -> Integrations -> Linear (`LinearSessionComments.tsx`). When on, a session whose first message carries the issue posts `started` once it is sent. The event hub posts `completed` on the first idle after that, and `failure` on `session.error` except `MessageAbortedError`. Failed comments must not fail session create. Comment bodies are English (they live on Linear) and are one markdown link named `OpenChamber session started` (or completed/failed). Web uses `/?session=<id>` on the current origin; desktop reports the loopback origin its own server listens on, not `openchamber-ui://`. A Linear comment is read by the whole team, so the server posts nothing when that origin is not publicly reachable rather than publishing a link only its author could open. Opening `/?session=` selects that session after the global session list can resolve its directory.

## Decisions

### Why GraphQL responses have a 16 MiB cap

Issue list/search pages request up to 50 summaries with labels, parent fields, and 20 child states each. Get/update responses also include descriptions, 50 comments, and up to 100 subissues. A 16 MiB streamed cap gives those data queries more room than the 1 MiB OAuth JSON cap while bounding memory held by each in-flight request.

### Why each Linear fetch carries a deadline

An `AbortSignal.timeout` per request keeps one stalled Linear or broker connection from holding an OpenChamber request open forever. An outer route budget would still leave background callers such as tracked-item refreshes unbounded and could not map the failure to a Linear-specific error. The broker calls get 5 seconds because the settings page polls status every 1.5 seconds; overlapping polls share one in-flight promise in `brokerPollsByState`, so a broker that answers in a few seconds still completes inside the bound. Token exchange, refresh and revoke get 15 seconds because the user waits on a callback page and a slow exchange should finish.

### Why issue summaries report more labels after one page

List and search return up to 50 issue summaries at once. Reading every label page for each issue would multiply query complexity or add a fetch per issue, so summaries request 50 labels and report `labelsMore` when Linear has another page.

## Notes for contributors

The implementation and deployment hand-off for the stable callback broker is
in [`OAUTH-BROKER-HANDOFF.md`](./OAUTH-BROKER-HANDOFF.md). It records the exact
Linear redirect URI that must be registered and why the original loopback
callback could not support packaged desktop or arbitrary self-hosted servers.

- Do not log tokens, codes, verifiers, or the client secret.
- Do not add Linear under Git or as a third-party plugin row.
- Actor is `user`. Do not enable Linear client-credentials tokens for this flow.
- One OAuth grant is still one Linear organization. The server stores many grants and keeps one current. Webhooks and inbound Linear issue actions are out of scope until a later change.
