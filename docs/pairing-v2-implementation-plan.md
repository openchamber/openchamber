# Pairing v2 Trusted-Device Issuance Backend Plan

## Scope

Implement the Pairing v2 mechanism without UI.

Included:

- Backend pairing session runtime.
- Pairing create/redeem/cancel routes.
- Trusted-device token issuance through the existing remote client auth runtime.
- Backward-compatible remote client metadata extension.
- Password/passkey issuance metadata alignment.
- Shared v2 `openchamber://connect` payload helpers.

Not included:

- Settings page.
- QR modal.
- Pair Device button.
- Device list UI.
- Translations/copy.
- Relay implementation.
- LAN discovery.
- End-user polished mobile/desktop screens.

## Naming

Use the existing `client-auth` domain.

New module:

```text
packages/web/server/lib/client-auth/pairing.js
```

Existing durable token module remains:

```text
packages/web/server/lib/client-auth/remote-clients.js
```

Conceptual names:

```text
Remote client
Trusted-device client token
Pairing session
Pairing secret
Pairing redeem
```

Deep link stays:

```text
openchamber://connect
```

Versions:

```text
v=1 => legacy server + long-lived token import
v=2 => one-time pairing handshake
```

## New Files

### 1. `packages/web/server/lib/client-auth/pairing.js`

Create a new backend runtime module for short-lived pairing sessions.

Responsibilities:

```text
createPairingSession
getPairingSession
cancelPairingSession
redeemPairingSession
sweepExpiredSessions
```

Store file:

```text
OPENCHAMBER_DATA_DIR/client-pairing-sessions.json
```

Suggested store shape:

```json
{
  "version": 1,
  "sessions": [
    {
      "id": "pair_...",
      "secretHash": "...",
      "createdAt": "...",
      "expiresAt": "...",
      "usedAt": null,
      "cancelledAt": null,
      "clientId": null,
      "label": "Pair new device",
      "fingerprint": "ABCD-1234",
      "allowedClientKinds": ["mobile", "desktop"],
      "createdByClientId": null
    }
  ]
}
```

Security requirements:

```text
Persist only secretHash.
Return plaintext secret only from createPairingSession.
Redeem is one-time.
Redeem is expiry-aware.
Redeem is cancellation-aware.
Redeem must be mutation-serialized to avoid double issuance.
No raw token/secret logging.
```

Public methods should accept injected dependencies, following `remote-clients.js` style:

```js
createClientPairingRuntime({
  fsPromises,
  path,
  crypto,
  storePath,
  remoteClientAuthRuntime,
})
```

## Existing Files To Update

### 2. `packages/web/server/lib/client-auth/remote-clients.js`

Extend trusted-device metadata backward-compatibly.

Current `createClient` input:

```js
{
  label,
  expiresAt,
  clientKind,
  dedupeKey,
}
```

Extend to:

```js
{
  label,
  expiresAt,
  clientKind,
  dedupeKey,
  authMethod,
  pairingId,
  deviceName,
  devicePlatform,
  deviceModel,
  appVersion,
}
```

Add normalized public fields:

```text
authMethod
pairingId
deviceName
devicePlatform
deviceModel
appVersion
```

Backward compatibility rules:

```text
Existing remote-clients.json remains valid.
Missing new fields normalize to null.
Existing tokens continue authenticating.
Public client output never exposes tokenHash.
Raw token is returned only from createClient.
```

Recommended `authMethod` values:

```text
pairing
password
passkey
desktop-local
manual
legacy
```

Do not force migration for old records. Treat missing `authMethod` as legacy/null.

### 3. `packages/web/server/index.js`

Instantiate the new pairing runtime next to `remoteClientAuthRuntime`.

Existing:

```js
const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
  fsPromises,
  path,
  crypto,
  storePath: REMOTE_CLIENTS_FILE_PATH,
});
```

Add:

```js
const CLIENT_PAIRING_SESSIONS_FILE_PATH = path.join(
  OPENCHAMBER_DATA_DIR,
  'client-pairing-sessions.json',
);
```

Then:

```js
const clientPairingRuntime = createClientPairingRuntime({
  fsPromises,
  path,
  crypto,
  storePath: CLIENT_PAIRING_SESSIONS_FILE_PATH,
  remoteClientAuthRuntime,
});
```

Pass `clientPairingRuntime` into `registerAuthAndAccessRoutes` dependencies.

### 4. `packages/web/server/lib/opencode/core-routes.js`

Add pairing routes near existing client-auth routes:

```text
/api/client-auth/clients
```

Add:

```http
POST   /api/client-auth/pairing/sessions
DELETE /api/client-auth/pairing/sessions/:id
POST   /api/client-auth/pairing/redeem
```

Optional, can be deferred:

```http
GET /api/client-auth/pairing/sessions/:id
```

Since UI polling is out of scope, `GET` is not required for this phase.

#### Route: `POST /api/client-auth/pairing/sessions`

Purpose:

```text
Create one short-lived pairing session and return data needed to build QR/deep link.
```

Auth:

```text
Require UI session auth.
Allow desktop-local client only if consistent with existing client-create exception.
Reject arbitrary remote client tokens.
Reject url-token auth.
```

Request:

```json
{
  "label": "Pair new device",
  "allowedClientKinds": ["mobile", "desktop"]
}
```

Response:

```json
{
  "pairing": {
    "id": "pair_...",
    "secret": "one_time_secret",
    "expiresAt": "...",
    "fingerprint": "ABCD-1234",
    "label": "Pair new device"
  },
  "server": {
    "label": "OpenChamber",
    "candidates": [
      {
        "type": "lan",
        "url": "http://192.168.1.20:4096",
        "priority": 10
      },
      {
        "type": "tunnel",
        "url": "https://abc.ngrok.app",
        "priority": 20
      }
    ]
  }
}
```

Headers:

```http
Cache-Control: no-store
```

Note:

```text
This route does not render QR.
UI can later encode the returned data into openchamber://connect?v=2&p=...
```

#### Route: `DELETE /api/client-auth/pairing/sessions/:id`

Purpose:

```text
Cancel an unused pairing session.
```

Auth:

```text
Require owner/session auth.
```

Behavior:

```text
Set cancelledAt.
Do not delete immediately.
If already used, cancellation should not revoke the issued client.
```

Response:

```json
{
  "cancelled": true
}
```

#### Route: `POST /api/client-auth/pairing/redeem`

Purpose:

```text
Exchange pairingId + one-time secret for a trusted-device client token.
```

Auth:

```text
No existing auth required.
The one-time pairing secret is the authentication factor.
```

Request:

```json
{
  "pairingId": "pair_...",
  "secret": "one_time_secret",
  "clientLabel": "Iryna iPhone",
  "clientKind": "mobile",
  "deviceName": "Iryna iPhone",
  "devicePlatform": "ios",
  "deviceModel": "iPhone",
  "appVersion": "1.12.0",
  "dedupeKey": "optional-stable-device-key"
}
```

Server behavior:

```text
Validate pairing exists.
Validate secret using constant-time comparison.
Validate not expired.
Validate not cancelled.
Validate not used.
Validate clientKind is allowed.
Mark pairing used.
Create remote client through remoteClientAuthRuntime.createClient.
Return clientToken once.
```

Create client with:

```js
{
  label: clientLabel || deviceName || 'Remote client',
  clientKind,
  dedupeKey,
  authMethod: 'pairing',
  pairingId,
  deviceName,
  devicePlatform,
  deviceModel,
  appVersion,
}
```

Response:

```json
{
  "ok": true,
  "server": {
    "label": "OpenChamber",
    "url": "https://selected-or-current-url",
    "fingerprint": "ABCD-1234"
  },
  "client": {
    "id": "device_...",
    "label": "Iryna iPhone",
    "clientKind": "mobile",
    "authMethod": "pairing",
    "createdAt": "..."
  },
  "clientToken": "oc_client_..."
}
```

Headers:

```http
Cache-Control: no-store
```

Failure response should be generic:

```json
{
  "error": "Invalid or expired pairing session"
}
```

Do not reveal whether id, secret, expiry, used, or cancellation caused failure.

### 5. `packages/web/server/lib/ui-auth/ui-auth.js`

Preserve existing password/passkey behavior.

Only add metadata to client token issuance when `issueClientToken === true`.

Password issuance should pass:

```js
authMethod: 'password'
clientKind: req.body?.clientKind
dedupeKey: req.body?.dedupeKey
deviceName: req.body?.deviceName
devicePlatform: req.body?.devicePlatform
deviceModel: req.body?.deviceModel
appVersion: req.body?.appVersion
```

Passkey issuance should pass:

```js
authMethod: 'passkey'
clientKind: req.body?.clientKind
dedupeKey: req.body?.dedupeKey
deviceName: req.body?.deviceName
devicePlatform: req.body?.devicePlatform
deviceModel: req.body?.deviceModel
appVersion: req.body?.appVersion
```

Backward compatibility:

```text
Existing POST /auth/session payload still works.
Existing response shape still works.
Existing clientToken issuance still works.
Password login remains disabled for tunnel/public scope.
```

### 6. `packages/ui/src/lib/connectionPayload.ts`

Extend existing connect payload helpers.

Keep current v1 behavior:

```text
openchamber://connect?v=1&server=...&token=...&label=...
```

Add v2 payload types and helpers.

Suggested types:

```ts
export type ClientConnectionPayloadV1 = {
  v: 1;
  serverUrl: string;
  token: string;
  label?: string;
};

export type PairingEndpointCandidate = {
  type: 'lan' | 'tunnel' | 'relay';
  url: string;
  priority?: number;
};

export type PairingConnectionPayloadV2 = {
  v: 2;
  pairingId: string;
  secret: string;
  label?: string;
  fingerprint?: string;
  expiresAt?: string;
  candidates: PairingEndpointCandidate[];
};
```

Suggested helpers:

```ts
encodePairingConnectionPayload(payload: PairingConnectionPayloadV2): string
parsePairingConnectionPayload(value: string): PairingConnectionPayloadV2 | null
```

Use deep link format:

```text
openchamber://connect?v=2&p=<base64url-json>
```

Validation:

```text
Require v=2.
Require pairingId.
Require secret.
Require at least one valid http/https candidate.
Reject malformed URL.
Reject oversized payload.
Reject expired payload locally if expiresAt is clearly in the past.
```

Do not break current exports used by mobile QR/manual connect.

### 7. `packages/ui/src/apps/mobileQrScan.ts`

Update parser only.

Current scan parser recognizes legacy fields like:

```text
server
label
```

Add support for v2 connect links.

Output should be able to distinguish:

```text
legacy v1 token import
pairing v2 payload
plain URL
```

Do not implement full mobile UI flow in this scope unless there is already a non-UI callable path.

### 8. `packages/ui/src/apps/mobileConnections.ts`

Add non-visual callable mechanism for redeeming pairing payload.

Add a function conceptually like:

```ts
redeemPairingConnection(payload: PairingConnectionPayloadV2): Promise<void>
```

Responsibilities:

```text
Try endpoint candidates.
POST /api/client-auth/pairing/redeem.
Persist issued token securely.
Persist connection metadata.
Switch runtime only after token write succeeds.
```

No new screens/buttons.

Existing password flow remains unchanged.

Candidate selection:

```text
Normalize candidates.
Probe /health with timeout.
Try candidates by priority.
Prefer HTTPS when priority ties.
If network failure, try next candidate.
If server says invalid/expired/used, stop.
```

Mobile native should reuse existing native HTTP fallback path for LAN HTTP.

### 9. `packages/electron/main.mjs`

Extend existing connect deep-link handling.

Current v1 behavior:

```text
openchamber://connect?v=1&server=...&token=...
```

Keep it.

Add v2 branch:

```text
openchamber://connect?v=2&p=...
```

Behavior:

```text
Parse v2 payload.
Show confirmation before redeem/write/switch.
Probe candidates.
Redeem pairing secret.
Store returned clientToken in desktop hosts config.
Ask/switch according to existing remote host behavior.
Never show token.
Never write config before confirmation.
```

If this phase is strictly backend-only, this file can be deferred. But if desktop app as client must be functionally supported by deep link in this phase, include this change.

### 10. `packages/electron/preload.mjs`

No change expected unless a renderer-side desktop API is needed for pairing redeem.

Prefer keeping pairing redeem in main process only for deep-link handling if desktop v2 is implemented there.

### 11. `packages/web/server/lib/ui-auth/DOCUMENTATION.md`

Update module documentation to reflect the unified issuance model:

```text
Password, passkey, and pairing are issuance methods.
Trusted-device client token is the durable credential.
Pairing v2 uses one-time secrets and issues remote client tokens.
```

Optionally add:

```text
packages/web/server/lib/client-auth/DOCUMENTATION.md
```

if the client-auth module needs ownership docs.

## Route Registration Summary

Add to `registerAuthAndAccessRoutes`:

```http
POST   /api/client-auth/pairing/sessions
DELETE /api/client-auth/pairing/sessions/:id
POST   /api/client-auth/pairing/redeem
```

Optional later:

```http
GET /api/client-auth/pairing/sessions/:id
```

Route placement:

```text
Register before generic OpenCode proxy.
Place near existing /api/client-auth/clients routes.
```

## Execution Sequence

### Step 1: Extend Remote Client Metadata

Files:

```text
packages/web/server/lib/client-auth/remote-clients.js
```

Do:

```text
Add metadata normalization.
Extend createClient input.
Extend publicClient output.
Keep old records valid.
Do not change token generation/authentication behavior.
```

### Step 2: Add Password/Passkey Metadata Issuance

Files:

```text
packages/web/server/lib/ui-auth/ui-auth.js
```

Do:

```text
When issueClientToken is true, pass authMethod='password' from password login.
When issueClientToken is true, pass authMethod='passkey' from passkey auth.
Pass optional device metadata through.
Preserve response shape.
```

### Step 3: Create Pairing Runtime Module

Files:

```text
packages/web/server/lib/client-auth/pairing.js
```

Do:

```text
Implement session creation.
Implement hashed secret storage.
Implement cancel.
Implement redeem.
Implement expiry/used/cancelled checks.
Integrate remoteClientAuthRuntime.createClient in redeem.
```

### Step 4: Instantiate Pairing Runtime

Files:

```text
packages/web/server/index.js
```

Do:

```text
Define CLIENT_PAIRING_SESSIONS_FILE_PATH.
Instantiate createClientPairingRuntime.
Pass clientPairingRuntime to registerAuthAndAccessRoutes.
```

### Step 5: Add Pairing Routes

Files:

```text
packages/web/server/lib/opencode/core-routes.js
```

Do:

```text
Destructure clientPairingRuntime from dependencies.
Add POST /api/client-auth/pairing/sessions.
Add DELETE /api/client-auth/pairing/sessions/:id.
Add POST /api/client-auth/pairing/redeem.
Use correct auth gates.
Set Cache-Control: no-store where secrets/tokens are returned.
Keep error responses generic for redeem.
```

### Step 6: Add v2 Payload Helpers

Files:

```text
packages/ui/src/lib/connectionPayload.ts
```

Do:

```text
Keep v1 helpers unchanged.
Add v2 payload type.
Add encode v2 helper.
Add parse v2 helper.
Use openchamber://connect?v=2&p=<base64url-json>.
Validate candidates.
Reject malformed/expired/oversized payloads.
```

### Step 7: Update QR Scan Parser Shape

Files:

```text
packages/ui/src/apps/mobileQrScan.ts
```

Do:

```text
Recognize v2 connect payload.
Return structured v2 result.
Do not add new UI.
Do not break v1/manual URL behavior.
```

### Step 8: Add Non-UI Mobile Redeem Plumbing

Files:

```text
packages/ui/src/apps/mobileConnections.ts
```

Do:

```text
Add callable redeem pairing function.
Try endpoint candidates.
Redeem via /api/client-auth/pairing/redeem.
Persist token before runtime switch.
Reuse existing storage model.
Keep password/manual connect unchanged.
```

### Step 9: Add Desktop Deep-Link v2 Handling If In Scope

Files:

```text
packages/electron/main.mjs
```

Do:

```text
Extend connect deep-link parser to recognize v2.
Confirm before redeem.
Redeem against candidate endpoint.
Store remote host config with returned token.
Switch only after confirmation and successful storage.
Keep v1 behavior unchanged.
```

If desktop client deep-link support is deferred, skip this step and document that v2 backend/shared payload exists but desktop consumer is not wired yet.

### Step 10: Update Documentation

Files:

```text
packages/web/server/lib/ui-auth/DOCUMENTATION.md
```

Optionally add:

```text
packages/web/server/lib/client-auth/DOCUMENTATION.md
```

Document:

```text
Unified trusted-device token issuance.
Pairing v2 flow.
Password/passkey/pairing authMethod values.
Security rules.
Backward compatibility guarantees.
```

## Important Non-Goals

Do not implement:

```text
Settings page
Pair Device button
QR modal
Device list UI
Translations
Visual design
Relay transport
LAN discovery
Account/cloud sync
Token migration to OS keychain on desktop
```

## Backward Compatibility Requirements

Must remain true:

```text
Existing v1 openchamber://connect links keep working.
Existing password login with issueClientToken keeps working.
Existing passkey issueClientToken keeps working.
Existing remote-clients.json keeps loading.
Existing client tokens keep authenticating.
Existing mobile saved connections keep working.
Existing desktop remote hosts keep working.
```

## Security Requirements

Must hold:

```text
No long-lived token in v2 link.
Pairing secret persisted only as hash.
Pairing secret returned only once.
Client token returned only once.
Token hash persisted server-side.
Redeem is one-time.
Redeem is expiry-aware.
Redeem is cancellation-aware.
Redeem errors are generic.
Password login remains disabled for tunnel/public scope.
Pairing session creation requires owner/session auth.
Pairing redeem requires no prior auth but requires valid one-time secret.
Desktop v2 connect confirms before writing host config or switching runtime.
```
