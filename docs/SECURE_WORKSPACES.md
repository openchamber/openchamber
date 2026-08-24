# Secure Workspaces: state of the work

One document for what this feature is, how far it has got, and how to test it on a
platform that has not been tested yet. The security and provider contract it must satisfy
lives in `SECURE_WORKSPACES_SPECIFICATION.md`; the working rules for anyone editing the
code live in `.agents/skills/secure-workspaces/SKILL.md`. The colleague handoff and
continuation order live in `SECURE_WORKSPACES_HANDOFF.md`. This file is the operational one.

## What it is

An agent runs inside a disposable container instead of on the host. The project is copied
in at creation, the agent works there, and changes come back only through an explicit
review and apply. Nothing the agent does reaches the host filesystem until a person selects
it. Egress leaves through a gateway that enforces an allowlist, and the runtime has no
route to the host API at all.

Three providers: **Docker** (the ordinary choice), **Kubernetes** (when the work must run
on somebody else's cluster), **Apple Container** (macOS, see below). The container work lives in a
separate repository, `openchamber/opencode-container-workspace`, pinned here by immutable
commit SHA; OpenChamber owns policy, authorization, lifecycle orchestration, export/apply,
and the UI.

**A workspace is a task, not a home.** The snapshot flows in once; changes flow out once.
After an apply the workspace is stale relative to the project by construction — there is
deliberately no path to bring host changes back in. Create → work → export/apply → delete.
Export and cleanup work on a workspace whose live connection is gone, and reconnecting an
old workspace after an app restart is best-effort, never something a flow depends on.

## Current identity

| Thing | Value |
| --- | --- |
| OpenChamber package | `1.18.4` |
| Host SDK / bundled CLI target | `1.18.18` |
| Plugin pin (`packages/web/package.json`, `packages/electron/package.json`, `bun.lock`) | `b1c4682d5c1509c86fa5ce7f4e7170fa4ba13466` |
| Installed/staged plugin package / API | `0.1.1` / `1.18.12` |
| Runtime image | `ghcr.io/openchamber/opencode-workspace@sha256:40266ce54560149396cdc89395fa26df08f8924e4f377acbf12a88da08b2c141` |
| Gateway image | `ghcr.io/openchamber/workspace-egress-gateway@sha256:37c1452849212c5e9b2b62257792ca092c44c5ebba6d165667f235164e571555` |

Images publish from a `v*` tag only, never from a merge to the plugin's default branch.
The host SDK/CLI and plugin API are currently mixed (`1.18.18` / `1.18.12`). The
Windows Docker lifecycle is live-proven for this exact candidate, but the combination
still needs an explicit compatibility decision before release. After any plugin merge:
repin all three files plus this table, run `bun install`, and confirm the runtime version
by running the published digest rather than trusting the build that produced it.

A repin only reaches an installation that already saved settings because startup
reconciliation rewrites the OpenCode plugin registration when its options no longer match
the policy. Without that, a repinned digest stays in the code while workspaces keep being
built from the superseded image.

## Where it has been proven

**Windows 11 packaged app with Docker Desktop — current candidate passed on
2026-08-20.** Create/connected, durable routed file authority, host isolation,
internal networking, blocked direct egress, unauthenticated runtime rejection,
export/review, dry-run, confirmed apply with exact bytes, artifact consumption,
restart association recovery, cleanup, idempotent cleanup, and zero final resources
were verified. The normal Files and Terminal surfaces remained host-project scoped.

**Windows Kubernetes — historical pass, current replay pending.** The 2026-08-08
`kind` lifecycle remains useful historical evidence, but it predates the current SDK,
plugin pin, routing changes, and packaged candidate. It does not complete the current row.

**Linux ARM64 AppImage and Docker — historical pass, current replay pending.** The
2026-08-11 run used a Raspberry Pi 4 with Debian 12, native ARM64 AppImage, Docker
20.10.24, and the exact runtime/gateway digests current at that time. It covered
isolation, transport auth, egress decisions, interactive apply, packaged restart, and
cleanup. That evidence belongs to an older candidate identity. The current Debian host
is unreachable, so no current AppImage/Docker claim is made.

**Linux Kubernetes — pending on a suitable host.** The historical Raspberry Pi host
lacked the cgroup v2 memory controller required by disposable `kind`. Changing boot
parameters on the shared Homebridge host was outside the validation boundary.

**Current focused automation.** The proxy/workspace/server-runtime suite passes
`93/93` locally and on Windows. Web type-check, Web lint, JavaScript syntax checks,
packaged plugin verification, and the packaged Windows build pass. Broad oxlint still
reports pre-existing findings in touched server files; no new finding was identified on
the authored paths. Historical suite counts are not current-candidate evidence.

**Not proven for the current candidate:** Windows Kubernetes, Debian Docker and
Kubernetes, hosted web, physical iOS/Android, and current VS Code unsupported behavior.

**Apple Container is implemented, offered, and deliberately not certified.** Managed
egress needs a network primitive the current CLI does not provide, so creation fails
closed unless an external proxy is configured. Historical local runs covered create,
files, terminal, snapshot, export/review/apply, ownership, system restart recovery, and
cleanup. That evidence is non-certifying and is not asserted for the current candidate.

## Testing a platform that has not been tested

Use a disposable profile so the operator's real OpenChamber is never involved. Two separate
things point at it and both are needed: `OPENCHAMBER_DATA_DIR` (settings, the OpenCode data
root, workspace journals, credential stores) and the Electron/Chromium `--user-data-dir`
(browser profile and logs).

```powershell
# Windows
$profile = Join-Path $env:TEMP 'openchamber-functional-profile'
$env:OPENCHAMBER_DATA_DIR = $profile
Start-Process '…\packages\electron\dist\win-unpacked\OpenChamber.exe' `
  -ArgumentList "--user-data-dir=`"$profile\chromium`""
```

```bash
# Linux / macOS
export OPENCHAMBER_DATA_DIR="${TMPDIR:-/tmp}/openchamber-functional-profile"
./OpenChamber.AppImage --user-data-dir="$OPENCHAMBER_DATA_DIR/chromium"
```

What lives where, once it has run:

| Path (under the profile) | Holds |
| --- | --- |
| `settings.json` | every `secureWorkspaces*` setting, `projects`, `activeProjectId`, and `desktopLocalPort` / `desktopLocalClientToken` |
| `chromium/logs/main.log` | the Electron main log — the first place to look |
| `opencode-data/opencode/log/` | the managed OpenCode's own log |
| `workspace-session-routes/` | session ↔ workspace ↔ project routes |
| `workspace-exports/`, `workspace-apply/`, `workspace-handoffs/`, `workspace-sessions/` | artifact cache and operation journals |

**Never hand-edit `settings.json` while the app is running.** Doing it once wrote a BOM and
the app silently reset every workspace setting and wiped the projects list. Drive the app,
or query it: everything the UI can do is reachable over the loopback API with
`authorization: Bearer <desktopLocalClientToken>` (the header `x-openchamber-client-token`
returns 401). `GET /api/workspaces/readiness` is the most useful single call — it reports
whether the plugin is registered, which providers are available, and the ordered setup
steps with their status.

### The click-through

1. **Readiness.** Open the workspaces panel (shield). Providers available, no red state.
2. **Create** a workspace for a disposable project. Docker takes seconds; **Kubernetes
   legitimately takes 80–120 seconds** — pods, two seeded volumes, a gateway rollout, a
   port-forward. It must end `connected`, never "Timed out", and the workspace must not
   vanish.
3. **Start session** from the panel. The chat opens immediately, the session appears in the
   sidebar under its project, and **Files** and **Terminal** show the *host project* — not
   an empty tree, not "Directory not found".
4. **Ask the agent for a file.** The answer arrives (no 403), and the new file does **not**
   appear in the host file tree. That is the isolation working.
5. **Review changes** in the panel. It must not ask for a password. The file appears as
   added; select it and **apply**; it lands in the host project, the artifact is consumed,
   and the apply journal is empty afterwards.
6. **Restart the app.** Workspace sessions stay grouped in the sidebar and still open with
   a working file tree and terminal. The workspace itself may stay disconnected — that is
   expected, not a failure.
7. **Delete** every workspace from the panel. Each must succeed on the first attempt, with
   no "cleanup is incomplete", and leave no containers, pods, PVCs, or rows behind.
8. **Policy change** (Settings → Secure Workspaces → Save) is the one place that asks for
   the password. Nothing else should.

### Per-platform notes

- **Linux:** native AppImage (FUSE/libfuse2 for a direct launch), Docker Engine, and a
  disposable `kind` for the Kubernetes part. Full Docker lifecycle plus interactive apply.
- **macOS / Apple Container:** supported host with Apple Container installed; managed
  egress must stay fail-closed with **no** Docker fallback. Cover create, target, export,
  reconcile, collision, `container system stop/start` recovery, and cleanup. A first
  uncached image pull can exceed the provider's 300-second command timeout — pull the exact
  digest once by hand, then run the lifecycle.
- **Kubernetes isolation:** a cluster that accepts a NetworkPolicy is not a cluster that
  enforces one. Test against both an enforcing CNI (kindnet) and a non-enforcing one
  (flannel); creation must fail closed on the second. Two probe pods are required — one
  unrestricted to prove the reference address is reachable at all.
- **Mobile:** `.maestro/secure-workspace-physical.yaml` and `…-cleanup.yaml` are fixtures a
  person runs against a real device after `packages/mobile/scripts/physical-device-smoke.mjs`
  launches the app. Nothing in CI invokes Maestro, and a Maestro dry run is not physical
  evidence.

### Traps that cost hours before they were measured

- **`bun run electron:build` takes ~12 minutes** and fails if the app is running (a locked
  `d3dcompiler_47.dll`, with a message that does not say so). Run it detached from a script
  file with the path **quoted**. Before believing a build is deployed, check the mtime of
  `resources/app.asar` — a detached build once silently never started and a stale completion
  marker reported success.
- **`tar` flavour depends on PATH order.** Git for Windows ships GNU tar, which reads
  `C:\path` as `host:path`; the same shadowing hides `whoami`. Name system binaries by
  absolute path, and never hand a Windows path to a tool whose flavour varies.
- **A container path is not a path here.** A routed session reports `/workspace`. Host-side
  state must never take it; it is converted at one boundary. On Windows it does not even
  stay recognisable — `/workspace` resolves against the current drive, and the host
  OpenCode was once caught bootstrapping `C:\workspace`.
- **Running tests:** there is no root test script. `packages/web` uses `npx vitest run`;
  `packages/ui` uses `bun test` (`bun run test` resolves to Git's `test.exe` on Windows).
- **A protection asserted by a test that would pass without it is not asserted.** `%TEMP%`
  is already private on a normal profile, so a permissions test must first open its own
  directory to everyone.

## Open work

1. **Windows credential stores.** `packages/web/server/lib/quota/credentials/store.js` and
   `remote-clients.json` declare `0o700`/`0o600`, which Windows does not implement, so they
   inherit whatever privacy their location happens to have and lose it when the data
   directory moves. The plugin's `src/windows-acl.js` is the working reference.
2. **The executable bit is lost** when snapshotting a Windows project into a Linux
   container. Git's index carries it (`git ls-files -s`) for a Git project.
3. **The SSE heartbeat proxy test** drives real timers with margins smaller than a loaded
   Windows machine's scheduling jitter.
4. **Four Electron test files run nowhere** — `desktop-local-client.test.mjs`,
   `packaged-smoke.test.mjs`, `packaged-workspace-smoke.test.mjs`, and
   `scripts/verify-workspace-plugin.test.mjs` appear in no script and no workflow. Wire them
   into `test:architecture` or delete them; an unrun test reads as coverage it does not give.
5. **Reserved plugin conflict hardening.** Refuse before provider creation when a
   project or ancestor OpenCode config registers the reserved workspace plugin with
   options that conflict with persisted OpenChamber policy.
6. **OpenCode version matrix.** Align or explicitly certify host SDK/bundled CLI
   `1.18.18` against plugin API and runtime `1.18.12`.
7. **Live recertification** for Windows Kubernetes, Debian Docker/Kubernetes, hosted
   web, physical mobile, and current VS Code unsupported behavior. Apple Container is
   non-certifying by decision — see the note above.

### Filed upstream (anomalyco/opencode)

- **#41315 / PR #41316** — the workspace sync loop had no connect timeout, so a target that
  accepted the connection but never answered wedged the loop in `connecting` forever, and
  `startSync` refuses to replace a live-but-wedged fiber. Only a server restart cleared it.
- **#41317** — there is no control-plane way to start sync for one existing workspace: the
  `workspace` query parameter on `sync/start` routes the call *into* the workspace, and the
  directory-only form is conditional on recent session activity.
- **Fixed upstream after `1.18.12`; current behavior must be re-audited:**
  `Session.workspaceID` serialization and workspace list filtering changed upstream.
  The current host SDK/CLI target is `1.18.18`, but the compatibility index remains until
  the generated API and live reads are verified together; it remains fail-closed and
  harmless when upstream supplies complete authority.
