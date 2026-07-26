# Engines & Claude Code Harness — Detailed Spec

Status: draft (design-only; not implemented)  
Primary engine for v1: `claude-code`  
Related product intent: keep OpenChamber UI/API as the primary surface; expand execution backends via a translator layer (Paseo-like: native CLI process, native subscription limits).

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
- MultiRun / injected `openchamber` tool on Claude sessions.
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
        ├── translator/opencode     → existing OpenCode SDK path (default)
        └── translator/claude-code  → @anthropic-ai/claude-agent-sdk → claude CLI
                │
                ▼
        Canonical events → sync/transcript stores (UI unchanged)
```

### Invariants

1. UI never talks to Claude CLI directly.
2. OpenCode remains the default engine and the reference semantics for messages/parts/status.
3. Claude translator must not call `api.anthropic.com` with extracted subscription tokens.
4. One failed Claude session must not clear or block OpenCode sessions.
5. Live status comes from the live harness channel, not reconstructed only from persisted history.
6. Fetch/detect failure must not masquerade as “engine ready with empty catalog”.

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
  | 'bypassPermissions' // if/when exposed; default hidden or advanced
```

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
  | 'unsupported-host'
  | 'error'

type HarnessDescriptor = {
  id: HarnessId
  displayName: string          // "Claude Code"
  shortName: string            // "Claude"
  auth: {
    mode: 'subscription-cli' | 'opencode-providers'
    // claude-code: subscription-cli only
  }
  capabilities: Record<HarnessCapability, CapabilityLevel>
  install: {
    binaryNames: string[]      // ['claude']
    docsUrl: string
    minVersion?: string
  }
}
```

### 5.3 Claude Code v1 capability matrix

| Capability | Level | Notes |
|---|---|---|
| prompt / abort / resume | full | SDK query + interrupt + resume |
| streaming-text | full | partial messages |
| streaming-tools | full | map tool_use/tool_result |
| permissions | full | `canUseTool` + Always patterns + tool linkage + agent-derived permissionMode → OpenChamber permission UI |
| images | full | base64 image blocks |
| file-attachments | full | data: embeds; sandboxed `file://` / project-path refs; images, text/plain-like, PDF; reject opaque binaries |
| slash-commands | partial | user skills via prompt text where CLI expands; no interactive-only cmds |
| mcp | partial | whatever Claude loads natively; no OpenChamber MCP editor bridge |
| subagents | partial | appear in stream if CLI emits; limited UI affordances |
| goal | partial | Server loop via harness turn snapshots + `/api/harness/prompt` continuations; token budget best-effort |
| multirun / openchamber-tool | none | OpenCode-only |

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

Rules:

- Binding is created at session create or first successful route to a harness.
- `harnessId` is sticky for the lifetime of that session.
- Changing engine never mutates an existing binding’s `harnessId`.

### 5.5 Selection / persistence (UI)

Extend selection + settings (names indicative):

```ts
// selection-store (or successor)
sessionTargets: Map<sessionId, ExecutionTarget>
lastUsedTarget: ExecutionTarget | null

// ui favorites become target-aware
favoriteTargets: ExecutionTarget[]

// settings
engines: {
  defaultHarnessId: HarnessId  // default 'opencode'
  claudeCode: {
    warnOnOpenCodeHandoff: boolean  // default true
  }
}
engineOrder: HarnessId[]
```

Favorites / recents / shortcuts must key by `harnessId + model identity` to avoid collisions with OpenCode `anthropic/...`.

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
      supportsImages?: boolean
      supportsDocuments?: boolean
    }>
  }>
}
```

For Claude Code v1, a single models section is enough (no provider nesting).

---

## 6. Module layout

```text
packages/web/server/lib/harness/
  DOCUMENTATION.md
  index.js
  registry.js                 # descriptors
  router.js                   # prompt/abort/resume dispatch
  session-bindings.js
  detect.js
  events/
    canonical.js
    from-claude.js
  translators/
    opencode/
      index.js                # thin delegate to existing SDK path
    claude-code/
      index.js
      auth-env.js             # subscription-only env policy
      spawn.js / query.js     # Agent SDK wiring
      permissions.js
      attachments.js
      catalog.js
  routes.js                   # /api/harness/*

packages/ui/src/
  stores/useHarnessStore.ts
  lib/harness/catalog.ts
  components/harness/
    EngineStatusBadge.tsx
    HandoffConfirmDialog.tsx
  components/sections/engines/
    EnginesSidebar.tsx
    EnginesPage.tsx
    ClaudeCodeEngineDetail.tsx
```

OpenCode proxy and Providers pages remain unchanged in ownership. Harness routes register **before** the generic OpenCode proxy.

---

## 7. Claude Code translator (Paseo-like)

### 7.1 Runtime choice

Use official `@anthropic-ai/claude-agent-sdk` which spawns the local `claude` CLI.

Rationale:

- Native tools, CLAUDE.md, skills, hooks, project MCP.
- Subscription billing when CLI OAuth/login is active.
- Structured messages + `canUseTool` (better than raw PTY scraping).

Dependency policy: adding `@anthropic-ai/claude-agent-sdk` requires an explicit dependency-add approval at implementation time (repo rule). Spec assumes that approval.

### 7.2 Auth policy (subscription only)

Hard requirements:

1. Claude engine **never** presents API-key entry.
2. Before spawn, child env must **not** prefer API billing credentials over subscription login.
3. Concrete policy for translator process env:
   - Unset/strip `ANTHROPIC_API_KEY` for Claude engine child processes.
   - Unset/strip other API-priority vars that would outrank Claude Code OAuth per Claude auth order, when the goal is subscription mode.
   - Do not copy OpenCode `auth.json` Anthropic API keys into Claude engine.
4. Ready criteria:
   - `claude` binary resolvable on the execution host.
   - Subscription login detectable (CLI auth probe / SDK auth state).
   - If only an API key exists and subscription login is absent → status `needs-login` (not `ready`).
5. Settings copy must state: API keys stay under OpenCode; Claude Code engine uses Claude subscription.

### 7.3 Query shape

- Text-only turns may use string prompt **or** streaming user messages.
- Any turn with attachments **must** use `AsyncIterable<SDKUserMessage>` content blocks.
- Resume uses stored `foreignSessionId`.
- Working directory = session/project directory.
- Do **not** default to `--bare` for product sessions (bare skips CLAUDE.md/skills/MCP and hurts nativity). Bare may exist later as an advanced opt-in; not v1 default.
- Permission mode derived from the selected OpenCode agent's edit permission
  (`allow`→`acceptEdits`, `ask`→`default`, `deny`→`plan`); not a separate Claude UI control.
  Session permission auto-accept replies through `/api/harness/permission/reply`.
- `canUseTool` bridges into OpenChamber permission requests.

### 7.4 Process lifecycle

- One Claude query/session binding per OpenChamber session (unless resume spawns a replacement query).
- Abort → SDK interrupt + terminate process tree (Claude + MCP children), Paseo-style tree kill.
- Crash → canonical `session.status=error` + `harness.notice`; keep binding for retry/resume when possible.
- Never log tokens, OAuth material, or raw credential env.

### 7.5 Event mapping (Claude → Canonical)

Map at least:

| Claude / SDK | Canonical |
|---|---|
| assistant text / text_delta | `part.delta` / message upsert |
| thinking (if emitted) | reasoning part (optional display) |
| tool_use / tool_result | tool start/update/end |
| permission prompt via canUseTool | `permission.request` |
| result / completion | `session.status=idle` + finalize |
| api_retry / rate_limit errors | error + user-visible notice |
| session_id | persist `foreignSessionId` |

Unknown event types: ignore safely or surface as `harness.notice` debug-level; do not crash the pump.

### 7.6 Catalog / detect API

`GET /api/harness` → list descriptors + runtime status per host/directory scope.  
`GET /api/harness/claude-code` → detail: version, login state, models, capabilities.  
`POST /api/harness/claude-code/detect` → force refresh (no silent success-on-failure).

Detection must run on the **execution host** (local server, desktop backend, or remote SSH host), not on a UI-only device that lacks the binary.

---

## 8. Routing & session flows

### 8.1 Send path

```
sendMessage / routeMessage
  read ExecutionTarget for current session (or pending handoff target)
  if harnessId === 'opencode':
    existing opencodeClient path
  else:
    POST /api/harness/prompt {
      sessionId, directory, target, parts, attachments, delivery?
    }
```

Server:

1. Validate binding/target consistency.
2. Validate capabilities (e.g. images required ⇒ `images != none`).
3. Translate attachments.
4. Start/resume Claude query.
5. Stream canonical events to the UI event pipeline.

### 8.2 Session create

- New chat with last-used / default engine.
- OpenChamber still owns the session list row and local/optimistic messages.
- Claude foreign id filled when SDK reports `session_id`.

### 8.3 Engine switch / handoff (required behavior)

When user selects a different engine in an existing session:

1. Mark target as **pending handoff** (do not rewrite binding).
2. On Send (or explicit Continue):
   - If notice enabled and `opencode → claude-code`: show confirm dialog.
   - Create **new** OpenChamber session with `harnessId: claude-code`.
   - Set `seedFromSessionId`.
   - Seed transcript (see §9).
   - Send the pending user message (with attachments) to the new session.
   - Navigate UI to the new session.
   - Leave the source session untouched.

Empty/nearly-empty source sessions may skip seed and only create a fresh Claude session (still show notice if billing gate applies and setting on).

If Claude engine is not `ready`, block send and deep-link to Settings → Engines → Claude Code.

In-place rewrite of `harnessId` on an existing session is **out of spec**.

---

## 9. Handoff seeding

### 9.1 Include

- User and assistant **text** turns (most recent first, up to budget).
- Attachment images/docs from the **pending outbound message** in full (subject to size clamps).
- Optional: last N image attachments from history if budget remains.

### 9.2 Exclude / degrade

- Full tool call/result transcripts by default (optional short textual summaries).
- Permission history.
- OpenCode-only synthetic parts that have no Claude meaning.
- Oversized binaries.

### 9.3 Budget

Implementation-defined token/char budget (configurable constant). When truncated, prepend a short system/user note:

`Prior conversation truncated for handoff; N earlier turns omitted.`

### 9.4 Seed delivery to Claude

Prefer a first synthetic user message (or structured streaming user messages) that clearly labels prior context, then the real user prompt as the actionable turn. Do not claim the Claude native session is the same session as OpenCode.

---

## 10. Handoff billing notice

### 10.1 When

Show only if all are true:

- source `harnessId === 'opencode'`
- target `harnessId === 'claude-code'`
- `settings.engines.claudeCode.warnOnOpenCodeHandoff !== false`
- user is about to create/continue via handoff (Send/Continue)

Do not show for:

- brand-new Claude sessions with no OpenCode source
- subsequent turns inside Claude
- reverse handoff Claude → OpenCode (v1)

### 10.2 Dialog

- Title: Continue on Claude Code?
- Body: Explains new session uses Claude **subscription usage limits**; API providers remain on OpenCode; conversation text is copied as context.
- Primary: Continue
- Secondary: Cancel
- Checkbox: Don’t show this again  
  - Applied only when user confirms Continue (Cancel must not persist dismissal).

### 10.3 Settings control

Settings → Engines → Claude Code:

```
Warnings
[ ] Warn when switching from OpenCode to Claude Code
    Explain that the new session uses your Claude subscription, not API billing.
```

Default: enabled.  
Dialog “Don’t show again” sets this to disabled.  
User can re-enable anytime on this page.

### 10.4 Persistence

Persist under user settings (same durability path as other OpenChamber settings), not a write-only localStorage tombstone without settings UI.

```ts
engines.claudeCode.warnOnOpenCodeHandoff: boolean // default true
```

---

## 11. Attachments

### 11.1 OpenChamber input

Reuse composer `AttachedFile` → `{ mime, url, filename }` (data URLs or resolvable URLs), including existing HEIC→JPEG and text MIME normalization where applicable **before** or inside translator ingress.

### 11.2 Claude mapping

| MIME / kind | Mapping |
|---|---|
| `image/png`, `image/jpeg`, `image/gif`, `image/webp` | SDK `image` base64 block |
| `image/heic`, `image/heif` | convert to JPEG first, then image block |
| text-like (`text/*`, json, yaml, …) | document/text content block |
| `application/pdf` | document block when supported; else explicit error |
| other binary | reject with clear error; do not silent-drop |

Turns with attachments must use streaming SDK user messages (string prompt path insufficient).

### 11.3 Size / safety clamps

- Max per-file and per-turn bytes (constants in translator).
- On exceed: fail the send with user-visible error identifying the file.
- Never log attachment contents.

### 11.4 Project files vs attachments

Files already on disk in cwd should preferably be referenced by path in text when the user attaches via file picker from the project; clipboard/drag-drop images remain embedded attachments.

### 11.5 Handoff + attachments

- Pending message attachments always attempt full transfer.
- Historical attachments best-effort within budget; omit with notice when needed.

### 11.6 UI capability gating

Paperclip remains available on Claude engine. Unsupported type → error on send. If detect reports `images: none` (should not happen for healthy Claude), disable image attach explicitly.

---

## 12. UI / IA

### 12.1 Settings

Group conceptually “Engines & models” (internal group id may remain `opencode` initially if slug churn is costly; user-visible titles should say Engines where needed):

| Page | Role |
|---|---|
| **Engines** (new, split) | OpenCode, Claude Code (later Codex/Gemini): status, login, capabilities, warnings |
| **Providers** | OpenCode providers + API auth only |
| **Agents** | OpenCode agents; Claude detail links to permission modes / note about CLI agents |
| Behavior / Commands / MCP / Plugins | OpenCode-scoped; Claude detail explains native CLI ownership |

Engines → Claude Code detail sections:

1. Status (Ready / Needs login / Missing CLI / Error) + version  
2. Actions: Login guidance / Open docs / Re-detect  
3. Capabilities summary  
4. Warnings toggle (`warnOnOpenCodeHandoff`)  
5. Note: API keys are configured under Providers on OpenCode  

### 12.2 Chat picker (ModelControls)

Compact chip:

`[Claude · Sonnet 5 ▾]  [Accept edits ▾]`

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

Mobile: engine chips, then models sheet.

Session list: small engine glyph + tooltip.

### 12.3 Visual rules

- Reuse theme tokens; no new purple glow aesthetic.
- Engine rows: icon + name + status text; active = foreground + leading indicator.
- Notices in transcript: rare meta lines, not sticker overlays.
- Disabled OpenCode-only features from Claude session: grey + one-line reason or deep-link to Engines.

### 12.4 Copy guidelines

- User-facing: **Engine**, **Claude Code**, **subscription**, **usage limits**.
- Avoid “harness” in UI strings.
- Locale keys under something like `settings.engines.*`, `chat.engines.*`, `chat.handoff.*`.

---

## 13. HTTP API (indicative)

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

OpenCode traffic stays on existing SDK/`/api/*` proxy path.

Event delivery: prefer reusing the existing OpenChamber event/stream pipeline with canonical event envelopes tagged by `sessionId` (exact transport left to implementation, but must satisfy sync invariants).

---

## 14. Permissions bridge

1. Claude `canUseTool` → create OpenChamber permission request for session.
2. UI uses existing permission cards/flows where possible.
3. Reply → translator resolves the pending Claude permission promise.
4. Permission mode chip maps to Claude modes; unsupported modes hidden.
5. If permission UI cannot be shown (disconnected client), fail closed per mode (deny / dontAsk semantics), never auto-bypass unless mode explicitly allows.

---

## 15. Usage / quota

- Settings → Usage continues to show Claude subscription windows when credentials for that fetcher exist.
- Claude **engine** readiness must not depend on OpenCode `auth.json` API keys.
- Prefer a Claude-Code-aware usage probe aligned with CLI subscription auth (separate from small-model Anthropic API path).
- Do not display API-credit usage as if it were Claude Code engine usage.

---

## 16. Runtime matrix

| Surface | Claude engine v1 |
|---|---|
| Desktop (Electron, in-process server) | Supported when `claude` installed for the user |
| Web local server | Supported on server host |
| VS Code | Supported when backend host has CLI |
| Remote SSH / tunnel | Supported only if **remote** host has CLI + login |
| Mobile client alone | Engine shown; execution requires connected host with CLI — otherwise `unsupported-host` / unavailable |

UI must surface host-scoped status, not pretend mobile has a local Claude binary.

---

## 17. Security & privacy

1. Never log bearer tokens, OAuth tokens, `CLAUDE_CODE_OAUTH_TOKEN`, auth.json contents, or attachment bytes.
2. Do not persist Claude credentials inside OpenChamber settings; rely on CLI login store.
3. Strip API keys from Claude child env (subscription-only policy).
4. Enforce cwd sandbox = project directory expectations already used by server file/terminal ops.
5. Tree-kill child processes on abort/close to avoid orphan MCP servers.
6. Treat permission fail-closed as correctness, not only UI hiding.

---

## 18. Failure & rollback

| Failure | User-visible | State |
|---|---|---|
| CLI missing | Engines status Missing CLI | No session binding corruption |
| Needs login | CTA to login | Sends blocked |
| Auth became API-key-only due to env leak | Treat as misconfiguration; do not silently bill API | Detect + error/notice |
| Mid-turn crash | Error status on that session | Other sessions intact; resume if foreign id known |
| Unsupported attachment | Send fails with file name/reason | Composer keeps files for retry |
| Handoff seed truncate | Notice in new session | Source session unchanged |
| Handoff cancel | No new session | Pending target cleared or kept per UX choice (prefer clear) |
| Permission timeout | Deny/fail closed | Turn ends error or waits per existing permission UX |

Optimistic UI messages for Claude sends must reconcile with translator accept/reject; failed send must not look like authoritative success.

---

## 19. Phased delivery

### Phase A — Contracts

- `HarnessId`, bindings, settings keys, catalog types.
- Engines settings page shell + Claude detail status/detect (can be read-only).
- Picker engine grouping wired to OpenCode-only until Phase B lands.

### Phase B — Claude vertical slice

- Dependency + translator prompt/stream/abort/resume.
- Subscription env policy + detect/login status.
- Canonical event ingest into transcript.
- Permission mode + canUseTool bridge (basic).

### Phase C — Attachments + handoff

- Attachment mapping + clamps.
- Handoff duplicate + seed.
- Billing notice + settings toggle + don’t-show-again.

### Phase D — Polish

- Favorites/recents by target.
- Usage probe alignment.
- Capability gating for OpenCode-only features.
- Session glyph + mobile engine chips.

Codex/Gemini engines are post-v1 registry additions following the same router contracts.

---

## 20. Testing requirements

Minimum focused coverage:

1. Router dispatches opencode vs claude-code without cross-talk.
2. Auth-env policy strips API key for Claude child env.
3. Detect status matrix: ready / needs-login / missing-cli / error.
4. Event mapper: text + tool + permission + result fixtures.
5. Attachments: image/text/pdf accept; unknown binary reject; HEIC conversion path.
6. Handoff: creates new session, seeds text, preserves source, sets `seedFromSessionId`.
7. Notice setting: default on; checkbox persists off only on Continue; settings re-enable works.
8. Capability gate: multirun not offered on Claude sessions; goal is offered (`partial`).
9. Failure isolation: Claude crash leaves OpenCode sessions usable.

Runtime validation on desktop/web host with real `claude` login is required before calling the feature done; typecheck alone is insufficient.

---

## 21. Open implementation choices (resolve at coding time)

1. Exact event transport into existing sync bus (mirror OpenCode SSE shapes vs parallel harness channel + adapter).
2. Whether OpenChamber session ids are purely local for Claude rows or also mirrored into an OpenCode-compatible session store stub.
3. Precise Claude model catalog source (static map vs CLI/SDK discovery).
4. Permission mode set exposed in v1 UI.
5. Numeric attachment/seed budgets.

These must not change locked product decisions in §2.

---

## 22. Acceptance criteria (v1)

1. User can select Engine **Claude Code** in the chat picker as a top-level engine.
2. With Claude CLI installed and subscription login present, user can chat with streaming text and tools in the normal OpenChamber transcript.
3. Usage consumes Claude subscription limits (not Anthropic API credits) under the subscription-only env policy.
4. API-key Anthropic use remains available only via OpenCode Providers.
5. Images and common text attachments send successfully; unsupported types error clearly.
6. Switching OpenCode → Claude Code on Send creates a **new** session with seeded context and optional billing notice.
7. Notice can be permanently dismissed and re-enabled from Settings → Engines → Claude Code.
8. Missing CLI / needs login are explicit and block sends without corrupting other sessions.

---

## 23. Reference prior art

- Paseo Claude provider: official Agent SDK / process ownership, tree-kill, timeline translation, native credentials.
- Claude Code headless / Agent SDK: `query()`, stream-json/SDK messages, resume, permissions, image blocks via streaming input.
- OpenChamber existing seams: `routeMessage`, Providers settings, quota `claude` provider, skill source `claude`, sync invariants.
)
