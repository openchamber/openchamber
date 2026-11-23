# Dev Server Discovery

## Ownership

This module answers `GET /api/dev-servers`: which loopback ports are listening
where the directory's code runs, the folder each listening process runs in, and
whether each port serves a web page, with its title and favicon (`page-probe.ts`).
The browser panel's list of running servers (`packages/ui/src/components/browser/BrowserEmptyState.tsx`,
placement in `packages/ui/src/lib/browser/devServers.ts`) decides what to show
and in which order. The dev tunnel (`../dev-tunnel`) uses the same scanner as its
allowlist.

## Invariants

- Only wildcard and loopback binds are offered through localhost; a listener
  bound solely to a LAN address would not answer that URL. Known service-port
  exclusions stay short so discovery does not hide real development servers.
- OpenChamber's own listeners are excluded so previews cannot offer the app
  itself. Failed scans are not cached, so the next request can recover.
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
- The route adds `page` to a server once its port has answered: `{ title, icon }`
  for a web page, `null` for anything else. A port still being asked has no
  `page`, and the panel lists it. `icon` is a `data:image/...` URL, so a client
  shows it without reaching the port, wherever the port runs.
- A probe runs where the ports are: the server inside a space or on a remote
  instance answers its own route. It asks `http://localhost:<port>/` only,
  follows redirects only on that origin, and fetches a favicon only from that
  origin; it never contacts another host.
- Probing never changes the scanner's result, so the tunnel's allowlist
  (`scanner.discover`) keeps every port whether or not it serves a page.
- Route registration supplies `getOwnPorts`, which returns a number array.
  Command and proc-file parsers retain their empty and null input handling,
  integer checks and malformed-record filtering.

## Decisions

### Why route types describe only the methods used here

The workspace has no Express declarations. The local route contract describes
the GET handler and its JSON responses without adding a dependency or a
declaration shim.

### Why thrown messages remain unparsed

The 500 response preserves any truthy `message` from a thrown value, including
non-Error objects. The error guard excludes only null and undefined because
JavaScript permits property reads on every other value. Its message property
stays optional and unknown to preserve missing and non-string messages without
adding object, string or property-presence checks.

### Why proc listeners have no process name and not an exhaustive owner lookup

Mapping every socket through every process's file descriptors costs more than
the label is worth. The listener remains usable without that optional metadata.

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

### Why pages are probed on the server, cached and refreshed in the background

The panel polls every 2 seconds, and on Windows discovery lists every port on
the machine. Each listener (port and pid) is asked once, at most 6 at a time,
and the answer is kept for 20 seconds. An expired answer is still returned while
a fresh one is fetched, so a port that never answers is waited on once, not on
every poll. A request waits at most 800 ms for first answers, then returns
without the rest. One port may take 10 seconds, because a dev server's first
page can compile that long. The server does this because only it can reach the
ports in every runtime, including spaces and remote instances.

### Why a page means HTML from the root with a 2xx or 5xx status

A framework's 404 for `/` ("Cannot GET /") is HTML from an API server, so 4xx
does not count. A dev server shows a failed build as a 5xx HTML page, which is
still the app. Same-origin redirects are followed so an app that sends `/` to
`/login` counts; a redirect to another host counts as a page without a title.

### Why an ICO favicon is cut to one frame

Multi-size ICO files are often larger than an icon the panel can carry in its
2-second poll (OpenCode's is 47 KB, some apps ship 280 KB). The server reads an
ICO up to 1 MB and sends only the frame closest to 32 px: a PNG frame as a PNG,
a bitmap frame as a one-frame ICO. A PNG saved as `.ico` is read as the PNG it
is. The icon sent is at most 32 KB; when the linked icon is larger, the server
tries `/favicon.ico` before showing no icon.
