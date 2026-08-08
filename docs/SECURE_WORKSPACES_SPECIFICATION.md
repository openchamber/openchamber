# Secure Workspaces Production Specification

Status: authoritative implementation and release specification
Last audited: 2026-07-31

## 1. Purpose

Secure Workspaces provides isolated OpenCode execution environments managed through OpenChamber. A workspace runs its own OpenCode server and isolated project copy in Docker, Kubernetes, or Apple Container. OpenCode remains the control plane and routes workspace-owned sessions and requests to that server. OpenChamber owns policy, product UX, privileged host operations, reviewed change export, and release integration.

This document is the only authoritative Secure Workspaces plan and acceptance contract. It replaces the former personal requirements, handoff, copied requirements, and test log. Historical command output is not evidence that the current implementation satisfies this specification.

The target is one complete production product. Work may proceed through explicit certification milestones, but a milestone does not waive a final release gate and MUST NOT be described as full production readiness. There is no reduced security baseline.

## 2. Normative Language And Completion Rules

- **MUST** and **MUST NOT** define release-blocking requirements.
- **SHOULD** permits deviation only when the reason and compensating control are recorded in this document.
- Code presence is not evidence of correctness.
- A requirement is complete only when implementation, focused automated coverage, relevant live validation, and documentation agree.
- Static type-checking and linting do not prove provider, security, recovery, packaging, or platform behavior.
- A historical smoke result does not validate a later plugin commit, OpenCode version, dependency pin, image digest, or packaged application.
- Provider failure MUST NOT become an authoritative empty result. Absent provider
  tooling is distinct from provider failure: when a provider's CLI or configuration
  is not present on the host, that provider cannot own resources there, so discovery
  returns an authoritative empty result. Tooling that is present but failing (daemon
  unreachable, cluster unreachable, malformed output) MUST still surface as an
  explicit failure. Availability is reported by provider validation, not by discovery
  errors.
- Partial success, cleanup failure, rollback failure, stale data, and unsupported platform behavior MUST be explicit.
- No release may be described as production-ready while a security, host-integrity, recovery, image, packaging, or required-platform gate remains incomplete.

## 3. Product Scope

### 3.1 Providers

The production product MUST support:

- Docker;
- Kubernetes;
- Apple Container.

All providers MUST implement the same common guarantees:

- isolated mutable workspace storage;
- an immutable seed-time baseline unavailable to the runtime for modification;
- authenticated workspace OpenCode access;
- deterministic provider resource identity and ownership;
- conservative runtime hardening;
- controlled egress;
- transactional create and rollback;
- idempotent cleanup;
- restart reconciliation;
- authenticated health validation;
- changed-file export including binary and untracked content;
- explicit unavailable, degraded, inconsistent, and cleanup-failed diagnostics.

Apple Container is a production provider on supported macOS hosts. It MUST be reported as intentionally unsupported on other platforms. The product MUST NOT silently fall back to Docker when Apple Container is selected.

### 3.2 OpenChamber Surfaces

Secure Workspaces MUST be fully functional in:

- Web;
- Electron Desktop;
- hosted mobile;
- Capacitor mobile.

VS Code is intentionally unsupported for provider management and host apply in this product scope:

- the Workspaces settings and workflow surfaces MUST be hidden in VS Code;
- the VS Code Runtime API MUST return a stable explicit unsupported result;
- contract tests MUST prevent accidental partial exposure or privileged host operations.

### 3.3 Project And Filesystem Support

The product MUST support:

- clean Git repositories;
- dirty Git repositories with staged, unstaged, and untracked seed content;
- directories without Git;
- text and binary files;
- additions, modifications, deletions, exact renames, file-mode changes, and symlinks;
- paths with spaces, quotes, leading dashes, and valid Unicode;
- explicit limits and actionable errors for oversized projects or artifacts.

### 3.4 Review And Apply

The product MUST provide:

- visual file diffs;
- file selection;
- text-hunk selection;
- whole-file binary selection;
- downloadable export artifacts;
- conflict validation;
- dry-run;
- explicit user confirmation;
- all-or-nothing host mutation;
- rollback on runtime failure;
- durable recovery after an OpenChamber process crash.

Binary changes MUST NOT expose fake hunk selection. Rename, symlink, and mode changes MUST be represented as complete logical operations.

## 4. Repositories And Ownership

### 4.1 OpenChamber

Repository: `openchamber/openchamber`
Local checkout: `/Users/iivashko/projects/openchamber`

OpenChamber owns:

- persisted product settings and policy UX;
- workspace list, status, create, reconcile, remove, session, and review UX;
- official OpenCode SDK consumption;
- live workspace state and runtime-switch invalidation;
- provider validation and plugin activation orchestration;
- host-admin capabilities and reauthentication;
- server-side export artifacts;
- visual review data;
- host conflict checking and atomic apply;
- artifact download and expiration UX;
- Electron staging and package verification;
- web, desktop, hosted-mobile, and Capacitor behavior;
- user-facing errors, localization, and accessibility.

OpenChamber MUST NOT:

- duplicate OpenCode workspace or session lifecycle state as an independent source of truth;
- implement its own session-to-workspace router;
- execute Docker, kubectl, or Apple Container export commands directly in web route modules;
- accept a browser-supplied patch for host apply;
- trust `workspace.extra` as proof of resource ownership;
- expose native provider credentials, target headers, or raw tokens to shared UI state.

### 4.2 Container Workspace Plugin

Repository: `openchamber/opencode-container-workspace`
Local checkout: `/Users/iivashko/projects/opencode-container-workspace`
Package: `@openchamber/opencode-container-workspace`

The plugin repository owns:

- OpenCode adapter registration;
- versioned runtime policy and metadata schemas;
- provider validation;
- canonical resource naming;
- provider lifecycle transactions;
- provider resource ownership verification;
- target resolution and internal provider health;
- provider state and secret storage;
- provider reconciliation and diagnostics;
- runtime authentication proxy;
- managed egress resources and policy;
- immutable baseline storage;
- provider-side snapshot/export collection;
- runtime and egress-gateway images;
- a typed server-side operations API consumed by OpenChamber.

The plugin MUST remain independently usable through OpenCode configuration without OpenChamber UI. Security policy, resource ownership, authentication, rollback, reconciliation, and cleanup MUST NOT depend on the settings page.

### 4.3 OpenCode

OpenCode remains authoritative for:

- workspace control-plane records and IDs;
- `Session.workspaceID`;
- workspace routing;
- session routing;
- workspace status events;
- session history synchronization;
- authoritative source and target session state used by OpenChamber's immutable context handoff;
- routed prompt, event, terminal, file, and VCS requests.

OpenChamber and the plugin MUST use public OpenCode SDK/plugin contracts where they are sufficient. Any reliance on an internal experimental extension MUST be isolated, version-pinned, compatibility-tested, and documented.

## 5. Current Implementation And Release Status

This section records the audited state of the current candidate. Evidence is identity-bound and must be rerun after any code, dependency, plugin pin, image, package, or workflow change.

### 5.1 Current Candidate Identity

- OpenChamber pins `@opencode-ai/sdk@1.18.12`.
- Web and Electron pin `@openchamber/opencode-container-workspace` to immutable plugin commit `5dc9ef84de826e4404cfe610aa8460834dcfb8d3` (plugin PR #12 on the default branch). It carries everything the previous pin `b263b906` carried — the cleanup, snapshot-source, provider-readiness, and granted-egress fixes from live Windows Docker validation, OpenCode 1.18.12, the home-directory/filesystem-root snapshot refusals, the Windows workspace-state access list (PR #9–#11) — plus the Kubernetes cleanup fix for the seed pod an interrupted create leaves mounted on both PVCs, which blocked their deletion forever through the PVC protection finalizer.
- That plugin payload is version `0.1.1` and compiles against `@opencode-ai/plugin@1.18.12`. The plugin API and the host SDK are held at one version deliberately: two copies of the same SDK in one dependency tree stop the Electron package from building.
- The `v0.1.1` images published on 2026-08-07 are the first carrying OpenCode `1.18.12`, closing the earlier gap where a workspace ran a `1.18.4` CLI against a `1.18.12` host SDK. The version was confirmed by running the published runtime digest rather than trusting the build that produced it.
- Electron stages and verifies the exact installed plugin payload and bundles an OpenCode CLI matching the OpenChamber SDK version.
- The runtime and gateway defaults in `packages/web/server/lib/workspaces/policy.js` are the signed `v0.1.1` multi-architecture manifest digests. Startup reconciliation converges an already-written plugin registration to these defaults, so a repin reaches existing installations without a settings re-save.
- The full recertified image/provider milestone for the current matrix remains open: live Kubernetes and Apple Container evidence at the exact current pin has not been recollected since the repin.

### 5.2 Implemented Security And Correctness Invariants

The implementation includes transactional Docker, Kubernetes, and Apple Container providers; authoritative ownership and immutable baselines; authenticated HTTP/SSE/WebSocket transport; managed/external egress without direct fallback; restart reconciliation; structured export/review; conflict-checked atomic host apply and recovery; immutable reviewed session handoff; proof-bound host administration; reserved-plugin mutation protection; process-attested Electron authority; exact packaged plugin/CLI verification; project-scoped web, Electron, hosted-mobile, and Capacitor UI; and explicit VS Code unsupported behavior.

Ordinary Secure Workspace session start is server-owned and principal-bound. It uses stable operation identity, deterministic reuse/create, canonical reauthentication for create, routed-session verification, a restart-safe journal, and explicit partial/recovery errors. UI selection between Host and Secure Workspace does not replace those server checks.

### 5.3 Current Automated Validation

The current OpenChamber candidate has passed the full workspace build, type-check, and lint; 77 focused workspace server tests; 6 UI regressions; 8 Electron packaging tests; 19 Electron architecture tests; 18 Electron updater tests; 4 mobile helper tests; release-certification tests; workflow YAML parsing; and documentation validation across 396 pages and 44 sidebar links. These checks prove their covered code and packaging contracts only.

Current-candidate live Docker, Kubernetes, Apple Container, Windows, Linux, iOS, Android, interactive apply, and exact image-digest recertification have not yet run. Simulator/emulator, fixture, packaged startup, and Maestro dry-run results must not be promoted to physical platform or interactive host-apply evidence.

### 5.4 Historical Evidence

The `v0.1.0` plugin/image milestone remains historical evidence for its exact `1.18.4` compatibility matrix only. Tag commit `eedfd5b3a08e99285f3f167c7e7d83799844c03d`, release run `30022813361`, and the signed public runtime/gateway digests recorded in section 15 validated that older matrix. Later historical plugin commit `d9567f00fa5d1c2115fed613d8fe5b9aafe69cbb` and run `30027172196` do not validate the current pin.

Historical evidence must not be used to certify SDK `1.18.12`, the current plugin commit, plugin API/OpenCode `1.18.12`, newly built images, or current native packages.

### 5.5 Remaining Gates And Validation Model

- Publish and certify exact signed runtime/gateway image digests for the current matrix, including both architectures, vulnerability gates, anonymous pulls, Docker, Kubernetes, transport, rollback, reconciliation, and cleanup.
- Resolve Apple Container managed egress. It remains fail-closed because the current CLI lacks an isolation-capable multi-network primitive for gateway-only egress without direct outbound.
- Run guided target-host sessions: packaged Windows with Docker Desktop and focused Kubernetes; native Linux AppImage with full Docker and disposable `kind`; supported macOS with Apple Container.
- Run exact TestFlight and signed-APK physical-device checks against disposable Windows/Linux servers.
- Complete interactive review, selection, dry-run, exact atomic apply, conflict, recovery, and cleanup evidence.

These runs use an OpenChamber session directly on each target host. The assistant runs commands and validation; the operator handles UAC, reboot, system dialogs, device trust, and UI confirmation. Self-hosted GitHub runners are not required. The complete procedure is `SECURE_WORKSPACES_PHYSICAL_TEST_SETUP.md`.

## 6. OpenCode Upstream Compatibility Contract

### 6.1 Audit Baseline

The last fully certified upstream baseline was OpenCode/SDK/plugin `1.18.4`, reviewed from `anomalyco/opencode` dev commit `5f241f1cc1fc0c266044b64bf9e860d4e37c9c1f`. The current candidate is intentionally newer and not yet fully certified: OpenChamber SDK `1.18.12`, plugin API/runtime OpenCode `1.18.12`, and the current plugin commit.

The workspace HTTP surface and generated SDK calls must be audited against this exact current combination. A dependency upgrade MUST still follow normal OpenChamber dependency, lockfile, bundled CLI, plugin staging, routing, transport, and live compatibility validation.

Before every plugin or OpenChamber release, the compatibility matrix MUST record:

- exact OpenCode release and binary digest;
- exact SDK version;
- exact `@opencode-ai/plugin` version;
- exact plugin commit and package version;
- runtime image OpenCode version;
- workspace HTTP and routing compatibility-suite results.

### 6.2 Official Workspace HTTP API

OpenChamber MUST consume the generated SDK methods for:

- `experimental.workspace.adapter.list`;
- `experimental.workspace.list`;
- `experimental.workspace.create`;
- `experimental.workspace.syncList`;
- `experimental.workspace.status`;
- `experimental.workspace.remove`;
- session `get`, `status`, `messages`, `list`, `create`, `prompt`, and `delete` for the OpenChamber-owned context handoff.

The handwritten workspace request and response types in OpenChamber MUST be removed or reduced to a narrow typed wrapper over generated SDK methods. OpenChamber-owned capabilities continue to use Runtime APIs.

Application wrappers MUST make semantically required fields required even if a generated convenience signature marks them optional:

- workspace create requires `type`;
- handoff session create and reads require exact directory/workspace routing;
- the inserted handoff message requires `noReply: true`, one text part, and deterministic operation-bound IDs where the SDK supports them.

### 6.3 Public And Internal Adapter Contracts

At the reviewed upstream commit, public `@opencode-ai/plugin` declares:

```ts
type WorkspaceAdapter = {
  name: string;
  description: string;
  configure(info: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>;
  create(info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>;
  remove(info: WorkspaceInfo): Promise<void>;
  target(info: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>;
};
```

OpenCode internally supports optional context and duck-typed `list(context)`, but the public plugin type does not declare them. It does not declare `health` or `exportDiff`.

Therefore:

- the plugin MUST compile against an exact compatible `@opencode-ai/plugin` version;
- `list(context)` MUST be isolated behind a compatibility adapter and tested against the pinned OpenCode binary;
- `list` MUST NOT be described as a stable public plugin API until upstream publishes it;
- `exportDiff` MUST NOT be registered or documented as an OpenCode adapter method;
- provider health remains an internal plugin operation;
- provider export remains a private plugin operations capability until an adequate official API exists.

### 6.4 Routed VCS Capabilities

Reviewed OpenCode exposes workspace-routed:

- `vcs.status`;
- structured `vcs.diff`;
- raw `vcs.diff.raw`;
- mutating `vcs.apply`.

OpenChamber SHOULD use routed `vcs.status` for live changed-file indicators and MAY use routed structured diff for bounded text preview. It MUST NOT use `file.status`, whose reviewed handler returns an unconditional empty list.

Routed raw diff is not a complete production export source at the reviewed commit because:

- it does not include `--binary` payloads;
- non-Git projects produce no typed export;
- unborn and unusual repository states have incomplete semantics;
- structured output may be bounded or truncated without a sufficient public completeness contract;
- routed apply has no dry-run contract and is not the reviewed host-apply boundary.

Canonical binary-safe and non-Git export therefore remains a plugin operations responsibility. OpenChamber host apply remains OpenChamber-owned.

### 6.5 Authenticated WebSocket Compatibility Boundary

Reviewed OpenCode overlays adapter target headers for HTTP/SSE proxying but does not pass target headers to the WebSocket proxy handshake. An authenticated remote workspace therefore rejects terminal and other WebSocket upgrades.

The upstream limitation remains relevant, but it is no longer a release blocker for this product because the plugin now owns a loopback compatibility transport that authenticates and forwards HTTP, SSE, and WebSocket traffic without weakening workspace authentication.

Release requirements:

- the plugin-owned transport MUST preserve authenticated HTTP/SSE/WebSocket behavior against every supported OpenCode version;
- target credentials MUST remain server-side and MUST NOT move to a long-lived URL token;
- forwarded Origin, auth, hop-by-hop, and client-controlled proxy headers MUST be normalized or removed by the transport boundary;
- TLS verification, rotation, reconnect, and credential stripping MUST be covered by contract and live tests;
- OpenChamber MUST validate authenticated HTTP, SSE, terminal WebSocket, reconnect, and credential stripping;
- an upstream target-header fix remains desirable but MUST NOT be assumed by the released compatibility matrix.

The released implementation uses the plugin-owned transport and does not depend on an unshipped upstream patch.

### 6.6 Create Failure Behavior

Reviewed OpenCode writes a workspace control-plane row before adapter create and can retain that row after adapter failure.

Required compensation and upstream direction:

- OpenChamber MUST provide a client-generated workspace ID;
- plugin create MUST rollback only resources created by the failed operation;
- OpenChamber MUST reconcile or remove the known provisional row after create failure;
- UI MUST NOT report success until authoritative workspace status reaches `connected`;
- a stale failed row MUST be visible and recoverable, not mistaken for a ready workspace;
- an upstream transactional or explicit provisional-row model SHOULD be contributed.

Reviewed OpenCode additionally bounds its own post-create wait for `connected` to a few
seconds and reports the missed window as a create failure while the provider resources it
just started are still booting. When exactly that upstream wait timeout is reported and
the provisional row exists, OpenChamber MUST NOT compensate immediately: it adopts the
row and applies its own bounded authoritative status wait, completing on `connected`,
answering a retryable provisional `connecting` on status-wait timeout, and compensating
only on authoritative `error` or a missing row. Every other create failure keeps
immediate compensation of the exact provisional ID.

`disconnected` MUST NOT be treated as a terminal status during these waits. Reviewed
OpenCode stamps `disconnected` at sync start, before its connect loop has attempted a
connection, so every booting workspace passes through it by design; a Kubernetes
workspace remains there until its port-forward is established. The waits end only on
`connected`, an explicit `error`, or the bounded ceiling, and the ceiling answer keeps
the row visible for an idempotent retry.

### 6.7 Remove Failure Behavior

Reviewed OpenCode removes associated sessions, suppresses adapter remove failure, and deletes the control-plane row. That can orphan provider resources and credentials without an authoritative record.

Required production orchestration:

1. OpenChamber authorizes and confirms removal.
2. OpenChamber invokes plugin operations cleanup using the authoritative record and trusted policy.
3. Plugin cleanup either fully succeeds or returns explicit remaining resources.
4. Only after successful provider cleanup does OpenChamber call official workspace remove.
5. Adapter `remove` is idempotent and succeeds when resources are already absent.
6. Failure to delete the final OpenCode row remains retryable.

Direct UI use of raw official remove MUST NOT bypass this orchestration. An upstream fix that preserves a cleanup-failed tombstone or surfaces adapter failure SHOULD be contributed.

### 6.8 Discovery And Recovery Identity

Reviewed internal `WorkspaceListedInfo` omits `id`; `syncList` allocates a new OpenCode workspace ID. A provider resource labelled only with the original control-plane ID cannot be safely verified after recovery.

The plugin MUST distinguish:

```text
controlPlaneWorkspaceID
providerResourceID
```

- `providerResourceID` is immutable and identifies provider resources, secrets, baseline, and local state.
- `controlPlaneWorkspaceID` is the current OpenCode record ID and may change during recovery.
- ownership verification uses provider resource ID, project ID, provider, managed marker, and resource role.
- the original control-plane ID may remain as audit metadata but is not the sole trust key.
- recovered metadata binds the current control-plane record to the immutable provider resource identity.

The preferred upstream improvement is an optional stable `id` in listed adapter records with collision and project validation.

Current local compensation verifies the listed record's original metadata and immutable provider ownership under the provider-resource lock before rebinding only `controlPlaneWorkspaceID`. Export artifacts bind the recovered current OpenCode ID, while cleanup remains keyed by the immutable provider resource ID. This closes the local recovery gap but does not remove the upstream preference for stable listed IDs.

### 6.9 `syncList` Failure Semantics

Reviewed `syncList` converts adapter-list failures to empty arrays, returns 204, adds records only, deduplicates by name, and does not mark stale resources unavailable.

OpenChamber MUST NOT treat 204 as proof of complete provider discovery. It MUST compare:

- OpenCode persisted records;
- plugin provider discovery results;
- provider-specific discovery failures;
- resource completeness diagnostics.

One failed provider MUST NOT erase or block complete providers. Missing resources MUST become explicit unavailable/degraded diagnostics. An upstream per-adapter sync result SHOULD be contributed.

### 6.10 Immutable Session Context Handoff

Upstream warp is intentionally outside the Secure Workspaces production flow. OpenChamber never mutates, archives, deletes, aborts, steals, or reassigns the source session. Exact event/history transfer is intentionally unsupported.

The normative continuation flow creates a deterministic, bounded, editable text draft from complete paginated authoritative source messages; requires explicit review; creates a new correctly routed target session; inserts exactly one text-only user context message with `noReply: true`; and verifies the exact text hash before navigation. Reasoning, tools and results, files, attachments, MCP/subtasks, hidden/system fields, binary/data URLs, and credential-like content are excluded with visible localized fidelity warnings. Server responses expose stable warning codes, not English warning prose. Workspace file changes use the independent export/review/apply flow.

OpenChamber persists a private principal-bound operation journal with atomic writes and restart-recoverable `drafted`, `confirmed`, `target-created`, `context-inserted`, `verified`, `completed`, and `cleanup-required` states. The journal never contains draft/transcript text: draft text exists only in the immediate creation response, while persisted draft state contains ID/revision/hash, source boundary, and omission codes. Journal reads reject symlinks and non-regular files. Every retry inspects complete paginated authoritative target metadata/messages before create or insert. Failure removes and confirms only the newly created target session; incomplete cleanup is explicit. This design removes upstream transactional warp from the release blockers.

### 6.11 Sync Startup And Stable Targets

Reviewed persisted workspaces require explicit `/sync/start` after OpenCode restart. Missing status means unknown, not disconnected. The reviewed reconnect loop resolves a target before its retry loop and can retry a stale endpoint indefinitely.

OpenChamber MUST:

- call the official sync-start capability for every active project after activation or restart;
- wait for `connected` or explicit `error` before reporting readiness;
- subscribe to workspace status events;
- periodically reconcile status without clearing known state on failure;
- restart sync when a provider target changes;
- preserve the authoritative workspace ID from routed event envelopes on every server-side follow-up session read or mutation, because directory-only calls can address a host projection and create irreconcilable same-sequence durable history.

Providers MUST prefer stable targets:

- Docker uses a persisted collision-checked host port;
- Kubernetes recreates port-forward on the same persisted local port or triggers control-plane sync restart;
- Apple Container uses a persisted collision-checked host port.

### 6.12 Credential Propagation

Reviewed OpenCode passes all host provider authentication to adapter create as `OPENCODE_AUTH_CONTENT`, along with selected telemetry environment fields.

The plugin MUST treat this input as sensitive and MUST NOT automatically expose it to the workspace. It MUST:

- parse it only in memory;
- select only credentials explicitly granted to that workspace;
- persist granted content only in provider secret storage;
- omit telemetry authorization data unless explicitly enabled;
- never log, include in command diagnostics, or store broad auth in metadata/state;
- support revocation and cleanup.

## 7. Plugin Architecture

The plugin core has been rewritten around the contracts below. Future changes MUST preserve focused lifecycle, trust, provider, runtime, and artifact ownership rather than moving domain behavior into entrypoints.

Conceptual structure:

```text
src/
  plugin.ts
  contracts/
    adapter.ts
    metadata.ts
    policy.ts
    provider.ts
    operations.ts
    artifact.ts
  core/
    lifecycle.ts
    transaction-journal.ts
    ownership.ts
    naming.ts
    state-store.ts
    secret-store.ts
    process-runner.ts
    health.ts
    snapshot.ts
    export.ts
    errors.ts
    redaction.ts
  providers/
    docker/
    kubernetes/
    apple-container/
  runtime/
    auth-proxy.ts
    startup.ts
  egress/
    policy.ts
    gateway.ts
    presets.json
runtime-image/
egress-image/
tests/
```

The exact directories may differ, but lifecycle, trust, provider, runtime, and artifact ownership MUST remain separated.

### 7.1 Public Package Exports

The package MUST publish built JavaScript and declarations for:

- `@openchamber/opencode-container-workspace`;
- `@openchamber/opencode-container-workspace/operations`;
- `@openchamber/opencode-container-workspace/contracts`.

The main export initializes the OpenCode plugin. The operations export exposes trusted server-side validation, discovery, reconciliation, cleanup, and export. The contracts export exposes runtime-validated schemas and types. Raw secret-store and arbitrary command helpers MUST NOT be public.

### 7.2 Server-Side Operations Contract

OpenChamber uses a typed server-only contract similar to:

```ts
interface WorkspaceProviderOperations {
  validateProvider(provider: WorkspaceProviderKind, policy: WorkspacePolicy): Promise<ProviderValidation>;
  discoverProject(projectID: string, policy: WorkspacePolicy): Promise<ProviderDiscoveryResult>;
  inspectWorkspace(workspace: OpenCodeWorkspace, policy: WorkspacePolicy): Promise<WorkspaceDiagnostics>;
  cleanupWorkspace(workspace: OpenCodeWorkspace, policy: WorkspacePolicy): Promise<CleanupResult>;
  exportWorkspace(workspace: OpenCodeWorkspace, policy: WorkspacePolicy, sink: ExportSink): Promise<ProviderExportResult>;
}
```

The operations layer MUST:

- run server-side only;
- use persisted trusted policy;
- receive workspace records from authenticated OpenCode SDK calls;
- derive canonical identity instead of trusting metadata;
- validate complete provider ownership;
- stream exports with byte and time limits;
- never return raw secrets;
- never accept arbitrary executable paths, resource names, contexts, or namespaces from browser input.

## 8. Policy Contract

Policy MUST have a versioned runtime schema. A representative required shape is:

```ts
interface WorkspacePolicyV1 {
  version: 1;
  defaultProvider: "docker" | "kubernetes" | "apple-container";
  images: {
    runtime: string;
    egressGateway: string;
    allowedRuntimeImages: string[];
    requireDigest: true;
  };
  resources: {
    cpuLimit?: string;
    memoryLimit?: string;
    pidsLimit?: number;
    storageLimit?: string;
  };
  egress:
    | {
        mode: "managed";
        preset: "restricted" | "custom";
        allowedDomainSets: string[];
        allowedDomains: string[];
        allowedCIDRs: string[];
      }
    | {
        mode: "external";
        proxyUrl: string;
        proxyCredentialRef?: string;
        allowedCIDRs: string[];
      };
  docker: { binary?: string };
  kubernetes: {
    binary?: string;
    kubeconfig?: string;
    context: string;
    namespace: string;
    allowedContexts: string[];
    allowedNamespaces: string[];
    storageClass?: string;
    connectivity: "port-forward" | "ingress";
    networkPolicy: "enforced";
    ingress?: KubernetesIngressPolicy;
  };
  appleContainer: { binary?: string };
  retention: {
    ttlHours: number | null;
    preserveStorageOnDelete: boolean;
  };
  credentials: {
    modelAuth: "required-secret-file";
    additionalGrants: "explicit";
  };
}
```

Required defaults:

- images are digest-pinned;
- egress uses managed restricted mode;
- automatic TTL deletion is disabled by default (`null`) to avoid silent loss of unexported changes;
- explicit delete removes storage after warning and confirmation;
- Kubernetes NetworkPolicy cannot be disabled in production policy;
- proxy credentials are never embedded in a URL;
- unsafe provider modes are rejected, not normalized to a weaker behavior.

Every persisted field MUST alter core behavior or be absent. Decorative controls are forbidden.

## 9. Metadata, State, And Ownership

### 9.1 Metadata

Metadata is recovery data, not a trust boundary. It contains only versioned hints:

```ts
interface WorkspaceMetadataV1 {
  version: 1;
  provider: WorkspaceProviderKind;
  controlPlaneWorkspaceID: string;
  providerResourceID: string;
  projectID: string;
  runtimeLayoutVersion: 1;
  createdAt: string;
  imageDigest: string;
  resourceRefs: ProviderResourceRefs;
  authRef: string;
  policyFingerprint: string;
}
```

Metadata MUST NOT contain:

- raw tokens or credentials;
- proxy credentials;
- arbitrary executable paths or command arguments;
- trusted resource labels supplied only by metadata;
- an arbitrary host target directory.

Every destructive, target, export, or exec-like operation MUST validate:

- current control-plane workspace and project;
- immutable provider resource identity;
- provider kind;
- metadata and runtime-layout versions;
- current policy and fingerprint compatibility;
- canonical resource names;
- actual provider labels for managed, provider, project, resource ID, and role;
- complete expected resource set;
- configured namespace, context, and network policy.

Cleanup is the deliberate exception to policy-fingerprint equality. A workspace
created under an earlier policy MUST remain deletable after any policy change:
cleanup validates immutable identity, canonical naming against the policy shape
recorded at creation, persisted provider state identity, and per-resource
ownership labels, and reports a fingerprint mismatch as an explicit diagnostic
instead of refusing. Requiring fingerprint equality for deletion would strand
provider resources permanently, which is itself a host-integrity failure. Use,
target, export, and credential operations keep strict fingerprint validation.

### 9.2 State And Secrets

Local provider state is allowed only for operation journals, secret references, stable target ports, baseline generation, and reconciliation diagnostics.

Requirements:

- per-workspace state keyed by provider resource ID;
- state directory mode `0700` and files mode `0600` where supported;
- atomic temporary write, fsync, and rename;
- cross-process locking with stale-lock recovery;
- explicit corruption errors;
- read/parse failure MUST NOT become `{}`;
- secret values stored separately from metadata and normal state;
- transactional rotation;
- cleanup deletes secrets only after provider cleanup is safely resolved.

## 10. Transactional Lifecycle

Internal plugin states are:

```text
absent -> creating -> ready -> degraded -> removing -> absent
                    \-> failed
```

These diagnostics supplement but do not replace official OpenCode status values.

### 10.1 Create

Create MUST:

1. acquire a workspace operation lock;
2. load and validate trusted policy;
3. validate provider capability;
4. derive canonical control-plane and provider resource identity;
5. inspect same-name resources;
6. reject foreign or incomplete collisions;
7. reconcile an exact existing owned workspace or return explicit already-exists;
8. create a durable operation journal;
9. create provider secrets;
10. create one immutable host source snapshot;
11. create and seed baseline storage;
12. create and seed mutable workspace storage from the same snapshot;
13. create isolated network resources;
14. create managed egress resources or validate external egress;
15. create the runtime;
16. create the access target;
17. validate every resource and label;
18. authenticate and health-check the runtime;
19. mark the operation committed;
20. report success only after OpenCode reaches connected status.

Rollback MUST delete only resources recorded as created by the current operation. Pre-existing resources MUST NOT be deleted. Primary and cleanup errors MUST both be preserved. Retry MUST reconcile the journal rather than recreate blindly.

### 10.2 Cleanup

Cleanup MUST:

1. acquire the operation lock;
2. rederive canonical identity;
3. inspect and verify every expected resource;
4. reject ownership mismatch;
5. stop local targets and port-forwards;
6. remove runtime and access resources;
7. remove ingress and egress resources;
8. remove provider network;
9. remove mutable and baseline storage according to explicit retention policy;
10. remove provider secrets;
11. remove local state;
12. return explicit remaining resources on partial failure.

Absent resources are idempotent success. Foreign resources are never removed.

Cleanup MUST NOT require the active policy fingerprint to match the workspace
metadata (see section 9.1) and MUST NOT require a healthy reconcile before
deletion: a degraded workspace remains deletable, with ownership verified per
resource. Storage retained by explicit retention policy is a successful cleanup
outcome: the result reports `ok: true` with the retained resources listed in
`retainedResources` and a diagnostic, and the control-plane record is removed.
Retained storage remains recorded in local provider state.

### 10.3 Reconciliation

Startup, list, target, and explicit repair MUST discover resources, validate the complete set, classify missing/foreign/stale resources, recover stable targets, recover port-forward state, verify image digest and network isolation, and surface degraded diagnostics. Missing destructive resources MUST NOT be recreated without explicit repair approval.

## 11. Process And Error Safety

Provider commands MUST use a structured process runner with:

- explicit executable and argument arrays;
- sensitive argument/value markers;
- redacted diagnostics;
- bounded stdout and stderr;
- streaming support for large artifacts;
- timeout and abort semantics;
- Windows process-tree termination and `windowsHide: true`;
- separate exit, signal, spawn, timeout, and decode errors;
- no default output logging;
- no shell interpolation for provider CLI arguments;
- version-controlled shell scripts only inside controlled runtime helpers.

Token values, model auth, proxy auth, OpenTelemetry auth, request headers, source content, and artifact content MUST be redacted from errors and logs.

## 12. Runtime Authentication And Credential Delegation

### 12.1 Runtime Endpoint

- Every workspace has a random 256-bit credential.
- The credential is file-backed.
- The auth proxy reads the credential from file and uses constant-time comparison.
- The workspace credential header is removed before forwarding to OpenCode.
- HTTP, SSE, and WebSocket are authenticated.
- Unauthorized requests return 401 without revealing target state.
- Runtime OpenCode listens on loopback inside the runtime.
- Target credentials remain server-side.

### 12.2 Model Authentication

Model auth MUST NOT be passed as a literal Docker/Apple CLI environment argument or Kubernetes Deployment value. Explicitly granted credentials are stored in provider secret storage, mounted read-only, and read by the startup wrapper. They are never stored in metadata, exported, or logged.

### 12.3 Additional Credentials

Git, SSH, cloud, and other host credentials are not inherited automatically. A grant requires explicit user approval, workspace scope, credential kind, expiration, revocation, and an audit event. Host credential directories MUST NOT be mounted writeable. Grants are deleted during workspace cleanup.

## 13. Managed Egress

The product ships a separate minimal signed gateway image:

```text
ghcr.io/openchamber/workspace-egress-gateway@sha256:<digest>
```

The gateway MUST:

- have no workspace or baseline mount;
- have no model credentials or provider socket;
- run non-root with read-only root, dropped capabilities, and `no-new-privileges` where supported;
- support HTTP and CONNECT;
- resolve and validate destinations itself;
- resist DNS rebinding;
- block loopback, link-local, cloud metadata, and private CIDRs unless explicitly allowed;
- apply versioned domain-set policy from `egress-presets.json`;
- log only resource ID, destination host/port, decision, timestamp, and byte counts;
- never log headers, body, query values, or credentials.

Runtime direct egress MUST be denied. In external-proxy mode, proxy credentials use a secret reference, real connectivity is validated, and proxy failure MUST NOT trigger direct fallback.

## 14. Provider Requirements

### 14.1 Docker

Each workspace MUST have:

- mutable workspace volume;
- immutable baseline volume;
- per-workspace internal network;
- runtime container;
- localhost access-proxy container;
- managed egress gateway or validated external proxy path.

The runtime MUST have no writeable host-project mount, Docker socket, direct published port, or shared cross-workspace network. It runs non-root with read-only root, controlled tmpfs, dropped capabilities, `no-new-privileges`, default seccomp, PID/resource limits, and only the minimum network path to the gateway and access proxy.

Target inspection MUST verify `HostIp` is loopback and validate role labels on the runtime, access proxy, network, volumes, and gateway. Stable host ports are persisted and collision-checked.

### 14.2 Kubernetes

Each workspace MUST use:

- provider secrets;
- immutable baseline PVC;
- mutable workspace PVC;
- Deployment;
- Service;
- enforced NetworkPolicy;
- dedicated ServiceAccount with token automount disabled;
- managed egress Deployment/Service or validated external proxy;
- optional Ingress only when ingress policy is complete.

The pod MUST set non-root UID/GID, RuntimeDefault seccomp, `allowPrivilegeEscalation: false`, dropped capabilities, read-only root, resource requests/limits, and startup/readiness/liveness probes.

Validation MUST cover CLI availability, context and namespace existence, allowlists, exact RBAC verbs, storage capability, Secrets, Deployment, Service, NetworkPolicy, selected connectivity, and proxy reachability. `kubectl auth can-i` requires literal affirmative output, not only exit code zero.

A cluster accepts NetworkPolicy objects whether or not its CNI enforces them, and an unenforced policy leaves the runtime reaching the whole cluster network and the internet directly while every surface still reports isolation. Creation therefore MUST observe enforcement and MUST fail closed when a cluster is proven not to enforce.

The observation MUST use two pods: an unrestricted pod establishing that the reference address is reachable, and a pod under a deny-all policy. One probe cannot distinguish an enforced policy from an address that was never reachable, so an unreachable reference MUST yield an explicit inconclusive verdict rather than a pass or a refusal. Because a pod can start before the CNI programs a policy selecting it, each probe MUST sample across a window: any blocked attempt proves enforcement, and only an unbroken run of successes disproves it. Verdicts MAY be cached per context and namespace, with a proven pass held longer than an inconclusive one, and preflight MUST report the last verdict rather than implying isolation it never checked.

The cluster's DNS service address MUST be resolved from the cluster rather than required from the operator; it differs per distribution, and a wrong value breaks name resolution inside the workspace without any visible cause. It MUST be requested only where RBAC hides it, and a configured range remains authoritative and validated. No other component may refuse a configuration for lacking a value this resolution supplies.

### 14.3 Kubernetes Ingress

Ingress policy MUST specify:

```ts
interface KubernetesIngressPolicy {
  ingressClassName: string;
  hostTemplate: string;
  pathTemplate: string;
  tls:
    | { mode: "existing-secret"; secretName: string }
    | { mode: "cert-manager"; clusterIssuer: string };
  controllerNamespaceSelector: Record<string, string>;
  controllerPodSelector: Record<string, string>;
  annotations: Record<string, string>;
}
```

HTTPS is mandatory. Host/path templates use canonical resource identity. An annotation allowlist prevents arbitrary controller behavior. NetworkPolicy admits only configured controller selectors. Workspace auth remains mandatory over TLS. Ingress health uses the final public target. There is no silent fallback to port-forward.

The existing `colima` validation context is intentionally minimal: it has no `IngressClass` or controller, uses `--disable=traefik`, has no Helm installation, and its VM address is not host-reachable. This is not an acceptable permanent external blocker. Certification uses a separate Colima profile so the existing port-forward validation cluster is not mutated.

The dedicated profile MUST have a host-reachable address and sufficient CPU, memory, and disk for k3s, ingress-nginx, cert-manager, two workspace images, and lifecycle tests. ingress-nginx `controller-v1.15.1` and cert-manager `v1.21.0` are the currently selected releases; their manifests and images MUST be pinned and reviewed before installation. A local test CA and DNS host template bound to the reachable profile address validate both `existing-secret` and `cert-manager` modes without introducing production DNS or TLS secrets. Tests MUST reach the final HTTPS URL from the host, trust only the explicit test CA, authenticate the workspace request, verify controller selectors and NetworkPolicy, and remove all workspace resources.

Local certification now uses the isolated bridged profile `openchamber-ingress` with 4 CPUs, 8 GiB memory, 40 GiB disk, and k3s `v1.33.1+k3s1`; creation left the active `colima` Docker and Kubernetes contexts unchanged. The host successfully reached the profile address directly. The ingress-nginx manifest matched SHA-256 `502fddca66b09c20dd48b6d0a792a9671cd663a3a0d2a8bda5ae990d13b6c5b2`. The original cert-manager manifest matched SHA-256 `6e499c3f1ab356abe79a7853911f80cb09c213885bfdf81092fdff142ba63c4a`; its temporary arm64 certification copy pinned cainjector `sha256:0583d676e24d4ff0d183342228be379e1ba420c74122bb9bcffeac4727b09248`, controller `sha256:11494ff2aae47908ef33bc436660e605fec3809dafda35cdb777939909fa0253`, and webhook `sha256:c58bea1e83746e990d5622f39c636896a2eddfb6a871e785ae378f7dfb8ec538`. Both authenticated HTTPS lifecycle modes passed, unauthenticated health returned `401`, export/reconciliation passed, and workspace resources were removed. The cert-manager run exposed and then verified the fix for a generated TLS secret cleanup leak.

### 14.4 Apple Container

Each workspace MUST have mutable and baseline volumes, a per-workspace host-only network, a loopback-only collision-checked publish, and controlled gateway egress. Runtime images run non-root with dropped capabilities and the strongest available privilege control. Restart after `container system stop/start`, target recovery, network collision, volume collision, port collision, and cleanup MUST be live-tested.

The absence of an exact Apple equivalent to Docker `no-new-privileges` is a documented platform property, not a hidden claim. Compensating controls and tests are mandatory.

The current `arm64` macOS `26.5.2` host has Apple Container `1.1.0` installed from Apple's signed and notarized `container-1.1.0-installer-signed.pkg`. Its SHA-256 matched `0ca1c42a2269c2557efb1d82b1b38ac553e6a3a3da1b1179c439bcee1e7d6714`, and installation used interactive local administrator approval without storing or automating a credential. `container system start`, native arm64 smoke, and system stop/start passed.

Local provider certification against an immutable locally imported arm64 image passed create, loopback-only target, authenticated HTTP, unauthenticated `401`, source mutation/export, reconciliation, foreign-network collision refusal, system stop/start recovery with an ownership-verified runtime restart, and cleanup. Apple Container `1.1.0` exposed and verified fixes for directory-only bind mounts, explicit named-volume ownership, a minimal `CHOWN` capability on network-disabled ephemeral seed/secret helpers, writable `/tmp` on the read-only runtime, and restart reconciliation. The same lifecycle passed against the published runtime digest, including system restart repair and cleanup. On the certification link, the initial uncached 569.5 MB manifest pull exceeded the provider's 300-second command timeout and failed explicitly before provider resource mutation; a standalone exact-digest pull completed in 7 minutes 29 seconds, and the cached lifecycle then passed in 21.14 seconds. SSE/WebSocket, volume/port collision, credential rotation, and broader failure injection remain required.

## 15. Runtime Images

The former default `ghcr.io/openchamber/opencode-workspace:1.0.0` is invalid for release because unauthenticated pull returned `denied`. It MUST be removed from defaults until a real public artifact exists.

The first image release contract is:

```text
Git tag: v0.1.0
Runtime package: ghcr.io/openchamber/opencode-workspace:0.1.0
Gateway package: ghcr.io/openchamber/workspace-egress-gateway:0.1.0
Production references: the same package names pinned as @sha256:<digest>
```

Release run `30022813361` published and verified these public multi-architecture manifests:

```text
Runtime: ghcr.io/openchamber/opencode-workspace@sha256:40266ce54560149396cdc89395fa26df08f8924e4f377acbf12a88da08b2c141
Gateway: ghcr.io/openchamber/workspace-egress-gateway@sha256:37c1452849212c5e9b2b62257792ca092c44c5ebba6d165667f235164e571555
Platforms: linux/amd64, linux/arm64
```

OpenChamber server policy uses these exact digests as its authoritative defaults. Explicit configured images remain digest-validated, and the UI does not duplicate the constants.

The runtime image MUST:

- be public on GHCR;
- support `linux/amd64` and `linux/arm64`;
- use a base image pinned by digest;
- use a dedicated non-root user;
- pin an OpenCode version compatible with the host release;
- include Node, Git, OpenSSH client, CA certificates, POSIX shell, and minimal build essentials;
- contain no credentials or package-manager caches;
- support a read-only root filesystem;
- expose versioned runtime scripts and a provider-compatible health probe.

The image pipeline MUST use buildx, run per-architecture OpenCode health smoke, generate SBOM and provenance, enforce a vulnerability gate, sign with keyless Cosign, publish immutable semver tags and digests, and verify unauthenticated public pulls.

OpenChamber production policy MUST default to a digest, not a mutable tag. The runtime OpenCode version, host OpenCode version, SDK, and plugin compatibility suite MUST agree.

### 15.1 Image And Architecture Model

There are exactly two Linux OCI products: runtime and managed egress gateway. Each product is one multi-architecture manifest containing `linux/amd64` and `linux/arm64`. There are no separate macOS, Windows, iOS, or Android images. Docker, Kubernetes, and Apple Container select the matching Linux architecture from the same manifest; Windows support uses a Linux-container backend when that platform is certified.

The release MUST NOT publish or consume `latest`. Semver tags are discovery labels; the only production authority is the immutable digest recorded after publication.

### 15.2 Deterministic Build Inputs

- Base images and CI helper images MUST be pinned by reviewed digest in source, not resolved from a mutable tag during the release.
- OpenCode in the runtime image is pinned to `1.18.4` for `v0.1.0`.
- Trivy and every GitHub Action are pinned to reviewed versions/commits.
- Builds include OCI source, revision, and version labels that link GHCR packages to `openchamber/opencode-container-workspace`.
- Build logs and metadata record the exact base, runtime, gateway, OpenCode, and output digests.

### 15.3 Branch And Pull-Request Image Gate

For each architecture, CI MUST load a uniquely tagged local image, run the real runtime smoke, and scan that same loaded image. A multi-architecture OCI archive may be generated for structure/SBOM/provenance checks, but MUST NOT be passed to a scanner format it cannot consume.

`docker-live` MUST start an ephemeral loopback registry inside the runner, push integration images, obtain actual registry manifest digests, and pass full `localhost:<port>/...@sha256:<manifest>` references to provider tests. Docker config IDs are not registry manifest digests. The ephemeral registry is destroyed with the job and is never a release destination.

A repeatable Kubernetes live job MUST use pinned cluster/controller inputs and cover digest pulls, port-forward, HTTPS ingress, controller-scoped NetworkPolicy, lifecycle, export, reconciliation, and cleanup. The image publish job depends on all unit, image, Docker, and Kubernetes gates.

### 15.4 Tag Publication

On `v0.1.0`, each image is first pushed as a run-scoped candidate. The exact candidate digest MUST pass both architecture scans and smoke before promotion to `0.1.0`. The workflow then:

1. records the exact digest;
2. promotes only that digest to the semver tag;
3. signs the digest with keyless Cosign using GitHub OIDC;
4. verifies a narrowly scoped repository/workflow/tag certificate identity;
5. verifies SBOM and provenance attestations;
6. logs out of GHCR;
7. pulls and inspects the exact digest without authentication;
8. verifies both required architectures.

No manual image upload, mutable production tag, Docker Hub credential, registry password, or long-lived signing key is part of the release design.

### 15.5 GHCR Package Bootstrap And Visibility

Before creating `v0.1.0`, a manually dispatched registry preflight MUST push run-scoped candidates without a production semver tag. It proves whether the repository-scoped Actions token can create both organization packages, link them to the repository, set public visibility, and pass unauthenticated pull.

The publish job uses only job-scoped permissions:

```yaml
permissions:
  contents: read
  packages: write
  id-token: write
```

If organization policy prevents package creation or public visibility, the workflow fails explicitly. An organization owner or package administrator then changes the specific organization/package setting and the preflight is rerun. A personal access token MUST NOT be added as a workaround unless GitHub provides no repository-scoped mechanism and the exception is separately reviewed, minimally scoped, rotated, and documented.

## 16. Source Snapshot And Immutable Baseline

Create MUST generate one consistent source snapshot and use it to seed both baseline and mutable storage.

Snapshot traversal MUST use `lstat` without following symlinks and record normalized relative path, entry type, mode, size, SHA-256, symlink target, and content/blob reference. It MUST reject absolute paths, traversal, NUL, unsafe hard links, reserved control-path collision, and platform-invalid target paths.

Host mutation during snapshot MUST be detected and retried or fail explicitly. The runtime MUST never receive write access to baseline storage. `.git` is copied as source data. Dirty Git state is part of the baseline and MUST NOT appear as a workspace-created change.

## 17. Export Artifact

Provider export snapshots current workspace storage and compares it with the immutable baseline. The canonical source of truth is content hashes and blobs, not a browser-provided patch.

```ts
interface WorkspaceExportArtifactV1 {
  version: 1;
  id: string;
  controlPlaneWorkspaceID: string;
  providerResourceID: string;
  projectID: string;
  provider: WorkspaceProviderKind;
  baselineGeneration: string;
  targetDirectory: string;
  createdAt: string;
  expiresAt: string;
  integrityHash: string;
  files: WorkspaceExportFile[];
}
```

Each file records stable ID, old/new path, operation kind, binary flag, baseline/result hashes, old/new mode, blob references, and text hunks where applicable.

Artifacts MUST be stored server-side under a private OpenChamber data directory with restrictive permissions, count/byte quotas, and a default 60-minute TTL. They are invalidated on server restart and consumed after successful apply. Wrong workspace, provider resource, project, directory, generation, integrity, expiration, or selection MUST fail explicitly.

## 18. Visual Diff And Selection

The legacy custom `diff --git` string splitter has been removed and MUST NOT return as a production selection boundary.

A reviewed structured diff implementation MUST produce stable text hunks and line/context hashes. Unknown, duplicate, overlapping, stale, or dependent selections are validated server-side. Binary content supports whole-file selection only. Large text may require whole-file selection with a visible explanation. Rename, mode, and symlink changes remain indivisible logical operations.

The browser receives review metadata and bounded content views, not authority to replace artifact content.

## 19. OpenChamber Runtime API

The implemented production API uses explicit side-effect-appropriate routes registered before the generic OpenCode proxy:

```text
GET    /api/workspaces/providers/validate
POST   /api/workspaces/providers/validate
GET    /api/workspaces/compatibility
POST   /api/workspaces/create
DELETE /api/workspaces/:workspaceID
POST   /api/workspaces/:workspaceID/reconcile
POST   /api/workspaces/settings
GET    /api/workspaces/:workspaceID/export
POST   /api/workspaces/exports/:exportID/apply
GET    /api/workspaces/exports/:exportID/download
DELETE /api/workspaces/exports/:exportID
POST   /api/workspaces/handoffs/draft
POST   /api/workspaces/handoffs/:operationID/commit
GET    /api/workspaces/handoffs/:operationID
DELETE /api/workspaces/handoffs/:operationID/target
```

There MUST be no raw client patch apply route. A directory is accepted only after canonical project binding. Provider settings and executable/context overrides come only from persisted host-admin policy.

## 20. Atomic Host Apply

Apply MUST:

1. validate host-admin capability;
2. acquire a canonical project mutation lock;
3. load and verify the server artifact;
4. verify workspace, provider resource, project, directory, generation, expiration, and unused state;
5. validate file and hunk selection;
6. recompute current host hashes for every affected path;
7. require affected host entries to match artifact baseline;
8. reject path traversal and symlink escape;
9. materialize the selected result in a temporary staging tree;
10. verify expected result hashes;
11. create a durable rollback journal and backups;
12. replace entries and apply mode/symlink operations;
13. fsync where supported;
14. verify final hashes;
15. commit the journal, clean backups, and consume the artifact.

Failure after journal creation MUST restore every backup, remove newly created paths, verify restoration hashes, and retain a recovery journal if rollback is incomplete. Further host mutation is blocked until recovery. The API MUST return primary and rollback diagnostics and MUST never report partial success as success.

Unselected files MUST remain unchanged. Concurrent changes to an affected host file produce a conflict rather than an automatic merge.

Because the baseline is the immutable creation-time snapshot, a change already applied
to the host keeps appearing in later exports of the same workspace. Apply MUST classify
each selected entry against the current host state rather than against the baseline
alone:

- host matches the artifact baseline — the change is pending and is applied;
- host already matches the intended outcome — the change was applied earlier, so it is
  reported as skipped and MUST NOT be treated as a conflict or reapplied;
- host matches neither — an external change occurred and the operation fails as a
  conflict.

Review results carry the same per-entry classification so the surface can preselect only
pending changes and label the rest. The baseline itself is never rewritten: apply grants
no write path into baseline storage, preserving section 16's immutability guarantee.

## 21. Session Workflows

### 21.1 Start In Workspace

Remote session creation MUST be routed through the workspace query/location contract, not only body association. The wrapper must use the generated SDK semantics equivalent to:

```ts
sdk.session.create({
  directory: hostProjectDirectory,
  workspace: workspaceID,
  title,
});
```

The returned/refetched session MUST confirm `Session.workspaceID` before UI navigation. Creating a host-side record with body-only `workspaceID` is not a substitute for remote routing.

OpenChamber MUST durably record the session↔workspace↔project association at creation, at both creation paths, because reviewed OpenCode exposes it on no read path: directory-scoped session lists exclude routed sessions, the `workspace` list parameter is ignored, and session reads omit `workspaceID`. Without the record, a client that did not create the session — or was restarted since — has nothing to group it by, and the session becomes unfindable. The record holds identifiers and the host project directory only, is bounded, and its failure degrades grouping without blocking creation. An upstream fix serializing the persisted `workspaceID` on session reads SHOULD be contributed; OpenCode's session table already stores it.

### 21.2 Continue In Workspace

The user reviews an editable deterministic text draft and explicitly confirms creation of a new target-routed session. The source remains unchanged. UI routing changes only after the new target and its single `noReply` text context message are authoritatively refetched and hash-verified.

### 21.3 Continue On Host

Host continuation uses the same immutable handoff with an exact null workspace binding. It creates a new host session and never detaches or rewrites the source. File changes are excluded and the UI directs users to explicit export/review/apply.

### 21.4 Workspace Lifetime Is Task-Scoped

A workspace is a disposable execution sandbox for one task, not a persistent development
environment. The snapshot flows in once, at creation; changes flow out only through
export/review/apply; there is deliberately no mechanism to bring host changes — including
ones just applied from this very workspace — back into an existing workspace, so after a
successful apply the workspace is stale relative to the project and a further export from
it conflicts with what it itself produced. The productive lifecycle is create → work →
export/apply → delete.

Consequences, measured live on 2026-08-08:

- Export and cleanup run through provider operations and MUST work on a workspace whose
  sync connection is absent. A disconnected workspace remains fully usable for
  review/apply/delete — a first-try clean deletion of a workspace with a dead sync
  connection is verified behavior, not an accident.
- Reconnecting sync after an application restart is **best-effort, not a lifecycle
  requirement**. Live sync serves only in-workspace session continuation; upstream
  provides no API to start sync for one existing workspace (the `workspace` query on
  `sync/start` routes the call *into* the workspace, and the directory-only form starts
  loops only for workspaces with recently active sessions), its `connectSSE` has no
  connect timeout, and a wedged sync fiber is never replaced while its status is not
  `error`. Products built on this reconnect at their own risk.
- A restarted application therefore presents an existing workspace as *disconnected,
  state preserved*, with review/apply/delete available, and offers session continuation
  through a new workspace and the immutable handoff — never by promising a reconnect.
- Reviewed upstream (`workspace/warp`, `sync/steal`, per-workspace `branch`,
  `timeUsed`, discovery re-sync) is shaped toward persistent session-mobile
  environments. This product intentionally diverges: with an immutable baseline and a
  one-way change flow, persistent reuse has no value after apply, and depending on
  upstream's sync lifecycle is the costliest part of riding that divergence.

## 22. Live Workspace State

Bootstrap uses official sync-list, list, and status, but does not treat sync-list 204 as complete discovery. Plugin discovery diagnostics are reconciled separately. Startup also invokes sync start for persisted projects.

OpenChamber consumes workspace ready, failed, and status events. Event updates affect only the corresponding workspace. Missing status is unknown. Status/list failure preserves previous authoritative state. Runtime, project, directory, and workspace identity key all caches. Runtime switch invalidates workspace caches, transports, and export artifacts.

## 23. Host Authorization

Capabilities are:

```text
workspace.read
workspace.use
workspace.admin
host.apply
```

- list/status require `workspace.read`;
- session use requires `workspace.use`;
- configure, validate privileged providers, create, reconcile, cleanup, credential grants, and export require `workspace.admin`;
- host mutation requires `host.apply`.

Default paired clients do not receive admin or apply capabilities. Host administration
MUST be refused outright when the request arrives over a tunnel or an unknown public
scope, whatever credentials it presents. Apply requires explicit review confirmation:
the selection is made against a listing of exactly what will be written.

**Only changing the Secure Workspace policy requires a second credential.** That
operation MUST carry a short-lived one-time proof bound to client/user, operation type,
target project, request-body hash, nonce, and expiration; WebAuthn is preferred with
password fallback, and replay is rejected. Every other privileged operation —
validating a provider, completing a setup step, creating, reconciling, cleaning up,
exporting for review, and apply itself — requires the capability and nothing further.

The distinction is what the operation acts on. Everything else acts *within* the
protections and states what it will do before doing it. Changing the policy acts *on*
them: it can widen the egress allowlist, replace the runtime image, or switch the
feature off, and it takes effect quietly and stays in effect.

A second credential elsewhere was found to defend against nothing. The workspace network
is created `--internal`, so a runtime has no route to the host API at all — the agent
this feature exists to contain cannot reach these endpoints with or without a password.
A remote caller is refused on scope before credentials are considered. What remained was
a prompt answered by a person on their own machine, in front of a screen listing what
they had just asked for, and asked often enough that it stopped being read — which costs
more than it defends, because a credential entered without reading is not a decision.

A successful password or passkey ceremony opens a server-side step-up authorization
window (default 10 minutes) bound to the authenticated principal and held only in
memory, so consecutive policy changes do not repeat the ceremony; every proof keeps its
full single-use binding. The window is cleared on credential rotation, password reset,
and server restart, and silent window probes never consume the password rate limit.

Native Electron operator authority is not inferred from a persisted client kind. Only the current Electron-host process may mint and attest the native local client. Persisted marker strings, legacy records, password login, pairing, and generic client-create requests cannot manufacture native authority. The reserved `desktop-local` dedupe identity cannot be replaced by remote issuance paths. The attested local client always has all four capabilities and capability mutation rejects rather than reducing them.

Remote-client credential persistence MUST fail closed on malformed or unsupported structure, duplicate IDs, duplicate token hashes, and I/O failure. Supported legacy shape migration is explicit. Writes use private same-directory temporary files, file fsync, atomic replacement, and directory fsync where supported; a failed replacement preserves the prior credential store.

## 24. Settings And Product UX

Settings MUST expose only enforced controls:

- enablement and activation status;
- provider availability;
- runtime image digest and allowlist;
- resource limits;
- managed/external egress and policy;
- Kubernetes kubeconfig, context, namespace, storage, port-forward/ingress, TLS, and controller policy;
- Apple Container capability;
- retention;
- credential grant policy;
- validation and reconciliation diagnostics.

Every setting MUST have shared type, sanitizer, persisted format, response formatting, defaults, search metadata, localization, and round-trip tests. Configure runs only after confirmed persistence. Failed activation leaves a reconciled, explicit state.

Secure Workspace settings are mutated only through `POST /api/workspaces/settings`. Reauthentication binds the exact submitted body and activation flag; only the separately validated canonical copy reaches persistence and plugin configuration. Generic settings mutation rejects every `secureWorkspaces*` field. Generic plugin CRUD treats the Secure Workspace package and its exact, normalized, or symlink-equivalent resolved filesystem path as reserved.

Settings persistence and plugin-entry replacement form one serialized recoverable transaction. Before the first mutation, OpenChamber writes a private prepared journal containing only the prior Secure Workspace field family and reserved entries. Settings and OpenCode config files publish through fsynced same-directory temporary files and atomic rename. Recovery is awaited before OpenCode bootstrap; recovery failure blocks startup. Windows rename exhaustion fails while preserving the live file and never falls back to an in-place copy. The journal is removed only after the complete new state is durable; caught failure or interrupted startup restores the exact prior field family and plugin entries without erasing unrelated configuration.

After recovery, startup reconciliation converges the plugin registration with persisted settings: a missing entry is registered, and an entry whose options no longer equal the currently computed plugin options is transactionally rewritten. The entry materializes policy defaults at save time, so without convergence a later default change — a repinned image digest — never reaches OpenCode on existing installations and new workspaces keep being built from the superseded image.

Daily workflow MUST not remain embedded in a settings component. A project/workspace surface provides provider/status badges, create, reconcile, cleanup, start session, reviewed continuation in a workspace or on the host, export, review, apply, and download. Mobile uses the same server contract in a responsive surface.

The primary user journey starts from the ordinary new-session surface, not from the lifecycle management surface. After the user explicitly chooses a project and chooses to create the session in a Secure Workspace, OpenChamber MUST reuse an applicable connected workspace or create and connect one, show bounded progress in that same flow, create the workspace-routed session only after connection, and navigate directly to the new chat. The user MUST NOT have to open Settings, discover the shield, load workspace records, select a workspace row, and press a second start-session action for this normal path.

The shield remains a secondary project-scoped management and recovery entrypoint and remains available before a session exists. Its project scope MUST come from an explicit current project/new-session selection; when no project is explicit, it opens a project chooser and MUST NOT silently use a hidden last-directory fallback. Reopening or leaving the shield surface has an obvious navigation action. A successful create/start action selects the resulting session, switches to chat, and inserts it into the correct workspace sidebar scope immediately rather than waiting for an event race.

Workspace list and connection status recover automatically after startup, managed OpenCode restart, reconnect, and runtime switch. A connected provider resource MUST NOT remain at permanent `Unknown status` pending a manual `load workspaces` action. Partial success is represented explicitly: a session or workspace created before a later response/navigation failure is reconciled and offered for continuation or cleanup, never reported only as an undifferentiated create failure that encourages duplicate retries.

The product distinguishes the primary `Start working in workspace` action from advanced handoff directions such as continuing an existing session in a workspace or on the host. Reviewing changes MUST NOT ask for a credential: review is what makes apply safe, and charging for it discourages the step the design depends on. Where a credential is genuinely required — changing the policy — the UX explains the independent Desktop UI password prerequisite before the action, and consecutive changes reuse a still-valid step-up authorization window rather than repeating the ceremony.

OpenChamber implements this boundary with `SecureWorkspacesSettings` limited to activation/provider/policy controls and a project-scoped Workspaces surface in desktop web/Electron and hosted/Capacitor mobile navigation. The surface is intentionally hidden in VS Code, resets workspace/export state across runtime and directory changes, preserves same-scope authoritative list/status data on refresh failure, and keeps read/use available when capability-aware remote clients lack admin or host-apply grants.

Errors distinguish no workspaces, unsupported platform, provider unavailable, unknown status, connecting, disconnected, resource missing, ownership mismatch, auth missing, policy mismatch, image unavailable, export expired, host conflict, cleanup incomplete, and rollback incomplete.

## 25. Packaging And Distribution

### 25.1 Plugin

For the `v0.1.0` image/provider milestone, OpenChamber consumes the public plugin repository by full immutable Git commit SHA. The pinned package MUST have built entrypoints/declarations, package-consumer tests, a clean `npm pack --dry-run`, and no test files, secrets, local config, or sibling-checkout assumptions. Electron stages and verifies that exact dependency payload.

npm trusted publishing with provenance remains a later distribution milestone. When adopted, it MUST use an exact semver, npm trusted publishing/OIDC where available, and explicit npm organization authorization rather than a long-lived npm token by default. Deferring npm publication does not permit mutable Git branches or tags in OpenChamber dependencies.

### 25.2 Electron

Every package and release workflow MUST install frozen dependencies, stage the exact plugin package, verify staged contents, build assets, package, inspect final resources, and run launch smoke. `package.mjs` MUST refuse packaging when the staged plugin is absent or mismatched so workflows cannot bypass staging.

The final verifier checks plugin entrypoint, package version, contracts, runtime assets, image references, and exclusion of tests/secrets.

## 26. Validation Matrix

### 26.1 Plugin Unit And Contract Tests

- policy parsing and rejection;
- metadata and provider-resource identity;
- recovered control-plane ID verification, immutable ownership, idempotent adoption, export rebinding, and cleanup;
- public plugin compatibility against pinned OpenCode/plugin versions;
- ownership and collision checks;
- process redaction and output bounds;
- state corruption and concurrent writes;
- lifecycle journals and rollback provenance;
- safe snapshot traversal;
- Git/non-Git artifact generation;
- auth proxy HTTP/SSE/WebSocket;
- egress destination policy;
- provider manifests and commands.
- generated create-ID fidelity, exact-row compensation ordering and partial cleanup, connected success, explicit error, and provisional timeout responses.

### 26.2 Failure Injection

For every provider create and cleanup step, test command failure, timeout, process kill, malformed output, foreign resource, missing resource, partial resource, cleanup failure, interrupted retry, concurrent operation, and restart recovery.

### 26.3 Docker Live

Validate both image architectures where available, source/baseline isolation, no writable host mount, per-workspace network, no lateral workspace access, blocked direct egress, allowed managed/external proxy egress, blocked private host targets, authenticated HTTP/SSE/WebSocket, stable target, restart/reconcile, export, cleanup, and foreign collision.

### 26.4 Kubernetes Live

Use a pinned CI cluster with a NetworkPolicy-capable CNI and cover RBAC denial, PVC/Secret/rollout failure, policy enforcement, managed gateway, direct-egress denial, port-forward recovery, ingress controller, TLS, controller-only ingress, pod restart, sync restart, export, cleanup, and foreign collision. Local ingress certification uses the separate reachable Colima profile defined in section 14.3; the existing minimal port-forward cluster is not repurposed.

### 26.5 Apple Container Live

Cover host-only network, managed gateway, loopback publish, port collision, authenticated HTTP/SSE/WebSocket, export, system stop/start, target reconciliation, cleanup, and foreign collision.

### 26.6 Artifact And Apply

Cover clean/dirty Git, non-Git, add/modify/delete/rename/binary/mode/symlink, unusual paths, large files, file and hunk selection, duplicate/unknown IDs, wrong workspace/resource/project/directory/generation, expiration, replay, concurrent host edit, conflict, apply failure, rollback failure, process crash, startup recovery, and proof that failed operations leave no partial host changes.

### 26.7 UI And Runtime

Cover navigation, settings persistence, provider validation, list/status/event reconciliation, create/reconcile/cleanup, routed session creation, immutable reviewed handoff, omitted part types, pagination and stale-source rejection, idempotency and timeout recovery, cleanup-required restart recovery, visual review, file/hunk/binary selection, confirmation, expiration/conflicts, admin reauth, mobile layout, runtime switching, and VS Code hidden/unsupported behavior.

### 26.8 Release

Cover plugin tarball and clean consumer, immutable Git pin, registry preflight, public GHCR pulls, per-architecture manifests, exact-digest smoke, image signatures/SBOM/provenance, clean OpenChamber install, all Electron release workflows, hosted web, remote mobile, and the exact compatibility matrix.

Current-candidate certification additionally requires Apple Container and Kubernetes ingress on dedicated local environments plus native iOS, Android, Windows, and Linux packaged-app validation. Historical completion of these gates for another matrix does not satisfy the current candidate.

## 27. Release Gates

### 27.1 Immediate `v0.1.0` Image And Provider Milestone

The image/provider milestone is blocked until all of the following are true:

- public pullable signed multi-arch runtime image;
- public pullable signed egress gateway image;
- exact immutable plugin Git commit with verified package payload;
- green plugin `test`, both `image`, `docker-live`, and `kubernetes-live` jobs at the tagged commit;
- successful registry preflight proving package creation, public visibility, and unauthenticated pulls without a personal PAT;
- exact candidate-digest vulnerability scans and smoke before semver promotion;
- keyless Cosign verification with the expected repository/workflow/tag identity;
- final runtime and gateway digests recorded as authoritative OpenChamber defaults;
- exact supported OpenCode/SDK/plugin compatibility matrix;
- plugin-owned authenticated HTTP/SSE/WebSocket compatibility transport validated against each supported OpenCode version;
- safe create failure reconciliation;
- provider cleanup before control-plane deletion;
- stable recovery identity;
- restart-recoverable immutable context handoff;
- explicit sync startup and stable target recovery;
- no raw patch apply endpoint;
- no inspect-visible or logged secrets;
- no metadata trust for sensitive operations;
- no shared cross-workspace provider network;
- settings round-trip passes;
- complete product UI is reachable;
- start and reviewed workspace/host continuation pass end to end;
- Git and non-Git export/apply pass;
- file and hunk selection pass;
- atomic rollback and crash recovery pass;
- Docker, Kubernetes, and Apple Container live suites pass;
- Electron packaged GUI smoke passes;
- host-admin capability and reauthentication pass;
- documentation matches released behavior.

Passing this milestone certifies Secure Workspace images/providers and their currently validated OpenChamber integration. It is not the final cross-platform application release.

### 27.2 Deferred Complete Product Release Gates

The complete cross-platform product release additionally requires:

- native iOS package/simulator/device validation;
- native Android package/emulator/device validation;
- native Windows package, GUI, process, Docker Desktop, and provider validation;
- native Linux AppImage, GUI, and provider validation;
- physical hosted/Capacitor mobile smoke where applicable;
- release signing and notarization credentials for the platform artifacts that require them;
- npm trusted publication only when the later npm distribution milestone is activated.

These remain required before claiming a complete cross-platform production release. Platform testing is a guided target-host QA workstream rather than a dependency of ordinary release CI, and passing a local smoke does not automatically promote it to release certification evidence.

Each Windows, Linux, and macOS check runs in an OpenChamber session on the target host against an exact candidate checkout and native package. The assistant owns commands, provider setup, assertions, recovery, and cleanup; the operator owns UAC, reboot, system dialogs, and interactive UI confirmation. Tests use disposable projects and isolated OpenChamber, Chromium, OpenCode, Docker, and Kubernetes profiles. Windows covers Docker Desktop and focused Kubernetes integration; Linux covers direct AppImage execution, full Docker, and disposable `kind`; macOS covers Apple Container without weakening fail-closed managed egress. VM, unpacked package, and automated packaged smoke cannot satisfy target-host or interactive-apply gates.

Physical mobile testing is owner-operated. iOS uses the exact TestFlight version/build delivered by the GitHub-hosted mobile release workflow and installed by the designated operator from a dedicated App Store Connect group containing no other testers. Android uses the exact signed APK after certificate, version, and build verification. Each device receives a distinct fresh single-use pairing URL for a disposable Windows/Linux OpenChamber server. Pairing credentials and device identities are not logged. Maestro proves routed session, change, export dry-run, and destructive cleanup; it does not prove interactive host apply. Self-hosted physical-device runners are not required.

## 28. Implementation Dependency Order

The implementation and certification work is delivered as one release candidate and one non-bypassable release gate. Workstreams may execute concurrently, but no partial workstream changes release status. Completion requires:

1. Keep this specification synchronized with current implementation, exact identities, evidence, and release decisions.
2. Produce and certify the exact compatibility matrix and immutable image digests.
3. Complete transport, collision, credential rotation, failure-injection, artifact/apply, and restart-recovery coverage.
4. Complete hosted web, Electron, iOS, Android, Windows, Linux, physical-device, and platform-signing evidence.
5. Pass the unified current-commit certification gate and final security review before publication.

## 29. Validation Responsibilities

The implementation reviewer should run all available automated suites, type-checks, lints, builds, package consumer tests, Git/non-Git fixtures, Docker/Colima tests, kind/CNI tests, Apple Container tests, macOS Electron package/GUI smoke, security inspections, and restart/failure-injection scenarios.

### 29.1 Current Contributor Permissions

The current contributor account `yulia-ivashko` is an active `openchamber` organization member with `maintain`, `push`, `workflow`, and pull access to both repositories, but without repository `admin`. No plugin repository ruleset or branch protection was found at the audit time. These rights are sufficient to change code/workflows, push commits, manually dispatch workflows, and normally push the `v0.1.0` tag.

The local `gh` OAuth token currently has `repo`, `workflow`, `read:org`, and `gist`, but not `read:packages` or `write:packages`. Therefore local CLI package listing/manual package administration is unavailable. This does not restrict the separate per-job Actions `GITHUB_TOKEN`.

### 29.2 Secrets And Signing Model

No personal registry secret, Docker Hub account, GHCR password, Cosign private key, or long-lived signing secret is required for the immediate image release:

- GHCR push uses the ephemeral Actions `GITHUB_TOKEN` with `packages: write`;
- keyless Cosign uses GitHub OIDC with `id-token: write`;
- SBOM and provenance use build attestations without a private key;
- public-pull verification runs after registry logout;
- the CI registry is ephemeral and unauthenticated on runner loopback;
- local Kubernetes certification uses an ephemeral local CA, not production DNS/TLS credentials;
- Apple Container installation requires an interactive local administrator authorization, which MUST NOT be stored in GitHub or repository files;
- npm credentials are not required while npm publication remains deferred.

### 29.3 Owner Or Administrator Actions

The contributor cannot inspect or change organization-level Actions/package policy; those APIs returned authorization failure without admin rights. An organization owner or package administrator is needed only if registry preflight proves that organization policy blocks one of the following:

- repository Actions creating `ghcr.io/openchamber/opencode-workspace`;
- repository Actions creating `ghcr.io/openchamber/workspace-egress-gateway`;
- either package becoming public;
- repository-scoped `packages: write` or OIDC signing.

The preferred remedy is a one-time organization/package policy or visibility change. The owner MUST NOT share a personal token or password. A PAT secret is not the default design.

Complete-product gates require owner-provided protected infrastructure or credentials for Apple application signing/notarization, native Windows/Linux release infrastructure, physical mobile devices, and production-like Kubernetes environments. npm organization trusted-publisher setup is required only when npm distribution is activated.

For every owner-run check, contributors MUST provide exact commands, prerequisites, expected results, cleanup steps, and evidence to record.
