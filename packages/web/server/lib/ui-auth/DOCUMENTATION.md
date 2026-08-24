# UI Auth Module Documentation

## Purpose
This module owns OpenChamber UI authentication for browser access, including password session auth, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Remote clients persist a validated capability set containing only `workspace.read`, `workspace.use`, `workspace.admin`, and `host.apply`. New and legacy remote clients default to `workspace.read` plus `workspace.use`; only the desktop-runtime controller returned by `startWebUiServer()` may mint the host-local `desktop-local` operator with all four capabilities. That in-process method fixes the client kind and dedupe identity, accepts only bounded display metadata, and is not exposed through HTTP or an Electron renderer bridge. HTTP login, passkey login, client creation, and pairing payloads cannot mint that kind. Capability grant/revoke requires a local UI session, explicit UI confirmation, and a one-time `host.capabilities` proof bound to the target client and exact grant/revoke body.

Privileged workspace and host-capability operations use short-lived, one-time `oc_reauth_...` proofs. A proof is bound to the authenticated UI session or remote client, operation, project, canonical request-body hash, caller nonce, and expiry. Password-enabled hosts can verify the password again or complete an operation-bound WebAuthn assertion whose server-side challenge record carries the complete binding. Proofs are sent only in `X-OpenChamber-Reauth-Proof`, never in URLs, and are consumed atomically after all bindings match. Passwordless hosts fail closed with an explicit setup-required response because current passkeys are password-bound and no independent passwordless step-up enrollment exists yet.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

## Entrypoints and structure
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation.
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Public exports (ui-auth.js)
- `createUiAuth({ password, cookieName, sessionTtlMs, readSettingsFromDiskMigrated })`: creates UI auth controller with methods:
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
  - `handleResetAuth(req, res)`
  - `ensureSessionToken(req, res)`
  - `handleReauthProof(req, res)`
  - `handlePasskeyReauthOptions(req, res)`
  - `handlePasskeyReauthVerify(req, res)`
  - `consumeReauthProof(req, expectedBinding)`
  - `dispose()`

## Public exports (ui-passkeys.js)
- `createUiPasskeys({ passwordBinding, readSettingsFromDiskMigrated, storeFile, rpName, challengeTtlMs })`: creates passkey runtime with methods:
  - `enabled`
  - `getStatus(req)`
  - `listPasskeys(req)`
  - `revokePasskey(req, passkeyId)`
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`
