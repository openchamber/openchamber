# Dev Server Discovery

## Ownership

This module answers `GET /api/dev-servers`: which loopback ports are listening
where the directory's code runs, and the folder each listening process runs in.
The browser panel's list of running servers (`packages/ui/src/components/browser/BrowserEmptyState.tsx`,
placement in `packages/ui/src/lib/browser/devServers.ts`) decides what to show
and in which order. The dev tunnel (`../dev-tunnel`) uses the same scanner as its
allowlist.

## Invariants

- A failed scan answers 503, never an empty list.
- Linux merges `lsof` and `/proc/net/tcp*` listeners by port. The `lsof` pid and command take priority so own-process exclusions still apply. A successful command does not prove that its listener list is complete.
- `directory` is optional. It is present only where `lsof` named the process's
  folder: never on Windows (`netstat`) or from `/proc/net/tcp`, which a space's
  container reads while its image has no `lsof`. A missing folder means unknown,
  and the panel keeps such a server in its list.
- The folder is the resolved path `lsof` reports. The panel compares it with
  project and worktree paths as stored, so a project registered through a
  symlink does not match its own servers.
- Folders cost one batched `lsof -d cwd` call for all pids per scan. If it fails,
  the scan still succeeds without folders.
- The set of ports is the same with or without folders, so the tunnel reaches
  every port the panel can show, including the ones it hides by default.

## Decisions

### Why kernel listeners supplement lsof

An unprivileged `lsof` can exit successfully while omitting root-owned listeners, including Docker-published ports. Reading the kernel tables only after a failed command misses those ports. Merging both sources keeps them reachable, preserves command metadata and folders, and retains useful results when either source fails.

### Why the server reports folders and the panel decides, rather than filtering here

Most listening ports belong to the OS and to OpenChamber's own helpers, and the
folder a process runs in tells them apart from a project's dev server. The
server only reports the folder. Filtering here would also shrink the tunnel's
allowlist, and a dev server that runs in Docker listens through Docker's own
process, outside any project, so it would vanish with no way back. The panel
knows the projects and worktrees, hides servers started outside all of them
behind its "show hidden ports" link, and still lists everything on request.
