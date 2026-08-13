# Agent Capabilities: Model Fusion

## Purpose

An agent-callable OpenChamber capability built on the managed agent-tool
pattern (`fusion.list`, `fusion.run` actions through the `openchamber` plugin
tool), with matching HTTP routes for UI-triggered runs.

**Model fusion**: creates one isolated child session of the calling session
per model and dispatches the same prompt in parallel with a per-prompt model
override. **The tool accepts preset names only** — users curate presets (2-4
models) in Settings → OpenChamber → Fusion, so the main LLM can never invoke
arbitrary or expensive models. The tool returns every run's final output; the
calling model is the aggregator (consensus, contradictions, unique insights,
blind spots).

Children are **real child sessions created with `parentID` and a `Fused:`
title** — the same mechanism opencode's Task-tool subagents use — so they
appear nested under the session in the sidebar and the work-status Subagents
section, and stream live progress into the transcript via the `openchamber`
tool card. They do **not** copy parent history (small prompt+result sessions),
so no session bloat.

**Child binding in the UI is authoritative**, mirroring the Task tool's
metadata join:

1. `fusion.js` publishes `openchamber:fusion-children-created`
   (`{ sessionId, directory, preset?, children: [{ model, sessionId }] }`)
   over the OpenChamber SSE channel the moment children exist, so the tool
   card renders the children and streams their messages live during the run.
2. The agent-tool plugin persists the run's `children` into the part's
   `openchamber` metadata envelope, so completed runs render from the part
   itself after reload.
3. Live-session filtering remains a fallback for runs that raced a
   reconnect before either source arrived.

## Module map

- `session-runner.js` — shared runner: OpenCode client factory, model
  validation against `/config/providers`, child-session creation with
  `parentID` + title, `prompt_async` dispatch, idle-wait with fail-fast on
  silent failures, final assistant text extraction, child abort.
  NOTE: the v2 SDK client takes flattened options (`{ directory, parentID,
  title }`); a nested `body: {...}` is silently dropped and creates a plain
  auto-titled session without `parentID`. Failures surface the real cause
  (HTTP status + server message), never a generic wrapper.
- `fusion-presets.js` — preset listing/resolution from OpenChamber settings.
- `fusion.js` — `createFusionRuntime({ runner, maxFusionModels, fusedTitlePrefix, emitChildrenCreated })`
- `routes.js` — `registerAgentCapabilityRoutes(app, { readSettingsFromDiskMigrated, persistSettings })`

## HTTP surface (preset CRUD)

| Route | Body / query | Behavior |
|---|---|---|
| `GET /api/openchamber/fusion/presets` | — | Lists fusion presets `{ name, description?, models }` |
| `POST /api/openchamber/fusion/presets/:name` | `{ description?, models[] }` | Creates or replaces a preset (validated BEFORE persisting; persisted in settings) |
| `DELETE /api/openchamber/fusion/presets/:name` | — | Removes a preset |

Fusion runs are agent-triggered only (`fusion.run` through the managed
`openchamber` tool) — there is no UI-triggered run route.

Errors use the `OpenChamberControlError` envelope (`{ error }` with status);
aborted tool requests propagate an abort signal that stops children.

## Fusion presets

- Persisted in OpenChamber settings (`fusionPresets`), sanitized by the
  settings layer: safe name (letters/digits/`.`/`-`/`_`, 1-64), optional
  description, 2-4 `provider/model` strings; invalid entries are dropped and
  >4-model presets are rejected outright. Preset saves are validated with the
  same rules BEFORE the settings write, so an invalid edit can never erase an
  existing preset.
- `fusion.run` (agent tool) accepts `preset` only; passing `models` is a
  usage error. The parent is ALWAYS the calling session — `input.sessionId`
  is ignored by the agent path (the plugin supplies `context.sessionID`).
  Aggregation guidance is described in the tool's agent-facing description.

## Guardrails

- At most `maxFusionModels` (default 4) models per fusion run; at least 2 are
  required (comparing one model is not fusion).
- No default run timeout: runs end when the model answers or the run is
  aborted, exactly like opencode's Task tool. An explicit `timeout` (1-86 400
  s) is honored when a caller passes one. A dispatch that never produces a run
  fails fast after 15 s instead of hanging.
- Children are isolated: they receive only `prompt` — never the main chat
  context.
- Model names are validated against the provider snapshot before any child
  session is created; unknown models are usage errors before any side effect.
- Results are capped at 60 000 characters per run.
- One failed model never erases the others (partial results are returned).
- Abort (request disconnect or tool `context.abort`) aborts every live child.

## Security invariants

- Agent-triggered runs use the existing managed agent-tool endpoint: loopback
  only, rotating bearer token, timing-safe comparison, fixed action allowlist.
- No arbitrary session titles, no deletion, no prompt forwarding of
  non-OpenChamber URLs.

## Runtime parity

- Web and Desktop managed OpenCode: available.
- External OpenCode (`OPENCODE_HOST` / skip-start): agent-tool is not injected,
  so the actions are unavailable to agents; UI routes still work when the
  managed server runs.
- VS Code: not injected; the extension owns a separate OpenCode lifecycle.
- Hosted and Capacitor mobile clients use the server's capabilities when
  connected to such a server.

## Notes

- Children do not inherit parent history (isolated, prompt-only sessions), so
  per-model results are independent of the parent chat. This also means the
  provider prompt-cache sharing of the fork approach does not apply.
