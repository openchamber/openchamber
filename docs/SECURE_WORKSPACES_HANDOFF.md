# Secure Workspaces Handoff

Status: active implementation, incomplete production certification
Updated: 2026-08-20

## Product Goal

Secure Workspaces runs an agent in an isolated disposable environment instead of
on the host project. The host project is snapshotted at creation. Workspace
changes return only through an explicit export, review, dry-run, confirmed host
apply, and cleanup flow.

The intended lifecycle is:

```text
create -> work -> export -> review -> dry-run -> confirmed apply -> cleanup
```

The security baseline is unchanged across providers:

- no writable host-project mount in the runtime;
- authenticated workspace transport;
- no direct runtime egress fallback;
- immutable provider identity and ownership checks;
- server-owned reviewed artifacts and host apply;
- transactional creation, recoverable apply, and idempotent cleanup.

## Ownership

| Boundary | Owner |
| --- | --- |
| Provider lifecycle, isolation, egress, runtime auth, snapshots, export | `openchamber/opencode-container-workspace` |
| Persisted policy, authorization, orchestration, review/apply, recovery | OpenChamber web server |
| Workspace/session control plane and routed requests | OpenCode |
| Packaged payload and native desktop boundary | OpenChamber Electron |
| Shared workflow UI | OpenChamber UI |

OpenCode remains authoritative for workspace records and routing. OpenChamber
maintains a bounded durable session/workspace/project compatibility index because
some supported OpenCode reads omit the association. Consumers validate every
recorded workspace against OpenCode and fail closed; the index never becomes an
independent workspace control plane.

The normal OpenChamber Files and Terminal surfaces intentionally remain scoped to
the host project. Agent-created workspace files stay invisible there until the
reviewed apply completes. OpenCode-routed file requests use workspace authority
and must never fall back to host files.

## Current Candidate

| Component | Current repository identity |
| --- | --- |
| OpenChamber package version | `1.18.4` |
| Host OpenCode SDK / bundled CLI target | `1.18.18` |
| Workspace plugin pin | `b1c4682d5c1509c86fa5ce7f4e7170fa4ba13466` |
| Installed/staged plugin package | `0.1.1` |
| Installed/staged plugin API | `1.18.12` |
| Runtime image | `ghcr.io/openchamber/opencode-workspace@sha256:40266ce54560149396cdc89395fa26df08f8924e4f377acbf12a88da08b2c141` |
| Gateway image | `ghcr.io/openchamber/workspace-egress-gateway@sha256:37c1452849212c5e9b2b62257792ca092c44c5ebba6d165667f235164e571555` |

The host SDK/CLI and plugin API are not currently on one OpenCode version. The
current Windows Docker lifecycle is live-proven, but the mixed `1.18.18` / `1.18.12`
combination still requires an explicit compatibility decision and matrix before a
release claim.

## Current Validation Matrix

| Target | Provider/surface | Current-candidate status |
| --- | --- | --- |
| Windows packaged app | Docker | Passed full lifecycle |
| Windows packaged app | Kubernetes | Pending replay |
| Debian native AppImage | Docker | Pending; validation host unreachable |
| Debian native AppImage | Kubernetes | Pending; validation host unreachable and prior host lacked the cgroup v2 memory controller required by `kind` |
| macOS | Apple Container | Historical non-certifying evidence only |
| Hosted web | Applicable provider host | Pending live workflow |
| Capacitor mobile | Physical iOS and Android | Pending live workflow and interactive apply |
| VS Code | Explicit unsupported behavior | Pending current-candidate confirmation |

Historical results do not certify the current candidate. In particular, the prior
Linux ARM64 AppImage/Docker pass and prior Windows Kubernetes pass belong to older
candidate identities and must be rerun.

## Windows Docker Evidence

The current packaged Windows candidate passed:

- authoritative managed OpenCode startup readiness;
- Docker workspace create and `connected` state;
- durable session/workspace/project routing;
- workspace-routed file list/content with no host-file fallback;
- host isolation before apply;
- internal workspace networking, blocked direct egress, and unauthenticated `401`;
- structured export and one-file review/selection;
- dry-run with no host mutation;
- confirmed apply with exact reviewed bytes and metadata;
- artifact consumption and zero apply journal/lock files;
- packaged restart association recovery;
- authoritative cleanup and idempotent cleanup retry;
- zero final containers, volumes, networks, projects, temporary directories, or candidate processes.

Focused proxy/workspace/server validation passed `93/93` locally and on Windows.
Web type-check, Web lint, JavaScript syntax checks, packaged plugin verification,
and the Windows Electron build passed. Broad oxlint still reports pre-existing
findings in touched server files; no new finding was identified on the authored
paths.

## Implemented Security Corrections

- Server provider operations load beside the exact plugin entrypoint registered
  with OpenCode, keeping adapter creation and privileged operations on one package
  and policy parser.
- Workspace-routed OpenCode file requests resolve the durable route, validate the
  workspace against the authoritative OpenCode list, canonicalize the upstream
  `workspace` selector, and reject missing, conflicting, or stale authority.
- Proxy authorization resolves UI and tunnel controllers lazily per request, so
  registering the proxy before controller initialization cannot permanently bypass
  workspace authorization or route rewriting.

## Open Product Work

1. Fail closed before provider creation when a project or ancestor OpenCode config
   registers the reserved workspace plugin with options that conflict with
   persisted OpenChamber policy. The Windows validation initially exposed this
   through a stale ancestor config selecting Kubernetes while OpenChamber selected
   Docker.
2. Reconcile and certify the OpenCode version matrix across host SDK, bundled CLI,
   plugin API, runtime image, and generated workspace HTTP surface.
3. Replay Windows Kubernetes on the current packaged candidate, including
   isolation enforcement, collision refusal, restart recovery, and cleanup.
4. Restore access to the Debian validation host, build a native current-candidate
   ARM64 AppImage, and rerun Docker. Run Kubernetes only on a Linux host with the
   required cgroup v2 controller.
5. Complete hosted-web, physical-mobile, and VS Code unsupported-behavior rows.
6. Resolve the remaining release gates in the production specification, including
   image/release identity, signing, and required platform evidence.

## Recommended Continuation Order

1. Preserve the current Windows Docker evidence by keeping candidate identity in
   every validation report.
2. Implement ancestor reserved-plugin conflict detection before provider mutation,
   with zero-resource regression coverage.
3. Decide and align the OpenCode version matrix, then rebuild exact native
   candidates.
4. Replay Windows Kubernetes.
5. Replay Debian AppImage/Docker and Linux Kubernetes on a suitable host.
6. Complete hosted web, physical mobile, and VS Code rows.
7. Run final release gates only after every required row is identity-current.

## Documentation Ownership

- `SECURE_WORKSPACES_SPECIFICATION.md`: normative product, security, and release contract.
- `SECURE_WORKSPACES.md`: operational state and platform runbook.
- `SECURE_WORKSPACES_HANDOFF.md`: high-level colleague handoff and continuation order.
- `.agents/secure-workspaces-validation-status.md`: compact current execution matrix and latest evidence.
- `packages/web/server/lib/workspaces/DOCUMENTATION.md`: server implementation invariants.

If these documents disagree, implementation work stops until the contradiction is
resolved. Volatile candidate identity and validation status do not belong in the
normative contract.
