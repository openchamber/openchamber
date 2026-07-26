# Harness (Engines) Module

## Purpose

Server-side **Engines** / harness adapter layer. OpenChamber keeps a single
session list (OpenCode session IDs as the UI shell) and routes non-OpenCode
execution through translators that emit **OpenCode-shaped** events into the
existing global UI event stream.

User-facing copy uses **Engine**. Internal IDs use `harnessId`.

Parent specs:

- `docs/engines-claude-code-spec.md`
- `docs/engines-claude-code-implementation-plan.md` §13

## Ownership

| Concern | Path |
| --- | --- |
| Descriptors / capabilities | `registry.js` |
| Binary + login detect | `detect.js` |
| Sticky session bindings | `session-bindings.js` (durable JSON + in-memory Map) |
| Prompt / abort / permission dispatch | `router.js` |
| HTTP routes | `routes.js` → `registerHarnessRoutes(app, deps)` |
| Claude SDK wrapper | `translators/claude-code/query.js` |
| Subscription env policy | `translators/claude-code/auth-env.js` |
| Attachment mapping | `translators/claude-code/attachments.js` |
| Claude permissions bridge | `translators/claude-code/permissions.js` |
| Claude prompt orchestration | `translators/claude-code/index.js` |
| OpenCode stub (SDK path stays in UI) | `translators/opencode/index.js` |
| Claude → canonical events | `events/from-claude.js` |
| Broadcaster wrapper | `events/emit.js` |

Registration: `packages/web/server/lib/opencode/feature-routes-runtime.js`
calls `registerHarnessRoutes` next to quota / small-model, **before** the
generic OpenCode proxy. JSON body parsing for `/api/harness` is enabled in
`core-routes.js` common middleware.

## Boundary (ui-api-decoupling)

- OpenCode engine traffic stays on `@opencode-ai/sdk/v2` from the UI.
- Claude Code engine traffic uses OpenChamber routes `/api/harness/*` via
  `runtimeFetch` (`packages/ui/src/lib/harness/client.ts`).
- Never call Anthropic HTTP from the UI for this engine.
- Never put Claude OAuth into `RuntimeAPIs` or OpenChamber settings JSON.
- Child Claude processes use subscription-only env (API keys stripped).

## Session shell model

1. UI creates an OpenCode session id (existing `session.create`).
2. First Claude prompt creates a sticky binding
   `{ sessionId, harnessId: 'claude-code', directory, target, foreignSessionId? }`.
3. Translator emits OpenCode-shaped events with that `sessionID`:
   - `message.updated`
   - `message.part.updated` / `message.part.delta`
   - `session.status` (`busy` / `idle`)
   - `session.error` on hard failures
   - `permission.asked` / `permission.replied` via the canUseTool bridge
4. Events fan out through `createGlobalUiEventBroadcaster` (same WS/SSE clients
   as other synthetic UI events), scoped with `{ directory }`.
5. Claude `session_id` is stored as `foreignSessionId` for resume.

Constraints:

- Do not also call OpenCode `session.promptAsync` for the same user turn.
- Abort interrupts the Claude query and tree-kills the process group.
- `harnessId` on a binding is sticky; engine switch requires a new session
  (handoff).

## Durable session bindings

File: `$OPENCHAMBER_DATA_DIR/harness-session-bindings.json`
(fallback `~/.config/openchamber/harness-session-bindings.json`).

| Rule | Behavior |
| --- | --- |
| Format | Versioned JSON `{ version: 1, bindings: [...] }` |
| Write | Atomic temp + rename, mode `0o600`, directory `0o700` |
| Load | `initSessionBindings()` on route registration (and lazy ensure) |
| Mutate | Debounced persist (~250ms); `flushSessionBindings()` for sync drain |
| Retention | Prune to ~200 entries by oldest `updatedAt` |
| Secrets | Never persisted — `sanitizeSessionBinding` allowlists fields |
| Tests | `configureSessionBindings({ filePath, persist })`; `resetSessionBindings({ clearDisk })` |

## HTTP API

All routes are authenticated like other OpenChamber runtime APIs. No secrets
in responses. Never log tokens, OAuth material, or attachment bytes.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/harness` | List engines + runtime status |
| GET | `/api/harness/:id` | Engine detail + catalog |
| POST | `/api/harness/:id/detect` | Force refresh detect |
| POST | `/api/harness/prompt` | Start Claude turn |
| POST | `/api/harness/abort` | Abort active Claude turn |
| POST | `/api/harness/permission/reply` | Resolve bridged `canUseTool` prompt |
| GET | `/api/harness/sessions/:sessionId` | Binding debug/UI |

### Prompt body

```json
{
  "sessionId": "ses_…",
  "directory": "/path/to/project",
  "target": {
    "harnessId": "claude-code",
    "modelRef": "sonnet",
    "permissionMode": "acceptEdits",
    "effort": "high"
  },
  "text": "…",
  "files": [{ "mime": "image/png", "url": "data:image/png;base64,…", "filename": "a.png" }],
  "messageId": "msg_…",
  "assistantMessageId": "msg_…"
}
```

Response `202` with `{ ok, sessionId, harnessId, messageId, assistantMessageId, status: "started" }`.
Streaming continues asynchronously via the event broadcaster.

### Permission reply body

```json
{
  "sessionId": "ses_…",
  "requestId": "perm_…",
  "reply": "once" | "always" | "reject",
  "directory": "/path/to/project"
}
```

### Detect statuses

| Status | Meaning |
| --- | --- |
| `ready` | Binary found, SDK importable, subscription login probe positive |
| `needs-login` | Binary + SDK OK; no subscription login (includes API-key-only hosts) |
| `missing-cli` | `claude` not on PATH |
| `unsupported-host` | Reserved (mobile-only / no exec host) — not emitted by v1 local detect |
| `error` | SDK import failure or unexpected detect exception |

**Login probe (B6):** `claude auth status --json` with API-priority env stripped
(`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`). OAuth-like `authMethod` → ready;
API-key / logged-out → continue to credential fallbacks. Fallbacks (in order):

1. Non-empty `CLAUDE_CODE_OAUTH_TOKEN` (Cursor Use Environment / CI secret)
2. Structured `claudeAiOauth.accessToken` in credentials under `CLAUDE_CONFIG_DIR`
   or `~/.claude/.credentials.json` (no secret values returned)

Child Claude processes keep `CLAUDE_CODE_OAUTH_TOKEN` via `auth-env.js` so Desktop
and cloud hosts that inject the secret authenticate without an interactive login.

**Invariant:** detect failure never returns `status: "ready"` with an empty
success catalog. Error / missing-cli responses use `sections: []`.

### Dependency injection

```js
registerHarnessRoutes(app, {
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
  getOpenCodeReady: () => isOpenCodeReady,
  sessionBindings: { filePath, persist, debounceMs, maxBindings },
});
```

`packages/web/server/index.js` wires broadcast + OpenCode ready. Tests may inject
a mocked `router` / `detectAll` / `detectOne`, and set `initBindings: false` or
`persist: false`.

## Permissions bridge

Capability: `permissions: full`.

`translators/claude-code/permissions.js`:

1. `createCanUseTool({ sessionId, directory, getBroadcast, assistantMessageId })`
   → Agent SDK option.
2. On tool ask: emit OpenCode-shaped `permission.asked` (`PermissionRequest`-like:
   `id`, `sessionID`, `permission`, `patterns`, `metadata`, `always`, optional
   `tool: { messageID, callID }`).
3. `always` is populated from concrete command/path patterns, or falls back to
   the tool name so PermissionCard “Always Allow” stays labeled and available.
4. Pending map: `requestId → { resolve, reject, sessionId, timer, … }`.
5. Timeout (~120s) and abort/turn-end → fail-closed deny + `permission.replied`.
6. `replyPermission({ sessionId, requestId, reply })`:
   - `once` → SDK `{ behavior: 'allow', updatedInput }`
   - `always` → allow + `updatedPermissions` from SDK suggestions when present
   - `reject` → `{ behavior: 'deny', message }`

UI: `harnessPermissionReply` → `respondToPermission` / `dismissPermission` branch
when `getSessionTarget(sessionId)?.harnessId === 'claude-code'`.

`permissionMode` is not a separate Claude composer control. The UI derives it
from the selected OpenCode agent's edit permission (`allow`→`acceptEdits`,
`ask`→`default`, `deny`→`plan`) on each send. Session permission auto-accept
also settles bridged harness asks via `replyHarnessPermission` (never OpenCode
`/permission/:id/reply` for Claude-bound sessions).

## Goal on Claude

Capability `goal: partial`. Session-goal listens to harness events through
`addHarnessEventObserver` and reads last-turn text from
`turn-snapshot.js` (OpenCode `/session/:id/message` is empty for harness
turns). Continuations call `harnessRouter.prompt` / `/api/harness/prompt`.
Token budget accounting is best-effort until Claude usage tokens are mapped.

## Follow-ups while busy

Claude rejects a second `prompt` for the same session with HTTP `409`
`TURN_IN_PROGRESS` (no second Claude process). The UI must not steer into an
active Claude turn. Follow-ups use the OpenChamber message queue (reorder +
idle auto-send). Abort interrupts the active turn and always clears busy via
`session.status: idle`.

Harness events stamp `properties.directory` and SSE fan-out preserves the
directory envelope so UI directory stores receive busy/idle (Stop + queue
auto-send). `GET /api/session/status` overlays active Claude busy entries so
OpenCode status polls cannot clear harness turns. `GET /api/session/:id/message`
overlays the turn-snapshot last user/assistant so OpenCode's empty message list
cannot wipe Claude chat on materialization/refetch.

## Session titles on Claude

Claude prompts bypass OpenCode `session.promptAsync`, so upstream
`ensureTitle` never runs. `session-title/runtime.js` listens to harness idle
events, generates a title once via the small-model helper from harness turn
text, and PATCHes the OpenCode shell session. Manual rename still uses
`session.update`.

## Claude auth-env policy

`translators/claude-code/auth-env.js` builds child env from `process.env` and
deletes API-priority keys:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`

PATH and other inherited vars are preserved (`env` replaces the subprocess
environment in the Agent SDK, so the full spread is required).

## Claude Agent SDK

Dependency: `@anthropic-ai/claude-agent-sdk` in `packages/web/package.json`.

`query.js`:

- Lazy-imports the SDK; caches load failures.
- `startClaudeQuery({ prompt, cwd, model, resume, permissionMode, effort, canUseTool, env })`
- Resolves `pathToClaudeCodeExecutable` via `executable-path.js` (PATH / env /
  `app.asar.unpacked` native package) so Electron does not spawn a path inside
  `app.asar` (that fails with `ENOTDIR`).
- Validates `cwd` is a real directory before starting the query.
- `includePartialMessages: true` for streaming deltas
- `interrupt()` when available, plus `killProcessTree(pid)` on abort/close

If the SDK import fails:

- Detect → `error` (not ready)
- Prompt → HTTP `503` with `CLAUDE_SDK_UNAVAILABLE`

Packaged Desktop also sets electron-builder `asarUnpack` for
`@anthropic-ai/claude-agent-sdk-*` native packages.

## Attachments

Capability: `file-attachments: full`.

OpenChamber `{ mime, url, filename }` → SDK content blocks:

| Source | Mapping |
| --- | --- |
| `data:` image (`png|jpeg|gif|webp`) | `image` base64 block |
| `data:` text-like / json/yaml/svg | labeled `text` block |
| `data:` `application/pdf` | `document` base64 block |
| `file://` or absolute path under session cwd | path reference text (`Attached project file: …`) after sandbox + MIME/size checks; Claude can `Read` the file natively |
| `file://` with `preferPathReferences: false` | embed bytes like `data:` |
| path outside cwd | reject `400 ATTACHMENT_PATH_OUTSIDE_CWD` |
| other binary (e.g. zip) | reject `400 ATTACHMENT_UNSUPPORTED_TYPE` |

User message events also emit OpenCode-shaped `file` parts so the transcript
reconciles optimistic attachments.

Turns with attachments use `AsyncIterable<SDKUserMessage>`; text-only may use
a string prompt.

## Event transport choice (spec §21)

**Chosen approach:** emit OpenCode-shaped payloads through
`createGlobalUiEventBroadcaster` with `{ directory }`, so the existing message
stream WS clients deliver them into `event-pipeline` / `event-reducer` without
a parallel harness channel.

Message/part IDs: OpenCode-compatible **ascending** `msg_*` / `prt_*` (timestamp
+ counter prefix, same shape as UI `ascendingId`). The UI sorts parts by id via
`Binary.search`, so random UUIDs reorder tool/text blocks in the transcript.
After each `tool_use`, the mapper starts a **new text part** so post-tool reply
text sorts after tools (`text → tool → text`), not merged above them.

Prompt may echo client-provided `messageId` / `assistantMessageId` for
optimistic reconcile.

## UI send path (shared UI)

- `packages/ui/src/lib/harness/client.ts` — `harnessPrompt` / `harnessAbort` /
  `harnessPermissionReply` via `runtimeFetch`
- `packages/ui/src/lib/harness/resolve-execution-target.ts` — sticky `ExecutionTarget` resolution
- `packages/ui/src/sync/session-ui-store.ts` — `routeMessage` branches `claude-code` → harness prompt (not OpenCode SDK)
- `packages/ui/src/sync/session-actions.ts` — permission reply/dismiss branches for Claude targets
- `packages/ui/src/lib/harness/composer-attachment-model.ts` — composer attachment modality warnings use the active `ExecutionTarget` (Claude catalog), not leftover OpenCode `currentModel`
- Model picker Engines section lives in `ModelControls` / `ModelPickerList`

## Out of scope (later slices)

- Codex CLI / Gemini CLI engines
- Reverse handoff billing notice (Claude → OpenCode)
- MultiRun / OpenChamber injected tool on Claude
- Full Claude token → goal budget accounting

## Testing

```bash
bun test packages/web/server/lib/harness/registry.test.js
bun test packages/web/server/lib/harness/detect.test.js
bun test packages/web/server/lib/harness/routes.test.js
bun test packages/web/server/lib/harness/session-bindings.test.js
bun test packages/web/server/lib/harness/events/from-claude.test.js
bun test packages/web/server/lib/harness/translators/claude-code/auth-env.test.js
bun test packages/web/server/lib/harness/translators/claude-code/attachments.test.js
bun test packages/web/server/lib/harness/translators/claude-code/permissions.test.js
bun test packages/ui/src/lib/harness/client.test.js
```

Or all harness tests:

```bash
bun test packages/web/server/lib/harness
```

## Notes for contributors

- Keep entrypoints thin; domain logic stays in focused modules under this folder.
- One failed Claude session must not clear or block OpenCode sessions.
- Prefer authoritative detect status over heuristics; never invent `ready`.
- Permission bridge fails closed; never auto-bypass unless Claude permission mode explicitly allows.
- Update this file when ownership, routes, or event contracts change.
