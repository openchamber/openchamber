# Engines & Claude Code Harness — Detailed Spec

Status: **implemented** (Phases A–C complete; Phase D mostly complete — see §19 / §24)  
Primary engine for v1: `claude-code`  
Owning runtime docs: [`packages/web/server/lib/harness/DOCUMENTATION.md`](../packages/web/server/lib/harness/DOCUMENTATION.md)  
Related plan: [`docs/engines-claude-code-implementation-plan.md`](./engines-claude-code-implementation-plan.md)

Product intent: keep OpenChamber UI/API as the primary surface; expand execution backends via a translator layer (Paseo-like: native CLI process, native subscription limits).

---

## 1. Goals

1. Introduce **Engines** as a top-level execution dimension above OpenCode providers.
2. Ship **Claude Code** as the first non-OpenCode engine.
3. Run Claude Code **natively** (official Agent SDK / `claude` CLI) so Pro/Max **subscription limits** apply.
4. Keep Anthropic **API keys** exclusively on the OpenCode engine path (existing Providers flow).
5. Preserve the current OpenChamber chat/session UX via a **canonical protocol + translator**.
6. Support **attachments** (images + common text/docs) through the translator.
7. On engine switch during a session: **duplicate/handoff** into a new session; show a dismissible billing notice controlled from Engines settings.

### Non-goals (v1)

- Codex CLI / Gemini CLI engines (structure must allow them later).
- Using Claude subscription OAuth through direct Anthropic HTTP from OpenChamber.
- Full TTY parity with interactive `claude` (rewind UI, all interactive-only slash commands).
- Separate Claude permission-mode chip (Claude `permissionMode` mirrors OpenCode agent edit + auto-accept).
- Editing Claude MCP/settings from OpenChamber Providers/MCP pages.
- Lossless binary clone of OpenCode sessions into Claude native session format.

---

## 2. Product decisions (locked)

| Decision | Choice |
|---|---|
| Engine placement in IA | Top-level engine (sibling of OpenCode), not a Provider row |
| First harness | Claude Code |
| Claude auth mode | **Subscription only** |
| API keys | Remain under OpenCode → Providers (Anthropic etc.) |
| Integration style | Paseo-like: spawn/use official Claude Code runtime; translate events |
| Mid-session engine change | Duplicate into new session + seed transcript; prefer handoff over in-place switch |
| Billing handoff notice | On by default; dismiss forever; re-enable from Engines settings |
| Attachments | Supported via SDK streaming input content blocks |
| Permission mode UI | When agents mode is `opencode`, derived from OpenCode agent edit permission; no separate Claude chip. When `claude`, native Claude permissions (OpenCode picker hidden) |
| Session identity | Reuse OpenCode session IDs as the UI shell; Claude `session_id` stored as `foreignSessionId` |
| Event transport | OpenCode-shaped payloads via `createGlobalUiEventBroadcaster` (same WS/SSE path) |

---

## 3. Terminology

| Term | Meaning |
|---|---|
| **Engine** | User-facing execution backend (`OpenCode`, `Claude Code`, later `Codex`, `Gemini`) |
| **Harness** | Internal code name for an engine adapter/translator (`HarnessId`) |
| **Provider** | OpenCode model-vendor identity (Anthropic, OpenAI, …). OpenCode-only in v1 UI |
| **Translator** | Module that maps Canonical Protocol ↔ engine-native protocol |
| **Foreign session id** | Engine-native session/resume id (Claude `session_id`) |
| **Handoff** | Create a new session on another engine, seed context from the source session, send there |

Internal IDs use `harnessId`. UI copy uses **Engine**.

---

## 4. Architecture

```
Composer / ModelControls / Session UI
        │
        ▼
Canonical Session Protocol (OpenChamber-shaped)
        │
        ▼
Harness Router  (packages/web/server/lib/harness)
        │
        ├── translator/opencode     → existing OpenCode SDK path (default; UI SDK)
        └── translator/claude-code  → @anthropic-ai/claude-agent-sdk → claude CLI
                │
                ▼
        OpenCode-shaped events → createGlobalUiEventBroadcaster → sync/transcript
```

### Invariants

1. UI never talks to Claude CLI directly.
2. OpenCode remains the default engine and the reference semantics for messages/parts/status.
3. Claude translator must not call `api.anthropic.com` with extracted subscription tokens.
4. One failed Claude session must not clear or block OpenCode sessions.
5. Live status comes from the live harness channel, not reconstructed only from persisted history.
6. Fetch/detect failure must not masquerade as “engine ready with empty catalog”.
7. Claude `harnessId` on a session binding is sticky; engine switch requires handoff (new session).

### Session shell model (as built)

1. UI creates an OpenCode session id (`session.create`) — same list/sync shell as today.
2. First Claude prompt creates a durable binding
   `{ sessionId, harnessId: 'claude-code', directory, target, foreignSessionId? }`.
3. `routeMessage` sees sticky/pending Claude target → `POST /api/harness/prompt` (not `session.promptAsync`).
4. Translator emits OpenCode-shaped events with that `sessionID` into the existing stream.
5. Claude native `session_id` is stored as `foreignSessionId` for resume.

---

## 5. Data model

### 5.1 Identifiers

```ts
type HarnessId = 'opencode' | 'claude-code' // future: 'codex-cli' | 'gemini-cli'

type ExecutionTarget =
  | {
      harnessId: 'opencode'
      providerId: string
      modelId: string
      agentName?: string
      variant?: string
    }
  | {
      harnessId: 'claude-code'
      modelRef: string          // Claude Code model id/alias (e.g. sonnet, opus, full id)
      permissionMode?: ClaudePermissionMode
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' // Claude Agent SDK effort; omit = SDK default
      // no API key fields
    }

type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions' // typed; not exposed as a composer control in v1
```

**As built:** types live in `packages/ui/src/types/harness.ts`. Server registry mirrors the same ids/capabilities in JS.

### 5.2 Harness descriptor

```ts
type CapabilityLevel = 'full' | 'partial' | 'none'

type HarnessCapability =
  | 'prompt'
  | 'abort'
  | 'resume'
  | 'streaming-text'
  | 'streaming-tools'
  | 'permissions'
  | 'images'
  | 'file-attachments'
  | 'shell'
  | 'slash-commands'
  | 'mcp'          // engine-native MCP discovery only in v1
  | 'subagents'
  | 'multirun'
  | 'goal'
  | 'openchamber-tool'

type HarnessRuntimeStatus =
  | 'ready'
  | 'needs-login'
  | 'missing-cli'
  | 'unsupported-host'  // typed + localized; not emitted by v1 local detect yet
  | 'error'

type HarnessDescriptor = {
  id: HarnessId
  displayName: string          // "Claude Code"
  shortName: string            // "Claude"
  auth: {
    mode: 'subscription-cli' | 'opencode-providers'
  }
  capabilities: Record<HarnessCapability, CapabilityLevel>
  install: {
    binaryNames: string[]      // ['claude']
    docsUrl: string
    minVersion?: string
  }
}
```

### 5.3 Claude Code v1 capability matrix (as built)

| Capability | Level | Notes |
|---|---|---|
| prompt / abort / resume | full | SDK `query` + interrupt + resume via `foreignSessionId` |
| streaming-text | full | `includePartialMessages` + ascending text parts / deltas |
| streaming-tools | full | `tool_use` / `tool_result`; new text segment after each tool so transcript order is `text → tool → text` |
| permissions | full | `canUseTool` → `permission.asked` with Always patterns + tool linkage; agent-derived `permissionMode`; fail-closed timeout/abort |
| images | full | base64 image blocks |
| file-attachments | full | `data:` embeds; sandboxed `file://` / project-path refs; images, text-like, PDF; reject opaque binaries |
| shell | full | OpenCode `session.shell` on the shared session id (engine-independent; available while Claude owns prompt turns) |
| slash-commands | full | Claude-native `/command` via harness prompt + system/init discovery; OpenCode-only slash blocked |
| mcp | full | OpenChamber MCP configs bridged into SDK `mcpServers`; project `.mcp.json` via `settingSources`; status from init |
| subagents | full | Agent tool + `forwardSubagentText`; nested child sessions in sidebar |
| goal | full | Server loop via harness turn snapshots + `/api/harness/prompt` continuations; Claude `result.usage` mapped into `assistant.info.tokens` |
| multirun | full | MultiRun launcher includes Claude models; sticky `ExecutionTarget` + harness prompt per run |
| openchamber-tool | full | In-process Claude SDK MCP (`createSdkMcpServer`) → shared control service; gated by `agentControlToolEnabled` |

### 5.4 Session binding

```ts
type SessionHarnessBinding = {
  sessionId: string                 // OpenChamber session id (UI list key)
  harnessId: HarnessId
  directory: string
  foreignSessionId?: string         // Claude session_id once known
  target: ExecutionTarget
  createdAt: number
  updatedAt: number
  capabilitySnapshot: HarnessDescriptor['capabilities']
  lastError?: { code: string; message: string; at: number }
  seedFromSessionId?: string        // set when created via handoff
}
```

**As built:** durable JSON at `$OPENCHAMBER_DATA_DIR/harness-session-bindings.json` (fallback `~/.config/openchamber/…`); atomic write; prune ~200; secrets never persisted (`sanitizeSessionBinding`).

Rules:

- Binding is created on first Claude prompt (or when handoff seeds a Claude session).
- `harnessId` is sticky for the lifetime of that session.
- Changing engine never mutates an existing binding’s `harnessId`.

### 5.5 Selection / persistence (UI) — as built

```ts
// selection-store
sessionTargets: Map<sessionId, ExecutionTarget>       // sticky per session
pendingHandoffTargets: Map<sessionId, ExecutionTarget> // used sessions awaiting Send handoff
lastUsedTarget: ExecutionTarget | null

// ui store favorites / recents (ExecutionTarget-aware)
favoriteTargets: ExecutionTarget[]
recentTargets: ExecutionTarget[]

// DesktopSettings (flat camelCase; sanitized in lib/harness/settings.ts)
enginesDefaultHarnessId: HarnessId              // default 'opencode'
enginesClaudeCodeWarnOnOpenCodeHandoff: boolean // default true
enginesClaudeCodeEnabled: boolean               // default true (feature flag)
enginesClaudeCodeAgentsMode: 'claude' | 'opencode' // default 'opencode'
```

Favorites / recents / shortcuts key by `harnessId + model identity` (Claude uses `providerID: 'claude-code'` compatibility shape where needed) to avoid collisions with OpenCode `anthropic/...`.

**Not implemented:** `engineOrder: HarnessId[]` (picker order is fixed OpenCode then Claude).

### 5.6 Engine catalog (API → picker)

```ts
type EngineCatalog = {
  engine: HarnessDescriptor
  status: HarnessRuntimeStatus
  statusDetail?: string
  version?: string
  sections: Array<{
    id: string
    name: string
    kind: 'provider' | 'profile' | 'models'
    models: Array<{
      id: string
      name: string
      // as built: limits, modalities, reasoning/toolCall flags from registry
      supportsImages?: boolean
      supportsDocuments?: boolean
    }>
  }>
}
```

**As built:** Claude models come from a **static catalog** in `packages/web/server/lib/harness/registry.js` (aliases + full ids, context/output limits, modalities). Single models section; no provider nesting.

---

## 6. Module layout (as built)

```text
packages/web/server/lib/harness/
  DOCUMENTATION.md
  index.js
  registry.js                 # descriptors + Claude model catalog
  detect.js                   # binary + login probe
  binary-path.js
  router.js                   # prompt/abort/permission dispatch
  routes.js                   # registerHarnessRoutes → /api/harness/*
  session-bindings.js         # durable sticky bindings
  turn-snapshot.js            # last-turn text for goal continuations
  events/
    from-claude.js            # SDK message → OpenCode-shaped events
    emit.js                   # broadcaster wrapper
  translators/
    opencode/index.js         # intentional no-op (SDK path stays in UI)
    claude-code/
      index.js                # prompt/abort orchestration
      auth-env.js             # subscription-only env policy
      query.js                # Agent SDK wiring + tree-kill
      executable-path.js      # PATH / CLAUDE_CODE_EXECUTABLE / asarUnpack
      permissions.js          # canUseTool bridge
      attachments.js          # MIME / file:// mapping

packages/ui/src/
  types/harness.ts
  stores/useHarnessStore.ts
  lib/harness/
    client.ts                 # runtimeFetch prompt/abort/permission
    catalog.ts
    settings.ts
    capabilities.ts
    resolve-execution-target.ts
    session-handoff.ts
    favorite-targets.ts
    apply-favorite-target.ts
    claude-models.ts
    claude-permission-mode.ts
    composer-attachment-model.ts
    active-model-limits.ts
  components/sections/engines/
    EnginesPage.tsx
    EnginesSidebar.tsx
    OpenCodeEngineDetail.tsx
    ClaudeCodeEngineDetail.tsx
  components/chat/HandoffConfirmDialog.tsx
  components/ui/EngineLogo.tsx
  sync/session-ui-store.ts    # routeMessage harness branch
  sync/selection-store.ts     # sessionTargets / pendingHandoffTargets
  sync/session-actions.ts     # permission reply/dismiss → harness
```

OpenCode proxy and Providers pages remain unchanged in ownership. Harness routes register **before** the generic OpenCode proxy (`feature-routes-runtime.js`).

---

## 7. Claude Code translator (Paseo-like)

### 7.1 Runtime choice

Uses official `@anthropic-ai/claude-agent-sdk` (dependency in `packages/web/package.json`), which spawns the local `claude` CLI.

Rationale:

- Native tools, CLAUDE.md, skills, hooks, project MCP.
- Subscription billing when CLI OAuth/login is active.
- Structured messages + `canUseTool` (better than raw PTY scraping).

### 7.2 Auth policy (subscription only) — as built

1. Claude engine **never** presents API-key entry.
2. Child env strips API-priority keys (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) via `auth-env.js`.
3. Does not copy OpenCode `auth.json` Anthropic API keys into Claude engine.
4. Ready criteria (`detect.js`):
   - `claude` binary resolvable on the execution host (PATH / `CLAUDE_CODE_EXECUTABLE` / Electron unpacked native package).
   - SDK importable.
   - Subscription login: `claude auth status --json` (API-priority env stripped) with OAuth-like methods → ready; API-key-only / logged-out → continue to fallbacks.
   - Fallbacks (in order): non-empty `CLAUDE_CODE_OAUTH_TOKEN`; structured `claudeAiOauth.accessToken` under `CLAUDE_CONFIG_DIR` or `~/.claude/.credentials.json`.
   - If only an API key exists and subscription login is absent → `needs-login` (not `ready`).
5. Settings copy states: API keys stay under OpenCode; Claude Code engine uses Claude subscription.
6. Never log tokens, OAuth material, or credential env values.

### 7.3 Query shape — as built

- Text-only turns may use string prompt **or** streaming user messages.
- Any turn with attachments **must** use `AsyncIterable<SDKUserMessage>` content blocks.
- Resume uses stored `foreignSessionId`.
- Working directory = session/project directory (validated before spawn).
- Not defaulted to `--bare`.
- `permissionMode` derived from the selected OpenCode agent's edit permission
  (`allow`→`acceptEdits`, `ask`→`default`, `deny`→`plan`); not a separate Claude UI control.
- Session permission auto-accept replies through `/api/harness/permission/reply` (never OpenCode `/permission/:id/reply` for Claude-bound sessions).
- `canUseTool` bridges into OpenChamber `permission.asked` / `permission.replied`.
- `includePartialMessages: true` for streaming deltas.
- Optional Claude Agent SDK `effort` forwarded when present on the target.

### 7.4 Process lifecycle — as built

- One active Claude turn per OpenChamber session (409 if already in progress).
- Abort → SDK `interrupt` + `killProcessTree` + fail-closed pending permissions + `MessageAbortedError`-shaped assistant event + idle.
- Crash → `session.status=idle` + `session.error`; binding kept for retry/resume when foreign id known.
- Electron: resolve executable outside `app.asar` (`executable-path.js` + builder `asarUnpack` for native SDK packages).

### 7.5 Event mapping (Claude → Canonical) — as built

| Claude / SDK | Canonical |
|---|---|
| assistant text / text_delta | `message.part.updated` + `message.part.delta` |
| tool_use / tool_result | tool part start/update/end (tool name preserved) |
| post-tool assistant text | **new** text part (ascending id) so UI order is chronological |
| permission via canUseTool | `permission.asked` / `permission.replied` |
| result / completion | finalize open text part + `message.updated` + `session.status=idle` |
| rate_limit / overloaded | assistant error with retryable flag when applicable |
| session_id | persist `foreignSessionId` |

**Part IDs:** OpenCode-compatible **ascending** `msg_*` / `prt_*` (timestamp + counter). The UI sorts parts by id via `Binary.search`; random UUIDs reorder tool/text blocks.

Unknown event types: ignored safely (no throw). Thinking/reasoning parts are optional/not required for v1 display completeness.

### 7.6 Catalog / detect API — as built

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/harness` | List engines + runtime status |
| GET | `/api/harness/:id` | Engine detail + catalog |
| POST | `/api/harness/:id/detect` | Force refresh (no silent success-on-failure) |

Detection runs on the **execution host** (local server, desktop backend, or remote SSH host), not on a UI-only device that lacks the binary.

Status matrix: `ready` / `needs-login` / `missing-cli` / `error`. `unsupported-host` is reserved for mobile-only / no-exec hosts and is **not emitted** by current local detect.

---

## 8. Routing & session flows

### 8.1 Send path — as built

```
sendMessage / routeMessage
  resolve ExecutionTarget (sticky session → pending handoff → last-used)
  if inputMode === 'shell':
    opencodeClient.shellSession (shared session infrastructure; all engines)
  else if harnessId === 'opencode':
    existing opencodeClient path
  else if harnessId === 'claude-code':
    block if catalog status ≠ ready (toast + deep-link Engines)
    block known OpenCode slash/skills
    optimisticSend → POST /api/harness/prompt {
      sessionId, directory, target, text, files?, messageId?, assistantMessageId?, seedFromSessionId?
    }
```

Server:

1. Validate session/directory/target; reject non-ready Claude.
2. Bind/update sticky session binding.
3. Emit user message events (text + file parts).
4. Translate attachments (cwd-sandboxed).
5. Start/resume Claude query with `canUseTool`.
6. Stream canonical events via broadcaster; return HTTP `202` immediately.

Client: `packages/ui/src/lib/harness/client.ts` (`harnessPrompt` / `harnessAbort` / `harnessPermissionReply` via `runtimeFetch`).

### 8.2 Session create

- New chat uses last-used / default engine (`enginesDefaultHarnessId`, default OpenCode).
- OpenChamber owns the session list row and optimistic messages.
- Claude foreign id filled when SDK reports `session_id`.

### 8.3 Engine switch / handoff — as built

When user selects a different engine in an existing **used** session:

1. Mark target as **pending handoff** (do not rewrite sticky binding).
2. On Send:
   - If notice enabled and `opencode → claude-code`: show `HandoffConfirmDialog`.
   - Create **new** OpenChamber session.
   - Seed synthetic context (see §9); set `seedFromSessionId` on binding.
   - Persist sticky target on the new session; send pending user message (with attachments).
   - Navigate UI to the new session.
   - Leave the source session untouched.

Empty/unused source sessions update sticky target **in place** (no duplicate).

If Claude engine is not `ready`, block send and deep-link to Settings → Engines → Claude Code.

In-place rewrite of `harnessId` on a used session is **out of spec**.

---

## 9. Handoff seeding — as built

### 9.1 Include

- User and assistant **text** turns (most recent first) up to **24_000** characters (`HANDOFF_SEED_CHAR_BUDGET`).
- Attachment images/docs from the **pending outbound message** in full (subject to translator clamps).

### 9.2 Exclude / degrade

- Full tool call/result transcripts (not seeded as structured tools).
- Permission history.
- OpenCode-only synthetic parts that have no Claude meaning.
- **Historical** attachments from prior turns (not seeded in v1; pending outbound only).
- Oversized binaries.

### 9.3 Budget

When truncated, prepend:

`Prior conversation truncated for handoff; N earlier turns omitted.`

### 9.4 Seed delivery to Claude

Synthetic user context is prepended into the harness prompt text (labeled prior context), then the real user prompt as the actionable turn. Does not claim the Claude native session is the same session as OpenCode.

---

## 10. Handoff billing notice — as built

### 10.1 When

Show only if all are true:

- source `harnessId === 'opencode'`
- target `harnessId === 'claude-code'`
- `enginesClaudeCodeWarnOnOpenCodeHandoff !== false`
- user is about to create/continue via handoff (Send/Continue)

Do not show for:

- brand-new Claude sessions with no OpenCode source
- subsequent turns inside Claude
- reverse handoff Claude → OpenCode (v1)

### 10.2 Dialog

Implemented as `HandoffConfirmDialog`:

- Title / body explain new session uses Claude **subscription usage limits**; API providers remain on OpenCode; conversation text is copied as context.
- Primary: Continue
- Secondary: Cancel
- Checkbox: Don’t show this again — applied **only** when user confirms Continue (Cancel must not persist dismissal).

Locale keys: `chat.handoff.*`.

### 10.3 Settings control

Settings → Engines → Claude Code → Warnings toggle bound to `enginesClaudeCodeWarnOnOpenCodeHandoff`.

Default: enabled. Dialog “Don’t show again” sets this to disabled. User can re-enable anytime on this page.

### 10.4 Persistence

Same durability path as other OpenChamber desktop settings (sanitized flat keys) — not a write-only localStorage tombstone without settings UI.

---

## 11. Attachments — as built

Capability: `file-attachments: full`.

### 11.1 OpenChamber input

Composer `AttachedFile` → `{ mime, url, filename }`. HEIC→JPEG, Office/OpenDocument extraction, HAR/notebook sanitization happen in shared UI (`attachment-files.ts` / `document-attachments.ts`) **before** harness send. Composer modality warnings follow the active `ExecutionTarget` (`composer-attachment-model.ts`), not leftover OpenCode `currentModel`.

### 11.2 Claude mapping

| Source / kind | Mapping |
|---|---|
| `data:` `image/png\|jpeg\|gif\|webp` | SDK `image` base64 block |
| `data:` text-like / json / yaml / svg | labeled `text` block |
| `data:` `application/pdf` | `document` base64 block |
| `file://` or absolute path **under session cwd** | path-reference text (`Attached project file: …`) after sandbox + MIME/size checks (Claude can `Read` natively) |
| `file://` with embed mode | bytes embedded like `data:` when path refs disabled |
| path outside cwd | reject `ATTACHMENT_PATH_OUTSIDE_CWD` |
| other binary (e.g. zip) | reject `ATTACHMENT_UNSUPPORTED_TYPE` — never silent-drop |

Turns with attachments use streaming SDK user messages. User message events also emit OpenCode-shaped `file` parts for transcript reconcile.

### 11.3 Size / safety clamps

- Max per-file and per-turn bytes (`MAX_ATTACHMENT_BYTES`, `MAX_TURN_ATTACHMENT_BYTES`).
- On exceed: fail the send with user-visible error identifying the file.
- Never log attachment contents.

### 11.4 Project files vs attachments

Files already on disk in cwd are preferably referenced by path; clipboard/drag-drop `data:` images remain embedded.

### 11.5 Handoff + attachments

- Pending message attachments attempt full transfer on the new session send.
- Historical attachments are **not** seeded in v1 (text-only prior turns).

### 11.6 UI capability gating

Paperclip remains available on Claude engine. Unsupported type → error on send. Healthy Claude catalog reports images supported.

---

## 12. UI / IA — as built

### 12.1 Settings

Settings slug `engines` (split page) in the OpenCode nav group (Engines before Providers):

| Page | Role |
|---|---|
| **Engines** | OpenCode + Claude Code: status, login guidance, capabilities, warnings |
| **Providers** | OpenCode providers + API auth only |
| **Agents** | Setting `enginesClaudeCodeAgentsMode`: `opencode` (default) inherits OpenCode agent permissions + system prompt; `claude` uses native Claude Code prompts/permissions |
| Behavior / Commands / MCP / Plugins | OpenCode-scoped |

Engines → Claude Code detail:

1. Status (Ready / Needs login / Missing CLI / Error) + version  
2. Actions: Login guidance / Open docs / Re-detect  
3. Capabilities summary (from descriptor)  
4. Warnings toggle (`enginesClaudeCodeWarnOnOpenCodeHandoff`)  
5. Note: API keys are configured under Providers on OpenCode  

Locale: `settings.engines.*`.

### 12.2 Chat picker (ModelControls)

Compact chip uses Claude model display names (e.g. Sonnet 5) when engine is Claude.

Picker structure:

```
★ Favorites
Recent
────────
ENGINES
○ OpenCode
○ Claude Code   (status meta)
────────
models for active engine
────────
Manage engines…
Add provider…          # only when active engine is OpenCode
```

Mobile: engine chips, then models sheet. Session list: Claude `EngineLogo` + tooltip on Claude-bound sessions.

Feature flag: `enginesClaudeCodeEnabled` (default `true`).

### 12.3 Visual rules

- Reuse theme tokens; no new purple glow aesthetic.
- Engine rows: icon + name + status text; active = foreground + leading indicator.
- Disabled OpenCode-only features from Claude session: grey + one-line reason or deep-link to Engines (multirun done; see §24 for remaining gates).

### 12.4 Copy guidelines

- User-facing: **Engine**, **Claude Code**, **subscription**, **usage limits**.
- Avoid “harness” in UI strings.
- Locale keys under `settings.engines.*`, `chat.engines.*`, `chat.handoff.*`.

---

## 13. HTTP API — as built

All routes authenticated like other OpenChamber runtime APIs. No secrets in responses.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/harness` | List engines + status |
| GET | `/api/harness/:id` | Engine detail + catalog |
| POST | `/api/harness/:id/detect` | Force detect |
| POST | `/api/harness/prompt` | Send prompt to non-OpenCode engine |
| POST | `/api/harness/abort` | Abort active turn |
| POST | `/api/harness/permission/reply` | Resolve bridged permission |
| GET | `/api/harness/sessions/:sessionId` | Binding + foreign id (debug/UI) |

OpenCode traffic stays on existing SDK / `/api/*` proxy path.

Event delivery: OpenCode-shaped envelopes through `createGlobalUiEventBroadcaster` with `{ directory }` so existing message-stream WS/SSE clients deliver into `event-pipeline` / `event-reducer`.

---

## 14. Permissions bridge — as built

Capability: `permissions: full`.

1. Claude `canUseTool` → OpenChamber `permission.asked` for the session (`id`, `sessionID`, `permission`, `patterns`, `metadata`, `always`, optional `tool: { messageID, callID }`).
2. `always` is populated from concrete command/path patterns, or falls back to the tool name so PermissionCard “Always Allow” stays labeled.
3. UI uses existing permission cards; Claude sessions reply via `harnessPermissionReply` (`once` / `always` / `reject`).
4. `permissionMode` is **not** a separate Claude composer control — derived from agent edit permission on each send.
5. Timeout (~120s), abort, and turn-end fail closed (deny). Never auto-bypass unless mode/SDK path explicitly allows.
6. Server permission-auto-accept reconciles harness pending asks via `listPendingPermissions` / harness reply (not OpenCode permission reply routes).

---

## 15. Usage / quota — as built

- Settings → Usage shows **Claude subscription** windows via `quota/providers/claude.js`.
- Auth resolution prefers Claude CLI OAuth / `CLAUDE_CODE_OAUTH_TOKEN`, then falls back to OpenCode `auth.json` aliases when present (`claude-cli-auth.js`).
- Claude **engine** readiness does **not** depend on OpenCode `auth.json` API keys.
- Do not display API-credit usage as if it were Claude Code engine usage; label remains “Claude subscription”.
- Context usage meters for Claude sessions use Claude catalog limits (`active-model-limits.ts`), not leftover OpenCode model limits.

---

## 16. Runtime matrix

| Surface | Claude engine v1 |
|---|---|
| Desktop (Electron, in-process server) | Supported when `claude` installed for the user (asar-safe executable resolution) |
| Web local server | Supported on server host |
| VS Code | Supported when backend host has CLI; `file://` attachments sandboxed to cwd |
| Remote SSH / tunnel | Supported only if **remote** host has CLI + login |
| Mobile client alone | Engine shown; execution requires connected host with CLI — `unsupported-host` reserved (not yet emitted by local detect) |

UI must surface host-scoped status, not pretend mobile has a local Claude binary.

---

## 17. Security & privacy

1. Never log bearer tokens, OAuth tokens, `CLAUDE_CODE_OAUTH_TOKEN`, auth.json contents, or attachment bytes.
2. Do not persist Claude credentials inside OpenChamber settings; rely on CLI login store / injected env for automated hosts.
3. Strip API keys from Claude child env (subscription-only policy).
4. Enforce cwd sandbox for `file://` / path attachments.
5. Tree-kill child processes on abort/close to avoid orphan MCP servers.
6. Treat permission fail-closed as correctness, not only UI hiding.

---

## 18. Failure & rollback

| Failure | User-visible | State |
|---|---|---|
| CLI missing | Engines status Missing CLI | No session binding corruption; sends blocked |
| Needs login | CTA to login | Sends blocked |
| Auth became API-key-only due to env leak | Treat as misconfiguration; do not silently bill API | Detect → `needs-login` / error |
| Mid-turn crash | Error status on that session | Other sessions intact; resume if foreign id known |
| Unsupported attachment | Send fails with file name/reason | Composer keeps files for retry |
| Path outside cwd | `ATTACHMENT_PATH_OUTSIDE_CWD` | No read outside project |
| Handoff seed truncate | Truncation notice in seed text | Source session unchanged |
| Handoff cancel | No new session | Pending target cleared on cancel path |
| Permission timeout | Deny/fail closed | Pending map cleared; turn can continue/deny per SDK |
| Turn already active | HTTP 409 `TURN_IN_PROGRESS` | No second Claude process for same session |

Optimistic UI messages for Claude sends reconcile with translator accept/reject; failed send must not look like authoritative success.

---

## 19. Phased delivery (status)

| Phase | Status | Notes |
|---|---|---|
| **A — Contracts & UI shells** | **Done** | Types, settings, store, Engines page, picker grouping (`enginesClaudeCodeEnabled` default on) |
| **B — Claude vertical slice** | **Done** | SDK wrapper, bindings, prompt/abort, events, `routeMessage`, permissions, detect/login |
| **C — Attachments + handoff** | **Done** | Attachment mapping + clamps + path refs; handoff duplicate/seed; billing notice |
| **D — Polish** | **Mostly done** | Favorites/recents by target; session glyph; mobile engine chips; usage probe; multirun gated; goal partial. Remaining: §24 |

Codex/Gemini engines remain post-v1 registry additions following the same router contracts.

---

## 20. Testing requirements

Focused coverage present under:

- `packages/web/server/lib/harness/**/*.test.js` (registry, detect, routes, bindings, from-claude, attachments, permissions, auth-env, query, turn-snapshot, …)
- `packages/ui/src/lib/harness/**` tests + `route-message-harness.test.js` + permission harness branches in `session-actions.test.ts`
- Quota: `claude.test.js` / `claude-cli-auth.test.js`
- Session-goal harness continuation tests

Minimum contracts to keep green:

1. Router dispatches opencode vs claude-code without cross-talk.
2. Auth-env policy strips API key for Claude child env.
3. Detect status matrix: ready / needs-login / missing-cli / error (never ready+empty on failure).
4. Event mapper: ascending ids; text → tool → text interleaving; permissions; result finalize.
5. Attachments: image/text/pdf accept; unknown binary reject; `file://` sandbox; HEIC conversion on UI path.
6. Handoff: creates new session, seeds text, preserves source, sets `seedFromSessionId`.
7. Notice setting: default on; checkbox persists off only on Continue; settings re-enable works.
8. Capability gate: multirun not offered on Claude sessions; goal is offered (`partial`).
9. Failure isolation: Claude crash leaves OpenCode sessions usable.

Runtime validation on desktop/web host with real `claude` login remains required before calling the feature “production proven”; typecheck alone is insufficient.

---

## 21. Resolved implementation choices

| Choice | Resolution |
|---|---|
| Event transport | OpenCode-shaped events via `createGlobalUiEventBroadcaster` + existing WS/SSE clients |
| Session ids | Reuse OpenCode session ids as UI shell; Claude id = `foreignSessionId` |
| Claude model catalog | Static map in `registry.js` (aliases + full ids + limits/modalities) |
| Permission mode UI | Derived from OpenCode agent edit permission; no separate Claude chip |
| Attachment / seed budgets | Attachment constants in translator; handoff seed **24_000** chars |
| Part ordering | Ascending OpenCode-compatible ids + new text segment after each `tool_use` |

These do not change locked product decisions in §2.

---

## 22. Acceptance criteria (v1) — code readiness

| # | Criterion | Status |
|---|---|---|
| 1 | User can select Engine **Claude Code** in the chat picker as a top-level engine | **Met** |
| 2 | With Claude CLI + subscription login, chat with streaming text and tools in the normal transcript | **Met in code** (needs host smoke with real CLI) |
| 3 | Usage consumes Claude subscription limits under subscription-only env policy | **Met** (auth-env + detect + Usage labeling) |
| 4 | API-key Anthropic use remains available only via OpenCode Providers | **Met** |
| 5 | Images and common text attachments send successfully; unsupported types error clearly | **Met** |
| 6 | Switching OpenCode → Claude Code on Send creates a **new** session with seeded context and optional billing notice | **Met** (text seed; historical attachments not seeded) |
| 7 | Notice can be permanently dismissed and re-enabled from Settings → Engines → Claude Code | **Met** |
| 8 | Missing CLI / needs login are explicit and block sends without corrupting other sessions | **Met** |

---

## 23. Reference prior art

- Paseo Claude provider: official Agent SDK / process ownership, tree-kill, timeline translation, native credentials.
- Claude Code headless / Agent SDK: `query()`, stream-json/SDK messages, resume, permissions, image blocks via streaming input.
- OpenChamber existing seams: `routeMessage`, Providers settings, quota `claude` provider, skill source `claude`, sync invariants.

---

## 24. Remaining gaps / follow-ups

| Item | Priority | Notes |
|---|---|---|
| Emit `unsupported-host` for no-exec / mobile-only hosts | Polish | Typed + localized; detect never returns it yet |
| Favorite/recent cycle skip unavailable engines/models | Polish | Target-aware keys exist; cycle does not yet skip unavailable |
| Gate `openchamber-tool` / schedule-task starters on Claude | Correctness | Capability is `none`; some starters may still appear |
| MCP/Agents settings explainers from Claude context | Polish | Engines page notes exist; deep Claude-context copy incomplete |
| Historical attachment handoff seed | Optional | Spec §9.1 optional; pending outbound attachments already transfer |
| Goal token budget completeness | Partial | Continuations work; Claude usage tokens → budget still best-effort |
| Locale cleanup (`goalUnsupported` “OpenCode only”) | Polish | Stale vs `goal: partial` |
| `engineOrder` setting | Deferred | Not required for v1 two-engine picker |

---

## 25. How to verify (manual)

1. **Picker:** Settings → Engines shows Claude status; chat picker Engines section selects Claude models.
2. **Chat:** With CLI + login, send a turn that uses tools then answers — transcript order is text → tools → final text.
3. **Permissions:** Agent edit = Ask → PermissionCard Allow once / Always / Reject; timeout fails closed.
4. **Attachments:** PNG + text data URL; project `file://` path; reject zip / outside-cwd.
5. **Handoff:** On a used OpenCode session, pick Claude → Send → confirm notice → new session with seed; source intact; Don’t show again only on Continue.
6. **Gating:** MultiRun disabled on Claude; Goal available; Usage labeled Claude subscription.
7. **Failure isolation:** Stop Claude mid-turn / missing CLI does not clear OpenCode sessions.
