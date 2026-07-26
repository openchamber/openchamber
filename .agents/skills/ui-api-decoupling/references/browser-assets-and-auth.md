# Browser Assets And URL Authentication

## Choose By Request Owner

| Request shape | Correct path |
|---|---|
| UI can fetch a small authenticated asset | `runtimeFetch`, read `blob()`, render an object URL |
| Browser must own a URL (`iframe`, download/open link, large/raw image, rewritten subresource) | `getRuntimeUrlResolver().authenticatedAsset(...)` |
| SSE | `getRuntimeUrlResolver().sse(...)` and owning transport |
| WebSocket | `getRuntimeUrlResolver().websocket(...)` plus `openRuntimeWebSocket` where required |

Do not prebuild a browser URL and then immediately call `runtimeFetch` with it. Ordinary HTTP callers pass route paths to `runtimeFetch`; browser/realtime consumers use resolver URLs.

## Object URLs

- Key caches by runtime identity, entity ID, update/version, and render options.
- Bound caches by count and bytes when values can be large.
- Revoke evicted object URLs with `URL.revokeObjectURL`.
- Render a deterministic fallback while loading or after display-only failure.

## URL Tokens

Browser-owned URLs cannot attach the normal `Authorization` header. Use short-lived scoped `oc_url_token` minted through runtime auth helpers.

- Never manually append `oc_url_token`.
- Never place a long-lived client bearer token in a URL.
- Treat `oc_client_token` query use as legacy stripping/rejection only.
- Add browser-readable GET or realtime paths to the narrow allowlist in `packages/web/server/lib/ui-auth/ui-auth.js`.
- Add allowlist tests; never allow arbitrary `/api/*` URL-token access.

## Preview Iframes And Rewritten Resources

- Use preview proxy helpers so preview and URL tokens propagate to rewritten resources and redirects.
- Strip legacy client-token query parameters before forwarding upstream.
- Do not use `postMessage('*')`; target the known preview origin.
- Preserve CSP where possible. If injecting a bridge, prefer a per-response nonce and remove only directives that block framing or the bridge.
- Re-resolve browser URLs after runtime switches; do not retain URLs minted for an old runtime.

## Security Tests

Prefer focused coverage in:

- `packages/ui/src/lib/runtime-url.test.ts`
- `packages/ui/src/lib/runtime-auth.test.ts`
- `packages/web/server/lib/ui-auth/ui-auth.test.js`
- `packages/web/server/lib/preview/proxy-runtime.test.js`
