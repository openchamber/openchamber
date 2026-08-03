# Phase 2E — Protected Managed OpenCode Credential Handoff

## Status and baseline

Implementation is present but the phase is not complete. This phase extends the prior web guardian/lifecycle implementation and does not reopen the closed cross-runtime scope.

Baseline (2026-07-31):

- HEAD: `894daff0c1138de3a3f422ee84a00eee5b844438`.
- Current `upstream/main`: `9a0f0b8aa`.
- The existing PR branch has no commits after the specified HEAD.
- Current implementation includes authenticated credential/health handling and a Linux process-boundary script/test with the controlled managed-child fixture.
- Native Windows was not run locally; required Windows evidence must come from hard-gated CI.
- No true bundled OpenChamber web-process E2E exists in this worktree; the controlled fixture/helper must not be represented as a bundled web binary.

## Goal

Preserve a managed OpenCode child’s system-derived Basic Auth credential across web-process boundaries without exposing it through public records or unauthenticated IPC, while retaining correct restart, stop, crash, and guardian-rehydration semantics.

## Security and data contract

- Store one encrypted credential record per managed-child incarnation under the existing ACL/private v2 root. Derive its encryption key from the existing guardian master secret.
- Do not add plaintext SQLite/JSON credentials, logs, or public credential fields. Keep public record fields unchanged unless later evidence proves a change necessary.
- Credential material is system-derived managed-child Basic Auth, not a user-authored/manual value; normal users never receive a raw credential editor or `list` response.
- Authenticated owner-scoped credential IPC must validate `ownerInstanceId`, `runtimeIdentity`, `launchFingerprint`, and `incarnation`. `list` must never include the credential.
- Reject oversized IPC frames before parsing; enforce one bounded limit for credential-related requests and responses.

## Shared resolver and lifecycle contract

- Guardian health and rehydration must use one shared hostname resolver with `launchSpec.hostname` and the stored Basic Auth credential; host and credential derivation must not diverge between paths.
- Before any credential-bearing health request, the guardian must complete the unauthenticated managed-health challenge/proof contract bound to the incarnation, launch fingerprint, and port. Missing or invalid proof fails closed without sending Basic Auth. This is an application-level ownership proof, not OS process attestation; stock OpenCode does not currently implement it, so unsupported password-protected managed runtimes are rejected before credential delivery. Password-free normal health paths remain compatible.
- Adoption selects the exact owner first, verifies health, then retrieves the credential and restores web auth state. Credential retrieval must not occur for a wrong or ambiguous owner.
- Restart detach retains the credential. A confirmed normal stop removes it. A failed or unconfirmed stop retains it for recovery.
- Guardian restart/rehydration must preserve the same incarnation-scoped protections and restore only the exact verified owner.
- Credential operation locks retain their authenticated owner token and process identity through `.lock.remove` quarantine. Exact in-process recovery or authoritative stale-owner recovery may remove only that quarantine artifact; a replacement live lock remains a fence.

## Acceptance gates

### Implementation

- Encrypted per-incarnation storage, master-secret-derived key handling, bounded credential IPC, exact owner validation, and `list` redaction are implemented without plaintext persistence or unnecessary public-field changes.
- The shared hostname resolver is used by both guardian health and rehydration with stored Basic Auth credentials.
- Adoption and stop/restart cleanup follow the lifecycle contract above.
- Windows rehydrated termination opens and retains one process handle, verifies the persisted start-time and launch identity against that handle, and terminates only that handle; unavailable helper/native identity is a fail-closed condition, never a PID-only fallback.

### Tests

- Shared hostname resolver tests pass.
- IPC frame-size limit tests pass.
- Credential lifecycle tests cover encrypted-at-rest behavior, retrieval, retention, confirmed-stop removal, wrong-owner rejection, and redacted listing.
- A password-protected managed-child fixture proves the stored Basic Auth path.
- True web process-boundary E2E covers graceful restart, crash recovery, wrong owner, and guardian restart/rehydration.

### CI, documentation, and validation

- Linux coverage is hard-gated at minimum. Windows covers credential, restart, and owner-mismatch paths; required paths do not use `continue-on-error`.
- Documentation states foreground/systemd semantics: ordinary SIGTERM is stop, while supported `openchamber restart` is the restart contract.
- Focused tests, source syntax, package type-check/lint, docs validation, and final CI evidence are recorded before completion. Injected helper tests do not prove native restart/rehydration; native Windows execution remains an explicit limitation and an open evidence gate.

## Review gate

Phase 2E must remain open until the credential storage/derivation, authenticated IPC and frame limit, shared resolver, lifecycle retention, true web-boundary E2E, required Linux/Windows CI, and foreground/systemd documentation are reviewed and validated. Prior guardian/lifecycle review and baseline CI do not satisfy these gates.

## Retained out-of-scope decisions

VS Code, Electron, mobile, hosted mobile, UI client persistence, and automatic OpenCode session/in-flight-turn restoration remain out of scope. Phase 2E is web-process-boundary credential handoff only.
