# Secure Workspaces Windows Docker Handoff

> **Status (2026-08-05): resolved.** Everything below is kept as the historical
> problem statement this work started from. The full lifecycle described in
> Scope And Goal — create, session, message, export, apply, delete — has been
> validated end-to-end in the packaged Windows Electron app. The deletion
> failure was a policy-fingerprint gate on cleanup, fixed in the plugin
> (merged as `opencode-container-workspace` PR #1) together with the other
> defects found along the way; OpenChamber is pinned to the merged commit.
> Current state and remaining work are tracked in
> `docs/SECURE_WORKSPACES_SPECIFICATION.md`.

## Scope And Goal

This work is validating and completing the Windows Docker Secure Workspaces
functional lifecycle in the packaged Electron application. The intended user
flow is:

1. Create a Docker-backed Secure Workspace for a disposable local project.
2. Start and use a session routed into that workspace.
3. Send a message under the configured model-auth policy.
4. Review and export isolated workspace changes, then apply them to the host.
5. Delete the workspace and confirm that provider resources and the OpenCode
   workspace record are cleaned up.

The immediate unresolved issue is that deleting the existing functional Docker
workspace is unsuccessful. The UI has not retained an actionable error long
enough to identify the provider or server failure. Do not treat the workspace
as safely deleted unless both the provider resources and the OpenCode record
are confirmed gone.

## Operating Constraints

- Do not run Git or GitHub commands unless the user explicitly requests them.
- Do not delete Docker containers, images, volumes, or workspace data manually
  without explicit user approval. The existing workspace is disposable, but
  manual removal would hide evidence needed to diagnose the product flow.
- Do not inspect, log, copy, or request secrets, passwords, bearer tokens,
  pairing credentials, or model credentials.
- Preserve unrelated worktree changes. This repository may already be dirty.
- The user expects evidence-backed root-cause analysis, not speculative
  reinstall/delete cycles.
- The user asked for this handoff without proposed solutions. This document
  therefore records facts, observed behavior, and missing evidence only.

## Environment

- Repository: `%USERPROFILE%\projects\openchamber`
- Platform: Windows 11 (`win32`)
- Date of latest work: 2026-08-03
- Functional profile data directory:
  `%TEMP%\openchamber-functional-profile`
- Functional disposable project:
  `%TEMP%\openchamber-functional-project`
- Packaged executable used for testing:
  `packages\electron\dist\win-unpacked\OpenChamber.exe`
- The packaged app was launched with `OPENCHAMBER_DATA_DIR` set to the
  functional profile and Chromium `--user-data-dir` set to the profile's
  `chromium` subdirectory.
- Local Docker registry used during functional validation: `127.0.0.1:5001`.
- Runtime image used:
  `127.0.0.1:5001/openchamber/runtime@sha256:bd6516fa1a5f0f5b7ce08729a56c4c7bb6f239775a85cb1f9e3ec57634f8b6c4`
- Gateway image used:
  `127.0.0.1:5001/openchamber/gateway@sha256:2e4a9356381f3f649fe294a320dfb228ae50dac5f2555b2d33a44f0129b7a8fb`

## Functional Workspace State

The following workspace was successfully created through the product flow:

- OpenCode workspace ID: `id-14684c2536efe896045922b9bd24a3d3`
- Provider resource ID: `ws-1355402e7e9c2bb6e3796007345e7370`
- Displayed workspace name prefix: `docker-1355402e7e9c`
- Provider: Docker

Last observed provider containers for that workspace:

- Access proxy: `827f0bf5079d`
- Runtime: `7a16300dc518`
- Egress gateway: `7b3ac7b0284b`

Those containers were observed as `Up` before the latest deletion attempts.
Their current state has not been re-confirmed after the final app relaunch.

The OpenCode managed log shows a workspace context at `C:\workspace`, which
confirms that a routed session reached the workspace runtime.

## Confirmed Findings

### Global OpenCode Data Contamination

An earlier malformed/stale session was stored under the global OpenCode data
directory:

`%USERPROFILE%\.local\share\opencode`

The managed OpenCode child had inherited that global data even when
`OPENCHAMBER_DATA_DIR` pointed at the functional profile. This caused a stale
temporary-path error to appear in the functional test profile. The UI was
already sending the selected `directory` query to SDK `syncList`; the stale
state was not caused by that query being omitted.

The managed child now receives a profile-local `XDG_DATA_HOME` when
`OPENCHAMBER_DATA_DIR` is present. The functional profile contains an
`opencode-data` directory after launch, establishing that managed runtime data
is written under the profile.

### Shared OpenCode Configuration

An earlier attempt to isolate `XDG_CONFIG_HOME` caused `Unknown workspace
adapter: docker`, because the shared OpenCode plugin configuration was no
longer loaded. That `XDG_CONFIG_HOME` isolation was removed. The managed log
subsequently showed config files loading from:

`%USERPROFILE%\.config\opencode`

The current intended arrangement is profile-local OpenCode data and shared
OpenCode configuration.

### Workspace Creation And Routing

Workspace creation succeeded after the profile-data isolation change. The
Docker runtime, access proxy, and egress gateway were created. A routed session
subsequently used `C:\workspace` in the managed OpenCode log.

### Model Authorization

The first workspace prompt failed with `403 Forbidden`. At that time the
workspace had been created before the model-auth policy grant was persisted and
activated. The settings save flow used `activate: false`, and workspace
credentials are materialized at workspace creation. The exact behavior of a
newly created workspace after the explicit model-auth policy is activated has
not been functionally completed.

### Current UI Status

The latest packaged app displays the existing workspace as Docker with
`Unknown status` and displays this error:

`Workspace policy fingerprint does not match the active policy`

This workspace was created before the active model-auth policy changed. The
policy mismatch is a real displayed condition. No causal link between that
condition and cleanup failure has been established.

The managed OpenCode log contains unrelated adapter-list warnings:

- Apple Container executable `container` is not on `PATH`.
- Kubernetes `kubectl` attempts to reach `localhost:8080` and fails because no
  Kubernetes API server is present.

These warnings are present while Docker workspace creation succeeded. Their
relationship to the displayed `Unknown status` or cleanup failure is not yet
established.

## Deletion Failure: Observed Behavior

The UI has a `delete workspace` action followed by a destructive confirmation
and request-bound reauthentication prompt. The user repeatedly completed the
visible flow, but deletion was unsuccessful.

Observed states during the attempts:

- Earlier attempts appeared to do nothing after password entry.
- A later attempt briefly displayed a new message, but it disappeared before
  the user could read it.
- The most recent user report is: deletion is still unsuccessful.
- No exact server/provider cleanup response, HTTP status, or diagnostics have
  been captured from a completed failing deletion request.
- Prior to UI diagnostic changes, provider containers remained `Up` and no
  cleanup entry was found in the managed OpenCode log. The managed OpenCode log
  is not necessarily the log source for the OpenChamber cleanup route.

The cleanup route is implemented in
`packages/web/server/lib/workspaces/routes.js`. Its order is:

1. Load the authoritative OpenCode workspace record.
2. Resolve persisted workspace context and provider operations.
3. Verify authoritative workspace identity.
4. Call provider `operations.cleanupWorkspace(workspace)`.
5. If the provider result is incomplete, return HTTP 409 with
   `Workspace provider cleanup is incomplete` and any remaining resources.
6. If provider cleanup succeeds, remove the OpenCode workspace record through
   `experimental.workspace.remove`.

The route catches failures and returns JSON with `cleaned: false`, `retryable:
true`, a safe error message, and any `remainingResources` provided by the
error. The exact branch reached in the failing functional run is unknown.

## Changes Made During This Work

These files have been modified during this work. There may also be unrelated
pre-existing modifications in the repository; do not revert them.

### Managed OpenCode Runtime

- `packages/web/server/index.js`
  - Adds profile-local `XDG_DATA_HOME` to the managed OpenCode child only when
    `OPENCHAMBER_DATA_DIR` is supplied.
  - Does not set `XDG_CONFIG_HOME`, preserving the shared OpenCode plugin
    configuration.
- `packages/web/server/lib/opencode/lifecycle.test.js`
  - Adds regression coverage for the managed OpenCode spawn environment.
- `packages/web/server/lib/opencode/DOCUMENTATION.md`
  - Documents the profile-local-data/shared-config arrangement.

### Workspace Lifecycle UI

- `packages/ui/src/components/workspaces/WorkspaceLifecycleView.tsx`
  - Adds generation/directory scope guards for stale asynchronous workspace
    list and status failures.
  - Closes the delete confirmation dialog before showing a failed cleanup
    result or thrown cleanup error, instead of allowing the confirmation dialog
    to obscure the error.
  - When workspace reauthentication resolves without a proof, closes the
    delete confirmation dialog and shows the existing localized reauthentication
    failure message.
  - Stops background `loadWorkspaces` refreshes from clearing `workspaceError`.
    This was identified after the user observed a deletion failure message flash
    and disappear: a non-status workspace event calls `loadWorkspaces(false)`,
    and that function had cleared `workspaceError` immediately.

No new user-facing localization strings were added for the latest UI changes.

## Validation Completed

The following commands passed after the relevant changes:

- `bun run --cwd packages/web test -- server/lib/opencode/lifecycle.test.js`
  - 15 passed.
- `node --check packages/web/server/index.js`
- `bun run type-check:web`
- `bun run lint:web`
- `bun run --cwd packages/ui type-check`
- `bun run --cwd packages/ui lint`
- `bun test packages/ui/src/components/workspaces/workspaceSurfaceState.test.ts`
  - 6 passed.
- `bun run electron:build`
  - Final build completed successfully after closing four packaged Electron
    processes that held files in `win-unpacked` open.
  - Packaging emitted existing Vite chunk-size/dynamic-import warnings and
    missing optional platform dependency notices, but completed successfully.

Runtime limitations of the validation:

- No automated browser/Electron test exercises the full reauthentication and
  provider-cleanup interaction.
- The final packaged app was relaunched after the last UI change, but the user
  reported deletion still unsuccessful before an exact error could be captured.
- The full message/export/apply lifecycle has not been completed.

## Useful Source Locations

- `packages/ui/src/components/workspaces/WorkspaceLifecycleView.tsx`
  - Workspace lifecycle UI, deletion confirmation, reauthentication dialog,
    errors, status refreshes, and session event subscription.
- `packages/ui/src/components/workspaces/workspaceSurfaceState.ts`
  - Workspace scope/status state helpers and capability mapping.
- `packages/ui/src/components/workspaces/DOCUMENTATION.md`
  - Ownership and runtime-scope invariants for this UI surface.
- `packages/ui/src/components/sections/openchamber/SecureWorkspacesSettings.tsx`
  - Secure Workspace policy configuration and activation UI.
- `packages/web/src/api/workspaces.ts`
  - Browser runtime API transport for workspace operations and reauthentication.
- `packages/web/src/api/reauth.ts`
  - Browser reauthentication proof request implementation.
- `packages/web/server/lib/workspaces/routes.js`
  - OpenChamber workspace API routes including cleanup.
- `packages/web/server/lib/workspaces/policy.js`
  - Maps `secureWorkspacesModelAuth` into provider policy.
- `packages/electron/resources/opencode-container-workspace/src/operations.js`
  - Plugin `cleanupWorkspace()` delegation.
- `packages/electron/resources/opencode-container-workspace/src/providers/docker.js`
  - Docker provider ownership/removal behavior.
- `packages/electron/resources/opencode-container-workspace/src/process.js`
  - Docker command process/timeout behavior.
- `packages/web/server/index.js`
  - Managed OpenCode child process environment.

## Runtime Evidence Locations

- Managed OpenCode log:
  `%TEMP%\openchamber-functional-profile\opencode-data\opencode\log\opencode.log`
- Functional profile root:
  `%TEMP%\openchamber-functional-profile`
- Functional project root:
  `%TEMP%\openchamber-functional-project`
- Current packaged executable:
  `%USERPROFILE%\projects\openchamber\packages\electron\dist\win-unpacked\OpenChamber.exe`

## State At Pause

- The latest `win-unpacked` package has been built successfully and launched
  with the functional profile.
- The Docker workspace record remains visible in the lifecycle UI.
- The user reports that deletion still does not complete.
- The existing workspace displays policy-fingerprint mismatch and unknown
  status.
- No manual Docker cleanup was performed.
- No exact cleanup error is currently available.
- No next implementation approach is selected in this handoff.
