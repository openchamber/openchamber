# Secure Workspaces Production Specification

Status: authoritative implementation and release specification
Last audited: 2026-07-21

## 1. Purpose

Secure Workspaces provides isolated OpenCode execution environments managed through OpenChamber. A workspace runs its own OpenCode server and isolated project copy in Docker, Kubernetes, or Apple Container. OpenCode remains the control plane and routes workspace-owned sessions and requests to that server. OpenChamber owns policy, product UX, privileged host operations, reviewed change export, and release integration.

This document is the only authoritative Secure Workspaces plan and acceptance contract. It replaces the former personal requirements, handoff, copied requirements, and test log. Historical command output is not evidence that the current implementation satisfies this specification.

The target is one complete production product. There is no reduced "v1", prototype, experimental implementation milestone, or deferred security baseline.

## 2. Normative Language And Completion Rules

- **MUST** and **MUST NOT** define release-blocking requirements.
- **SHOULD** permits deviation only when the reason and compensating control are recorded in this document.
- Code presence is not evidence of correctness.
- A requirement is complete only when implementation, focused automated coverage, relevant live validation, and documentation agree.
- Static type-checking and linting do not prove provider, security, recovery, packaging, or platform behavior.
- A historical smoke result does not validate a later plugin commit, OpenCode version, dependency pin, image digest, or packaged application.
- Provider failure MUST NOT become an authoritative empty result.
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

## 5. Current Audited Baseline

The existing implementation is useful source material but does not conform to this specification.

Verified current strengths include:

- an external plugin repository and immutable Git dependency pin;
- Docker, Kubernetes, and Apple Container provider implementations;
- file-backed workspace endpoint tokens;
- a runtime authentication proxy covering HTTP, SSE, and WebSocket inside the runtime;
- Docker capability drop, `no-new-privileges`, internal networking, and localhost access-proxy concepts;
- Kubernetes Secret, PVC, Deployment, Service, NetworkPolicy, port-forward, and hardened tar seeding concepts;
- Apple Container host-only networking, loopback publishing, and gateway rewrite concepts;
- OpenChamber compatibility, validation, export artifact, and selected-file apply route groundwork;
- Electron plugin staging groundwork;
- useful mocked provider and route tests.

Known current non-conformities include:

- the Workspaces page is not mounted in `SettingsView`;
- all `secureWorkspaces*` settings are discarded by the server settings sanitizer;
- the default runtime image is not publicly pullable;
- production release workflows skip plugin staging;
- `workspace.extra` controls sensitive provider operations;
- broad OpenCode auth content is inspect-visible and can appear in process errors;
- create retry can delete an existing workspace;
- the token store is not atomic or concurrency-safe;
- the seed baseline is wrong for dirty Git repositories;
- raw patch apply bypasses artifact identity and expiration;
- check-then-apply has no durable rollback;
- required settings and daily workspace UX are incomplete;
- start-session-in-workspace is not implemented;
- status failure is converted to empty status state;
- Kubernetes ingress is accepted but not provisioned;
- policy fields such as TTL and secret mode are accepted without enforcement;
- local recovery now safely adopts a `syncList`-allocated control-plane ID after provider and state verification; stable upstream discovery IDs remain preferred.

The plugin has not been publicly released. Production code does not need compatibility aliases, old metadata migration, or the old token-store format. Local development resources may be removed with an explicit development cleanup tool, not a permanent production compatibility path.

## 6. OpenCode Upstream Compatibility Contract

### 6.1 Audit Baseline

The latest upstream reviewed for this specification is:

- repository: `anomalyco/opencode`;
- `dev` commit: `5f241f1cc1fc0c266044b64bf9e860d4e37c9c1f`;
- latest reviewed release: `v1.18.4`;
- latest reviewed npm SDK: `@opencode-ai/sdk@1.18.4`;
- OpenChamber installed SDK at audit time: `1.18.3`.

The relevant workspace HTTP surface in SDK 1.18.3 materially matches the reviewed upstream implementation. A dependency upgrade MUST still follow normal OpenChamber dependency, lockfile, CLI packaging, and compatibility validation.

Before every plugin or OpenChamber release, the compatibility matrix MUST record:

- exact OpenCode release and binary digest;
- exact SDK version;
- exact `@opencode-ai/plugin` version;
- exact plugin package version;
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

### 6.5 Authenticated WebSocket Blocker

Reviewed OpenCode overlays adapter target headers for HTTP/SSE proxying but does not pass target headers to the WebSocket proxy handshake. An authenticated remote workspace therefore rejects terminal and other WebSocket upgrades.

Release requirements:

- OpenCode MUST forward adapter target headers during WebSocket proxy handshakes;
- the fix MUST have an upstream test with a header-authenticated remote target;
- OpenChamber MUST validate authenticated HTTP, SSE, terminal WebSocket, reconnect, and credential stripping;
- workspace authentication MUST NOT be weakened or moved into a long-lived URL token as a workaround.

This is an upstream release blocker for complete authenticated remote workspaces.

### 6.6 Create Failure Behavior

Reviewed OpenCode writes a workspace control-plane row before adapter create and can retain that row after adapter failure.

Required compensation and upstream direction:

- OpenChamber MUST provide a client-generated workspace ID;
- plugin create MUST rollback only resources created by the failed operation;
- OpenChamber MUST reconcile or remove the known provisional row after create failure;
- UI MUST NOT report success until authoritative workspace status reaches `connected`;
- a stale failed row MUST be visible and recoverable, not mistaken for a ready workspace;
- an upstream transactional or explicit provisional-row model SHOULD be contributed.

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
- restart sync when a provider target changes.

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

## 7. Plugin Redesign

The plugin core SHOULD be rewritten before its first public release. Existing code may be reused only after it satisfies the contracts below.

Recommended structure:

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

### 14.4 Apple Container

Each workspace MUST have mutable and baseline volumes, a per-workspace host-only network, a loopback-only collision-checked publish, and controlled gateway egress. Runtime images run non-root with dropped capabilities and the strongest available privilege control. Restart after `container system stop/start`, target recovery, network collision, volume collision, port collision, and cleanup MUST be live-tested.

The absence of an exact Apple equivalent to Docker `no-new-privileges` is a documented platform property, not a hidden claim. Compensating controls and tests are mandatory.

## 15. Runtime Images

The former default `ghcr.io/openchamber/opencode-workspace:1.0.0` is invalid for release because unauthenticated pull returned `denied`. It MUST be removed from defaults until a real public artifact exists.

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

The current custom `diff --git` string splitter MUST NOT be the production selection boundary.

A reviewed structured diff implementation MUST produce stable text hunks and line/context hashes. Unknown, duplicate, overlapping, stale, or dependent selections are validated server-side. Binary content supports whole-file selection only. Large text may require whole-file selection with a visible explanation. Rename, mode, and symlink changes remain indivisible logical operations.

The browser receives review metadata and bounded content views, not authority to replace artifact content.

## 19. OpenChamber Runtime API

The production API SHOULD use side-effect-appropriate methods such as:

```text
POST   /api/workspaces/providers/:provider/validate
GET    /api/workspaces/compatibility
POST   /api/workspaces/configuration
POST   /api/workspaces/:workspaceID/exports
GET    /api/workspace-exports/:exportID
GET    /api/workspace-exports/:exportID/files/:fileID
POST   /api/workspace-exports/:exportID/validate
POST   /api/workspace-exports/:exportID/apply
GET    /api/workspace-exports/:exportID/download
DELETE /api/workspace-exports/:exportID
```

There MUST be no raw client patch apply route. A directory is accepted only after canonical project binding. Provider settings and executable/context overrides come only from persisted host-admin policy.

## 20. Atomic Host Apply

Apply MUST:

1. validate host-admin capability;
2. validate one-time short-lived reauthentication proof;
3. acquire a canonical project mutation lock;
4. load and verify the server artifact;
5. verify workspace, provider resource, project, directory, generation, expiration, and unused state;
6. validate file and hunk selection;
7. recompute current host hashes for every affected path;
8. require affected host entries to match artifact baseline;
9. reject path traversal and symlink escape;
10. materialize the selected result in a temporary staging tree;
11. verify expected result hashes;
12. create a durable rollback journal and backups;
13. replace entries and apply mode/symlink operations;
14. fsync where supported;
15. verify final hashes;
16. commit the journal, clean backups, and consume the artifact.

Failure after journal creation MUST restore every backup, remove newly created paths, verify restoration hashes, and retain a recovery journal if rollback is incomplete. Further host mutation is blocked until recovery. The API MUST return primary and rollback diagnostics and MUST never report partial success as success.

Unselected files MUST remain unchanged. Concurrent changes to an affected host file produce a conflict rather than an automatic merge.

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

### 21.2 Continue In Workspace

The user reviews an editable deterministic text draft and explicitly confirms creation of a new target-routed session. The source remains unchanged. UI routing changes only after the new target and its single `noReply` text context message are authoritatively refetched and hash-verified.

### 21.3 Continue On Host

Host continuation uses the same immutable handoff with an exact null workspace binding. It creates a new host session and never detaches or rewrites the source. File changes are excluded and the UI directs users to explicit export/review/apply.

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

Default paired clients do not receive admin or apply capabilities. Privileged remote operations require a short-lived one-time proof bound to client/user, operation type, target project, request-body hash, nonce, and expiration. WebAuthn is preferred with password fallback. Apply additionally requires explicit review confirmation. Replay is rejected.

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

Daily workflow MUST not remain embedded in a settings component. A project/workspace surface provides provider/status badges, create, reconcile, cleanup, start session, reviewed continuation in a workspace or on the host, export, review, apply, and download. Mobile uses the same server contract in a responsive surface.

OpenChamber implements this boundary with `SecureWorkspacesSettings` limited to activation/provider/policy controls and a project-scoped Workspaces surface in desktop web/Electron and hosted/Capacitor mobile navigation. The surface is intentionally hidden in VS Code, resets workspace/export state across runtime and directory changes, preserves same-scope authoritative list/status data on refresh failure, and keeps read/use available when capability-aware remote clients lack admin or host-apply grants.

Errors distinguish no workspaces, unsupported platform, provider unavailable, unknown status, connecting, disconnected, resource missing, ownership mismatch, auth missing, policy mismatch, image unavailable, export expired, host conflict, cleanup incomplete, and rollback incomplete.

## 25. Packaging And Distribution

### 25.1 Plugin

The plugin MUST publish an exact npm version with provenance, built entrypoints, declarations, package-consumer tests, and no test files, secrets, local config, or sibling-checkout assumptions. Direct OpenCode installation is documented.

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

Use kind with a NetworkPolicy-capable CNI and cover RBAC denial, PVC/Secret/rollout failure, policy enforcement, managed gateway, direct-egress denial, port-forward recovery, ingress controller, TLS, controller-only ingress, pod restart, sync restart, export, cleanup, and foreign collision.

### 26.5 Apple Container Live

Cover host-only network, managed gateway, loopback publish, port collision, authenticated HTTP/SSE/WebSocket, export, system stop/start, target reconciliation, cleanup, and foreign collision.

### 26.6 Artifact And Apply

Cover clean/dirty Git, non-Git, add/modify/delete/rename/binary/mode/symlink, unusual paths, large files, file and hunk selection, duplicate/unknown IDs, wrong workspace/resource/project/directory/generation, expiration, replay, concurrent host edit, conflict, apply failure, rollback failure, process crash, startup recovery, and proof that failed operations leave no partial host changes.

### 26.7 UI And Runtime

Cover navigation, settings persistence, provider validation, list/status/event reconciliation, create/reconcile/cleanup, routed session creation, immutable reviewed handoff, omitted part types, pagination and stale-source rejection, idempotency and timeout recovery, cleanup-required restart recovery, visual review, file/hunk/binary selection, confirmation, expiration/conflicts, admin reauth, mobile layout, runtime switching, and VS Code hidden/unsupported behavior.

### 26.8 Release

Cover plugin tarball and clean consumer, public GHCR pulls, image signatures/SBOM/provenance, clean OpenChamber install, all Electron release workflows, macOS package and GUI, Windows package and GUI, Linux AppImage and GUI, hosted web, remote mobile, and exact compatibility matrix.

## 27. Release Gates

Release is blocked until all of the following are true:

- public pullable signed multi-arch runtime image;
- public pullable signed egress gateway image;
- exact published plugin package;
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
- required macOS, Windows, and Linux matrix passes;
- host-admin capability and reauthentication pass;
- documentation matches released behavior.

## 28. Implementation Dependency Order

This is execution order, not a sequence of partial product releases. Every item is mandatory before completion.

1. Adopt this specification and remove contradictory plans.
2. Establish the plugin-owned authenticated transport compatibility boundary and local reconciliation for unstable discovery/removal behavior. Upstream WebSocket target headers, stable discovery identity, and warp are not production dependencies.
3. Replace plugin package contracts, schemas, build output, and compatibility tests.
4. Implement plugin process, redaction, state, secret, ownership, and transaction core.
5. Implement safe source snapshot, immutable baseline, and artifact core.
6. Implement and publish pre-release runtime and managed egress images.
7. Rewrite Docker provider against the new core.
8. Rewrite Kubernetes provider, including real ingress.
9. Rewrite Apple Container provider.
10. Implement typed plugin server-side operations.
11. Replace OpenChamber handwritten workspace SDK behavior with generated SDK contracts.
12. Repair settings persistence and configuration transactions.
13. Implement host capabilities and reauthentication.
14. Implement export storage, structured review, and atomic host apply.
15. Implement authoritative live workspace state and sync startup.
16. Implement project/workspace product UI and mobile parity.
17. Implement routed session create and immutable reviewed context handoff.
18. Correct every Electron and release packaging path.
19. Build all automated, failure-injection, live-provider, platform, and release tests.
20. Perform an independent security and data-integrity review.
21. Publish final plugin and signed images.
22. Pin exact package versions and image digests.
23. Run the complete release validation matrix.
24. Release only when every gate is satisfied.

## 29. Validation Responsibilities

The implementation reviewer should run all available automated suites, type-checks, lints, builds, package consumer tests, Git/non-Git fixtures, Docker/Colima tests, kind/CNI tests, Apple Container tests, macOS Electron package/GUI smoke, security inspections, and restart/failure-injection scenarios.

The repository owner may need to provide or execute checks requiring protected infrastructure or credentials:

- GitHub Actions permission for public GHCR publish and signing;
- npm organization publication rights;
- native Windows Docker Desktop and packaged-app validation;
- native Linux AppImage and provider validation;
- production-like Kubernetes storage, RBAC, ingress, TLS, and CNI validation;
- physical mobile-device smoke;
- release signing and notarization credentials.

For every owner-run check, contributors MUST provide exact commands, prerequisites, expected results, cleanup steps, and evidence to record.
