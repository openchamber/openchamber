# Mode 3 — Local Team

**Status:** Planned. Do not start before Mode 2 is usable end-to-end.
**Audience:**
1. Co-located small teams on LAN (ofis).
2. Regulated orgs whose code may not leave the host.
3. Remote teams on a VPN / Tailscale mesh.

**Goal:** Cloud-free team collaboration with one killer capability Mode 2
doesn't have: **live shared AI sessions** (CRDT-backed, with presence and
follow-mode).

Read first: [`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md),
[`TEAMS_OVERVIEW.md`](TEAMS_OVERVIEW.md),
[`MODE_1_INDIVIDUAL.md`](MODE_1_INDIVIDUAL.md),
[`MODE_2_GITHUB_TEAM.md`](MODE_2_GITHUB_TEAM.md).

---

## Non-goals

- Full P2P mesh (host/peer star topology is sufficient at this scale).
- 100+ concurrent peers per host (budget: 10 peers with headroom for 20).
- Federation between hosts.
- A replacement for general chat (Slack, Discord, XMPP).
- Email-based identity, password recovery flows.

---

## Defaults for autonomous runs (additive to Mode 1 + 2)

| Question | Default |
| --- | --- |
| CRDT library | `yjs` + `y-websocket` provider (or in-process host adapter). |
| Identity | Ed25519 keypair per device, stored in OS keychain if available, else `~/.config/openchamber/teams/identity.json` mode `0o600`. |
| Key format | base58 fingerprint for display; full key in storage as base64. |
| Auth model | TOFU (trust on first use). Host admits a peer after verifying fingerprint out-of-band. |
| Transport | WebSocket over TLS. Self-signed cert is fine on LAN; mobile/remote peers use tunnel TLS. |
| Discovery | mDNS opt-in (off by default). QR code / link is the primary join path. |
| Host process | single `openchamber serve --team` command (new flag on existing server). |
| Peer boot | existing web UI, but client sends `X-Peer-Identity` signed nonce on first connect. |
| Shared state scope per session | all messages, plan, drafts, inline annotations, open-file list. NOT: cursor, scroll, typing flags (those are presence). |
| Presence batching | 100ms debounce for cursor/scroll; heartbeat every 5s. |
| Agent identity | agents are first-class members: display name, avatar, can be @mentioned. |
| Message signing | every user action signed with device key; agent actions signed by host. |
| Key rotation | out of scope for Mode 3.0. Revoke-and-rejoin only. |
| Host failure | peers pause with "host offline" banner, reconnect automatically on return. |
| Host state backup | daily SQLite snapshot to `~/.config/openchamber/teams/backups/`; keep last 14. |

---

## Core architectural decisions (locked before coding)

1. **Star topology with a designated host.** One machine runs `serve --team`,
   others connect. No multi-leader replication in Mode 3. This keeps
   state authoritative and auditable. Federation can come later.

2. **CRDT only for session docs, not for global state.** Workspace config,
   members, activity log are host-authoritative, not CRDT. Only the
   actively-shared session document is Yjs.

3. **Presence is ephemeral and NOT in the CRDT.** Cursors, typing, focus
   events travel on a separate WebSocket channel. Keeping them out of the
   CRDT keeps the doc compact and avoids history bloat.

4. **Host coordinates agent turns.** Agents run on the host (or a machine
   designated by the host). Peers don't run their own agents in a shared
   session. This prevents split-brain "two agents replying at once".

5. **Device identity, not user identity.** One person with two laptops has
   two device identities. Display name groups them visually; auth is
   per-device.

---

## Reusable building blocks

- Mode 2's SQLite DB and migration harness (extend, don't duplicate).
- Mode 2's activity log (Mode 3 writes local-team events to the same table,
  `workspace_id = local-<uuid>`).
- Existing WebSocket paths in the web server (PWA bridge already uses WS).
- Mode 2's handoff snapshot — Mode 3 reuses the snapshot format, but adds
  ownership-transfer inside an already-shared session.
- Existing multi-agent runner (renamed conceptually to
  "agent-as-participant"; no new agent framework).

---

## Data model additions

```sql
-- A local-team workspace is a workspace row with github_org_login = NULL
-- and a new local-only metadata blob.
ALTER TABLE workspaces ADD COLUMN local_json TEXT;
-- local_json = { "localId": "uuid", "hostFingerprint": "…" }

-- Device trust list (TOFU).
CREATE TABLE trusted_devices (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  public_key_b64 TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  admitted_by TEXT NOT NULL,            -- host admin login at admit time
  admitted_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (workspace_id, device_fingerprint)
);

-- Pairing invites (short-lived tokens for the QR/URL flow).
CREATE TABLE pairing_invites (
  token TEXT PRIMARY KEY,               -- short opaque string
  workspace_id TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0
);

-- Shared session CRDT doc metadata (the doc itself is Yjs, stored on disk).
CREATE TABLE shared_sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_updated_at INTEGER NOT NULL
);
```

Yjs docs themselves are persisted as files:
`~/.config/openchamber/teams/ydocs/<session_id>.ydoc`.

---

## WebSocket protocol (additions)

Base path: `/ws/team` (new).

**Handshake frames**

```
peer → host : { type: "hello", identity: base58, sig: base64, nonce }
host → peer : { type: "welcome", workspaceId, displayName, role }
```

**Presence frames**

```
peer → host : { type: "presence.cursor", sessionId, path, line, col }
host → *    : { type: "presence.update", peerId, …fields }
peer → host : { type: "presence.heartbeat" }
```

**Shared-doc frames** (opaque Yjs updates)

```
peer → host : { type: "ydoc.update", sessionId, update: base64 }
host → *    : { type: "ydoc.update", sessionId, update: base64 }
peer ↔ host : { type: "ydoc.sync-step-*", … }   // Yjs sync protocol v1
```

**Session ownership frames**

```
peer → host : { type: "session.ownership.transfer", sessionId, toFingerprint }
host → *    : { type: "session.ownership.changed", sessionId, newOwner }
```

**Pairing frames** (outside sessions)

```
peer → host : { type: "pairing.request", invite, identity, fingerprint, sig }
host → peer : { type: "pairing.admitted" | "pairing.denied" | "pairing.awaiting-admin" }
```

All frames are JSON except Yjs updates, which wrap binary updates as base64.

---

## Features

### 3.1 Host mode (`openchamber serve --team`)

**Problem.** Today's server starts in single-user mode. We need a team mode
that exposes the team endpoints and WebSocket.

**UX.** Invisible. Flag on the existing CLI.

**Files.**
- `packages/web/bin/cli.js` — add `--team` flag.
- `packages/web/server/index.js` — mount team routes + `/ws/team` when flag
  is on. If off, Mode 2's team routes still work (GitHub team doesn't need
  the local-team WS).
- `packages/web/server/lib/local-team/bootstrap.js` — starts the WS server.

**Commit plan.**
1. `feat(teams/mode3/host): add --team flag and ws/team mount`
2. `feat(teams/mode3/host): wire bootstrap to open ydoc dir and db tables`

**Open questions.**
- Should `--team` be the default when a local-team workspace exists on
  disk? Default: yes, auto-enable on startup.

---

### 3.2 Device identity + keypair

**Problem.** No auth at all today. Any local-team feature needs a device
identity before anything else works.

**UX.** On first launch, silently generate the keypair. On settings page,
show the fingerprint + "Reset identity" button (with confirmation).

**Files.**
- `packages/identity/` (new package OR `packages/web/server/lib/identity/`;
  default: start under `web/server/lib/identity/` to avoid new workspace).
- Keychain access via `keytar` — **NEW DEP** → surface as a question before
  shipping; fall back to file storage if keytar isn't permitted.

**Commit plan.**
1. `feat(teams/mode3/identity): add keypair gen + disk storage with tests`
2. `feat(teams/mode3/identity): add settings view showing fingerprint`

**Open questions.**
- `keytar` vs file-only: which? Default for the autonomous run: **file-only**
  to avoid the dep. Keychain is an optional upgrade later.

---

### 3.3 Pairing / TOFU admission

**Problem.** How does Bob join Alice's team on first run?

**UX.**
- Host (Alice) opens *Invite* → sees a QR code and a URL + 6-char code.
- Peer (Bob) scans or pastes; his device sends a pairing request carrying
  his fingerprint and signs a host-supplied nonce.
- Alice's UI shows "Admit Bob (fingerprint `a1b2c3…`)? [Accept / Deny]".
- On accept, Bob is added to `trusted_devices`.

**Endpoints.**
- `POST /api/teams/local/invites` — host creates an invite.
- `POST /api/teams/local/pair`   — peer submits pairing.
- `POST /api/teams/local/trust/:fingerprint/admit` — host decision.
- `DELETE /api/teams/local/trust/:fingerprint` — revoke.

**Files.** `packages/web/server/lib/local-team/pairing.js`,
`packages/ui/src/features/local-invite/`,
`packages/ui/src/features/local-trust/`.

**Commit plan.**
1. `feat(teams/mode3/pair): add invite issuing + pair request routes`
2. `feat(teams/mode3/pair): add admit/deny flow + trust storage`
3. `feat(teams/mode3/pair): add invite UI (QR + code) and join UI`

**Open questions.**
- Mutual fingerprint confirmation (peer sees host's fingerprint too) —
  default: yes, display both sides.

**Stuck checks.**
- QR library — will we need a new dep? If yes, BLOCK. Otherwise fall back to
  displayable URL only.

---

### 3.4 Shared session CRDT

**Problem.** Two people in the same AI session must see the same stream of
messages and be able to edit the draft prompt without conflict.

**UX.** *Invite teammate* in any session. Invitee opens a tab, their avatar
appears. Messages, drafts, plan, annotations — all synced.

**Files.**
- `packages/web/server/lib/local-team/ydoc/` — per-session Yjs doc storage
  + sync router.
- `packages/ui/src/features/live-session/` — Yjs binding for the session UI
  (messages list, plan editor, draft input).
- `packages/ui/src/stores/team/live-session.ts`.

**Commit plan.**
1. `feat(teams/mode3/live-session): add ydoc storage + load/save on host`
2. `feat(teams/mode3/live-session): add yjs sync wiring over /ws/team`
3. `feat(teams/mode3/live-session): bind messages + plan + draft to ydoc`
4. `feat(teams/mode3/live-session): add participant avatars strip`

**Open questions.**
- Where does agent output enter the doc — as CRDT edits or as
  host-authoritative appends? Default: **host-authoritative appends** into
  the Yjs doc (the host holds a doc reference and writes to it server-side).
  Rationale: agents produce monotonic, ordered output; no merge needed.
- Draft prompt field — Y.Text. Multiple simultaneous typers work naturally.
- Plan-mode steps — Y.Array of Y.Map, one map per step.

**Stuck checks.**
- `yjs` + `y-websocket` — NEW DEPS. These are unavoidable for this feature
  and explicitly allowed in `IMPLEMENTATION_GUIDE.md`.
- Confirm session state the UI currently reads is a structure we can back
  with Yjs without rewriting the UI. If it's a tightly-coupled zustand
  store, introduce a thin adapter layer — don't rewrite.

---

### 3.5 Presence + Follow mode

**Problem.** Collaborators need to know what each other is looking at;
sometimes one person wants to just "watch" another.

**UX.**
- Live avatars with colored dots + "looking at `src/foo.ts`".
- Click an avatar → *Follow* (next to a *Wave* action). Your view mirrors
  theirs: file open, cursor, diff hunk, terminal output.
- Esc to leave follow mode.

**Files.**
- `packages/web/server/lib/local-team/presence.js` — ephemeral state.
- `packages/ui/src/features/team-presence/`.

**Commit plan.**
1. `feat(teams/mode3/presence): add presence channel + heartbeat`
2. `feat(teams/mode3/presence): add avatar strip with last-seen file`
3. `feat(teams/mode3/presence): add Follow mode + unfollow`

**Open questions.**
- Follow across different worktrees — default: disable follow if the two
  peers' working directories don't match; show a notice.

---

### 3.6 Agents as participants

**Problem.** Mental model: an agent stops being "the session runner" and
becomes "a member who can be @mentioned".

**UX.** Agents have avatars in the participant strip. Typing
`@claude-sonnet …` routes the message to that agent. Multiple agents can
coexist: `@claude plan the change. @gpt5 critique Claude's plan.`

**Files.**
- Extend the existing multi-agent runner on the host side to dispatch based
  on mentions.
- `packages/ui/src/features/agent-mentions/` — autocomplete + rendering.

**Commit plan.**
1. `feat(teams/mode3/agents): route @-mentioned prompts to specific agents`
2. `feat(teams/mode3/agents): render agent avatars in participant strip`
3. `feat(teams/mode3/agents): add mention autocomplete in draft input`

**Open questions.**
- Concurrent agent turns — default: each agent can reply to its own @mention
  independently; no global "one reply at a time".
- Agent policy (who can invoke which agent) — default: every member can
  mention any configured agent; Maintainer+ can restrict via the agents
  config.

---

### 3.7 Session ownership transfer

**Problem.** Even in a shared session, someone has to "own" next-action
responsibility.

**UX.** Owner has a crown icon. *Transfer ownership to …* in the session
menu. Owner also has the final "merge/close PR" control (other participants
see it disabled).

**Files.** `packages/web/server/lib/local-team/session-ownership.js`,
UI rendering of the crown.

**Commit plan.**
1. `feat(teams/mode3/ownership): add ownership field + transfer endpoint`
2. `feat(teams/mode3/ownership): render crown + gate destructive actions`

**Open questions.**
- Forced takeover when owner is offline — default: any Maintainer can
  reclaim ownership after 24h of owner offline. Audited in activity log.

---

### 3.8 Shared context pool

**Problem.** Team skills, prompts, notes, todos, secrets — a single place
for shared context.

**UX.** *Workspace → Context* tab. Four subsections: Skills, Prompts, Notes,
Todos. Secrets are a fifth, Maintainer-only.

**Endpoints.** Extend Mode 2's skills catalog; add three new entity types
(prompts, notes, todos) under a shared `teams/context/*` route prefix.

**Files.** `packages/web/server/lib/local-team/context/`, one file per
entity. UI feature under `packages/ui/src/features/team-context/`.

**Commit plan.**
1. `feat(teams/mode3/context): add prompts + notes + todos tables + routes`
2. `feat(teams/mode3/context): add context UI tab with four subsections`
3. `feat(teams/mode3/context): add Maintainer-gated secrets (encrypted)`

**Open questions.**
- Notes CRDT? Default: yes, Y.Text per note (so two people can edit the
  same note live). Todos and prompts: last-write-wins with optimistic
  concurrency.
- Secrets shared with peers: store encrypted with a workspace symmetric
  key derived from the host's master key. Only Maintainers see them
  decrypted client-side.

---

### 3.9 Team chat (narrow scope)

**Problem.** Workflow-adjacent discussion has nowhere to go unless we
leave the app. But we don't want to build Slack.

**UX.** One chat per repo, plus one workspace-wide. Agents can be
@mentioned; messages can spawn sessions via *Create session with context*.
No DMs, no threads in v1.

**Endpoints.** Chat messages are Yjs docs per channel.

**Files.** `packages/ui/src/features/team-chat/`.

**Commit plan.**
1. `feat(teams/mode3/chat): add per-channel ydoc + message storage`
2. `feat(teams/mode3/chat): add chat UI with code snippet render`
3. `feat(teams/mode3/chat): add "start session from message" action`

**Open questions.**
- Persistence window — default: 90 days. Older messages archived to
  `archive_messages` table; still searchable.
- DMs / threads — explicitly out of scope v1.

---

### 3.10 Local activity feed

**Problem.** The host needs an auditable record of local-team events.

**UX.** Per-workspace activity view. Kinds: member joined/left, session
transferred, branch created, skill modified, trust admitted/revoked.

**Files.** Reuses Mode 2's `activity_events` table with
`workspace_id = local-<uuid>`.

**Commit plan.**
1. `feat(teams/mode3/activity): emit local-team events into activity_events`
2. `feat(teams/mode3/activity): render local activity feed`

**Open questions.**
- Export (CSV/JSON) for audit — default: yes, Maintainer-only button.

---

### 3.11 Local admin UI

**Problem.** Host machine needs a dashboard for managing trust, roles,
workspace settings.

**UX.** Settings → *Local team admin* (only visible on the host).

**Files.** `packages/ui/src/features/local-admin/`.

**Commit plan.**
1. `feat(teams/mode3/admin): add trust list + revoke action`
2. `feat(teams/mode3/admin): add backup/restore controls`
3. `feat(teams/mode3/admin): add "nuke team" flow with confirm`

**Open questions.**
- Backup format — default: zipped `{ db.sqlite, ydocs/, identity.json,
  secrets.enc }`. Restore reverses on the same machine only (fingerprints
  don't transfer).

---

### 3.12 Optional GitHub bridging (for hybrid setups)

**Problem.** A local team may still want to post PRs and comments to
GitHub from within a shared session.

**UX.** Each member links their personal GitHub to their device identity
(Mode 1's OAuth). When posting to GitHub, a selector asks "Post as @bob".

**Files.** Extend Mode 1's multi-account auth; no new server module.

**Commit plan.**
1. `feat(teams/mode3/github-bridge): show "post as" selector in PR actions`
2. `feat(teams/mode3/github-bridge): persist per-device GitHub link`

**Open questions.**
- Auto-detect which device's token to use for a given repo — default: ask
  once, remember per-repo.

---

## Shipping order

1. 3.1 Host mode (plumbing only).
2. 3.2 Device identity.
3. 3.3 Pairing / TOFU.
4. 3.11 Local admin UI (just enough to manage trust list).
5. 3.4 Shared session CRDT. (Biggest feature — expect 2–3 weeks here.)
6. 3.5 Presence + Follow.
7. 3.7 Ownership transfer.
8. 3.6 Agents as participants.
9. 3.8 Shared context pool.
10. 3.10 Activity feed.
11. 3.9 Team chat.
12. 3.12 GitHub bridging.

Do not start 3.4 until 3.1–3.3 are merged and verified. A broken shared
session with no trust layer beneath it is worse than no Mode 3 at all.

---

## Security notes

- All traffic must be TLS. LAN self-signed certs are acceptable but must
  still be verified against stored device keys, not just CA.
- Fingerprint comparison is the *sole* trust anchor. No "skip verification".
- Signed frames: every peer-originated frame carries `sig` over
  `(workspace_id, nonce, hash(payload))`. Host drops frames with invalid
  signatures.
- Rate limits: 100 ops/sec per device per session (well above real use).
- Audit: every ownership transfer, trust admit/revoke, and secret access
  appends to `activity_events`.

## Performance notes

- Yjs doc size: with message history, sessions stay under 5 MB for months
  of use. Archive to append-only JSON once a doc exceeds 10 MB.
- Presence updates: 100ms debounce, 5s heartbeat — well within mid-range
  LAN bandwidth.
- Host supports 10 concurrent peers comfortably; 20 with good hardware.
- Follow mode: viewer-side only rendering difference; no extra server
  round-trips beyond presence channel.
