# UI Auth Module Documentation

## Purpose
This module owns OpenChamber UI authentication for browser access, including password session auth, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

## Entrypoints and structure
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/server/lib/ui-auth/session-cookie.js`: resolves the session cookie name from a request's `Host` port; shared by session issuance and validation in `ui-auth.js` and notification/session identity extraction in `packages/web/server/lib/security/request-security.js`.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation. Revoking also stops the device's push notifications (`../notifications/DOCUMENTATION.md`, *Revoked and expired clients*).
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Session cookie scoping
Browsers key a cookie jar on the host only, never the port (RFC 6265). Two OpenChamber instances reached through the same hostname on different ports therefore shared a single `oc_ui_session` cookie. Logging into the second overwrote the first instance's session cookie (issue #2377). This affects LAN and loopback hosts alike.

`sessionCookieNameForRequest(req, base)` folds the request `Host` port into the cookie name: `oc_ui_session_<port>` when the host carries an explicit port (including a port from `x-forwarded-host`), or the bare `oc_ui_session` when it does not. `localhost:3000` and `localhost:3001` use separate names, just like two ports on one LAN address. Password and browser passkey login both call `issueSession` and receive this cookie. Session validation, clearing, and notification identity extraction use the same resolver; identity extraction does not provide a CSRF token. Bearer-token validation is unchanged.

Compatibility: upgrading renames the cookie for any explicit-port host, so already-signed-in browser sessions must log in once again. No on-disk format changes.

## Per-session sign-out

Every UI session belongs to the owner. There are no separate UI accounts or permission levels. `DELETE /auth/session` ends the caller's valid cookie session first, or otherwise revokes its bearer client token through `remote-clients.js`. It answers `200 { signedOut: true }`, clears the session cookie, and removes URL tokens minted from that credential. Other sessions, clients and passkeys stay valid. Missing or invalid credentials receive 401. With UI password authentication disabled it answers `200 { signedOut: false }`. Tunnel and unknown-public scope receive `403 { error: 'Sign-out is disabled for tunnel scope', tunnelLocked: true }` before the UI controller runs.

New UI session JWTs carry a random 128-bit `jti`, so two sign-ins in the same second produce distinct tokens. The header, `type`, `iat`, `exp`, lifetimes and signature verification are unchanged. Tokens issued before this change have no `jti` and stay valid. Two legacy tokens issued in the same second with the same lifetime are identical, so signing out one ends both until they expire, after 12 hours or 7 days with "trust this device".

`revoked-sessions.js` owns `<OPENCHAMBER_DATA_DIR>/ui-revoked-sessions.json`, beside `jwt-secret`. Its format is `{ "version": 1, "revoked": [{ "digest": "<sha256 hex of the whole session token>", "expiresAt": <verified JWT exp in milliseconds> }] }`. It holds UI session JWT digests only and keeps a Set for authentication checks. Expired entries are dropped on load and every write. A missing file means no revocations. At startup D14 recovery first persists the new JWT secret and clears URL tokens. Only then does clearing the revocation list attempt to move the unreadable input to `<file>.unreadable-<UTC timestamp>` and write the empty list. Quarantine is attempted once; its failure does not prevent clearing. Authentication and session issuance wait for recovery persistence. If key persistence fails, the unreadable file remains at its original path, sign-in stays refused, and the next startup retries rotation. A content-free error reports recovery; failure adds an error-code-only diagnostic explaining that restart requires a writable data directory. With `OPENCODE_JWT_SECRET` pinned, rotation is impossible: quarantine is attempted immediately so later sign-outs can write, one error reports that revoked UI sessions may be accepted again until they expire, and the in-memory list starts empty.

Writes run serially within each controller, including concurrent sign-outs and clearing the list. Each sign-out re-reads the file inside its queued operation and merges persisted entries with memory by digest. ENOENT contributes no entries; unreadable or invalid state aborts the write without replacing the file. Each write uses a unique temporary file with mode 0600, fsyncs it before an atomic rename, then fsyncs the containing directory. Memory changes only after persistence succeeds; a failed write returns 500, removes the temporary file and allows a retry. A directory-fsync failure can leave the renamed file on disk while memory remains unchanged; retry re-reads that file. Controllers do not synchronize live authentication checks or serialize simultaneous writes across processes sharing a data directory.

"Sign out everywhere" rotates `jwt-secret`, clears URL tokens and empties the persisted revocation list, alongside its existing passkey reset. `OPENCODE_JWT_SECRET` prevents global sign-out because the configured secret cannot be rotated; per-session sign-out still persists revocations with that secret. Desktop bearer revocations live in the independent client store: D14 recovery and "Sign out everywhere" leave both active and revoked client credentials unchanged. URL tokens are short-lived in-memory entries and are deleted by their originating session or client identity at sign-out; session-backed URL tokens also consult the digest Set. The browser treats a 401 from sign-out as already signed out and reloads to the sign-in screen.

### Why token digests identify revoked sessions

Whole-token digests support both legacy and new JWTs without storing credentials or forcing a login after upgrade. A random `jti` gives new sign-ins independent identities while preserving legacy verification.

### Why revocation writes share one queue

The queue covers state changes and persistence together, so concurrent sign-outs in one controller cannot overwrite each other. Re-reading merges entries already persisted by another writer. Committing memory after both fsyncs keeps a failed write retryable without falsely reporting success. Clearing after key rotation deliberately replaces the list without merging old digests, so recovery also works when quarantine failed.

### Why unreadable revocations rotate the UI session key

An empty fallback alone can restore a revoked UI session for its remaining lifetime. D14 invalidates every old UI JWT before authentication resumes. Keeping unreadable input in place until the new key is persisted makes a failed rotation retry at the next startup; moving it earlier would let that startup accept revoked cookies under the unchanged key. The pinned-secret exception preserves availability when configuration prevents rotation and logs the resulting exposure explicitly.

## URL auth tokens
`POST /auth/url-token` returns `{ token, expiresAt, expiresIn }`. `expiresAt` is on the server's clock; `expiresIn` is the remaining lifetime in milliseconds. The shared UI places the expiry on its own clock from `expiresIn` (`packages/ui/src/lib/runtime-auth.ts`), because a phone whose clock is a minute ahead of the server otherwise treats every fresh token as expired and opens the terminal and event sockets without one (issue #5614). `expiresAt` stays for clients older than `expiresIn`.

## Public exports (ui-auth.js)
- `readSessionTtlMs(raw, unitMs, fallbackMs)`: parses a positive session lifetime from an environment value, else the fallback. Defaults come from `OPENCHAMBER_UI_SESSION_TTL_HOURS` (12) and `OPENCHAMBER_UI_TRUSTED_SESSION_TTL_DAYS` (7, used when the user ticks "trust this device").
- `createUiAuth({ password, cookieName, sessionTtlMs, trustedSessionTtlMs, readSettingsFromDiskMigrated })`: creates UI auth controller with methods:
  - `enabled`
  - `requireAuth(req, res, next)`
  - `handleSessionStatus(req, res)`
  - `handleSessionCreate(req, res)`
  - `handleSessionDelete(req, res)`
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
