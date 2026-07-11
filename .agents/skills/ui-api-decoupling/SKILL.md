---
name: ui-api-decoupling
description: Use when creating or modifying OpenChamber UI data access, RuntimeAPIs, runtimeFetch/runtime-url auth, authenticated browser assets, OpenCode SDK calls, VS Code bridges, Electron runtime switching, or web server API endpoints.
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
| Browser/realtime URL that cannot send headers (iframe, download/open link, SSE, WebSocket, preview subresource) | `getRuntimeUrlResolver()` helpers plus `oc_url_token` allowlist, not hardcoded URLs |
| UI-controlled authenticated asset fetch (small icons/thumbnails where JS can fetch) | `runtimeFetch` with `Authorization`, then `URL.createObjectURL(blob)` |

## Mandatory Rules

1. **Never bypass the SDK for official OpenCode APIs**
   - Do not add raw `fetch` or direct `runtimeFetch` from feature UI to official endpoints such as `/api/session`, `/api/permission`, `/api/question`, `/api/auth`, `/api/provider`, `/api/command`, `/api/app`.
   - Use `opencodeClient` wrappers or `opencodeClient.getSdkClient()`.
   - If the SDK lacks a method, add a narrow wrapper in `client/ui/src/lib/opencode/client.ts`, mark it as an SDK gap, and add transport coverage when body/method/query/signal matters.

2. **Preserve SDK request fidelity**
   - Runtime transport must preserve `Request` method, body, headers, query string, auth, and abort signal.
   - Do not rebuild a request from only `url` and `init`.
   - Regression tests belong near `client/ui/src/lib/runtime-fetch.test.ts`, `packages/vscode/webview/api/bridge.test.ts`, and proxy tests when transport changes.

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
   - HTTP auth is owned by `runtime-auth` and `runtimeFetch`; callers pass route paths and let transport attach `Authorization` only for the active runtime service URL.
   - Browser/realtime transports that cannot set headers use `runtime-url` helpers and short-lived `oc_url_token` query auth.
   - Never put long-lived client bearer tokens in URLs. `oc_client_token` should appear only in legacy stripping/rejection paths, tests, or migration compatibility code.
   - Do not manually append `oc_url_token`; use resolver helpers and add server-side allowlist coverage when a new browser-consumed route needs URL auth.

7. **Runtime switch must reset stale state**
   - Runtime base URL, runtime key, bearer token, SDK clients, terminal transports, session memory, and UI runtime-scoped state must not be cached blindly.
   - Use `switchRuntimeEndpoint`, `subscribeRuntimeEndpointChanged`, `opencodeClient.reconnectToRuntimeBaseUrl()`, and runtime-keyed store state.

8. **Authoritative fetches must signal failure**
   - If a caller uses returned data to replace, delete, or clear authoritative state, the method must throw or return `null` on failure.
   - Do not swallow errors and return `[]`, `{}`, or `null` when that value is also a valid empty success unless the caller treats it as display-only.

9. **Privileged runtime switching requires explicit user intent**
   - Electron connect/deep-link flows that import a remote host, store a client token, change default host, or switch active runtime must show an in-app confirmation before writing config or switching.
   - The confirmation may show the label and server URL, but never the token.
   - Existing-host imports still require confirmation because they can overwrite the stored token or change the active runtime.

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
const rawImageSrc = getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path });
const iframeSrc = getRuntimeUrlResolver().authenticatedAsset(proxyPath);
const eventUrl = getRuntimeUrlResolver().sse('/api/event');
const socketUrl = getRuntimeUrlResolver().websocket('/api/terminal/ws');
```

Plain `fetch` is acceptable only for intentional external network requests that do not target the OpenChamber runtime, such as npm registry, models.dev, or a user-provided `https://...` URL.

## Authenticated Browser Assets

Authenticated assets need an explicit transport choice. Pick based on who owns the request:

| Asset/request shape | Correct pattern |
|---------------------|-----------------|
| React/UI code can fetch it and the object is small (project icons, small thumbnails, generated previews) | `runtimeFetch('/api/...')` with `Authorization`, read `blob()`, render a `URL.createObjectURL(blob)` |
| Browser must own the URL (iframe `src`, image/download/open-link for large raw files, rewritten preview subresources) | `getRuntimeUrlResolver().authenticatedAsset(...)` so the URL carries short-lived `oc_url_token` |
| Realtime transports | `getRuntimeUrlResolver().sse(...)` or `.websocket(...)`; never generic fetch/proxy paths |

For object-URL assets:
- Key caches by runtime identity (`getRuntimeApiBaseUrl()` or runtime key), entity ID, version/update timestamp, and render-affecting options.
- Cap caches and revoke evicted object URLs with `URL.revokeObjectURL`.
- Render a deterministic fallback while loading or after failure; do not leave empty chrome.
- Keep the fetch display-only unless the caller intentionally treats failure as authoritative.

For URL-auth assets:
- The server route must explicitly allow `oc_url_token` in `backend/server/lib/ui-auth/ui-auth.js` and have coverage in `ui-auth.test.js`.
- Scope allowlists narrowly to browser-readable GET routes or specific realtime upgrade paths. Do not allow arbitrary `/api/*`.
- Use short-lived `oc_url_token` only. Do not revive `oc_client_token` in query strings.

Preview iframe/subresource rules:
- Use preview proxy helpers so `oc_preview_token` and `oc_url_token` propagate to rewritten resources and redirects.
- Strip legacy `oc_client_token` before forwarding to dev servers.
- Do not use `postMessage('*')`; target the known preview origin.
- Preserve CSP where possible. If injecting a bridge, prefer a per-response nonce and remove only directives that block framing or the bridge.

## Runtime API Extension Pattern

When adding a native/per-runtime capability:

1. Add or extend the interface in `client/ui/src/lib/api/types.ts`.
2. Implement web HTTP behavior in `client/web/src/api/*` and compose it in `client/web/src/api/index.ts`.
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
- `__OPENCHAMBER_CLIENT_TOKEN__`, `__OPENCHAMBER_HOME__`, and privileged desktop IPC are local-page gated.
- Do not expose filesystem, shell, or host secrets to remote pages for UI convenience.
- Do not trust arbitrary loopback, `file://`, or `about:blank` origins as local UI. Gate privileged preload/IPC/token access to the packaged UI origin and exact runtime origins.
- Deep-links that add or switch remote runtimes are trust-boundary changes. Confirm before storing tokens or switching hosts.

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
| Manually appending `oc_client_token` or `oc_url_token` | `runtimeFetch` for HTTP, resolver helpers for browser/realtime URLs |
| Direct `<img src>` to a small authenticated app asset | `runtimeFetch` + `blob()` + object URL with fallback and bounded cache |
| Adding URL-auth access to a route without server allowlist tests | Narrow `oc_url_token` allowlist in `ui-auth.js` plus `ui-auth.test.js` coverage |
| Connect deep-link writes host config before consent | Confirm first, then import/switch |

## Verification Checklist

Before finalizing a UI/API decoupling change:

1. Official OpenCode routes use SDK wrappers or documented SDK-gap helpers.
2. OpenChamber routes are registered before the generic proxy.
3. VS Code has parity, proxy fallback, or explicit unsupported behavior.
4. Runtime transport preserves body, method, headers, query, auth, and abort signal.
5. Runtime auth/token handling uses `runtime-auth` and `runtime-url`.
6. No long-lived client bearer token is placed in a URL; browser/realtime URL auth uses scoped short-lived `oc_url_token` only.
7. Browser-consumed routes that need `oc_url_token` have narrow server allowlist and tests.
8. Runtime switch clears or scopes affected client/store/object-URL state.
9. Authoritative loaders distinguish failure from empty success.
10. Targeted tests cover changed transport, bridge, proxy, auth allowlist, or runtime API behavior.

## Implementation Map

### Shared UI Sources Of Truth

`client/ui/src/lib/opencode/client.ts` is the central OpenCode SDK wrapper. It creates `@opencode-ai/sdk/v2` clients with `fetch: runtimeFetch`, runtime auth headers, current-directory handling, scoped clients, and convenience wrappers. Add official OpenCode API behavior here unless a feature directly consumes `getSdkClient()` in sync/runtime code.

`client/ui/src/lib/runtime-fetch.ts` rewrites `/api`, `/auth`, and `/health` through the active runtime URL resolver and injects runtime auth. Its key contract is preserving SDK-created `Request` objects, including method, body, headers, query, and signal. For ordinary HTTP calls, pass route paths directly to `runtimeFetch`; do not pre-resolve them with `getRuntimeUrlResolver()` first.

`client/ui/src/lib/runtime-url.ts` owns HTTP, auth, health, raw-file, SSE, WebSocket, and authenticated browser URL construction. `getRuntimeUrlResolver()` is the call-time source for browser-consumed URLs like iframe `src`, large/raw image `src`, download/open links, SSE URLs, and WebSocket URLs. `runtimeUrl` is not safe for new code that must survive runtime switches.

`client/ui/src/lib/runtime-auth.ts` owns bearer-token state and short-lived URL-token minting. `runtimeFetch` merges `Authorization` unless a caller already supplied one. Runtime URL helpers add scoped `oc_url_token` where headers are impossible; they must never expose long-lived client bearer tokens in URLs.

### Runtime API Contract

`client/ui/src/lib/api/types.ts` defines `RuntimeAPIs` and all per-runtime capability contracts.

`client/ui/src/contexts/RuntimeAPIProvider.tsx` provides APIs to React and wraps `files` with a content cache that invalidates on write, delete, and rename.

`client/ui/src/hooks/useRuntimeAPIs.ts` is the React consumption path. `client/ui/src/contexts/runtimeAPIRegistry.ts` is the non-React escape hatch for modules that cannot use hooks.

`client/ui/src/App.tsx` and app variants register APIs and reset runtime-scoped stores on `openchamber:runtime-endpoint-changed`.

### Web Runtime

`client/web/src/runtimeConfig.ts` reads injected globals, configures the runtime URL resolver, sets the runtime bearer token, installs the runtime fetch bridge, and creates web APIs.

`client/web/src/main.tsx`, `mobile-main.tsx`, and `mini-chat-main.tsx` assign `window.__OPENCHAMBER_RUNTIME_APIS__` before rendering shared UI.

`client/web/src/api/index.ts` composes web `RuntimeAPIs` from implementations such as `files.ts`, `git.ts`, `terminal.ts`, `settings.ts`, `permissions.ts`, `github.ts`, `clientAuth.ts`, `push.ts`, and `tools.ts`.

Web runtime API implementations are normally HTTP clients for OpenChamber-owned server routes. Use `runtimeFetch` for HTTP requests; use `getRuntimeUrlResolver()` only when producing browser/realtime URLs that will not be immediately fetched by code.

### Server Routes And Proxy

`backend/server/index.js` starts the OpenChamber web server. Electron imports this server in-process.

`backend/server/lib/opencode/core-routes.js` installs JSON parsing for OpenChamber-owned `/api/*` route families.

`backend/server/lib/opencode/feature-routes-runtime.js` registers OpenChamber feature routes before the generic OpenCode proxy: filesystem, git, GitHub, quota, config entities, skills/plugins, magic prompts, session folders, scheduled tasks, and related features.

`backend/server/lib/opencode/proxy.js` is the generic `/api/*` proxy to upstream OpenCode. It strips the `/api` prefix, injects OpenCode auth headers, replays parsed bodies for non-GET requests, handles `/api/event` and `/api/global/event` as SSE, applies readiness gating, and canonicalizes directory query parameters.

OpenChamber-owned routes must be explicit and registered before the proxy. If a route is shared UI contract, add VS Code parity or a deterministic unsupported response.

If an OpenChamber route is consumed directly by the browser with `oc_url_token`, update the readable/realtime allowlist in `backend/server/lib/ui-auth/ui-auth.js` and add tests in `ui-auth.test.js`. Do not use URL tokens as a blanket `/api/*` auth bypass.

### VS Code Runtime

`packages/vscode/webview/api/index.ts` composes VS Code `RuntimeAPIs`. Terminal is a stub; files, git, settings, permissions, notifications, GitHub, tools, editor, and VS Code actions use the bridge.

`packages/vscode/webview/main.tsx` installs `window.__OPENCHAMBER_RUNTIME_APIS__` and overrides `window.fetch`. It handles OpenChamber local routes, then proxies generic OpenCode `/api/*` calls to the extension host. It has special branches for SSE and session message POST.

`packages/vscode/webview/requestBodyTransport.ts` extracts request bodies from SDK-style `Request` objects and `init.body` without losing bytes.

`packages/vscode/webview/api/bridge.ts` sends bridge messages, supports abort propagation, exposes `proxyApiRequest`, `proxySessionMessageRequest`, and SSE start/stop helpers.

`packages/vscode/src/bridge-proxy-runtime.ts` forwards generic OpenCode proxy requests to the live OpenCode API URL, merges sanitized headers with OpenCode auth, forwards body bytes, and rejects SSE through the generic proxy.

`packages/vscode/src/bridge-config-runtime.ts`, `bridge-fs-runtime.ts`, `bridge-git-runtime.ts`, and related bridge modules implement OpenChamber-owned route behavior in the extension host.

### Electron Runtime

`packages/electron/main.mjs` starts the web server in-process, resolves local/remote runtime target, tracks `apiBaseUrl` and `clientToken`, injects init scripts, confirms remote connect deep-links before storing tokens, and handles host switching.

`packages/electron/preload.mjs` exposes runtime globals. API base and local origin are broadly available for routing. Client token, home directory, and privileged desktop IPC stay local-page gated so remote pages cannot access local host capabilities.

Shared UI should not branch on Electron for backend behavior. Prefer web runtime APIs and the `__OPENCHAMBER_DESKTOP__` bridge only for shell capabilities that already exist in the shared runtime contract.

### Runtime Switch Flow

`client/ui/src/lib/runtime-switch.ts` updates `__OPENCHAMBER_API_BASE_URL__`, `__OPENCHAMBER_CLIENT_TOKEN__`, runtime URL resolver, bearer token, and dispatches `openchamber:runtime-endpoint-changed`.

`client/ui/src/App.tsx` reacts by preparing/restoring runtime-keyed session and UI state, reconnecting `opencodeClient`, clearing provider/agent connection state, disposing terminal transports, resetting streaming state, and triggering re-bootstrap.

Any cache keyed only by session ID, directory, or URL should be reviewed when runtime switching is involved. Use runtime keys when local and remote instances can share IDs or paths.

### Tests To Prefer

Use targeted transport/auth tests when changing request forwarding or URL auth: `client/ui/src/lib/runtime-fetch.test.ts`, `client/ui/src/lib/runtime-url.test.ts`, `client/ui/src/lib/runtime-auth.test.ts`, `backend/server/lib/ui-auth/ui-auth.test.js`, `packages/vscode/webview/api/bridge.test.ts`, `packages/vscode/src/bridge-proxy-runtime.test.js`, `backend/server/opencode-proxy.test.js`, and `backend/server/lib/preview/proxy-runtime.test.js`.

Use runtime API tests near the implementation when adding or changing per-runtime behavior, for example web API tests under `client/web/src/api/*.test.ts`, VS Code bridge tests under `packages/vscode/src/*test.js`, and UI wrapper tests under `client/ui/src/lib/*test.ts`.

Run `bun run type-check` and `bun run lint` before finalizing code changes unless the user explicitly narrows validation.

## References

- SDK wrapper: `client/ui/src/lib/opencode/client.ts`
- Runtime fetch/auth/url: `client/ui/src/lib/runtime-fetch.ts`, `runtime-auth.ts`, `runtime-url.ts`
- Runtime API contract: `client/ui/src/lib/api/types.ts`
- Web API composition: `client/web/src/api/index.ts`, `client/web/src/runtimeConfig.ts`
- VS Code bridge/proxy: `packages/vscode/webview/main.tsx`, `packages/vscode/webview/api/bridge.ts`, `packages/vscode/src/bridge-proxy-runtime.ts`
- Server proxy: `backend/server/lib/opencode/proxy.js`, `backend/server/lib/opencode/core-routes.js`
- UI auth and URL-token allowlists: `backend/server/lib/ui-auth/ui-auth.js`
- Preview proxy and rewritten browser subresources: `backend/server/lib/preview/proxy-runtime.js`
