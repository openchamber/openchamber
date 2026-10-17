# Disk Space Work Status extension

An optional SDK extension that shows used capacity, available space and total
capacity for the selected project's filesystem on the connected OpenChamber server.
It adds no core widget, server route or SDK API. It has no rail panel.

This replaces the proposed core implementation in
[PR #4784](https://github.com/openchamber/openchamber/pull/4784), following the
[maintainer's extension recommendation](https://github.com/openchamber/openchamber/pull/4784#issuecomment-6133854538).

## Install

1. Use OpenChamber 2.2.0 or later on web or Electron.
2. In Settings → Extensions, add this folder's absolute path on the connected server.
3. Approve its local service. Open a project and expand Disk space in Work Status.

The checked-in JavaScript bundles make the folder installable without a build step.
For ZIP installation, include `package.json`, `status/index.html`, `status/main.js`
and `service/main.js` at the archive root. No source files or `node_modules` are needed.
Hide, show, reorder or collapse Disk space through the existing Work Status section
settings. Disable the whole extension in Settings → Extensions. It is not installed
or enabled for other users by this repository example.

## Refresh and performance

Capacity is read on mount, project changes, focus, visibility restoration and manual
refresh. SDK session lifecycle events schedule at most one activity read every
30 seconds, coalescing bursts. There is no polling interval, watcher, directory scan
or shell process per read. Only one service request runs at a time. A project change
discards obsolete replies and reads the newest project after any existing request settles.
The initial session snapshot is a baseline and does not start an extra idle read.
The service permits only one filesystem read at a time across clients. If a mount
is slow, additional requests fail as Unavailable instead of queuing more work.

The last successful bar stays visible during refresh. The SDK button shows its
spinner only while a read is pending, disables duplicate clicks, and respects
reduced-motion preferences. Failure shows Unavailable, never a fake empty or full disk.
The body follows host theme and locale snapshots, including custom themes and RTL.
The manifest's section title is static, matching the existing SDK section contract.

Collapsing or hiding the section unloads its iframe and releases its subscriptions.
Hidden browser tabs cancel activity timers and schedule no new reads. The existing
SDK local service starts on demand and stays idle between reads until the host stops
it or the extension is disabled or removed. This has a small process/memory and
request cost; it is not a claim of zero overhead. Each read uses one directory stat
and one asynchronous `statfs` call. Available bytes exclude OS-reserved blocks.

The public SDK supplies session lifecycle events, not individual file-tool events.
Disk changes outside those events appear on the next focus, mount or manual refresh.
Continuous disk monitoring is deliberately omitted to avoid idle work.

## Permissions and runtime behavior

The only requested capability is the local service. Like every SDK service, it runs
with the host user's full access and requires explicit approval. This implementation
only reads filesystem metadata, binds to `127.0.0.1`, authenticates every request
with the host-issued service token, and sends no data to external services.
Enterprise installations must allow this extension source through the existing
extension policy. No token reaches the iframe.

Web and Electron use the connected server's disk, including remote hosts. VS Code,
hosted mobile and Capacitor do not load SDK extensions today. Windows and macOS use
the host's Node `statfs` implementation; failed or unsupported reads show Unavailable.
Containers report their own filesystem view. This does not aggregate multiple disks.

## Build

From the repository root, using the existing workspace dependencies:

```bash
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/disk-space-status/status/main.ts packages/sdk/examples/disk-space-status/status/main.js
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/disk-space-status/service/main.ts packages/sdk/examples/disk-space-status/service/main.js
bun run --cwd packages/sdk type-check
bun run --cwd packages/sdk test
bun test packages/ui/src/lib/guests/sdk-examples.test.ts
```

Keep both bundles in sync with their sources before installing or sharing the folder.
