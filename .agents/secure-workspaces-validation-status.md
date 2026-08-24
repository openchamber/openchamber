# Secure Workspaces Validation Status

Status: current execution matrix, not a product contract
Updated: 2026-08-20

## Sources Of Truth

- Contract: `docs/SECURE_WORKSPACES_SPECIFICATION.md`
- Operational runbook: `docs/SECURE_WORKSPACES.md`
- Colleague handoff: `docs/SECURE_WORKSPACES_HANDOFF.md`
- Current defaults: `packages/web/server/lib/workspaces/policy.js`

This file records only current-candidate evidence and immediate blockers. Historical
results do not complete a current matrix row.

## Current Candidate

| Component | Identity |
| --- | --- |
| OpenChamber | `1.18.4` |
| Host SDK / bundled CLI target | `1.18.18` |
| Plugin pin | `b1c4682d5c1509c86fa5ce7f4e7170fa4ba13466` |
| Installed/staged plugin | package `0.1.1`, API `1.18.12` |
| Runtime image | `ghcr.io/openchamber/opencode-workspace@sha256:40266ce54560149396cdc89395fa26df08f8924e4f377acbf12a88da08b2c141` |
| Gateway image | `ghcr.io/openchamber/workspace-egress-gateway@sha256:37c1452849212c5e9b2b62257792ca092c44c5ebba6d165667f235164e571555` |

## Matrix

| Target | Provider/surface | Status |
| --- | --- | --- |
| Windows packaged app | Docker | Passed current full lifecycle |
| Windows packaged app | Kubernetes | Pending current-candidate replay |
| Debian native AppImage | Docker | Blocked: validation host unreachable |
| Debian native AppImage | Kubernetes | Blocked: host unreachable; prior host also lacked required cgroup v2 memory controller |
| macOS | Apple Container | Historical non-certifying evidence only |
| Hosted web | Applicable provider host | Pending live workflow |
| Capacitor mobile | Physical iOS and Android | Pending live workflow and interactive apply |
| VS Code | Explicit unsupported behavior | Pending current-candidate confirmation |

## Current Windows Docker Evidence

- Packaged build and exact staged plugin payload verified.
- Managed OpenCode reached authoritative `/health` readiness.
- Workspace create reached `connected` under the active policy fingerprint.
- Durable session routing returned workspace files and never host files.
- Workspace changes remained absent from the host before apply.
- Internal networking, blocked direct egress, and unauthenticated runtime `401` passed.
- Export returned the exact selected addition; dry-run did not mutate the host.
- Confirmed apply wrote the exact reviewed bytes and metadata.
- The artifact was consumed and apply journal/lock files were absent.
- Packaged restart recovered the workspace/session/project association.
- Workspace cleanup succeeded; the idempotent retry returned `404 Workspace not found`.
- Final state contained no matching containers, volumes, networks, disposable projects,
  project directories, candidate processes, temporary runners, or apply journal files.

Focused proxy/workspace/server tests passed `93/93` locally and on Windows. Web
type-check, Web lint, JavaScript syntax checks, packaged plugin verification, and
the Electron build passed. Broad oxlint still reports pre-existing findings in
touched server files.

## Immediate Follow-Ups

1. Fail closed before provider creation when a project or ancestor OpenCode config
   registers the reserved workspace plugin with options conflicting with persisted
   OpenChamber policy. Assert zero provider and provisional resources.
2. Align or explicitly certify the `1.18.18` host SDK/CLI against plugin API and
   runtime OpenCode `1.18.12`.
3. Replay Windows Kubernetes on the current candidate.
4. Restore Debian host access, build a native current-candidate ARM64 AppImage, and
   replay Docker; use a suitable Linux host for Kubernetes.
5. Complete hosted-web, physical-mobile, and VS Code matrix rows.
