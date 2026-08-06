# Linear Module Documentation

## Purpose

- This module owns the Linear (linear.app) issue-tracker integration: workspace authorization, starting OpenChamber sessions from Linear issues, linking sessions back to their issue, and posting lifecycle status comments to the issue.
- From the user perspective: label an issue (or paste its identifier in Settings), OpenChamber starts an agent session seeded with the issue context, the issue gets a link to the session, and the issue's comment thread receives concise start / completed / failed / needs-attention updates.

## Entrypoints and structure

- `packages/web/server/lib/linear/index.js`: public server entrypoint.
- `packages/web/server/lib/linear/routes.js`: Express route registration for `/api/linear/*` endpoints.
- `packages/web/server/lib/linear/runtime.js`: integration runtime (connect/disconnect, settings, session starts, label-trigger polling, lifecycle status comments).
- `packages/web/server/lib/linear/client.js`: minimal Linear GraphQL client over fetch (no SDK dependency).
- `packages/web/server/lib/linear/store.js`: API key + identity + settings persistence.
- `packages/web/server/lib/linear/link-store.js`: issue ↔ session link persistence.
- `packages/web/server/lib/linear/issue-prompt.js`: issue → initial session prompt and session title.
- `packages/web/server/index.js`: composition root — creates the runtime, registers routes, boots watchers after listen, stops them on shutdown.
- `packages/ui/src/stores/useLinearIntegrationStore.ts`: web client wrapper for the endpoints.
- `packages/ui/src/components/sections/integrations/LinearSection.tsx`: settings UI.

## Routes

- `GET /api/linear/status`: connection state, viewer/organization identity, settings, polling state. Never includes the API key.
- `POST /api/linear/connect` `{ apiKey }`: validates the key against Linear (`viewer` query) before persisting; a bad key never replaces a working one.
- `POST /api/linear/disconnect`: stops polling and clears the stored key (settings are preserved).
- `PUT /api/linear/settings`: partial merge of integration settings.
- `GET /api/linear/teams`: Linear teams for team → project mapping.
- `GET /api/linear/links`: recorded issue ↔ session links, newest first.
- `DELETE /api/linear/links/:issueId`: forget a link (allows re-starting from the issue).
- `POST /api/linear/issues/start` `{ issue, projectId? }`: start a session from an issue id, `ENG-123` identifier, or issue URL.
- `POST /api/linear/poll`: run one trigger sweep on demand.

## Auth and storage

- Config file: `$OPENCHAMBER_DATA_DIR/linear-integration.json` (default `~/.config/openchamber/linear-integration.json`), atomic writes, mode `0o600` (carries the API key).
- Link file: `linear-session-links.json` in the same root (no secrets), bounded to 500 links.
- Personal API keys (`lin_api_…`) are sent raw in the `Authorization` header; OAuth tokens (`lin_oauth_…`) get a `Bearer` prefix.
- `OPENCHAMBER_LINEAR_API_URL` overrides the GraphQL endpoint for tests and local end-to-end validation against a stub server.
- The API key never leaves the module through API responses or logs.

## Settings model

- `defaultProjectId`: OpenChamber project used when no team mapping matches.
- `teamMappings[]`: `{ teamId, teamKey, teamName, projectId }` — resolves the issue's team to an OpenChamber project.
- `triggerLabel` (default `openchamber`): label that hands an issue to OpenChamber when auto-start polling is on.
- `autoStartEnabled` (default off): poll Linear (60s) for unstarted/started issues carrying the trigger label and start sessions for unlinked ones.
- `postStatusUpdates` (default on): post start/completed/failed/attention comments on the issue.
- `linkBaseUrl`: optional base URL for the `/?session=<id>` deep links posted to Linear; defaults to the loopback server URL.

## Issue-to-session flow

1. Resolve the issue reference (UUID, identifier, or URL) and fetch the issue with its last 20 comments.
2. Resolve the OpenChamber project: explicit `projectId` → team mapping → default project → reject with 400.
3. Create the session through the shared OpenChamber session service (`packages/web/server/lib/openchamber-sessions/routes.js`) so model/agent defaults, project validation, and prompt-landed confirmation match the web UI.
4. Persist the issue ↔ session link (idempotency: an already-linked issue is rejected with 409, never started twice).
5. Link back to Linear: an issue attachment pointing at the session deep link, plus a start comment when status updates are on.

## Lifecycle status updates

- The runtime subscribes to the shared global message-stream hub (same source the messenger bridge uses).
- `session.idle` → `completed`, `session.error` → `failed` (with a one-line error), `permission.asked` / `question.asked` → `attention`.
- Status transitions are recorded on the link; a repeated identical status is suppressed so Linear is not spammed by event repeats.
- Comments are best-effort: a Linear outage never breaks the session.

## Failure behavior

- Connect validates before persisting — a rejected key keeps the previous connection intact.
- Session-start partial failure is explicit: once the session exists the local link is always kept, and the response's `linkback` flags report whether the attachment/comment landed.
- One failed issue in a polling sweep never blocks other issues.
- Polling stops itself when Linear reports the key as rejected; other poll errors are logged and retried on the next tick.
- All timers are `unref`ed and `stop()` is wired into server shutdown.

## Permissions

- Access to issues is bounded by the connected Linear key's own permissions (private teams stay private) and on the OpenChamber side by the existing `/api` auth guard — the Linear routes are registered behind the same middleware as every other API route.

## Testing

- `bunx vitest run server/lib/linear` in `packages/web` (colocated `*.test.js`, stubbed fetch/client, supertest for routes).
