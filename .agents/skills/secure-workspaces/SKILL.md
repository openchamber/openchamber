---
name: secure-workspaces
description: Use when changing Secure Workspaces policy, lifecycle, providers, isolation, egress, credentials, workspace auth or transport, export/review/apply, handoff, plugin pins, runtime images, release workflows, or files under the web workspace modules and shared workspace UI.
---

# Secure Workspaces

## Read First

Read the sources that own the touched boundary before editing:

1. `docs/SECURE_WORKSPACES_SPECIFICATION.md` for the authoritative product, security, provider, and release contract.
2. `packages/web/server/lib/workspaces/DOCUMENTATION.md` for the server trust boundary, lifecycle, artifact, apply, and handoff invariants.
3. `packages/electron/README.md` for plugin staging and packaged-payload verification when Electron dependencies or packaging change.
4. `../opencode-container-workspace/README.md` when the sibling plugin checkout is available and provider, image, or plugin contracts change.

Also load every other matching skill. Common combinations are `openchamber-change-discipline`, `ui-api-decoupling`, `desktop-shell`, `relay-transport`, `settings-ui-patterns`, and `locale-ui-patterns`.

## Ownership Map

| Boundary | Owner |
|---|---|
| Provider implementation, snapshots, provider state, runtime auth proxy, image contents | `opencode-container-workspace` |
| Persisted policy, privileged operations, reconciliation, export cache, host apply, handoff | `packages/web/server/lib/workspaces` |
| OpenCode configuration and reserved-plugin mutation protection | `packages/web/server/lib/opencode` |
| Shared lifecycle, review, apply, settings, and navigation UI | `packages/ui` |
| Native authority and exact packaged plugin payload | `packages/electron` |
| Unsupported VS Code behavior | `packages/vscode` |
| Product and release contract | `docs/SECURE_WORKSPACES_SPECIFICATION.md` |

Keep entrypoints, routes, bridges, and UI thin. Security decisions belong in the owning server or provider boundary.

## Non-Negotiable Invariants

### Authority And Identity

- Persisted server policy is authoritative. Never let browser input select source directories, image references, Kubernetes contexts/namespaces, provider metadata, resource IDs, or cleanup targets.
- Keep OpenCode control-plane workspace identity distinct from immutable provider resource identity.
- Recompute canonical resource names. Do not trust persisted or request-provided names without canonical verification.
- Verify provider, project, resource ID, role, and original audit identity before target, restart, export, rotation, reconciliation, or deletion.
- A missing or failed provider query is not authoritative empty state. Preserve unrelated valid entities and report partial failure explicitly.

### Isolation And Egress

- Runtime images execute workspace code; gateway images enforce outbound policy. Do not combine these trust roles.
- Runtime containers must not have direct fallback egress. Use the managed gateway or an explicitly configured external proxy.
- The gateway must not receive project mounts, workspace credentials, provider state, or arbitrary process helpers.
- Keep images immutable and digest-pinned. Do not introduce `latest`, tag-only production defaults, silent pull fallback, or platform fallback.
- Provider differences must be explicit. In particular, Apple Container must never silently fall back to Docker, and unsupported managed networking must fail closed.

### Secrets And Transport

- Keep workspace credentials file-backed and provider-owned. Never place secret values in CLI arguments, ordinary environment variables, metadata, diagnostics, URLs, logs, or browser payloads.
- Seed secret volumes through bounded redacted stdin. Never bind-mount private host secret directories into helpers.
- Preserve authenticated HTTP, SSE, and WebSocket behavior. The host shim strips caller routing/auth headers, verifies the fixed provider target, rereads the canonical token, and injects it only upstream.
- Do not treat loopback source address as remote-client authority. Relay and tunnel traffic can arrive through loopback.

### Lifecycle And Failure

- Create is journaled and rolls back only resources proven to have been created by that operation.
- Cleanup is idempotent for absence, refuses foreign resources, and reports retained or unresolved resources instead of deleting the control-plane row.
- Reconciliation may repair only ownership-verified resources and must report each repair.
- Make interrupted create, changed-source recovery, credential rotation, restart recovery, collision handling, retention, and cleanup behavior explicit.
- Never hide rollback or cleanup failure behind a successful UI state.

### Export, Apply, And Handoff

- Export produces the bounded structured artifact contract. Do not reintroduce raw patch, browser-supplied content, or browser-owned apply decisions.
- Host apply uses server-cached exact bytes, server-issued selection IDs, project locking, baseline conflict checks, staging, durable journals, rollback, and startup recovery.
- Successful mutating apply consumes the artifact; dry-run and failed apply preserve it until expiry.
- Session handoff preserves the source, refetches authoritative complete history, rejects stale review, and never persists transcript text in its journal.

### Runtime And Packaging Parity

- Web, Electron, hosted mobile, and Capacitor share the server contract. VS Code remains intentionally unsupported until its complete privileged boundary exists.
- Generic settings/plugin routes must not mutate Secure Workspace policy or the reserved plugin identity.
- Electron packages the exact pinned plugin payload. Do not bypass staging or final payload verification.

## Change Method

Before implementation, state which trust boundary changes and answer:

- What input is authoritative?
- Which persisted or provider resources already exist?
- What remains valid after the first failure?
- What is rolled back, retained, or retried?
- How is foreign-resource refusal tested?
- Which runtimes intentionally differ?

Prefer the smallest change in the owning module. A UI restriction is never a substitute for server/provider enforcement.

## Validation

Use package scripts as the command source of truth and validate the real risk:

| Change | Required evidence |
|---|---|
| Server policy, routes, permissions, lifecycle, artifacts, apply, handoff | Focused workspace/opencode tests, server JS syntax checks, and affected package type-check/lint |
| Shared UI or Runtime API | Focused UI/runtime tests, UI type-check/lint, and intentional web/Electron/mobile/VS Code behavior |
| Provider core | Unit tests plus package build/lint/type-check; live provider lifecycle for platform behavior |
| Auth, SSE, WebSocket, proxy, or egress | Authenticated and unauthenticated live paths; direct and applicable relay paths; negative network assertions |
| Kubernetes | Port-forward or final HTTPS target as applicable, NetworkPolicy, ownership, rollback, reconciliation, and cleanup |
| Apple Container | Supported macOS host, immutable arm64 image, create/target/export/reconcile, collision, system restart, and cleanup |
| Runtime/gateway images | Both architectures, exact digest, runtime smoke, HIGH/CRITICAL fixed-vulnerability gate, and anonymous pull when public |
| Plugin pin or Electron packaging | Lockfile/install verification, staging tests, package verification, and affected packaged build/smoke |
| Source/export/import shape | `bun run dead-code` in addition to affected checks |

Static checks do not prove isolation, transport, provider, rollback, or platform correctness. Do not claim those gates without live evidence.

## Release Discipline

- Do not tag until branch tests, both image architectures, vulnerability gates, Docker live, and Kubernetes live are green.
- Before the first release, require registry preflight to prove public anonymous exact-digest pulls for runtime and gateway.
- Publish from a final reviewed plugin commit, sign exact digests, verify signatures/attestations, and record both digests.
- Pin OpenChamber to the final plugin Git SHA and image digests, then verify Electron staging/package contents.
- Call the result `image/provider milestone ready` until the deferred native platform and signing matrix is complete.

## Red Flags

- Browser-selected path, image, context, namespace, resource name, or apply content.
- Tag-only image, mutable default, direct egress, or silent provider fallback.
- Runtime and gateway combined or gateway given workspace mounts/secrets.
- Secret in args, env, metadata, URL, logs, or diagnostics.
- Delete/restart/export before ownership verification.
- Fetch failure converted to an empty list or successful cleanup.
- Control-plane row removed while provider resources remain.
- Static tests presented as proof of live provider or transport security.
