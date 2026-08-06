# Phase 2A Implementation Plan

## Modules

- `managed-opencode-handoff-v2/secret-provider.js`: owns the raw master in closure, durable initialization evidence, record-MAC derivation, public credential fingerprinting, and opaque one-shot lifecycle credential use.
- `managed-opencode-handoff-v2/store.js`: owns the isolated SQLite file and exposes async read, authoritative-time CAS, cleanup, and close operations with exact schema/durability checks.
- `managed-opencode-handoff-v2/protocol.js`: owns strict v2 record signing and the reserve/armed-delivery-fence/launch/bind/bounded-renew/terminal state machine.
- Shared v2 record validation defines canonical public fields and legal transitions for the store and protocol.

## Failure and cleanup rules

- Arm opaque lifecycle material before `reserved -> launch-delivering` CAS. The callback rechecks its owner-only delivery authority immediately before user invocation; a terminal mutation either wins before the fence or is rejected until delivery completes.
- Zero derived keys and credential buffers in `finally` paths.
- Preserve initialization evidence; never backfill it for an existing secret or overwrite missing/corrupt secret state to recover automatically.
- Require a successful CAS before reporting a state transition.

## Test plan

- Secret provider: deterministic concurrent initialization, evidence-backed missing/corrupt and secret-only failure, unsafe file rejection, actual initialization directory-fsync failure, and one-shot disposal.
- Store: worker-thread and OS-process initialization, exact schema/trigger/view/index/metadata rejection including `sqliteEvil` lookalikes, authoritative CAS timing/horizon, and no credential columns or values.
- Protocol: prearmed delivery fence, deterministic terminal/expiry interleavings, launch/bind identity, bounded renewal, and real provider+SQLite MAC-tamper/reopen coverage.

## Second security remediation completion

- `reserveLaunch()` exposes no credential material. `beginLaunch({ withCredential })` arms opaque material before it CASes to `launch-delivering`; terminal mutations cannot win while that owner-only fence is active, and the callback rechecks authority immediately before invocation.
- Renewal candidates are built from the SQLite transaction's current time and constrained to the configured maximum lease horizon.
- Initialization evidence is atomically/exclusively published before first secret creation. A root retaining that evidence rejects a missing or corrupt secret, and an existing secret without evidence also fails closed; deleting the whole root remains the documented fresh-initialization boundary.
- Store initialization retries SQLite contention across worker threads and independent OS processes, verifies exact approved strict schema/index/metadata shape, rejects `sqliteEvil` lookalikes, and fails on POSIX directory-fsync errors.
- Focused tests use only temporary roots/databases, include independent SQLite opens and real provider+SQLite+protocol MAC tamper/reopen coverage, and do not spawn OpenCode children, bind ports, or signal processes.
- Validation passed: focused v2 tests (25), unchanged v1 handoff tests (19), source `node --check`, `type-check:web`, `lint:web`, and `docs:validate`. `dead-code` completed non-blockingly with repository-wide findings plus isolated, intentionally unwired v2 module entries; no runtime wiring is added to suppress them.
- The local `better-sqlite3` native binding was initially absent; it was rebuilt from the already-declared package before the actual SQLite tests ran. No dependency manifest changed.
