# E2: how the dispatcher recognises a space request

Method: code reading only, 2026-09-19. Nothing was run. Paths are relative to the repo root. `ui/` means `packages/ui/src/`, `server/` means `packages/web/server/`. SDK lines refer to `@opencode-ai/sdk` 1.18.31, `dist/v2/client.js`.

## Verdict

1. Use client-side addressing (B). The dispatcher matches one thing only: the URL prefix `/api/spaces/<id>/`. It never reads a directory, a body, or an id to decide where a request goes.
2. Server-side recognition (A) cannot work as "forward whole": the terminal socket is one multiplexed socket for all terminals, the dev tunnel names only a port, and about ten route families carry the directory only in a JSON body or not at all.
3. B is cheap because every UI request already passes through two seams (`runtimeFetch` and the runtime URL resolver). No raw `fetch('/api...')` exists in `ui/` or `packages/web/src`. The server adds two small guards on top, so a forgotten call site fails loudly and never reaches the wrong place.

## Inventory

| Channel | Where | Directory known at call site | How it is conveyed today |
|---|---|---|---|
| SDK client factory | `ui/lib/opencode/client.ts:221-229`, all calls go through `runtimeFetch` as a `Request` | n/a | base URL fixed at client creation (`client.ts:373-377`), rebuilt on runtime switch (`client.ts:391-397`) |
| SDK scoped client | `client.ts:419-428` | Always | SDK sets header `x-opencode-directory`, URI-encoded (SDK `client.js:55-59`). On GET and HEAD it moves the header into `?directory=` (SDK `client.js:17-41`) |
| SDK unscoped client with per-call `directory` | about 40 sites in `client.ts` (for example `:639-641`, `:1265-1268`), `ui/sync/session-actions.ts:501,571,1639,2393` | Best effort: `requestDirectory ?? currentDirectory`, omitted when both are empty | `?directory=` query |
| SDK calls with no directory parameter | `auth.set/remove`, `global.*`, `experimental.controlPlane.moveSession` (`session-actions.ts:380`), provider pages (`ProvidersPage.tsx:225,260,477`) | No | nothing |
| Git | `ui/lib/gitApiHttp.ts:135-141` (one `buildUrl` helper, 68 calls) | Always | `?directory=` |
| Files (web RuntimeAPI) | `packages/web/src/api/files.ts:64-67` and each method | Path always. Header is the ambient current directory (`packages/web/src/api/index.ts:47`) | `?path=` or JSON body `path`, plus raw (not encoded) `x-opencode-directory` |
| File upload | `files.ts:233-246` | Yes | `?path=`, body is a streamed `application/octet-stream` blob |
| Terminal HTTP | `ui/lib/terminalApi.ts:468` (create, body `cwd`), `:476` (list, `?cwd=`), `:518-525` (`/api/terminal/:id/...`), `:492` (`touch`, body is a list of ids) | UI store is keyed by directory (`ui/stores/useTerminalStore.ts:84-99`) | mixed: body, query, id only |
| Terminal WebSocket | `terminalApi.ts:185`, singleton `:465` | No | one socket, terminal id inside each frame (`:205`, `:239`) |
| Global event WebSocket and SSE | `ui/sync/event-pipeline.ts:215-240`, `:565` | n/a | one stream for all directories, each event carries its directory (`:168-190`) |
| Dev tunnel | `ui/lib/browser/devTunnel.ts:39-40` | No | `?port=` only |
| Dev servers, probe, free port | `ui/lib/browser/devServers.ts:33,60`, `ui/lib/detectDevServer.ts:87` | No | nothing |
| Dictation, guests, notifications, OpenChamber events | `dictation-client.ts:123`, `guests/surface-client.ts:67`, `useWebNotificationStream.ts:37`, `openchamberEvents.ts:376` | n/a | host services, never a space |
| Authenticated assets | `FilesView.tsx:3089` (`/api/fs/raw`), `FilesView.tsx:4044` (`/api/fs/serve/...`), `markdownImageAssets.ts:252`, `runtime-url.ts:157` | Path always | `?path=` or path segment, plus `oc_url_token` (`runtime-url.ts:103-112`) |
| Session-keyed OpenChamber routes | see next table | From session record | id in the URL path |

Totals: 378 `runtimeFetch(` calls in 107 files. Openers that use the resolver directly: 5 WebSocket, 2 SSE, 5 asset URL builders.

## Requests without a directory

| Request | Evidence | What identifies the target today |
|---|---|---|
| `/api/terminal/ws` | `terminalApi.ts:185`; frames `attach`, `write` carry `s: sessionId` (`:205,239`) | terminal id per frame. Host and space terminals share the socket |
| `/api/terminal/:id/resize`, `appearance`, `restart`, `DELETE`, `force-kill`, `touch` | `terminalApi.ts:492,518-525` | terminal id. `touch` sends a batch that can span host and spaces |
| `/api/dev-tunnel?port=` | `devTunnel.ts:39`; server connects to `127.0.0.1:port` (`server/lib/dev-tunnel/runtime.js:39,84`) | port. Port 3000 can exist on the host and in every space |
| `/api/dev-servers`, `/api/system/probe-url` | `devServers.ts:33,60` | nothing |
| Session calls when the directory is unknown | `session-actions.ts:584-590` falls back to the current directory; `getSessionReplyClient` falls back to the unscoped client (`:612-620`); `rejectQuestion` uses only the ambient directory (`client.ts:1446-1450`) | a guess. A wrong guess goes to the host today |
| Permission and question replies | `session-actions.ts:1989-2000`, `:873-883` | request directory, then session directory, then current directory |
| Message queue | `ui/stores/messageQueueStore.ts:331` (`/api/message-queue/sessions/:id`), `:506` (global snapshot) | session id. Directory only inside the JSON item |
| Auto-accept | `ui/stores/permissionStore.ts:98,107,164-168` | session id, directory only in the JSON body |
| Goals, message-sent, image grants | `ui/lib/sessionGoalActions.ts:43-62`, `ui/sync/session-ui-store.ts:314`, `markdownImageAssets.ts:140` | session id |
| Batch archive | `ui/sync/session-archive-batch.ts:42-45` | directory in the JSON body only |
| Host-wide snapshots | `/api/sessions/status` (`client.ts:1199`), `/api/session-activity` (`:1222`), `GET /api/message-queue`, `GET /api/permission-auto-accept` | nothing. These are aggregates, not space requests |

## Design A cost

- The dispatcher would have to read four places: query (`directory`, `path`, `cwd`), header, JSON body, and ids. OpenChamber routes get `express.json` up to 50 MB (`server/lib/opencode/core-routes.js:1089-1117`). OpenCode proxy routes skip the parser so bodies stream (`core-routes.js:1118-1119`). Sniffing a body means parsing before proxying and re-serialising, which is no longer "forward whole".
- The terminal socket cannot be forwarded whole. One socket carries frames for host and space terminals. The dispatcher would have to split frames by terminal id and keep a terminal-to-space index.
- Session-keyed and terminal-keyed routes need a host index from id to space. That index is a cache of untrusted space data. When it is stale or missing, the dispatcher guesses. A malicious space can also claim another space's session id.
- The dev tunnel and `/api/dev-servers` carry nothing to sniff. They need a new parameter, which is already design B.
- Ambiguous cases: the files header is the ambient directory and can disagree with `path` (`files.ts:64-67`). The header arrives URI-encoded from the SDK, raw from the files API, and marker-encoded for non-Latin-1 (`ui/lib/runtime-fetch.ts:131-158`, `server/lib/opencode/proxy.js:132-149`). With no directory the host falls back to `settings.lastDirectory` (`server/lib/opencode/project-directory-runtime.js:65-100`), so "no directory" silently means "whatever was browsed last".
- Places that would need sniffing: the HTTP entry before `validateDirectoryPath` (9 call sites in 6 files), and four separate upgrade handlers (`server/lib/terminal/runtime.js:431`, `dev-tunnel/runtime.js:177`, `dictation/runtime.js:262`, `realtime-proxy.js:273`).

## Design B cost

- The seam is one pure function, `spaceRoute(directory)`, in a new `ui/lib/spaces/` module. It matches the path against the space root, checks the id against the known-spaces store, and returns `/api/spaces/<id>` or nothing. It is applied in three places:
  1. `runtimeFetch` accepts a `directory` option and rewrites `/api/x` to `/api/spaces/<id>/x` before `buildRuntimeFetchUrl` (`runtime-fetch.ts:95`) and before `extractRelayPath` (`:184`). Both the network branch and the relay branch must use the same rewritten path.
  2. The SDK fetch wrapper (`client.ts:224`) reads the directory that the SDK itself put on the request: `?directory=` on GET, `x-opencode-directory` otherwise. This is the SDK contract, not a guess. It covers the scoped clients and the 40 per-call sites with no edits.
  3. A `spacePath(path, directory)` helper that WebSocket and asset callers use before calling the resolver.
- Runtime switch rule: nothing is cached. The prefix is a path segment added to a route path. The base URL is still resolved at call time by the resolver. The known-spaces store is keyed by runtime key and reset in the runtime-switch flow. `scopedClients` is already cleared on reconnect (`client.ts:397`).
- Call sites to change: about 150 of the 378 calls touch a directory or a session, in about 25 files. Helpers reduce the edits: `gitApiHttp.buildUrl` (68 calls, one edit), `files.ts` (11 calls, derive from `path`), the `terminalApi.command` helper, the config stores that already pass `x-opencode-directory`. Host-only families need no change: GitHub, Linear, client auth, voice, tunnel settings, guests, themes, passkeys.
- Terminal: replace the singleton (`terminalApi.ts:465`) with one `TerminalTransport` per target (host, or a space id), chosen from the terminal's directory. `touch` is split per target.
- Transports: the relay HTTP allowlist accepts any `/api/` path (`server/lib/relay/tunnel-host.js:23-28`), and the tunnel passes `pathname?search` unchanged (`ui/lib/relay/tunnel-payloads.ts:32-36`). `shouldResolveApiPath` accepts `/api/` (`runtime-fetch.ts:11-13`). So HTTP and SSE work on web, Electron, hosted mobile, and Capacitor with no transport change.
- WebSocket and URL-token paths are exact-match lists. The new prefix must join all of them by shape, like `GUEST_SURFACE_WS_PATH`: `ALLOWED_WS_PATHS` (`tunnel-host.js:30-40`), `isUrlAuthWebSocketPath` (`server/lib/ui-auth/ui-auth.js:329-338`), `isUrlAuthReadableHttpPath` for `/api/spaces/<id>/fs/raw` (`ui-auth.js:314-327`), and the Electron realtime proxy (`server/lib/realtime-proxy.js:13-17`). Only `terminal/ws`, `dev-tunnel`, and `fs/raw` need it.
- The host authenticates the user first, then the dispatcher strips cookies, the bearer, and the `oc_url_token` query parameter, and adds the space token. This does not break the relay rule: the relay host still injects nothing, the dispatcher is a separate hop after authentication.

## Recommendation

B, with two server guards. Rule for implementers:

A request goes to a space if and only if its path starts with `/api/spaces/<id>/` and `<id>` is in the space manager's label-derived list. The dispatcher authenticates the user, strips the prefix and the user's credentials, adds that space's token, and forwards the rest untouched, streaming. It reads nothing else. In the UI, every directory-scoped or session-scoped request names its directory, and one function turns a directory into a prefix at call time. Guard 1: after stripping, if `?directory=` or `x-opencode-directory` is present and is not under that space's root, answer 400. Guard 2: a request without the prefix whose `directory` query or header is under the spaces root gets a stable 4xx before `validateDirectoryPath` and before the `lastDirectory` fallback. Guards reject. They never route.

Special cases:

| Case | Handling |
|---|---|
| Terminal socket and `/api/terminal/:id/*` | One transport per target. Socket at `/api/spaces/<id>/terminal/ws`. Target comes from the terminal's directory in `useTerminalStore` |
| Dev tunnel, dev servers, probe | Caller passes the directory of the pane that asked. `/api/spaces/<id>/dev-tunnel?port=`. Electron `relay-dev-tunnel.mjs` and `server/lib/dev-tunnel/client.js` need the same parameter |
| Session-keyed routes (queue, auto-accept, goals, message-sent, image grants, replies) | Directory from the session record. If no server-confirmed directory exists, fail the action. Do not fall back to the current directory when any space exists |
| Global events, session list, `/api/sessions/status`, queue and auto-accept snapshots | Not dispatched. The host merges per DESIGN.md. The host must drop any space record or event whose directory is outside `/spaces/<that id>/`, and must not let a space overwrite a host session id |
| `/api/fs/serve` and `/api/preview/proxy` under the prefix | Refuse in the dispatcher. Files from a space must not render under the app origin. `fs/raw` is forwarded with `nosniff` and an attachment or image-only content type |
| `moveSession`, worktree and git-integrate actions across the boundary | Refuse when source and destination targets differ |
| `auth.set`, provider pages, settings, GitHub, Linear, voice, guests | Host only. Never prefixed |
| `/api/projects/:id/*` | Host settings routes. Icon discovery for a space project is a later decision |
| VS Code | No space manager. The helper returns "unsupported" and the UI hides spaces |

Security property: the target is named in the URL by an authenticated user's client, the id is checked against runtime labels, and the space token is chosen by that id alone. Nothing a space returns can change where a request goes, because the dispatcher reads no ids and no bodies. A lying session record can at worst make the UI call the space that produced it, or fail guard 1.

## What this changes in DESIGN.md

- "Dispatcher, sessions, events", first bullet: replace "forwards matching requests whole" with the prefix rule above. Drop "The few requests without a directory are handled one by one". They use the same prefix.
- Add: the UI resolves directory to space in one function. The terminal transport is per target. WebSocket and URL-token allowlists gain the prefix shapes.
- Second bullet: add `oc_url_token` to the list of stripped credentials.
- Session bullet: add the merge rule that a space may only report directories under its own root, and the id collision rule.
- LESSONS.md, "The existing server": add the `lastDirectory` fallback and the single multiplexed terminal socket.

## Not verified

- Nothing was run. Relay, Capacitor, and Electron behaviour is inferred from code. The relay skill requires a real relay test for the new WebSocket paths.
- Whether OpenCode inside a space reports `session.directory` exactly as `/spaces/<id>/<repo>` (symlinks, canonical paths). The whole UI mapping depends on it (`ui/stores/globalSessionStructure.ts:42-47`).
- The count of 150 call sites is an estimate from per-file counts, not a full audit. Guard 2 exists to catch the misses.
- SDK `/api/session/...` style endpoints use `location[directory]` on GET (SDK `client.js:31`). I did not check which of them the UI calls with a non-GET method and no header.
- Rewriting a `Request` with a stream body needs `duplex: 'half'` (`runtime-fetch.ts:212-214`). SDK bodies are strings today. Upload goes through the string-path branch, so it should be safe, but this was not tested.
- VS Code webview fetch routing (`packages/vscode/webview/main.tsx`) was not read.
- Session id format and collision odds between host and spaces were not checked.
