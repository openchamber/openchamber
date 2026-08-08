# OpenChamber P2P Account Sync — Specification

Status: draft  
Audience: product + engineering  
Related surfaces: `packages/web` (server), `packages/ui` (sync/stores), `packages/electron`, `packages/mobile`, private relay  
Non-goals of this document: implementation code, UI pixel specs, provider OAuth app registration details

## 1. Problem

Today OpenChamber multi-device access is **fan-in to one host**:

```text
[Mobile / Desktop remote / Browser]
        │  bearer oc_client_*  + optional E2EE private relay
        ▼
[OpenChamber web server] ──proxy──► [OpenCode]
```

Clients share state only by talking to the **same** OpenChamber + OpenCode instance. There is no:

- cloud OpenChamber account identity (password / passkey / Pairing v2 are host-local),
- peer replication of projects / sessions / messages,
- selective sync of “this project + related chats” or “everything”.

This spec defines **account-mediated P2P sync** between OpenChamber instances of the same user: login (including social) establishes identity and device trust; data moves peer-to-peer (with relay fallback), end-to-end encrypted, with scoped and efficient streaming sync.

## 2. Goals

1. **Login identity** — user can sign in with social providers (Google, GitHub, Apple) and/or email/passkey; identity is portable across devices.
2. **P2P data path** — sync payloads never leave devices in plaintext; rendezvous/signaling may be centralized, content is E2EE.
3. **Scoped sync** — user chooses:
   - one or more projects (full project corpus),
   - all chats/sessions related to those projects,
   - or full account sync (everything eligible).
4. **Fast & efficient** — content-addressed deltas, streaming compression (Zstd primary, LZ4 control plane), resume, parallelism, backpressure.
5. **Preserve OpenChamber invariants** — failure ≠ empty; authoritative vs optimistic separation; directory/runtime scoping; partial scope failure isolation; no secret logging.

## 3. Non-goals (v1)

- Sync of LLM provider secrets (`auth.json`) by default (opt-in later, separately encrypted vault).
- Sync of arbitrary workspace source trees (git remotes remain the source of truth for code).
- Real-time collaborative co-editing of one live agent turn across two writers (v1 is multi-device continuity, not Google-Docs-for-agents).
- Making VS Code extension a sync host (thin client only).
- Replacing Pairing v2 / private relay for classic “connect to this host” remote UI.

## 4. Conceptual model

### 4.1 Actors

| Actor | Role |
|---|---|
| **Account** | Stable user identity (`acct_…`) from OpenChamber Identity Service |
| **Device** | A concrete OpenChamber host or thin client with a device keypair |
| **Sync peer** | A device that stores an authoritative local corpus and can serve/receive sync |
| **Rendezvous** | Lightweight online service: auth, device directory, signaling, optional encrypted blob relay |
| **Scope** | Named sync selection: project set, related sessions, or full |

### 4.2 What “P2P” means here

Recommended topology: **hybrid P2P**.

```text
┌────────────┐     login / device attest      ┌─────────────────────┐
│  Device A  │◄─────────────────────────────►│ Identity + Rendezvous│
│ (Desktop)  │     signaling / NAT assist     │ (no plaintext data) │
└─────┬──────┘                               └──────────▲──────────┘
      │  direct QUIC/WebRTC DataChannel (prefer)         │
      │  or E2EE relay fallback                          │
      ▼                                                  │
┌────────────┐                                           │
│  Device B  │◄──────────────────────────────────────────┘
│ (Laptop)   │
└────────────┘
```

- **Control plane (centralized):** OAuth login, device registration, peer discovery, capability ads, optional push wake.
- **Data plane (P2P first):** encrypted sync streams between peers. If direct path fails, fall back to existing private-relay style mux or a sync-specific encrypted relay — still opaque ciphertext.

This reuses lessons from today’s private relay (`packages/web/server/lib/relay`) without treating that relay as a data store.

### 4.3 Authority model

OpenChamber today assumes **one OpenCode writer** per directory. P2P sync must not pretend multiple OpenCode servers are a single live store.

v1 authority rule:

1. Each device keeps a **local Sync Vault** (content-addressed objects + indexes) owned by OpenChamber, separate from live OpenCode process state.
2. Live UI continues to talk to **local** OpenCode via existing SDK / `RuntimeAPIs` path.
3. Sync Engine imports/exports between Vault ↔ local OpenCode/OpenChamber stores with explicit apply steps.
4. Concurrent edits on two devices resolve in the Vault via CRDT / causal merge; apply to OpenCode is idempotent and revision-aware (aligns with existing mutation revisions / tombstones in `packages/ui/src/sync`).

## 5. Identity & login (including social)

### 5.1 OpenChamber Account

Introduce an **Identity Service** (new product surface; not host-local UI password):

| Method | Notes |
|---|---|
| Google OAuth | Primary social |
| GitHub OAuth | Aligns with existing GitHub feature auth, but **separate** app purpose: OpenChamber account, not PR tooling |
| Apple Sign In | Required for App Store mobile parity |
| Email magic link / passkey | Non-social fallback; passkeys bound to account, not host password |

Output of login:

```text
accountId
idToken / session (short-lived)
refresh handle (device-bound)
deviceId
deviceSigningKey (Ed25519)
deviceEncKey (X25519)
accountRootKey material  →  never leaves device after unwrap
```

### 5.2 Key hierarchy (E2EE)

```text
Account Root Key (ARK)
  ├─ Sync Master Key (SMK)          # wraps per-scope keys
  ├─ Device Trust Graph             # signed device certs
  └─ Scope Keys (SK_project, SK_full…)
        └─ Object encryption keys (per-blob or per-stream)
```

- Social login authenticates to Identity Service only.
- **ARK** is recovered via:
  - passkey / recovery key (primary),
  - or escrow of ARK wrapped to each trusted device’s public key,
  - optional threshold recovery later.
- Rendezvous stores **ciphertext only** for device/key packages; never SMK/ARK plaintext.

### 5.3 Relationship to existing auth

| Existing | Remains | Interaction with Account Sync |
|---|---|---|
| UI password / passkey (`ui-auth`) | Yes, host gate | Orthogonal; optional “link this host to account” |
| Remote client tokens `oc_client_…` | Yes | Still used for classic remote UI to a host |
| Pairing v2 | Yes | Can also *offer* “add device to my account sync circle” |
| Private relay | Yes | Reused as optional encrypted transport fallback |
| Provider OAuth in `auth.json` | Yes | **Out of sync scope** by default |

### 5.4 Device enrollment UX (product)

1. Sign in on Device A (social / passkey).
2. Device A becomes first sync peer; generates ARK.
3. On Device B: same login → shows Device A for trust approval (or QR + account session).
4. After mutual device signatures, peers advertise sync capabilities and selected scopes.

## 6. Sync scopes

### 6.1 Scope kinds

| Scope | Includes | Excludes (v1) |
|---|---|---|
| **`project:<projectKey>`** | Project metadata, icons, OpenChamber project prefs, all sessions whose directory resolves to that project, messages/parts, session folders, goals, todos/pins tied to those sessions | Unrelated projects; provider secrets; unrelated local caches |
| **`projects:set`** | Union of several `project:` scopes | Same as above |
| **`full`** | All projects + all sessions + OpenChamber settings subsets marked syncable + session folders/goals globally | Local-only UI ephemera; runtime tokens; relay host keys; LLM secrets (default) |

### 6.2 Project identity across machines

Today OpenChamber project id is path-derived (`path_<base64url(path)>`). Paths differ across devices.

Introduce stable **`projectKey`**:

```text
projectKey = blake3(
  canonical_repo_fingerprint? ||
  user_chosen_link_id ||
  content_hash_of_bootstrap_marker
)
```

Resolution order when linking a project into a scope:

1. Explicit user link (“this folder is Project X”).
2. Same git remote + default branch tip / `origin` URL fingerprint when available.
3. Manual create-new vs merge prompt if ambiguous.

Local `path` remains device-specific; sync stores **`pathHints`** per device, never treats path as global identity.

### 6.3 “Related chats”

A session is in scope for `project:<projectKey>` when:

- `session.directory` / worktree maps to a linked local path for that projectKey, or
- session carries an explicit `projectKey` annotation written at creation/import time, or
- parent/child session graph (`parentID`) roots into an in-scope session (include whole tree).

### 6.4 User-facing sync modes

| Mode | Behavior |
|---|---|
| Selected projects | Continuous sync for chosen projectKeys + related chats |
| Everything | Continuous `full` scope |
| One-shot transfer | Temporary scope for migration (“copy Project X to this machine now”) |

## 7. Data model (Sync Vault)

### 7.1 Object types

Content-addressed objects (`objId = blake3(ciphertext)` or `blake3(plaintext)` before encrypt — prefer encrypt-then-hash of ciphertext for storage addressing):

| Type | Payload (logical) |
|---|---|
| `project.meta` | label, color, icon refs, defaultModel, sync annotations |
| `project.icon` | binary icon blob |
| `session.meta` | OpenCode session fields + projectKey + parentID + directory hint |
| `session.message` | message envelope |
| `session.part` | part payload (text/tools/files refs) |
| `session.folder` | OpenChamber folder membership |
| `session.goal` | goal markdown / structured goal |
| `settings.slice` | syncable settings document fragment |
| `tombstone` | deletion marker with causal stamp |
| `snapshot.manifest` | complete scope root at revision R |

### 7.2 Indexes

Per scope:

```text
ScopeRoot
  ├─ Merkle tree of object ids (or Prolly/Merkle-search tree)
  ├─ Causal clock vector / hybrid logical clock
  ├─ Tombstone log (bounded, compacted)
  └─ Latest snapshot.manifest ref
```

### 7.3 Mapping to today’s stores

| Today | Sync direction |
|---|---|
| OpenCode sessions/messages/parts | Export on change → Vault; import apply → OpenCode with revision guards |
| OpenChamber `settings.json` projects | Bi-directional for syncable fields |
| Session folders / goals APIs | Bi-directional |
| `persist-cache` localStorage | **Never** authoritative sync source |
| Remote clients / pairing / relay keys | **Never** synced as account data |

Import/apply must respect existing sync invariants from `packages/ui/src/sync/DOCUMENTATION.md` and `sync-state-invariants`:

- failed fetch/import ≠ empty wipe,
- mutation revisions / tombstones win over stale snapshots,
- one project failure must not clear others.

## 8. Sync protocol

### 8.1 Phases

```text
1. Hello / capability negotiate
2. Auth (device certs + scope ACL)
3. Compression negotiate
4. Inventory exchange (scope roots, clocks, bloom/fingerprint)
5. Want/Have negotiation (set reconciliation)
6. Streaming object transfer (parallel channels)
7. Apply + ack + new root advertisement
8. Live delta feed (optional continuous mode)
```

### 8.2 Set reconciliation (efficient)

Prefer a layered approach:

1. **Scope root hash** equality → done.
2. Else exchange **Merkle proofs / tree diffs** (or Range-Based Set Reconciliation / Rateless IBLT for large divergent sets).
3. Fallback: chunked inventory fingerprints (2048-bit blooms + stratified samples).

Goal: minimize round trips on mostly-in-sync peers (common case after first sync).

### 8.3 Streaming transfer

- Multiplexed bi-directional streams over one session (QUIC streams or WebRTC DataChannels).
- Priority classes:
  - `P0` control / acks,
  - `P1` session.meta + recent messages,
  - `P2` older history,
  - `P3` icons / bulky attachments.
- Resume tokens: `(scopeId, rootFrom, byteOffset, objId)` so reconnects do not restart full history.
- Backpressure: credit-based windows; never buffer unbounded message corpora in UI memory (align with existing event-pipeline coalescing spirit).

### 8.4 Live continuous sync

After initial catch-up:

- Peers subscribe to scope delta feeds.
- Emit operations: `put`, `tombstone`, `snapshot`.
- Batch small ops (~16–64 KiB compressed frames) before flush; flush sooner for interactive recent chat.
- Do **not** derive live busy/agent status from sync history — live activity stays on local OpenCode event channels (`event-stream`). Sync is for durable corpus continuity.

### 8.5 Conflict rules (v1)

| Entity | Rule |
|---|---|
| Messages / parts | Append-only by id; duplicate id → identical content or quarantine |
| Session meta title/model | LWW by hybrid logical clock + device tie-break |
| Deletes | Tombstones beat older puts; never resurrect without newer create |
| Project meta | Field-level LWW |
| Folder membership | OR-set / observed-remove set |
| Settings slices | Document-level LWW per slice id |

Quarantine bucket for unmergeable conflicts; UI surfaces “sync conflict” without silent data loss.

## 9. Compression (streaming, current best practice)

### 9.1 Codec policy

| Plane | Codec | Rationale |
|---|---|---|
| Control frames / tiny JSON | **LZ4** (or uncompressed if `< 64 B`) | Lowest latency |
| Bulk object streams / history | **Zstandard (RFC 8878)** streaming frames | Best 2025–2026 speed/ratio default |
| Cold one-shot migration archives | **Zstd level 9–14** (or zstd long mode) | Compress once, transfer once |
| Static web assets | Brotli remains unrelated (CDN) | Out of scope |

Do **not** use gzip/bzip2 for new sync paths. Do **not** recompress already-compressed blobs (images, zips); store as raw framed objects.

### 9.2 Zstd streaming profile

Negotiated parameters (example defaults):

```text
codec = zstd
level = 3                # live sync sweet spot
windowLog ≤ 20           # ≤1 MiB window for memory-safe peers (mobile)
content checksum = on
frame per logical batch  # independent decompress for resume/parallelism
dict = shared trained dictionary (optional, versioned)
```

Capabilities advertisement:

```json
{
  "compress": ["zstd-3", "zstd-1", "lz4", "none"],
  "zstdDictIds": ["oc-sync-msg-v1", "oc-sync-meta-v1"],
  "maxWindowLog": 20
}
```

Pick highest mutually supported preference order: `zstd-3+dict` → `zstd-3` → `zstd-1` → `lz4` → `none`.

### 9.3 Dictionaries

Train offline dictionaries on representative corpora:

- `oc-sync-msg-v1` — message/part JSON shapes,
- `oc-sync-meta-v1` — session/project meta.

Distribution:

- Ship well-known dicts in the app (content-addressed `dictId`),
- or send dict once via Zstd skippable frame / out-of-band dict object at session start (dictionary-in-stream pattern),
- peers must reject unknown dict ids rather than guessing.

Dictionary compression is especially important because sync records are often small JSON — raw zstd without dict underperforms.

### 9.4 Framing

```text
SyncFrame {
  u8  flags          # codec | priority | final
  u8  codec          # 0=none 1=lz4 2=zstd
  u32 dictId         # 0 if none
  u32 plainLen
  u32 compLen
  bytes payload      # codec frame(s)
  u32 crc32c         # of payload
}
```

Rules:

- Never compress payloads `< 64` bytes.
- One SyncFrame ≤ 256 KiB compressed (split larger objects).
- Encrypt **after** compression (compress → encrypt → hash/address), classic order for ratio; AEAD seals compressed bytes.
- Independent frames so receivers can parallel-decompress and resume mid-stream.

### 9.5 Adaptive mode

Monitor `bytes_out / cpu_ms` and RTT:

- High RTT / low bandwidth → raise zstd level toward 5–7 for bulk history.
- High CPU / thermal / battery (mobile) → drop to `zstd-1` or `lz4`.
- LAN / loopback → prefer `lz4` or `zstd-1` (ratio less valuable).

## 10. Transport

### 10.1 Preference order

1. **Direct QUIC** (preferred on desktop/native) or **WebRTC DataChannel** (web/mobile reach).
2. **Existing private relay mux** (E2EE already) if both peers already know a host path — only when syncing through a reachable host is intentional.
3. **Account encrypted relay** (rendezvous-operated TURN-like ciphertext forwarder) as last resort.

### 10.2 Security properties

- Mutual device authentication via signed device certs bound to `accountId`.
- Per-session ephemeral ECDH → AEAD (ChaCha20-Poly1305 or AES-GCM).
- Scope ACL: peer may only request scopes the user enabled for that device.
- Rate limits + max object sizes; reject pathological windows/dicts.
- Never log tokens, ARK/SMK, pairing/account secrets, or message plaintext.

### 10.3 Runtime placement

| Runtime | Role |
|---|---|
| `packages/web` server | Sync Engine host, Vault storage under `OPENCHAMBER_DATA_DIR/sync/`, apply to OpenCode |
| `packages/electron` | Privileged key storage, background sync, deep-link account link confirmations |
| `packages/ui` | Scope picker UI, progress, conflicts; **no** raw secret handling in render paths |
| `packages/mobile` | Thin peer: can hold Vault subset or act as sync client to a desktop peer; Keychain for device keys |
| `packages/vscode` | Consume synced data only via connected OpenChamber host; not a first-class sync peer in v1 |

## 11. Module ownership (proposed)

```text
packages/web/server/lib/sync-p2p/
  identity-client.js      # talk to Identity/Rendezvous
  vault/                  # object store + indexes
  engine/                 # reconcile, transfer, apply
  compress/               # zstd/lz4 framing
  transport/              # quic/webrtc/relay adapters
  DOCUMENTATION.md

packages/ui/src/sync-p2p/   # UI-facing status store + hooks (thin)
packages/ui/src/components/settings/…  # scope + account UI (later)
```

Keep entrypoints thin; domain logic in `sync-p2p`. Do not overload `packages/ui/src/sync` event reducers with peer protocol — bridge via explicit import/apply APIs so live OpenCode sync invariants stay intact.

## 12. API sketch (local host)

Account & devices:

```text
POST   /api/account/login/start
POST   /api/account/login/finish
POST   /api/account/devices/approve
GET    /api/account/devices
DELETE /api/account/devices/:id
```

Scopes & sync:

```text
GET    /api/sync/scopes
PUT    /api/sync/scopes/:id          # selection + enabled peers
POST   /api/sync/scopes/:id/run      # one-shot
GET    /api/sync/status
GET    /api/sync/conflicts
POST   /api/sync/conflicts/:id/resolve
```

Internal peer protocol is **not** REST; it is the framed binary sync session described above, reached after signaling.

## 13. UX requirements (product)

1. Settings → Account: social login buttons + passkey + device list.
2. Settings → Sync: choose **Selected projects** / **Everything**; project multi-select; “include related chats” toggle (default on).
3. Per-project overflow: “Sync this project…”.
4. Status: last sync time, peer name, bytes, conflicts.
5. First-link path mapping wizard when projectKey has no local path.
6. Explicit consent before any full-corpus export to a newly trusted device.

Copy and settings search must follow locale + settings UI skills when implemented.

## 14. Efficiency targets (acceptance)

| Scenario | Target |
|---|---|
| Already-in-sync peers, idle | ≤ 2 RTT + ≤ 2 KiB control |
| Catch-up 100 small chat messages | wall time dominated by RTT; payload ≪ raw JSON via zstd+dict |
| Initial project history 500 MB logical | sustained ≥ 50–80% of path bandwidth after handshake; full resume support |
| Mobile thermal | auto downgrade codec; no UI freeze (apply off main thread / server-side on host) |
| Partial failure | other scopes continue; failed scope retains prior Vault root |

## 15. Phased delivery

### Phase 0 — Spec + threat model (this doc)

### Phase 1 — Account identity MVP

- Identity Service + Google/GitHub/(Apple) login
- Device certs + ARK recovery via passkey
- No sync yet; “Signed in” settings surface

### Phase 2 — Vault + one-shot P2P transfer

- Project scope export/import between two devices
- Direct transport + relay fallback
- Zstd streaming frames + dicts

### Phase 3 — Continuous scoped sync

- Merkle reconciliation, live deltas, conflict UI
- Multi-project + full scope

### Phase 4 — Hardening

- Mobile peer optimizations, adaptive compression, auditing, quota, corrupt-object repair

## 16. Threat model (summary)

| Threat | Mitigation |
|---|---|
| Honest-but-curious rendezvous | E2EE data plane; ciphertext relay only |
| Stolen device | Device revoke; scope rewrap; remote wipe flag for Vault |
| Account OAuth compromise | Device approval step; step-up for new device; recovery key |
| Malicious peer on account | Still limited to granted scopes; apply path validates schema |
| Rollback / fork | Monotonic clocks + signed roots; detect diverged history |
| Compression oracles | Encrypt after compress; fixed framing; no error side-channels on secrets |

## 17. Open questions

1. **Hosted Identity/Rendezvous**: operate as `account.openchamber.dev` vs self-hostable package? (Recommendation: hosted MVP + documented self-host later.)
2. **Should mobile hold a full Vault** or only a cache synced from desktop peers? (Recommendation: cache + selective project subset.)
3. **Include worktree session topology** in project scope automatically? (Recommendation: yes if worktree maps to same projectKey.)
4. **Opt-in provider secret vault** timeline — keep firmly out of v1.
5. **WebRTC-only vs QUIC-native** for Electron — prefer QUIC native where available, WebRTC for browser/mobile.

## 18. Compatibility with current architecture

Must remain true after P2P lands:

1. Classic Pairing v2 + `oc_client_` remote UI still works without an account.
2. Private relay remains a reachability feature, not a plaintext sync database.
3. `packages/ui` live session sync continues to treat local OpenCode as live authority for busy/status/streaming tokens.
4. Runtime switch / directory cache isolation unchanged.
5. No dependency added until an implementation phase explicitly requests it (zstd/lz4 native bindings, WebRTC stack, etc.).

## 19. Validation plan (when implementing)

| Change class | Validation |
|---|---|
| Vault/engine unit tests | reconcile, tombstones, resume, compress framing |
| Transport integration | direct + relay fallback; reconnect resume |
| Apply path | failure ≠ empty; revision/tombstone cases; multi-project isolation |
| Account/device | revoke, unknown dict, scope ACL deny |
| Perf harness | corpus fixtures; zstd/lz4 adaptive switches |
| Docs | owning `DOCUMENTATION.md` under `sync-p2p` |

Docs-only acceptance for **this** PR: reviewable spec accuracy against current auth/sync/relay realities.

## 20. Summary decision record

| Decision | Choice |
|---|---|
| Topology | Hybrid P2P (central identity/signaling, E2EE data plane) |
| Identity | Social + passkey OpenChamber Account |
| Scope | Project / multi-project / full + related chats |
| Store | Content-addressed Sync Vault beside OpenCode |
| Live agent status | Still local event stream, not sync history |
| Compression | Zstd streaming (+dicts) default; LZ4 control/low-latency; adaptive |
| Encryption order | compress → AEAD encrypt → address |
| Code home | `packages/web/server/lib/sync-p2p` + thin UI status |

---

## Appendix A — Mapping to existing modules

| Concern | Existing anchor |
|---|---|
| Live session sync invariants | `packages/ui/src/sync/DOCUMENTATION.md` |
| Stores / failure≠empty | `packages/ui/src/stores/DOCUMENTATION.md` |
| UI + client tokens | `packages/web/server/lib/ui-auth/DOCUMENTATION.md` |
| Pairing / remote clients | `packages/web/server/lib/client-auth/` |
| E2EE tunnel patterns | `packages/web/server/lib/relay/DOCUMENTATION.md` |
| Event transport | `packages/web/server/lib/event-stream/DOCUMENTATION.md` |
| Project ids today | `packages/ui/src/lib/projectId.ts` |

## Appendix B — Example scope document

```json
{
  "id": "scope_proj_work",
  "kind": "projects:set",
  "projectKeys": ["pk_8f3a…", "pk_12cd…"],
  "includeRelatedSessions": true,
  "includeSessionFolders": true,
  "includeGoals": true,
  "includeSettingsSlices": ["projects", "sessionFolders"],
  "peers": ["dev_aaa", "dev_bbb"],
  "mode": "continuous"
}
```

## Appendix C — Example compression negotiate

```json
{
  "type": "compress.offer",
  "prefer": ["zstd-3+dict:oc-sync-msg-v1", "zstd-3", "lz4", "none"],
  "maxWindowLog": 20,
  "maxFrameCompBytes": 262144
}
```

```json
{
  "type": "compress.accept",
  "selected": "zstd-3+dict:oc-sync-msg-v1",
  "maxWindowLog": 20
}
```
