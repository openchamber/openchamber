# Phase 2 — V2 Durable Foundation

## Goal

Provide fail-closed Linux/POSIX storage and protocol primitives for Web-daemon restart handoff without connecting them to a running process.

## Phase 2A scope

- Dedicated 32-byte v2 master secret in a private `0700` root with `0600` secret/evidence files, symlink/mode/length rejection, exclusive durable initialization evidence, and no record-check/create race.
- Dedicated v2 SQLite database with WAL, FULL synchronous mode, busy timeout, exact strict schema/index/metadata validation, fatal parent-directory fsync, malformed-row rejection, authoritative transactional time, and `BEGIN IMMEDIATE` revision/MAC/lease CAS.
- V2 records signed from derived keys; reservation creates a random incarnation and public fingerprint only. Opaque material is armed before an unexpired `reserved -> launch-delivering` CAS, then delivered only while that fenced state remains authoritative before it completes to `launching`.
- Active renewal is bounded from transaction-authoritative time; expiry and callback failure revoke in-flight material. Public terminal transitions cannot win during `launch-delivering`.

## Exclusions

No guardian, process spawn, signals, ports, health probes, registry/reaper integration, lifecycle/startup/shutdown/CLI/routes, Electron, VS Code, UI, v1 changes, handoff/adoption implementation, or session resume.

## Acceptance gates

- Concurrent first secret creation converges on one valid secret.
- Unsafe, symlinked, nonregular, malformed, or wrong-length secret/store state fails closed.
- SQLite CAS rejects stale, expired, or malformed authority state atomically.
- SQLite initialization converges across independent opens and rejects altered constraints, indexes, triggers, views, or metadata.
- Schema validation rejects user trigger/view/index names that resemble SQLite internal names, such as `sqliteEvil`.
- Both worker-thread and independent OS-process initializers converge on one valid SQLite schema.
- Cleanup only removes expired records; valid terminal records remain authoritative until their lease expires.
- Records and diagnostics never serialize raw master or credential material.
- Tests use temporary paths/databases only and create no real OpenCode child or network/process side effects.

## Second Phase 2A remediation result

- Credential material is armed before a durable `reserved -> launch-delivering` fence. A terminal mutation either wins before the fence and prevents callback delivery, or is rejected while the fenced callback completes to `launching`.
- Renewals derive expiry from store-authoritative current time and reject an unbounded horizon.
- Durable master-initialization evidence closes the record-check/create race; a secret-only root without evidence is corrupt and fails closed. Deleted-root loss of evidence remains documented.
- SQLite initialization retries concurrent locking, verifies exact schema/metadata, rejects `sqliteEvil` lookalikes, and treats POSIX directory-fsync failures as fatal while dispatching Windows durability and permission checks to its ACL trust boundary.
- Focused tests cover deterministic delivery fencing, real provider+SQLite+protocol MAC tamper/reopen behavior, worker-thread and OS-process initialization, and actual secret-provider fsync failure.
- Final validation passed: focused v2 tests (25), unchanged v1 tests (19), source syntax checks, `type-check:web`, `lint:web`, and `docs:validate`. `dead-code` remains non-blocking and reports repository-wide findings plus intentionally unwired v2 entries.

Phase 2B remains blocked pending native security review disposition; this work does not authorize lifecycle or runtime wiring.
