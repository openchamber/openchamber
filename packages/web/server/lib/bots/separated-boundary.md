# Separated Bot authority

## Ownership

The front door owns the complete Bot coordinator for host and isolated placement.
Its personal storage holds definitions, policy approvals, items, effect requests,
questions, placement, discovery accounting, provider cursors, notice queues and
tool receipts. Project addresses are opaque strings there. The owner never
constructs the project config runtime or runs Git against a project.

The authenticated agent server supplies the operation-specific execution
contract in `../agent-server/bot-service-contract.js`. It retains identity
secrets, credential resolution, mutation and audit journals, checkout ownership,
host sessions, knowledge and host proof. It constructs no Bot coordinator,
discovery worker or schedule admission. A space server retains its child inbox.

Web and Electron use the owner HTTP routes. Hosted mobile and Capacitor use
those same routes through their existing direct or relay transport. VS Code
constructs no Bot backend. Public UI contracts are unchanged.

## Invariants

- Public `/api/projects/:projectId/bots` control stays on the front door after
  path normalization, even with a selected Space directory. The private
  `/api/openchamber/bot-services` namespace is refused to owner clients. Its
  routes exist only on the authenticated agent server.
- Every execution operation names a registered parent project. Checkout and
  host-session operations additionally require the captured Bot, item, checkout
  key and exact recorded execution identity. A path string alone grants nothing.
- Requests and replies use bounded, operation-specific schemas. Oversized
  policy, snapshots and accounting fail as a whole. No response is clipped into
  an apparently complete success. Credentials never appear in replies.
- Policy delegation returns complete file bytes and explicit missing/unreadable
  states. The owner computes fingerprints, parses rules and applies its own
  approvals. A delegated approval flag or supplied hash grants no authority.
- Service callbacks stay inside the owner process. Agent preflight checks the
  immutable prepared request and credentials without executing content. The
  owner then rechecks its current policy, question and merge generation and
  durably admits dispatch. The agent repeats its execution checks using the
  original descriptor and mutation key. A lost execution response stays
  uncertain and only that descriptor can reconcile it.
- Delegated host proof uses the item's captured placement even if isolation is
  enabled for new work while its fixing stage runs.
- Host and isolated notices retain owner queues and deterministic message IDs.
  Both recheck `notices.assertDispatch` before synthetic delivery. A host queue
  uses typed session operations and cannot fall through to generic project HTTP.
- The owner pulls host tools only for its recorded fixing session. Metadata is
  a wake hint; startup also pulls. A durable owner receipt precedes settlement,
  so losing settlement repeats the receipt without repeating the tool.
  Interrupted dispatch receipts remain attention until their original effect
  is reconciled. Session identity cannot be borrowed from another item.
- Isolated stages use the owner's Spaces manager, grants and dispatcher.
  Code transfer binds the owner-captured source to the allocated Space and
  retains the existing mirror, quarantine and promotion checks. A reported SHA
  without that association grants no adoption authority.
- Owner Bot scheduling uses the existing occurrence and claim protocol in
  Bot-only mode. It runs no ordinary worktree/session cleanup or repository loop
  discovery. The agent excludes Bot rows before claiming occurrences. Internal
  Bot watches stay owner-local; public automatic PR loops keep agent routing.
- Shutdown stops admission and drains Bot effects and dedicated queues before
  closing Space and agent transports. A failed owner operation has no local
  project fallback.

## Decisions

### Why host placement shares the owner coordinator

Placement can outlive a config edit and a restart. Keeping both placements with
one control owner preserves their immutable effect keys and captured placement;
two coordinators would compete over questions, schedules and publication.

### Why preflight and execution are separate

Credentials and provider configuration can fail before a write. A separate
preflight keeps those requests repairable while prepared, without a callback
from the agent into owner authority. Once dispatch is admitted, failure is
conservative and recovery reads the original effect.

### Why local adapters remain

Single-account installations already have the required project and credential
owners. Injecting the separated execution services preserves that composition
without routing local work through a second HTTP server.

## Validation

`separated-owner.test.js` checks owner-computed policy hashes, refusal of changed
or omitted approved files, bounds, a disposable approval-check mutation, host
tool settlement replay and typed host notice delivery. It uses temporary storage
and controlled execution owners. It establishes no account permissions, live
provider authentication, model inference or container isolation.

`host-notice-recovery.test.js` reproduces unavailable-agent activity without a
later idle event, typed delivery refusal and shutdown during a held typed send.
It checks timer recovery, retention of an undelivered notice and settled queue
persistence before transport shutdown.

`separated-composition.test.js` runs the real owner composition and typed agent
HTTP services through investigation, correction, proof, judgment, publication,
PR-watch attachment, restart and Stop for both placements. A lost PR result
recovers its original mutation key without another write. Checkout, provider and
process peers are controlled; isolated stages use the actual SDK/dispatcher
adapter. The separate transfer tests exercise real Git and bundle quarantine.

From the repository root, run
`node packages/web/server/lib/bots/separated-process.driver.mjs`. It starts real
owner and agent `index.js` processes with temporary HOME/data directories and a
controlled OpenCode peer. It checks authenticated owner control, private-route
refusal, exact delegated policy approval, pre-dispatch attention, offline state
retention, restart and graceful shutdown. Its deliberate missing-identity
scenario performs no provider write, checkout or Space allocation.

The operation and transfer suites beside their owning modules cover their
request/reply and Git boundaries. The offline installer owns migration; a
running agent snapshot cannot establish owner authority. Live provider flows,
Spaces runtime grants and the separate-account filesystem boundary require the
authorized runtime checks described by those modules.
