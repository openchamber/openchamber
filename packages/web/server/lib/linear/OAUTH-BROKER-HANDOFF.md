# Linear OAuth broker hand-off

## Required Linear application change

Register this exact redirect URI in the Linear OAuth application used by the
baked-in client ID:

`https://api.openchamber.dev/v1/oauth/linear/callback`

Linear compares the full redirect URI, including scheme, host, path, and port.
Deploy the API broker and apply its D1 migration before testing this branch.

## Why the original callback failed

The first implementation redirected Linear back to the OpenChamber server:

`http://127.0.0.1:<listen-port>/linear/oauth/callback`

That address is not stable across OpenChamber runtimes:

- packaged desktop prefers its stored local port and can select another free
  port when needed;
- local development and the CLI use different ports;
- self-hosted servers may sit behind a reverse proxy or have no public inbound
  address at all.

Linear requires an exact pre-registered callback. Registering every possible
desktop or self-hosted address is impossible, and forcing desktop onto one port
would make startup fail whenever another process owns that port.

## New flow

The built-in Linear client now uses the stable callback broker in
`openchamber-website/apps/api`:

1. The OpenChamber server generates OAuth state, a PKCE verifier, and a separate
   claim secret.
2. The broker stores only hashes of state and the claim secret for ten minutes.
3. Linear sends its authorization code to the stable public callback.
4. The OpenChamber server polls the broker with state and the claim secret.
5. The OpenChamber server exchanges the code using the PKCE verifier and stores
   the Linear tokens locally.
6. After persistence succeeds, OpenChamber acknowledges the hand-off and the
   broker marks it consumed.

The broker never receives the PKCE verifier, access token, or refresh token.
Private Relay is not involved; the local server only needs outbound HTTPS.

## Compatibility and configuration

- `OPENCHAMBER_LINEAR_BROKER_URL` or `settings.json` `linearBrokerUrl` selects a
  self-hosted broker. The default is
  `https://api.openchamber.dev/v1/oauth/linear`.
- `OPENCHAMBER_LINEAR_REDIRECT_URI` or `settings.json` `linearRedirectUri`
  bypasses the broker and preserves the direct callback flow for a custom
  Linear OAuth application.

## Owning files

OpenChamber:

- `auth.js`: broker and redirect configuration.
- `oauth.js`: PKCE, broker registration/poll/acknowledgement, token exchange.
- `routes.js`: starts authorization and completes broker results during status
  polling.

Hosted API, in the `openchamber-website` repository:

- `apps/api/src/routes/linear-oauth.ts`
- `apps/api/migrations/0010_linear_oauth_transactions.sql`
- `apps/api/LINEAR-OAUTH.md`

## Validation

OpenChamber focused tests:

```sh
bunx vitest run \
  packages/web/server/lib/linear/oauth.test.js \
  packages/web/server/lib/linear/auth.test.js \
  packages/web/server/lib/linear/routes.test.js
```

Hosted API checks:

```sh
cd apps/api
bun test src/routes/linear-oauth.test.ts
bun run check
bun run build
```
