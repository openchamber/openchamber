# Jira Integration Module Documentation

## Purpose

- This module owns the Jira integration: connecting a Jira account, starting OpenChamber sessions from Jira issues, linking sessions back to issues, and posting lifecycle status updates to issues.
- The first version focuses on issue-to-session initiation and lifecycle linkage, not full Jira synchronization.

## Entrypoints and structure

- `packages/web/server/lib/jira/index.js`: composes the integration runtime (`createJiraIntegrationRuntime`) and is the only entrypoint `server/index.js` uses.
- `packages/web/server/lib/jira/auth.js`: connection storage (deployment, base URL, credentials, user).
- `packages/web/server/lib/jira/config.js`: integration config (project mappings, default directory, app base URL, update toggles, issue listener).
- `packages/web/server/lib/jira/client.js`: minimal Jira REST v2 client over fetch, deployment-aware auth and search.
- `packages/web/server/lib/jira/issue-context.js`: issue payload -> session title and initial prompt.
- `packages/web/server/lib/jira/links.js`: persisted issue<->session links and listener attempt bookkeeping.
- `packages/web/server/lib/jira/session-start.js`: issue-to-session orchestration (`createJiraSessionStarter`).
- `packages/web/server/lib/jira/status-updates.js`: live session lifecycle -> Jira comments (`createJiraStatusUpdates`).
- `packages/web/server/lib/jira/issue-listener.js`: outbound polling listener that starts sessions from trigger-labeled issues.
- `packages/web/server/lib/jira/routes.js`: `/api/jira/*` Express routes.
- UI surface: `packages/ui/src/components/sections/integrations/JiraSection.tsx` (Settings -> Integrations), which calls the routes through `runtimeFetch`.

## Deployments and auth

- Jira Cloud: Basic auth with Atlassian account email + API token.
- Jira Server / Data Center: Bearer auth with a personal access token; context paths in the base URL are preserved.
- Both use REST API v2 so descriptions and comments are plain strings. ADF payloads are defensively flattened to text.
- Search is deployment-specific on purpose: Cloud uses `/rest/api/2/search/jql`, Server/DC uses classic `/rest/api/2/search`.
- Credentials are validated against `/myself` before being stored. Redirect responses (Server login pages) are treated as auth failures.

## Storage

All files live in the OpenChamber data dir (`OPENCHAMBER_DATA_DIR` or `~/.config/openchamber`), are written atomically, and use mode `0600`:

- `jira-auth.json`: single active connection, including the API token (never returned by any route).
- `jira-integration.json`: normalized integration config.
- `jira-session-links.json`: bounded issue<->session link history (500) and listener attempts (1000).

Malformed stored data is treated as "not configured", never as a crash or as authoritative empty config that would overwrite valid data on its own.

## Issue-to-session flow

`createJiraSessionStarter().startSessionFromIssue({ issueKey, directory?, agent?, model?, requestOrigin?, source })`:

1. Validates the issue key shape, requires a stored connection.
2. Fetches the issue; 404/403 map to an explicit error naming issue permissions and private project access (Jira hides forbidden issues behind 404).
3. Resolves the session directory: explicit `directory` > project-key mapping > default directory; otherwise fails with `no_project_mapping`.
4. Creates the session through the shared OpenChamber session service (`createOpenChamberSessionService.create`) with the issue context prompt.
5. Records the local link, then best-effort posts a remote issue link and a "session started" comment to Jira. Jira-side failures are reported in `result.linkage.errors` without undoing the session.
6. Arms lifecycle status updates only when the prompt actually dispatched.

Session links posted to Jira use the web deep link `<appBaseUrl>/?session=<id>`; `appBaseUrl` comes from config, falling back to the API request origin. Without either, linkage reports the missing base URL explicitly and comments carry the session id.

## Status updates

`createJiraStatusUpdates` subscribes to the shared global message-stream hub (`createGlobalMessageStreamHub`) while at least one session is watched:

- `permission.asked` / `question.asked` -> "attention required" comment, deduped per request id.
- `session.error` -> "failed" comment with a one-line formatted error; ends the watch.
- `session.idle` -> "completed" comment; ends the watch. Idle events inside a 5s grace window after watch start are ignored (stray idle before the turn starts).
- `session.deleted` -> silently ends the watch.

Watchers are in-memory only (bounded at 100): lifecycle is derived from the live event channel, and a restarted server intentionally does not resume watching turns it never observed. Each toggle in `config.updates` is re-read at event time.

## Issue listener

`createJiraIssueListener` polls Jira (min 15s, default 60s) for issues carrying the configured trigger label (`labels = "<label>" AND statusCategory != Done`). Applying the label in Jira is the "issue action" that starts a session; polling is outbound-only so it works identically for Cloud and Server/DC without exposing an inbound endpoint.

- Success records a permanent `started` attempt and best-effort removes the trigger label.
- Failure records a `failed` attempt first, then posts a failure comment (respecting `updates.failed`). A failed issue is retried when it changes more than 60s after the attempt, so the listener's own comment cannot re-trigger a loop.
- Connection and config are re-read on every tick; the listener is started unconditionally at server boot and is a no-op until enabled.

## Routes

All routes are behind the standard `/api` UI auth gate:

- `GET /api/jira/status`: connection summary (no credentials) + config.
- `POST /api/jira/connect`: validate + store a connection.
- `DELETE /api/jira/auth`: disconnect.
- `PUT /api/jira/config`: partial config update (normalized server-side).
- `GET /api/jira/issue?key=`: issue preview.
- `POST /api/jira/sessions`: start a session from an issue (`issueKey`, optional `directory`, `agent`, `model`).
- `GET /api/jira/links?sessionId=|issueKey=`: linkage lookup.

Errors carry `{ error, code }`; codes include `not_connected`, `invalid_issue_key`, `no_project_mapping`, `auth_invalid`, `permission_denied`, `not_found`, `network_error`.

## Failure semantics

- Everything up to session creation fails the whole start operation explicitly; nothing is persisted.
- After the session exists, local link recording happens first, then Jira-side linkage; those failures are partial results reported to the caller, never silent.
- Status comment posting resolves the connection at post time; a disconnect stops updates instead of using stale credentials.
- The listener records a `started` attempt only after the session was created; a crash in the narrow window between creation and recording can at worst start one duplicate session on the next poll.

## Non-goals (first version)

- No inbound webhook endpoint (would require an unauthenticated route in front of the UI auth gate).
- No Jira OAuth 2.0 (3LO) flow; API tokens / PATs only.
- No issue field synchronization, transitions, or two-way comment sync.

## Testing

- `bunx vitest run server/lib/jira` from `packages/web` covers every module, including deployment differences, error mapping, partial-failure reporting, lifecycle dedupe/grace behavior, and listener retry semantics.
