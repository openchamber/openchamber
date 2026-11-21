# Client Auth Module Documentation

## Purpose

This module owns the two stores behind trusted-device access to an OpenChamber server: remote client bearer tokens (`remote-clients.json`) and short-lived Pairing v2 sessions (`client-pairing-sessions.json`). The routes that issue and redeem them, and password/passkey access, belong to `../ui-auth/` (`../ui-auth/DOCUMENTATION.md`); the relay dispatcher that stamps `x-openchamber-relay-connection` and the relay proof belongs to `../relay/`.

`remote-clients.js` mints, lists, revokes and authenticates `oc_client_...` bearer tokens. `pairing.js` creates a one-time session that a device redeems for that same token, marks the session used and records the created client id. Both stores keep only hashes, are normalized on every read and write, and are mutated under one serialized queue per runtime.

## Invariants

- A bearer token, pairing secret or client token is persisted only as its SHA-256 hex digest. The plaintext value leaves the module once, in the creation or redemption answer.
- Token and secret comparison is constant-time over decoded hex buffers of equal length.
- Store writes create their directory `0o700` and write the file `0o600`; the mode is applied again after every write.
- Every store read-modify-write runs through `withStoreMutation`, so two concurrent requests cannot drop each other's client or resurrect a revoked record.
- A pairing session is redeemable only when it is not used, not cancelled, not expired, allows the redeeming client kind, and its secret matches. Every failed check answers the same generic `Invalid or expired pairing session`, so a caller cannot learn which check failed.
- A stored label of `null` means the operator did not name the device, and the stored value stays `null` until someone does. Labels are capped at 80 characters.
- A request is relay-carried only when it carries this server's relay proof (`x-openchamber-relay-proof`, checked by `hasRelayProvenance` in `../relay/provenance.js`): a random secret that exists only in this process's memory and that only the relay tunnel dispatcher stamps on what it forwards. `x-openchamber-relay-connection` alone, the client's address and the peer being loopback prove nothing, so a header a client sends on a LAN request or through a same-host proxy or tunnel daemon stays direct and never changes `usesRelay` or `localOnly`. A relay request must never be classified as direct.
- `usesRelay` is true when a device is known to use the relay, and once true stays true for the record's lifetime. `lastTransport` is the transport of the last authenticated request and may be `direct` after a relay request.
- `localOnly` is true when every candidate in the device's pairing link was a plain `http` address (LAN or loopback): no relay and no `https` tunnel URL. It is set only at pairing and cleared, together with setting `usesRelay`, by the first request that arrives through the relay. A record without the field reads as `false`.
- Relay demand counts any active (not revoked, not expired) client with `usesRelay === true` or `lastTransport === 'relay'`, and any still-redeemable pairing session with `usesRelay === true`.

## Decisions

### Why raw inputs and stored records have separate types

HTTP routes pass unparsed body fields to creation and redemption, and both stores
read JSON written by older versions. Input fields remain unknown until the local
guards parse them. Non-string metadata, malformed records, missing values and
invalid timestamps retain their existing fallback behavior. Stored and public
records use normalized types; a stored pairing label can be null while its public
label is always the display placeholder or a supplied name. A newly minted client
has no `lastTransport` until normalization or authentication supplies it.

The injected filesystem requires read, write and directory creation. `chmod`
remains an optional capability checked at runtime, preserving adapters that omit
it. The mutation queue initializes its release callback before constructing the
promise; the synchronous executor always replaces it before the first await.

### Why the pending-device placeholder is display-only

`publicSession` shows `Pair new device` when the stored label is null, but `createPairingSession` keeps the label null. Storing the placeholder would make it indistinguishable from a typed name, and redeem would then pass it to `createClient` as an explicit label, replacing the device's own reported name with the placeholder. Null also lets redemption fall back to the device's reported name.

### Why an unset label is null and not an empty string

`normalizeStoredLabel` returns null for an absent or blank name, so callers can tell "the operator gave no name" from a real name and let the device-reported fallback apply. An empty string would be treated as a name and would either overwrite a device label or produce an unnamed entry.

### Why a dedupe-keyed mint keeps the replaced record's label

A dedupe-keyed mint replaces the previous record for the same device. Keeping the replaced label when the caller passes none means a re-pair or rescan from an already-named device does not reset it to the app's default name. An explicit label still wins, and only a first-ever mint falls back to the client-reported label. `pairing.js` therefore passes the operator's typed pairing label as `label` and the device's self-reported name as `fallbackLabel`.

### Why a kind-tagged dedupe mint also drops legacy same-label records

Pre-`clientKind` desktop tokens identify a client by label alone: no kind, no dedupe key. Their tokens can no longer pass the desktop-local client-create gate, so they are unreachable but would remain in the store forever. A deduped mint that carries a kind removes same-label records that have neither a kind nor a dedupe key, because the new record supersedes them.

### Why observed transport, not only the pairing flag, decides relay demand

A pairing QR can omit the relay candidate, and records written before `usesRelay` existed carry no relay flag. A request that arrives through the relay tunnel is direct proof that the device uses it, so `hasActiveRelayClients` also reads `lastTransport`. Without that, the relay host could shut down while a device is still connected through it.

### Why `usesRelay` heals and stays sticky

`authenticateBearerToken` sets `usesRelay` when a request arrives through the relay. The pairing-time snapshot is not authoritative; the tunnel is. It is sticky because a later request over LAN, or a paired device that is currently reachable directly, is not evidence that the device stopped using the relay. Clearing it on a direct request would make relay demand flap with every transport switch.

### Why relay provenance is a per-process secret and not the connection header

The device flags are a restriction the user chose at pairing, so what lifts them must be something a device cannot produce. Every header a client sends reaches the server unchanged on a direct request, and a same-host tunnel daemon or reverse proxy makes that request come from loopback, the same address the dispatcher dials. The dispatcher runs in this server's process, so it stamps a secret minted at process start and never stored or sent to a client; the server takes it out of the headers before any handler runs, so no proxy forwards it. Matching the stamp against the relay host's live connection ids was the other option, but those ids come from the relay service, not from this server, and couple this module to the relay host's connection state.

### Why `lastUsedAt` is throttled but a transport change writes immediately

`lastUsedAt` is display data and would otherwise write the store on every request, so it is written at most once per 60 seconds. A changed transport is not display-only: it feeds relay demand and the device's transport column, so it is written at once and a LAN/relay switch is visible without waiting for the next interval.

### Why expired-but-never-inactive sessions are purged by `expiresAt`

The sweep keeps a session for `ttlMs` after it is used or cancelled, which preserves a short audit window. A session that was never used or cancelled has no such timestamp, so it is dropped once its own `expiresAt` passes; nothing can redeem it, and keeping it would leave it in the store forever.

### Why `localOnly` is stored at pairing and not derived from `usesRelay`

`usesRelay` is false for every device paired before Pairing v2 and for a device paired through a public `https` tunnel, and neither of those stays inside the home network. Only the pairing link knows that the device was given nothing but LAN addresses, so the flag is taken from it once and kept on the client record, where `../notifications/client-push-access.js` reads it to send the device no push and `/api/client-auth/connection/candidates` reads it to leave the relay out. A device that reaches the server through the relay anyway is not local-only, so the relay request clears the flag. Devices paired before the flag existed keep their notifications; to stop them, the user pairs the device again. A phone that pairs again for the home network only replaces its old record through the dedupe key; `createClient` returns the ids it replaced so the redeem route can remove their push registrations, which would otherwise keep delivering under the old key.

### Why candidate URL normalization checks for a string

The pairing route passes the unchecked `serverUrl` body field. The normalizer ignores non-strings so the route can fall back to the request origin. URL parsing alone would coerce some non-string values into URLs.
