# Bots UI

## Ownership

This module owns the project Bots page, editable definitions, item admission and
detail, archive, repository-policy review, identities, and the attention-only
sidebar section. The server owns execution, approvals, credentials, item state
and recorded operations; see `packages/web/server/lib/bots/DOCUMENTATION.md` and
`runtime-contract.md`. Network parsing and session membership are described in
`packages/ui/src/lib/bots/DOCUMENTATION.md`. Visual constraints live in `DESIGN.md`.
Shared account reads and attention selection live in hook-only modules so
component exports remain compatible with Fast Refresh.

Web and Electron open the lazy project-rail page. Hosted mobile and Capacitor
open the same feature inside the mobile full-screen surface. VS Code has no
Bots server: its entry is absent, and direct view/API use reports unsupported.

## Invariants

- Definitions expose the editable server configuration, including independent
  stage models and MCP rules. Machine approvals never enter a config write.
- Isolated definitions retain explicit place, network and provider-source references.
  `BotSpaceFields` probes inventories only after the existing Spaces switch says on,
  preserves partial-read failures and hidden drafts, and permits no typed secret.
  The host projection is documented in `packages/web/server/lib/bots/space-options.md`.
- Discord destinations are an explicit per-bot list of guild/channel ID pairs.
  The Execution form preserves IDs as text and adds/removes whole pairs. An
  empty list selects no channel; approved people's DMs remain server-governed.
- Reads belong to one mounted runtime/project visit. A failed refresh retains
  that owner's last result with an error; changing the owner hides old data
  immediately. A confirmed replacement invalidates older in-flight reads.
- Refreshes come from the shared control stream and explicit user actions.
  The visible detail owns its refresh subscription while the parent list is
  hidden. No bot polling or background per-project fan-out is introduced.
- Mutations are explicit and serial per form. Failure leaves the editable draft
  on screen. Config persistence can succeed before scheduler synchronization
  fails, so errors tell the user to refresh before retrying.
- Identity forms keep secret inputs only in mounted React state, clear them
  after a submission, and never hydrate them from a response. Managing identities
  preserves the bot draft; closing that dialog refreshes identity choices.
  Jira OAuth forms edit public site/cloud/client IDs and require a fresh client
  secret for replacement. Switching kinds clears the mounted secret too.
- Proof absence, failed/inconclusive proof, judge reasons, retained waits,
  transitions, stage sessions, diff and recorded operations remain inspectable.
  Archive detail reads the item-detail route for retained evidence, stage reports
  and diff. Resume, answer and stop controls remain absent.
- Stage session links use the current detail's validated `sessionDirectories`
  entry for that exact session ID. Missing addresses disable the link, including
  before detail loads and in archive views without a valid projection. An initial
  detail failure grants no navigation authority.
- The mobile Bots body owns vertical scroll. A project or view-identity change
  starts it at the top before paint, including the project picker. Editor/item
  IDs, archive mode, create mode and the selected list tab define navigation;
  resource refreshes and edits within the same form preserve scroll. Desktop
  retains the shared `ProjectRailPage` scroll behavior.
- Policy approval requires a reviewed fingerprint and visible content. Missing
  reviewable people content blocks approval rather than trusting an empty list.
- `useUIStore.botsPageTarget` is a one-shot `{ projectId, itemId?, botId? }`
  navigation target, consumed after the project snapshot resolves. `botId` opens
  the exact definition for managed scheduled rows. Runtime switches retire the
  target, and main-page transitions close Bots atomically.

## Decisions

### Why the mobile scroll owner receives view changes

The list, editor and item detail share one persistent body. Keeping its prior
offset clipped the new page's controls under the fixed mobile header. The owner
resets through its own ref when scalar navigation identity changes; refreshed
snapshots and edited draft objects do not move the reader's position.

### Why session addresses come from detail and not the item worktree

The item worktree describes the host checkout. An isolated stage can run under
a different directory, so each link needs the server-captured address for its
session. Without that address navigation remains disabled, avoiding the shared
session opener's active-directory fallback. Archived inspection uses the same
detail projection, so retained reports and diff stay readable while session
navigation requires the server-projected address for each session.

### Why visit-local resources and not a Bots store

Only the shown project needs a full read. Sidebar attention already has durable
server notifications and a live blocking-request index, so another global cache
would duplicate authority and require another reset/reconciliation protocol.

### Why explicit content review and not fingerprint-only approval

A fingerprint identifies bytes but does not let a person review them. The policy
route supplies `people.content` for review before approval, while routing identities
remain unavailable until that exact fingerprint is approved. Missing reviewable
content disables the approval action.

### Why suggestion handoff remains with the source owner

`BotItemCreate.initial` carries source identity and evidence into admission, but
it does not reserve or convert a suggested task. The suggested-task owner must
connect its server-owned idempotent conversion; direct UI mutation of suggestion
status would lose the cross-feature transaction.

## Coordinator integration and QA

The shared stream parser accepts `openchamber:bots-changed` and
`openchamber:bot.item.changed` envelopes with `properties.projectId`. The server
must forward its bot invalidations into that existing authenticated control
stream. Only the named visible project refreshes.

Durable attention entries must have `kind: 'bot'`, `resolvedAt: null` and
`action: { type: 'bots', projectId, itemId }`; read state alone does not settle
them. The server resolves them when attention ends. Blocking session requests
come from the live request index, including requests on unmarked descendants.

The coordinator owns suggestion conversion and managed scheduled-row links;
their existing editors were excluded from this worker's file ownership. A
managed row sets `botsPageTarget` and opens the desktop page or mobile Bots
action instead of editing the server-managed scheduled definition.

Focused tests cover the HTTP boundary, membership, read authority, evidence,
atomic page transitions, managed targets, archive waits, and real form-to-HTTP
bot creation/editing. Combined runtime QA still needs the coordinator's server:
create/edit a bot and source item, review and approve policy content, create and
replace redacted identities, answer/stop/resume an item, navigate stage sessions,
and observe sidebar attention appear and clear. Verify desktop, narrow mobile,
RTL, both themes, and a runtime switch with a mounted secret form. Unit tests
and per-file diagnostics do not establish that runtime or visual evidence.
