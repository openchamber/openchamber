# Secure Workspaces: state of the work

One document for what this feature is, how far it has got, and how to test it on a
platform that has not been tested yet. The security and provider contract it must satisfy
lives in `SECURE_WORKSPACES_SPECIFICATION.md`; the working rules for anyone editing the
code live in `.agents/skills/secure-workspaces/SKILL.md`. This file is the operational one.

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
| Plugin pin (`packages/web/package.json`, `packages/electron/package.json`, `bun.lock`) | `69c125d024583696ff096f6e5b84416cdefbabab` |
| Runtime image | `ghcr.io/openchamber/opencode-workspace@sha256:40266ce54560149396cdc89395fa26df08f8924e4f377acbf12a88da08b2c141` |
| Gateway image | `ghcr.io/openchamber/workspace-egress-gateway@sha256:37c1452849212c5e9b2b62257792ca092c44c5ebba6d165667f235164e571555` |
| OpenCode / SDK / plugin API | `1.18.12` |

Images publish from a `v*` tag only, never from a merge to the plugin's default branch.
`v0.1.1` is the first release whose runtime carries OpenCode `1.18.12`; before it every
workspace ran `1.18.4` against a `1.18.12` host, unnoticed because nothing reports the
version. After any plugin merge: repin all three files plus this table, run `bun install`,
and confirm the runtime version by running the published digest rather than trusting the
build that produced it.

A repin only reaches an installation that already saved settings because startup
reconciliation rewrites the OpenCode plugin registration when its options no longer match
the policy. Without that, a repinned digest stays in the code while workspaces keep being
built from the superseded image.

## Where it has been proven

**Windows 11, packaged app, Docker Desktop and `kind` — passed end to end on 2026-08-08.**
Create, session routed into the workspace, file tree and terminal scoped to the host
project, agent message under the model-auth policy, isolation (container changes stay out
of the host tree), export → review → apply landing the file on the host, application
restart preserving sidebar grouping, full Kubernetes cycle, and four first-try deletions
including one workspace whose sync connection was dead. Namespace, containers, workspace
rows, artifact cache, and apply journals were empty afterwards.

**Linux ARM64, native AppImage and Docker Engine — passed end to end on 2026-08-11.**
The host was a Raspberry Pi 4 running Debian 12 `aarch64`, kernel
`6.12.34+rpt-rpi-v8`, and stock Docker `20.10.24`. The native ARM64 AppImage was
216,626,530 bytes with SHA-256
`782420f9a3d4756d6fdd2a3b06ea861359005ff722f88881bc7cb7277cc6932b`; its packaged
OpenCode CLI was `1.18.12`, its staged plugin payload contained 33 files, and final ELF
verification covered the Electron executable and native modules. Clean Docker creation
reached `Ready` in about 35 seconds. The runtime and gateway resolved to the exact digests
in the identity table; the runtime had only its internal network, the access target was
loopback-only, unauthenticated health returned `401`, authenticated health and SSE returned
`200`, direct TCP was blocked, an allowed CONNECT returned `200`, and a denied domain
returned `403`.

Interactive export → review → apply created the selected 49-byte host file with the exact
reviewed bytes while leaving the immutable baseline unchanged; the artifact was consumed
and locks/journals were empty. Packaged restart rewrote the stale AppImage plugin path
before OpenCode launch, recovered `Starting → Ready`, and preserved the routed session.
Delete succeeded on the first attempt in 5.5 seconds and left no managed container,
volume, network, or control-plane row. Final cleanup on 2026-08-13 removed only disposable
validation tooling, profiles, projects, provider data, and configuration; Homebridge
remained active and enabled.

**Linux Kubernetes — deferred on this host, not failed provider evidence.** Disposable
`kind` could not start its control plane because the host kernel does not expose the
cgroup v2 memory controller (`memory.oom.group can't be set: controller "memory" not
available`). Changing boot parameters and rebooting a shared Homebridge host was outside
the validation boundary. Kubernetes remains covered by the current Windows live run and
must be rerun on a Linux host whose kernel exposes the required controller before Linux
Kubernetes is claimed.

**Automated.** 129 focused workspace server tests; UI tests for session routing, sidebar
ownership, and locale parity; Electron packaging/architecture/updater tests; the plugin's
own suite (159 tests, green on Windows). In `packages/web` on Windows, 14 test files fail
— every one of them also fails on a clean `origin/main` worktree, and two files that fail
on `origin/main` pass here. Compare against a baseline worktree before treating any
failure as this branch's.

**Not proven yet:** Linux Kubernetes and physical iOS/Android. Linux Docker is proven at
the current plugin pin, exact image digests, and native AppImage identity above.

**Apple Container is implemented, offered, and deliberately not certified.** Managed
egress needs a network primitive the current CLI does not provide, so creation fails
closed unless an external proxy is configured — meaning it delivers *less* isolation than
Docker on the same machine, and the product's central promise cannot be kept there. Its
audience is one intersection: macOS where Docker Desktop is not permitted and a corporate
proxy already exists. It stays visible in settings, described requirement-first, because
hiding it would leave that person with no path at all; it carries no release gate and no
live-evidence obligation until Apple ships the primitive. Everything on it that does not
need the internet — create, files, terminal, snapshot, export/review/apply, ownership,
`container system stop/start` recovery, cleanup — is worth testing and does work; the model
simply will not answer without a real proxy.

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
5. **Live recertification** at the current pin and images for Linux Kubernetes and physical mobile.
   Linux Docker is complete; Linux Kubernetes and physical mobile remain. Apple Container
   is out of this list on purpose — see the note above.

### Filed upstream (anomalyco/opencode)

- **#41315 / PR #41316** — the workspace sync loop had no connect timeout, so a target that
  accepted the connection but never answered wedged the loop in `connecting` forever, and
  `startSync` refuses to replace a live-but-wedged fiber. Only a server restart cleared it.
- **#41317** — there is no control-plane way to start sync for one existing workspace: the
  `workspace` query parameter on `sync/start` routes the call *into* the workspace, and the
  directory-only form is conditional on recent session activity.
- **Already fixed upstream** (post-`1.18.12`, arrives with the next pin): `Session.workspaceID`
  is serialized on session reads and the workspace list filter works. Until then the
  server-side session-route record is what makes a workspace session findable; afterwards it
  stays harmless.
