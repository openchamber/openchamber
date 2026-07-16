# Runtime Implementation Map

## Shared UI

- `packages/ui/src/lib/opencode/client.ts`: OpenCode v2 SDK wrapper, current-directory handling, runtime-aware SDK client.
- `packages/ui/src/lib/runtime-fetch.ts`: runtime HTTP URL resolution and auth while preserving SDK `Request` fidelity.
- `packages/ui/src/lib/runtime-url.ts`: browser/realtime URL construction.
- `packages/ui/src/lib/runtime-auth.ts`: bearer state and short-lived URL-token minting.
- `packages/ui/src/lib/api/types.ts`: shared `RuntimeAPIs` contract.
- `packages/ui/src/contexts/RuntimeAPIProvider.tsx`: React provider and runtime API wrappers.
- `packages/ui/src/hooks/useRuntimeAPIs.ts`: React consumption path.

## Web And Server

- `packages/web/src/runtimeConfig.ts`: initializes runtime URL/auth and web APIs.
- `packages/web/src/api/index.ts`: composes web `RuntimeAPIs`.
- `packages/web/server/lib/opencode/core-routes.js`: installs OpenChamber route families.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: explicit feature route registration.
- `packages/web/server/lib/opencode/proxy.js`: generic OpenCode proxy fallback.
- `packages/web/server/lib/ui-auth/ui-auth.js`: session and URL-token route gates.

Explicit OpenChamber routes must register before the generic `/api/*` OpenCode proxy.

## VS Code

- `packages/vscode/webview/main.tsx`: webview fetch routing and local-route handling.
- `packages/vscode/webview/api/index.ts`: webview `RuntimeAPIs` composition.
- `packages/vscode/webview/api/bridge.ts`: request, session-message, and SSE bridge helpers.
- `packages/vscode/webview/requestBodyTransport.ts`: byte-preserving request-body extraction.
- `packages/vscode/src/bridge-proxy-runtime.ts`: extension-host OpenCode forwarding.
- `packages/vscode/src/bridge-*-runtime.ts`: owning native/local handlers.

## Runtime Switching

`packages/ui/src/lib/runtime-switch.ts` updates endpoint/auth state and emits the runtime-change event. App roots reconnect SDK clients and reset runtime-scoped stores/transports.

Review every cache keyed only by session ID, directory, URL, or entity ID. Add runtime identity when local and remote runtimes can collide.

## Tests To Prefer

- HTTP/request fidelity: `packages/ui/src/lib/runtime-fetch.test.ts`
- URL/auth: `packages/ui/src/lib/runtime-url.test.ts`, `runtime-auth.test.ts`
- Server auth: `packages/web/server/lib/ui-auth/ui-auth.test.js`
- Generic proxy: `packages/web/server/opencode-proxy.test.js`
- Preview proxy: `packages/web/server/lib/preview/proxy-runtime.test.js`
- VS Code bridge: `packages/vscode/webview/api/bridge.test.ts`
- VS Code proxy: `packages/vscode/src/bridge-proxy-runtime.test.js`

Also run focused tests beside new runtime implementations and validation required by each affected workspace.
