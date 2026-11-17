# UI Auth Module Documentation

## Purpose
This module owns OpenChamber UI authentication for browser access, including password session auth, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

## Entrypoints and structure
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/server/lib/ui-auth/session-cookie.ts`: resolves the session cookie name from a request's `Host` port; shared by session issuance and validation in `ui-auth.js` and notification/session identity extraction in `packages/web/server/lib/security/request-security.js`. Source imports retain the `.js` specifier.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation. Revoking also stops the device's push notifications (`../notifications/DOCUMENTATION.md`, *Revoked and expired clients*).
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Invariants

- Password and passkey sign-in share one attempt budget per trusted-proxy
  resolved client IP. Reading X-Forwarded-For directly would let an attacker
  choose a new bucket for each attempt. Only rejected passkey assertions spend
  that budget; failures after accepted authentication do not.
- Explicit bearer authentication decides session status on its own. Falling
  back to an ambient session cookie would hide a revoked native-client token
  while bearer-only API requests fail.
- An empty passkey label restores its registration-time generated name, so
  clearing a custom name does not erase the device's identifiable label.

## Session cookie scoping
Browsers key a cookie jar on the host only, never the port (RFC 6265). Two OpenChamber instances reached through the same hostname on different ports therefore shared a single `oc_ui_session` cookie. Logging into the second overwrote the first instance's session cookie (issue #2377). This affects LAN and loopback hosts alike.

`sessionCookieNameForRequest(req, base)` folds the request `Host` port into the cookie name: `oc_ui_session_<port>` when the host carries an explicit port (including a port from `x-forwarded-host`), or the bare `oc_ui_session` when it does not. `localhost:3000` and `localhost:3001` use separate names, just like two ports on one LAN address. Password and browser passkey login both call `issueSession` and receive this cookie. Session validation, clearing, and notification identity extraction use the same resolver; identity extraction does not provide a CSRF token. Bearer-token validation is unchanged.

Compatibility: upgrading renames the cookie for any explicit-port host, so already-signed-in browser sessions must log in once again. No on-disk format changes.

## URL auth tokens
`POST /auth/url-token` returns `{ token, expiresAt, expiresIn }`. `expiresAt` is on the server's clock; `expiresIn` is the remaining lifetime in milliseconds. The shared UI places the expiry on its own clock from `expiresIn` (`packages/ui/src/lib/runtime-auth.ts`), because a phone whose clock is a minute ahead of the server otherwise treats every fresh token as expired and opens the terminal and event sockets without one (issue #5614). `expiresAt` stays for clients older than `expiresIn`.

## Decisions

### Why authentication dependencies and password hashing wait for use

JOSE loads on the first session check and WebAuthn's large dependency tree loads
on the first passkey operation. Password hashing waits for the first sign-in
attempt because doing it during server creation blocks the embedding host's
main thread on every startup.

### Why the passkey and auth controllers remain JavaScript

The passkey store accepts every string transport and filters out only nonstrings.
WebAuthn option generation preserves those strings, including values outside
`@simplewebauthn/server`'s `AuthenticatorTransportFuture` union. Its registration,
authentication and credential-verification contracts require that narrower union.
Typing the stored transports as that union would misrepresent accepted files;
filtering them would change behavior. The library boundary must be resolved
before converting `ui-passkeys.js`.

The mixed-JavaScript checker infers `createUiPasskeys`'s options from its defaulted
properties and omits `passwordBinding` and `readSettingsFromDiskMigrated`.
Consequently `ui-auth.js` cannot convert independently without changing that
dependency's contract or adding a replacement declaration.

### Why cookie headers retain runtime string checks

`Host` and `x-forwarded-host` come from HTTP requests. `SessionCookieRequest`
accepts Node's header representation and permits a missing request or headers.
The string guard preserves the existing rejection of array-valued forwarded
hosts and the fallback to `Host`. No internal value needs a `typeof` check.

## Public exports (ui-auth.js)
- `readSessionTtlMs(raw, unitMs, fallbackMs)`: parses a positive session lifetime from an environment value, else the fallback. Defaults come from `OPENCHAMBER_UI_SESSION_TTL_HOURS` (12) and `OPENCHAMBER_UI_TRUSTED_SESSION_TTL_DAYS` (7, used when the user ticks "trust this device").
- `createUiAuth({ password, cookieName, sessionTtlMs, trustedSessionTtlMs, readSettingsFromDiskMigrated })`: creates UI auth controller with methods:
  - `enabled`
  - `requireAuth(req, res, next)`
  - `handleSessionStatus(req, res)`
  - `handleSessionCreate(req, res)`
  - `handlePasskeyStatus(req, res)`
  - `handlePasskeyRegistrationOptions(req, res)`
  - `handlePasskeyRegistrationVerify(req, res)`
  - `handlePasskeyAuthenticationOptions(req, res)`
  - `handlePasskeyAuthenticationVerify(req, res)`
  - `handlePasskeyList(req, res)`
  - `handlePasskeyRevoke(req, res)`
  - `handlePasskeyRename(req, res)`
  - `handleResetAuth(req, res)`
  - `ensureSessionToken(req, res)`
  - `dispose()`

## Public exports (ui-passkeys.js)
- `createUiPasskeys({ passwordBinding, readSettingsFromDiskMigrated, storeFile, rpName, challengeTtlMs })`: creates passkey runtime with methods:
  - `enabled`
  - `getStatus(req)`
  - `listPasskeys(req)`
  - `revokePasskey(req, passkeyId)`
  - `renamePasskey(req, passkeyId, label)`
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`
