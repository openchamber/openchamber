# Harness Backend Architecture

## Purpose

The `harness/` modules provide a backend-agnostic execution layer for OpenChamber.
The UI talks to canonical OpenChamber routes, and the server resolves each session to
the correct backend adapter before calling that backend's official SDK/runtime.

This layer exists to prevent backend-specific HTTP shapes from leaking into shared UI
or route code.

## Ownership

- `backends.js`
  - Declares the backend catalog exposed to the UI.
  - Owns availability flags, labels, capabilities, and default-backend resolution.
- `session-bindings.js`
  - Persists the OpenChamber-owned mapping from session ID -> backend runtime.
  - Restores backend routing across restarts.
- `opencode-backend.js`
  - OpenCode adapter built on `@opencode-ai/sdk/v2`.
- `codex-backend.js`
  - Codex adapter built on `@openai/codex-sdk` plus the local Codex CLI/runtime.

The actual HTTP route registration lives in:

- `packages/web/server/lib/opencode/openchamber-routes.js`

That file should remain thin. It validates inputs, resolves the session binding, then
delegates to the appropriate backend runtime.

## Core design rules

### 1. UI speaks OpenChamber contracts only

Shared UI should use canonical routes like:

- `POST /api/openchamber/harness/session`
- `POST /api/openchamber/harness/session/:sessionId/message`
- `POST /api/openchamber/harness/session/:sessionId/command`
- `POST /api/openchamber/harness/session/:sessionId/abort`
- `POST /api/openchamber/harness/session/:sessionId/update`
- `GET /api/openchamber/harness/control-surface`

Do not make the UI aware of backend-native transport details such as:

- backend-specific query parameter placement
- backend-specific route names like `prompt_async`
- backend-specific body shapes

### 2. Adapters own backend-native translation

Each backend runtime should translate between OpenChamber concepts and the backend SDK.

Examples:

- OpenCode adapter:
  - `directory` belongs on the OpenCode SDK client
  - prompt payloads use `client.session.promptAsync(...)`
- Codex adapter:
  - session state is persisted in OpenChamber-owned storage
  - mode/model/effort map into Codex thread/run options

If a backend has an official SDK, use it. Do not re-handcraft that backend's HTTP
requests in shared server or UI code.

### 3. Session routing is owned by OpenChamber

`session-bindings.js` is the source of truth for which backend owns a session.

Each binding stores:

- `sessionId`
- `backendId`
- `backendSessionId`
- `directory`
- timestamps

All session-scoped actions must resolve through this binding before they touch a
backend adapter.

### 4. Control-surface data is backend-owned

The composer must not assume that every backend has:

- OpenCode-style agents
- OpenCode-style providers
- OpenCode-style model variants

Instead, each backend returns a canonical control surface:

- `backendId`
- `modeSelector`
- `modelSelector`
- `effortSelector`
- `commandSelector`

That surface lets the UI render the right controls without hardcoding backend-specific
UI semantics.

## Backend runtime shape

There is not currently a formal TypeScript interface in this folder, but the route
layer expects a backend runtime to expose methods like:

- `createSession(input)`
- `promptAsync(input)`
- `command(input)` when supported
- `abortSession(input)`
- `updateSession(input)`
- `getControlSurface(input)`

Backends may also expose backend-specific helpers for:

- session listing / lookup
- message reconstruction
- streaming / event fanout

If you add a new backend, keep the public adapter surface aligned with what
`openchamber-routes.js` and proxy/session restoration logic actually consume.

## Adding a new backend

### Step 1. Create the adapter

Add a new file under `packages/web/server/lib/harness/`, for example:

- `claude-backend.js`
- `gemini-backend.js`

The adapter should:

- use the backend's official SDK or CLI bridge
- own all backend-native request/response translation
- return OpenChamber-friendly session/control data

### Step 2. Register the backend descriptor

Update `backends.js` with:

- `id`
- `label`
- `available`
- `comingSoon`
- capability flags

Only set `available: true` when the backend actually works end-to-end in the harness.

### Step 3. Wire it into server bootstrap

Update `packages/web/server/index.js` to:

- construct the new backend runtime
- pass it into route/bootstrap dependencies

### Step 4. Route canonical harness actions to it

Update `packages/web/server/lib/opencode/openchamber-routes.js` so the canonical
harness routes can delegate to the new backend runtime based on `backendId`.

If session restore, legacy proxy, or bootstrap code still has backend assumptions,
update those paths too.

### Step 5. Keep restart behavior correct

If the backend has its own session IDs or persistence model, make sure the adapter
and `session-bindings.js` together preserve:

- reload / restart session access
- archive/update/delete correctness
- cross-runtime parity

### Step 6. Expose a control surface

Implement `getControlSurface()` so the UI can render:

- primary selector: `agent` or `mode`
- backend-native model catalog or provider-driven models
- backend-native effort options
- backend-native slash commands

The UI should not need backend-specific if/else logic beyond interpreting the
canonical control-surface schema.

### Step 7. Update VS Code parity

If the backend is selectable in shared UI, update:

- `packages/vscode/src/bridge-proxy-runtime.ts`

The bridge must expose the same backend availability/capability view as the web
runtime, or the UI will render inconsistent backend state.

## Control-surface conventions

### `modeSelector`

Use this when the backend exposes a primary mode-like choice.

Examples:

- OpenCode: `kind: "agent"`
- Codex: `kind: "mode"` with entries like `build` / `plan`

### `modelSelector`

Two valid sources:

- `source: "providers"`
  - backend follows the OpenCode provider/model pattern
- `source: "backend"`
  - backend exposes its own flat model catalog

### `effortSelector`

Two valid sources:

- `source: "model-variants"`
  - OpenCode-style model variants
- `source: "backend"`
  - backend-native effort/reasoning levels

If the backend cannot support a specific effort/model combination, prefer surfacing
the backend's own validation error unless the SDK exposes authoritative compatibility
metadata.

### `commandSelector`

Two valid sources:

- `source: "config"`
  - backend supports OpenCode-style editable command config
- `source: "backend"`
  - backend exposes its own native slash-command catalog

Each command item may declare an `executionMode`:

- `session-command`
  - dispatch through the backend-native command route
- `prompt-text`
  - send the slash command text as a normal prompt to the backend

For Codex specifically, backend-native reusable slash entries come from deprecated
custom prompts. Those live as top-level Markdown files under `~/.codex/prompts`
and are exposed as `/prompts:<name>`.

## Validation checklist

Before merging a new backend:

- `bun run type-check`
- `bun run lint`
- `bun run build`

Then verify, at minimum:

- create session
- send first message
- revisit existing session after restart
- archive/update session
- correct backend lock in composer for active sessions
- correct model/mode/effort surface for that backend
- sidebar/provider/runtime indicators remain consistent

## Common failure patterns

### Backend label mismatch in composer

Cause:

- UI is reading draft/default backend instead of the active session's authoritative
  backend from the live session or control surface.

Fix:

- prefer session/control-surface backend for active sessions
- then persist it back into `sessionBackendSelections`

### Restart sends session to the wrong backend

Cause:

- binding lookup fell back before persisted bindings finished loading

Fix:

- await binding load before applying fallback behavior
- eagerly load bindings during server bootstrap

### Mixed model catalogs in the picker

Cause:

- backend-native model lists were merged with OpenCode provider catalogs

Fix:

- when `modelSelector.source === "backend"`, treat that model list as exclusive

### SDK/transport mismatch

Cause:

- adapter logic was bypassed with handcrafted backend-native HTTP requests

Fix:

- move the operation back behind the backend adapter and use the official SDK
