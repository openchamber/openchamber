---
name: secure-workspaces
description: Use when changing Secure Workspaces policy, lifecycle, providers, isolation, egress, credentials, workspace auth or transport, export/review/apply, handoff, plugin pins, runtime images, release workflows, platform setup, or live/physical validation.
---

# Secure Workspaces

## Read First

Read the sources that own the touched boundary before editing:

1. `docs/SECURE_WORKSPACES_SPECIFICATION.md` for the authoritative product, security, provider, and release contract.
2. `docs/SECURE_WORKSPACES_PHYSICAL_TEST_SETUP.md` for guided target-host, packaged-app, provider, physical-mobile, interactive-apply, and cleanup validation.
3. `packages/web/server/lib/workspaces/DOCUMENTATION.md` for the server trust boundary, lifecycle, artifact, apply, and handoff invariants.
4. `packages/electron/README.md` for plugin staging and packaged-payload verification when Electron dependencies or packaging change.
5. `../opencode-container-workspace/README.md` when the sibling plugin checkout is available and provider, image, or plugin contracts change.

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
| Guided platform and physical validation runbook | `docs/SECURE_WORKSPACES_PHYSICAL_TEST_SETUP.md` |

Keep entrypoints, routes, bridges, and UI thin. Security decisions belong in the owning server or provider boundary.

## Non-Negotiable Invariants

### Authority And Identity

- Persisted server policy is authoritative. Never let browser input select source directories, image references, Kubernetes contexts/namespaces, provider metadata, resource IDs, or cleanup targets.
- Keep OpenCode control-plane workspace identity distinct from immutable provider resource identity.
- Recompute canonical resource names. Do not trust persisted or request-provided names without canonical verification.
- Verify provider, project, resource ID, role, and original audit identity before target, restart, export, rotation, reconciliation, or deletion.
- A missing or failed provider query is not authoritative empty state. Preserve unrelated valid entities and report partial failure explicitly.
- Capability decides who may act; a credential prompt is not a substitute and rarely an addition. Host administration is refused outright over a tunnel, and the runtime network is created `--internal`, so what this feature contains has no route to these endpoints at all. Only changing the policy — the egress allowlist, the runtime image, the feature switch — asks again, because it acts on the protections rather than within them and takes effect without showing what it did. Reviewing changes must never ask: review is what makes apply safe, and charging for it discourages the step the design depends on.
- A prompt that appears on every adjacent action is a security problem, not a security feature. It is answered without reading, which is worse than not asking.

### Isolation And Egress

- Runtime images execute workspace code; gateway images enforce outbound policy. Do not combine these trust roles.
- Runtime containers must not have direct fallback egress. Use the managed gateway or an explicitly configured external proxy.
- The gateway must not receive project mounts, workspace credentials, provider state, or arbitrary process helpers.
- Keep images immutable and digest-pinned. Do not introduce `latest`, tag-only production defaults, silent pull fallback, or platform fallback.
- Provider differences must be explicit. In particular, Apple Container must never silently fall back to Docker, and unsupported managed networking must fail closed.
- A cluster accepting a NetworkPolicy is not a cluster enforcing one. Where nothing enforces, every written policy is inert, the egress allowlist means nothing, and every surface still reports the workspace as isolated. Creation probes enforcement and fails closed when a cluster is proven not to enforce.
- That probe needs two pods, not one: an unrestricted pod establishes the reference address is reachable, and only then does a restricted pod prove anything. A single blocked probe cannot tell an enforced policy from an address that was never reachable, and must report inconclusive rather than pass.
- Enforcement latches but is not instant. A pod can start before the CNI programs a policy selecting it, so a probe samples across a window; any blocked attempt proves enforcement, and only an unbroken run of successes disproves it. A single attempt races enforcement and reports a false negative on a healthy cluster.

### Secrets And Transport

- Keep workspace credentials file-backed and provider-owned. Never place secret values in CLI arguments, ordinary environment variables, metadata, diagnostics, URLs, logs, or browser payloads.
- Seed secret volumes through bounded redacted stdin. Never bind-mount private host secret directories into helpers.
- Preserve authenticated HTTP, SSE, and WebSocket behavior. The host shim strips caller routing/auth headers, verifies the fixed provider target, rereads the canonical token, and injects it only upstream.
- Do not treat loopback source address as remote-client authority. Relay and tunnel traffic can arrive through loopback.

### Host And Container Boundaries

- A path inside a workspace means nothing on this computer. A session routed into a workspace reports the directory it works in — `/workspace` — and host-side state must never take it: the file tree points at nothing, and it persists as `lastDirectory` past the session that introduced it. Convert at the transport boundary.
- Ask a person only for what the machine cannot determine. The cluster states its own DNS service address and kubeconfig names its own contexts; requiring either by hand blocks the case Kubernetes exists for and breaks name resolution invisibly when mistyped. Ask only where RBAC genuinely hides the answer, and say what to request.
- One rule, one owner. When the provider learned to discover the DNS address, the requirement stayed in OpenChamber's completeness check and refused every save — including changes about something else, which then rolled back. A rule enforced in two places will drift, and the second copy fails silently.
- Hold the plugin API and the host SDK at one OpenCode version. Two copies of the SDK in one dependency tree stop the Electron package from building, and the runtime image must track that version too so the CLI inside a workspace matches the API the host talks to. Before moving, compare the workspace surface across the versions — the v2 client, the generated SDK and the generated types — rather than assuming a patch release is inert.
- Never hand a tool an absolute path it may reinterpret. Windows ships bsdtar in System32 and Git for Windows ships GNU tar, which reads `C:\path` as `host:path`; PATH order decides which answers, so the same command works or fails depending on what else is installed. Stream through stdout rather than detecting flavours.

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

### Guided Live Validation

- Run target-platform validation in an OpenChamber session on that Windows, Linux, or macOS host. A self-hosted GitHub runner is not a prerequisite.
- The assistant owns commands, build, provider setup, assertions, recovery, and cleanup; the operator owns UAC, reboot, device trust, passkey, system dialogs, and interactive UI confirmation.
- Use disposable projects and isolated app, OpenCode, provider, Docker, and kubeconfig profiles. Never mutate personal profiles or projects.
- Windows validates the packaged app with Docker Desktop and focused Kubernetes integration. Linux validates the native AppImage with full Docker and disposable `kind`. macOS validates Apple Container without weakening fail-closed managed egress.
- TestFlight delivery uses the GitHub-hosted mobile release workflow; Android delivery uses its signed artifact. Neither requires a physical-device runner.
- Simulator, emulator, fixture, VM, unpacked package, and automated packaged smoke are not physical/live platform evidence. Maestro dry-run is not interactive host-apply evidence.
- Do not claim production readiness until the exact plugin, SDK/OpenCode, runtime/gateway images, package, and required-platform matrix has current live evidence.

## Product Strategy

These are decisions, not preferences. Each was reached by working the problem; reversing
one needs a reason at least as concrete.

- **A workspace is a task, not a home.** The snapshot flows in once at creation and
  changes flow out only through export/review/apply, so after an apply the workspace is
  stale relative to the project by construction — there is deliberately no way to bring
  host changes back in. Create → work → export/apply → delete is the lifecycle. Export
  and cleanup work on a disconnected workspace (verified live); sync reconnection after
  an app restart is best-effort only, because upstream offers no per-workspace sync
  start, no connect timeout, and no replacement of a wedged sync fiber. Never build a
  flow that depends on reconnecting to an old workspace; offer a new workspace plus the
  immutable handoff instead.
- **Docker is the ordinary choice; Kubernetes means a cluster somebody else runs.** A
  cluster on the same computer is strictly worse here — same machine, more layers, a
  1.3 GB pull into the cluster, an extra port-forward hop — for isolation Docker enforces
  natively. Kubernetes earns its place when the work must run elsewhere: a cluster from
  work, a bigger machine, one with a GPU. Say so where the choice is made, so nobody
  configures a local cluster believing it is the more serious option.
- **This product does not create clusters.** Tools at this layer consume one and document
  how to get it; provisioning belongs to kind, minikube, Docker Desktop, or a vendor CLI.
  Offering a known-good recipe is fine; owning cluster lifecycle is not.
- **Nothing is discovered by failing.** A person must not learn the state of their setup
  by choosing an operation and having it refused. If a fact is knowable before the
  attempt — a missing namespace, a policy that no longer matches, a dependency that is
  not installed — surface it beside the thing it concerns, before it is needed.
- **Ask only for what the machine cannot know.** Everything the cluster, kubeconfig, or
  environment already states is read, not typed. What remains for a person is genuinely
  theirs: a domain they own, an allowlist, a credential.
- **Name the setting at fault, not the symptom observed.** An image the cluster cannot
  pull is an image problem; reporting it as an isolation result sends the reader to the
  wrong screen. Map every failure to the thing its owner can change.
- **A control that names an outcome produces it.** Editing a text field is a draft and
  waits for Save; pressing a button called "Use built-in images" is not. A control that
  only stages a change while appearing to act is indistinguishable from a broken one.
- **An answer must outlive the thing that showed it.** Results reported inside a section
  that a refresh can unmount are lost exactly when they matter. A completed checklist
  stays visible too — it is the only way to confirm a setup is still sound.
- **The setup path is finite, ordered, and shown whole.** Every requirement is listed
  from the start with its own status, the app completes the steps it can, and the list
  reads as a request an operator can hand to whoever administers their cluster.

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
| Kubernetes | Port-forward or final HTTPS target as applicable, NetworkPolicy **enforcement observed on a cluster that enforces and one that does not**, ownership, rollback, reconciliation, and cleanup. A create takes roughly eighty seconds against a local cluster; waits shorter than that report healthy workspaces as timed out |
| Apple Container | Supported macOS host, immutable arm64 image, create/target/export/reconcile, collision, system restart, and cleanup |
| Runtime/gateway images | Both architectures, exact digest, runtime smoke, HIGH/CRITICAL fixed-vulnerability gate, and anonymous pull when public |
| Plugin pin or Electron packaging | Lockfile/install verification, staging tests, package verification, and affected packaged build/smoke |
| Windows/Linux/macOS platform behavior | Guided run on the target host using the exact native package, isolated profiles, applicable providers, interactive apply, failure recovery, and authoritative cleanup |
| Physical iOS/Android behavior | Exact TestFlight build or signed APK on one physical device, disposable remote server, redacted pairing, Maestro dry-run/cleanup, and separate interactive apply evidence |
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
- Simulator, emulator, VM, fixture, package smoke, or Maestro dry-run presented as physical platform or interactive host-apply evidence.
- NetworkPolicy objects created and treated as isolation without observing that the cluster enforces them.
- A container path stored, compared, or displayed as a path on this computer.
- A value required from the operator that the cluster, kubeconfig, or environment already states.
- The same requirement enforced in both the plugin and OpenChamber, where one can refuse what the other has learned to resolve.
- An absolute path passed as an argument to a tool whose flavour varies by platform or PATH order — and, the same defect wearing a different coat, a system tool invoked by bare name. Git for Windows ships `tar` and `whoami` that shadow the ones in System32 and answer differently; name System32 binaries by absolute path.
- A protection asserted by a test that would pass without it. Modes and access lists are the usual case: a directory under `%TEMP%` is already private on a normal profile, so a test rooted there confirms nothing until it first opens the directory to everyone.
- A long-standing platform-specific test failure dismissed as noise. Two such failures in the snapshot suite were a real defect that broke workspace creation for every Windows operator whose PATH preferred Git's tar.
- A permission the code declares and the platform ignores. Windows implements neither `0o700` nor `0o600`; a store that says it restricts its secrets and inherits that restriction from wherever it happens to live has not restricted anything, and moves the moment someone repoints the data directory.
- A locale left behind when the surface grows. This feature reached ten dictionaries and skipped German, and the key-parity test failed for as long as the feature existed — an untranslated key is a visible bug for those users, not a deferral.
