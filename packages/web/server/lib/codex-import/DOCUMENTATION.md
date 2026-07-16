# Codex import

This module owns one-way import from a local Codex installation into OpenChamber and OpenCode. It is built into OpenChamber, but its core is isolated behind injected host capabilities so it can later move to a separate package or OpenCode plugin.

## Architecture

Portable core:

- `app-server-client.js`: minimal JSON-RPC client for `codex app-server --stdio`. It owns process startup, request correlation, timeouts, and Windows command-shim handling.
- `runtime.js`: Codex discovery, safe preview shaping, transcript conversion, import orchestration, OpenCode session pagination, and process-local import serialization.

OpenChamber host adapters:

- `project-registrar.js`: atomically merges available Codex project paths into the latest OpenChamber settings snapshot.
- `routes.js`: maps the runtime to authenticated OpenChamber HTTP routes.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: composition root that injects the OpenCode SDK factory, settings adapter, filesystem, process, URL, and auth capabilities.
- `packages/web/src/api/imports.ts` and `CodexImportDialog.tsx`: web transport and shared UI adapter.

The portable core must not import OpenChamber settings helpers, stores, React code, or the OpenCode SDK. Host-specific behavior enters through the dependency object.

## Core dependency contract

`createCodexImportRuntime(dependencies)` requires:

- `spawn`, `fsPromises`, `path`: platform capabilities.
- `registerProjects(paths)`: host project registration; returns `{ added, existing, unavailable }`.
- `buildOpenCodeUrl()` and `getOpenCodeAuthHeaders()`: current runtime connection details, resolved at import time.
- `createOpenCodeClient(options)`: official OpenCode client factory.
- Optional `createCodexClient()`: test or alternate Codex transport factory.

`createCodexProjectRegistrar(dependencies)` is deliberately separate. It depends on OpenChamber's `updateSettings(createChanges)` queue and `sanitizeProjects()`, and is not part of the portable import core.

## HTTP contract

- `POST /api/import/codex/inspect`: returns safe Codex configuration fields, projects, and thread metadata.
- `POST /api/import/codex/apply`: accepts `{ threadIds: string[], projectPaths: string[] }` and returns project counters plus one independent result per requested thread.

The UI treats projects as expandable conversation groups. Selecting a project selects all of its thread IDs; individual thread changes produce an indeterminate project state, and `apply` receives only the final selected thread IDs. Project paths remain a separate field so an available project can still be registered independently of its conversation count.

Both routes are registered before the generic OpenCode proxy and use the normal OpenChamber API authentication middleware. The shared `ImportsAPI` is optional; runtimes without the host capability do not render the import action.

## Data conversion

- OpenCode's public API cannot create historical assistant/tool messages. Each Codex thread is stored as one role-labelled Markdown transcript in a `noReply` user message.
- Command names and exit status are retained, but command output is omitted.
- Supported Codex items receive stable role/activity sections. Unknown item types receive an explicit marker without serializing their unreviewed payload.
- Transcripts are bounded to 1,000,000 characters.
- Imported sessions carry `metadata.importSource = "codex"`, `metadata.importThreadID`, and `metadata.importFormat = "transcript-v1"`.

## Reliability and security invariants

- Read Codex through `codex app-server --stdio`; never parse Codex SQLite or rollout JSONL files directly.
- Never read, return, persist, or log Codex authentication data.
- Preview returns only project paths, thread metadata, and a small safe configuration summary.
- Codex app-server stderr is drained but never included in client-visible errors.
- Import requests are serialized within one OpenChamber process. Before creation, all OpenCode session pages for the directory are checked for matching import metadata.
- Retry skips an existing matching session. A failed transcript write deletes the newly created empty session.
- Missing project directories are not added. Conversation failures are isolated; successful imports and valid project additions remain intact.
- Project registration is a settings-queue read-modify-write operation, so it merges against the latest persisted project list instead of replacing concurrent settings changes.

## Migration path

For extraction into a package, move `app-server-client.js`, `runtime.js`, and their tests first. Provide package-level interfaces for the injected dependencies; keep `project-registrar.js`, routes, RuntimeAPIs, and React UI in the OpenChamber adapter.

For an OpenCode plugin migration, reuse the Codex client and transcript conversion. Replace `createOpenCodeClient` with plugin-native session access and expose the operation as a plugin command/tool. The existing OpenCode plugin system does not provide OpenChamber UI or project-settings extension points, so the sidebar/dialog and project registrar must remain an OpenChamber adapter unless those extension points are added later.

The transcript metadata keys and `transcript-v1` format are the compatibility boundary. A future implementation must preserve them or ship an explicit migration.

## Public exports

- `createCodexAppServerClient(dependencies)`
- `createCodexImportRuntime(dependencies)`
- `formatCodexTranscript(thread)`
- `createCodexProjectRegistrar(dependencies)`
- `registerCodexImportRoutes(app, dependencies)`
