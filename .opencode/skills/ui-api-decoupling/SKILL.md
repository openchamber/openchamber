---
name: ui-api-decoupling
description: Use when creating or modifying OpenChamber UI data access, RuntimeAPIs, runtimeFetch, OpenCode SDK calls, VS Code bridge/proxy routes, Electron runtime switching, or web server API endpoints.
license: MIT
compatibility: opencode
---

## Overview

OpenChamber shared UI runs against web, Electron desktop, remote server URLs, and VS Code webviews. API code must preserve that runtime boundary.

**Core principle:** official OpenCode API calls go through `@opencode-ai/sdk/v2` via `opencodeClient`; OpenChamber-owned capabilities go through `RuntimeAPIs` or explicit OpenChamber routes; runtime transport preserves SDK-generated requests exactly.

## Scope

Use this skill for changes touching UI data loading, session/message operations, provider/auth/config calls, filesystem/git/terminal/settings APIs, runtime switching, desktop/VS Code bridges, or server routes under `/api/*`.

Do not use this skill for pure visual-only UI work unless the change adds, removes, or reshapes data access.

## First Step

Before editing, classify every endpoint or capability involved:

| Need | Correct path |
|------|--------------|
| Official OpenCode endpoint | `opencodeClient` or `opencodeClient.getSdkClient()` |
| SDK gap to official OpenCode | Central helper in `opencodeClient` using `runtimeFetch`, documented as SDK gap |
| OpenChamber-owned feature route | `RuntimeAPIs` first, otherwise `runtimeFetch` to explicit OC route |
| Native/runtime capability | Extend `RuntimeAPIs`, implement per runtime, consume via hook/registry |
| Browser-consumed URL (iframe/img/download), SSE, or WebSocket | `getRuntimeUrlResolver()` helpers, not hardcoded URLs |

## Mandatory Rules

1. **Never bypass the SDK for official OpenCode APIs**
   - Do not add raw `fetch` or direct `runtimeFetch` from feature UI to official endpoints such as `/api/session`, `/api/permission`, `/api/question`, `/api/auth`, `/api/provider`, `/api/command`, `/api/app`.
   - Use `opencodeClient` wrappers or `opencodeClient.getSdkClient()`.
   - If the SDK lacks a method, add a narrow wrapper in `packages/ui/src/lib/opencode/client.ts`, mark it as an SDK gap, and add transport coverage when body/method/query/signal matters.

2. **Preserve SDK request fidelity**
   - Runtime transport must preserve `Request` method, body, headers, query string, auth, and abort signal.
   - Do not rebuild a request from only `url` and `init`.
   - Regression tests belong near `packages/ui/src/lib/runtime-fetch.test.ts`, `packages/vscode/webview/api/bridge.test.ts`, and proxy tests when transport changes.

3. **Use `RuntimeAPIs` for runtime-owned capabilities**
   - Files, git, terminal, settings, notifications, GitHub helpers, client auth, editor/VS Code actions, and tools belong in `RuntimeAPIs` when shared UI needs runtime-specific behavior.
   - React components use `useRuntimeAPIs()` or `useRuntimeAPI()`.
   - Non-React modules use `getRegisteredRuntimeAPIs()` only when a hook cannot be used.
   - Direct `window.__OPENCHAMBER_RUNTIME_APIS__` reads are entrypoint/legacy escape hatches, not a new feature pattern.

4. **Keep OpenChamber routes explicit**
   - Direct `runtimeFetch` is acceptable for OpenChamber-only routes such as `/api/config/settings`, `/api/config/skills`, `/api/config/commands`, `/api/fs`, `/api/git`, `/api/terminal`, `/api/preview`, `/api/magic-prompts`, `/api/tts`, and `/api/openchamber/tunnel`.
   - Register OpenChamber routes before the generic OpenCode proxy, or the proxy will steal the path.
   - Shared UI depending on an OC route requires web and VS Code parity, or an explicit deterministic unsupported response.

5. **Do not hardcode local runtime URLs**
   - Do not infer `localhost`, server ports, or `/api` origins in shared UI.
   - Use `getRuntimeUrlResolver()` at call time.
   - Do not use the exported `runtimeUrl` singleton for new code because it can capture stale resolver state.

6. **Treat runtime auth as transport state**
   - HTTP auth is owned by `runtime-auth` and `runtimeFetch`.
   - SSE/WebSocket/authenticated assets use `runtime-url` query token handling where headers are not viable.
   - Do not manually append `oc_client_token` outside resolver helpers.

7. **Runtime switch must reset stale state**
   - Runtime base URL, runtime key, bearer token, SDK clients, terminal transports, session memory, and UI runtime-scoped state must not be cached blindly.
   - Use `switchRuntimeEndpoint`, `subscribeRuntimeEndpointChanged`, `opencodeClient.reconnectToRuntimeBaseUrl()`, and runtime-keyed store state.

8. **Authoritative fetches must signal failure**
   - If a caller uses returned data to replace, delete, or clear authoritative state, the method must throw or return `null` on failure.
   - Do not swallow errors and return `[]`, `{}`, or `null` when that value is also a valid empty success unless the caller treats it as display-only.

## HTTP Request Decision Rules

For normal HTTP requests to the active OpenChamber runtime, use `runtimeFetch` with the route path. Let `runtimeFetch` resolve the current runtime base URL and auth at call time.

```ts
// Good: runtimeFetch owns base URL, runtime auth, and runtime switching.
await runtimeFetch('/health');
await runtimeFetch('/auth/session', { method: 'GET' });
await runtimeFetch('/api/config/settings');
await runtimeFetch('/api/fs/raw', { query: { path: absolutePath } });

// Bad: callers should not prebuild runtime HTTP URLs for fetches.
await fetch(getRuntimeUrlResolver().health());
await runtimeFetch(getRuntimeUrlResolver().api('/api/config/settings'));
await runtimeFetch(getRuntimeUrlResolver().rawFile(absolutePath));
```

Use `runtimeFetch(..., { query })` instead of manually appending query strings when the request targets `/api`, `/auth`, or `/health`.

```ts
// Good
await runtimeFetch('/api/git/status', { query: { directory, mode: 'light' } });

// Avoid
await runtimeFetch(`/api/git/status?directory=${encodeURIComponent(directory)}&mode=light`);
```

Use `getRuntimeUrlResolver()` only when the resulting URL is consumed by the browser or a realtime transport, not immediately fetched as HTTP:

```ts
// Good resolver usage: URL is assigned to browser/realtime consumers.
const imageSrc = getRuntimeUrlResolver().api('/api/fs/raw', { path });
const iframeSrc = getRuntimeUrlResolver().authenticatedAsset(proxyPath);
const eventUrl = getRuntimeUrlResolver().sse('/api/event');
const socketUrl = getRuntimeUrlResolver().websocket('/api/terminal/ws');
```

Plain `fetch` is acceptable only for intentional external network requests that do not target the OpenChamber runtime, such as npm registry, models.dev, or a user-provided `https://...` URL.

## Runtime API Extension Pattern

When adding a native/per-runtime capability:

1. Add or extend the interface in `packages/ui/src/lib/api/types.ts`.
2. Implement web HTTP behavior in `packages/web/src/api/*` and compose it in `packages/web/src/api/index.ts`.
3. Implement VS Code webview API in `packages/vscode/webview/api/*` and compose it in `packages/vscode/webview/api/index.ts`.
4. Add extension-host handlers in `packages/vscode/src/bridge-*-runtime.ts` when filesystem, git, settings, or OpenCode manager access is required.
5. Keep Electron shared through the web runtime unless it needs shell-only IPC in `packages/electron/main.mjs` or `packages/electron/preload.mjs`.
6. Register the runtime APIs through app entrypoints and consume through `RuntimeAPIProvider`.

## VS Code Route Parity

For any shared UI call to `/api/*`, decide the VS Code behavior explicitly:

| Route type | VS Code handling |
|------------|------------------|
| OpenChamber local route | Handle in `packages/vscode/webview/main.tsx` and bridge to extension host when needed |
| Official OpenCode route | Let generic fetch proxy forward to OpenCode via `api:proxy` |
| SSE route | Use `api:sse:start` / stream messages / `api:sse:stop`, never generic proxy |
| Session message POST | Use `api:session:message` special proxy path |
| Unsupported native feature | Return stable 501/unsupported JSON, not silent fallback |

## Electron Security Boundary

Electron exposes API base and shell identity broadly, but privileged local capabilities stay local-only.

- `__OPENCHAMBER_API_BASE_URL__` and `__OPENCHAMBER_LOCAL_ORIGIN__` route requests.
- `__OPENCHAMBER_CLIENT_TOKEN__`, `__OPENCHAMBER_HOME__`, and `__TAURI__`-style IPC are local-page gated.
- Do not expose filesystem, shell, or host secrets to remote pages for UI convenience.

## Common Anti-Patterns

| Anti-pattern | Use instead |
|--------------|-------------|
| `fetch('/api/session/...')` in shared UI | SDK through `opencodeClient` |
| `runtimeFetch('/api/session/...')` from a component | SDK wrapper or documented SDK-gap helper |
| `fetch(getRuntimeUrlResolver().health())` | `runtimeFetch('/health')` |
| `runtimeFetch(getRuntimeUrlResolver().api('/api/foo'))` | `runtimeFetch('/api/foo')` |
| `runtimeFetch(getRuntimeUrlResolver().rawFile(path))` | `runtimeFetch('/api/fs/raw', { query: { path } })` |
| New `/api/foo` only in web server | Web + VS Code route decision |
| Component reads `window.__OPENCHAMBER_RUNTIME_APIS__` | `useRuntimeAPIs()` / `useRuntimeAPI()` |
| Rebuilding `new Request(newUrl)` only | `new Request(newUrl, oldRequest)` plus merged headers |
| Returning `[]` on authoritative SDK failure | Throw or return `null` and preserve state |
| Caching `getRuntimeUrlResolver()` output forever | Read resolver/client at call time or reset on runtime switch |

## Verification Checklist

Before finalizing a UI/API decoupling change:

1. Official OpenCode routes use SDK wrappers or documented SDK-gap helpers.
2. OpenChamber routes are registered before the generic proxy.
3. VS Code has parity, proxy fallback, or explicit unsupported behavior.
4. Runtime transport preserves body, method, headers, query, auth, and abort signal.
5. Runtime auth/token handling uses `runtime-auth` and `runtime-url`.
6. Runtime switch clears or scopes affected client/store state.
7. Authoritative loaders distinguish failure from empty success.
8. Targeted tests cover changed transport, bridge, proxy, or runtime API behavior.

## Implementation Map

### Shared UI Sources Of Truth

`packages/ui/src/lib/opencode/client.ts` is the central OpenCode SDK wrapper. It creates `@opencode-ai/sdk/v2` clients with `fetch: runtimeFetch`, runtime auth headers, current-directory handling, scoped clients, and convenience wrappers. Add official OpenCode API behavior here unless a feature directly consumes `getSdkClient()` in sync/runtime code.

`packages/ui/src/lib/runtime-fetch.ts` rewrites `/api`, `/auth`, and `/health` through the active runtime URL resolver and injects runtime auth. Its key contract is preserving SDK-created `Request` objects, including method, body, headers, query, and signal. For ordinary HTTP calls, pass route paths directly to `runtimeFetch`; do not pre-resolve them with `getRuntimeUrlResolver()` first.

`packages/ui/src/lib/runtime-url.ts` owns HTTP, auth, health, raw-file, SSE, and WebSocket URL construction. `getRuntimeUrlResolver()` is the call-time source for browser-consumed URLs like iframe `src`, image `src`, download/open links, SSE URLs, and WebSocket URLs. `runtimeUrl` is not safe for new code that must survive runtime switches.

`packages/ui/src/lib/runtime-auth.ts` owns bearer-token state. `runtimeFetch` merges Authorization unless a caller already supplied one. Realtime URLs add `oc_client_token` through resolver helpers.

### Runtime API Contract

`packages/ui/src/lib/api/types.ts` defines `RuntimeAPIs` and all per-runtime capability contracts.

`packages/ui/src/contexts/RuntimeAPIProvider.tsx` provides APIs to React and wraps `files` with a content cache that invalidates on write, delete, and rename.

`packages/ui/src/hooks/useRuntimeAPIs.ts` is the React consumption path. `packages/ui/src/contexts/runtimeAPIRegistry.ts` is the non-React escape hatch for modules that cannot use hooks.

`packages/ui/src/App.tsx` and app variants register APIs and reset runtime-scoped stores on `openchamber:runtime-endpoint-changed`.

### Web Runtime

`packages/web/src/runtimeConfig.ts` reads injected globals, configures the runtime URL resolver, sets the runtime bearer token, installs the runtime fetch bridge, and creates web APIs.

`packages/web/src/main.tsx`, `mobile-main.tsx`, and `mini-chat-main.tsx` assign `window.__OPENCHAMBER_RUNTIME_APIS__` before rendering shared UI.

`packages/web/src/api/index.ts` composes web `RuntimeAPIs` from implementations such as `files.ts`, `git.ts`, `terminal.ts`, `settings.ts`, `permissions.ts`, `github.ts`, `clientAuth.ts`, `push.ts`, and `tools.ts`.

Web runtime API implementations are normally HTTP clients for OpenChamber-owned server routes. Use `runtimeFetch` for HTTP requests; use `getRuntimeUrlResolver()` only when producing browser/realtime URLs that will not be immediately fetched by code.

### Server Routes And Proxy

`packages/web/server/index.js` starts the OpenChamber web server. Electron imports this server in-process.

`packages/web/server/lib/opencode/core-routes.js` installs JSON parsing for OpenChamber-owned `/api/*` route families.

`packages/web/server/lib/opencode/feature-routes-runtime.js` registers OpenChamber feature routes before the generic OpenCode proxy: filesystem, git, GitHub, quota, config entities, skills/plugins, magic prompts, session folders, scheduled tasks, and related features.

`packages/web/server/lib/opencode/proxy.js` is the generic `/api/*` proxy to upstream OpenCode. It strips the `/api` prefix, injects OpenCode auth headers, replays parsed bodies for non-GET requests, handles `/api/event` and `/api/global/event` as SSE, applies readiness gating, and canonicalizes directory query parameters.

OpenChamber-owned routes must be explicit and registered before the proxy. If a route is shared UI contract, add VS Code parity or a deterministic unsupported response.

### VS Code Runtime

`packages/vscode/webview/api/index.ts` composes VS Code `RuntimeAPIs`. Terminal is a stub; files, git, settings, permissions, notifications, GitHub, tools, editor, and VS Code actions use the bridge.

`packages/vscode/webview/main.tsx` installs `window.__OPENCHAMBER_RUNTIME_APIS__` and overrides `window.fetch`. It handles OpenChamber local routes, then proxies generic OpenCode `/api/*` calls to the extension host. It has special branches for SSE and session message POST.

`packages/vscode/webview/requestBodyTransport.ts` extracts request bodies from SDK-style `Request` objects and `init.body` without losing bytes.

`packages/vscode/webview/api/bridge.ts` sends bridge messages, supports abort propagation, exposes `proxyApiRequest`, `proxySessionMessageRequest`, and SSE start/stop helpers.

`packages/vscode/src/bridge-proxy-runtime.ts` forwards generic OpenCode proxy requests to the live OpenCode API URL, merges sanitized headers with OpenCode auth, forwards body bytes, and rejects SSE through the generic proxy.

`packages/vscode/src/bridge-config-runtime.ts`, `bridge-fs-runtime.ts`, `bridge-git-runtime.ts`, and related bridge modules implement OpenChamber-owned route behavior in the extension host.

### Electron Runtime

`packages/electron/main.mjs` starts the web server in-process, resolves local/remote runtime target, tracks `apiBaseUrl` and `clientToken`, injects init scripts, and handles host switching.

`packages/electron/preload.mjs` exposes runtime globals. API base and local origin are broadly available for routing. Client token, home directory, and `__TAURI__` IPC stay local-page gated so remote pages cannot access local host capabilities.

Shared UI should not branch on Electron for backend behavior. Prefer web runtime APIs and the preload-provided `__TAURI__` compatibility shim only for shell capabilities that already exist in the shared runtime contract.

### Runtime Switch Flow

`packages/ui/src/lib/runtime-switch.ts` updates `__OPENCHAMBER_API_BASE_URL__`, `__OPENCHAMBER_CLIENT_TOKEN__`, runtime URL resolver, bearer token, and dispatches `openchamber:runtime-endpoint-changed`.

`packages/ui/src/App.tsx` reacts by preparing/restoring runtime-keyed session and UI state, reconnecting `opencodeClient`, clearing provider/agent connection state, disposing terminal transports, resetting streaming state, and triggering re-bootstrap.

Any cache keyed only by session ID, directory, or URL should be reviewed when runtime switching is involved. Use runtime keys when local and remote instances can share IDs or paths.

### Tests To Prefer

Use targeted transport tests when changing request forwarding: `packages/ui/src/lib/runtime-fetch.test.ts`, `packages/vscode/webview/api/bridge.test.ts`, `packages/vscode/src/bridge-proxy-runtime.test.js`, `packages/web/server/opencode-proxy.test.js`, and `packages/web/server/lib/preview/proxy-runtime.test.js`.

Use runtime API tests near the implementation when adding or changing per-runtime behavior, for example web API tests under `packages/web/src/api/*.test.ts`, VS Code bridge tests under `packages/vscode/src/*test.js`, and UI wrapper tests under `packages/ui/src/lib/*test.ts`.

Run `bun run type-check` and `bun run lint` before finalizing code changes unless the user explicitly narrows validation.

## References

- SDK wrapper: `packages/ui/src/lib/opencode/client.ts`
- Runtime fetch/auth/url: `packages/ui/src/lib/runtime-fetch.ts`, `runtime-auth.ts`, `runtime-url.ts`
- Runtime API contract: `packages/ui/src/lib/api/types.ts`
- Web API composition: `packages/web/src/api/index.ts`, `packages/web/src/runtimeConfig.ts`
- VS Code bridge/proxy: `packages/vscode/webview/main.tsx`, `packages/vscode/webview/api/bridge.ts`, `packages/vscode/src/bridge-proxy-runtime.ts`
- Server proxy: `packages/web/server/lib/opencode/proxy.js`, `packages/web/server/lib/opencode/core-routes.js`
