# Directory reachability

## Ownership

Whether a folder's disk answers at all. A disconnected SMB mapping, a stale NFS
mount or a sleeping NAS makes each file call wait for the operating system's
timeout (17 to 22 seconds on Windows, over a minute on macOS). This module
answers `available`, `missing` or `unreachable` without that wait, for every
server feature that touches a project's disk. What a feature does with the
answer belongs to the feature.

- `index.ts` holds the answers, `probe-process.ts` the helper process.
- `gate.ts` refuses requests that name an unreachable folder with 503 and
  `DIRECTORY_UNREACHABLE`, for the routes that touch the project's disk.
- `while-reachable.ts` ends a task whose folder stops answering, for requests
  that cover several projects.
- `thread-pool.ts` widens libuv's pool at start.

`../opencode-trust` refuses the same way for OpenCode routes that open a
folder, and `../git/service.ts` checks before it starts git.

## Invariants

- No answer is ever read as deleted or empty. `missing` needs ENOENT or ENOTDIR
  from a disk that answers; when the Windows drive, the UNC share or the macOS
  volume is itself absent, the folder is `unreachable`. Every other error, such
  as Windows' UNKNOWN for a dead share, is `unreachable` too.
- A first question waits 3 seconds at most. A folder already known to be
  unreachable answers within 100 ms and is asked again in the background, so it
  recovers by itself.
- A folder that does not answer makes its parents suspects, up to the one that
  answers. Everything below a suspect is refused without a probe of its own.
- Nothing spawns a process with a working directory, or calls a synchronous
  file function, on a project path that was not checked just before. Starting a
  process waits for its working directory on the calling thread on every
  platform. Git that runs on its own never starts in the project at all: it
  starts in the temporary folder with `-C` (`../git/git-launch.ts`), so a share
  that drops between the check and the start holds only the git process.

## Decisions

### Why git gets `-C` through a private simple-git list

simple-git starts git in `baseDir` and stats it synchronously, and has no public
option that adds a global git argument. `launchesFrom` appends to its internal
`spawn.args` plugins and throws when they are gone, so an upgrade that removes
them fails every git test instead of silently bringing the freeze back.

### Why a helper process and not the server's own pool

libuv's pool is shared by the whole server, and a hung call keeps its thread. At
most two probes run in the server; once one takes 250 ms the rest go to a Node
process with 256 threads, which stops after a minute without work. A call stuck there for
30 seconds is asked again in a fresh process (waits double up to 10 minutes), so
a share remounted at the same path recovers while the old call still hangs. Most users
never start it. A worker thread would delay quitting until its call returns.

### Why the probe opens the folder and not only stats it

macOS answers `stat`, `access` and `chdir` from its cache for seconds after the
server went silent, so `stat` let git start in a dead folder and froze the
thread. Opening and reading the directory asks the disk. The handle is closed in
a `finally`, because a handle left to the garbage collector is closed on the
main thread and blocks it.

### Why the pool is 32 threads

Calls that passed the check moments before the share died still hang. With four
threads, four of them stop every other file call, settings included. OpenCode's
bundled server gets the same size for the same reason. The variable is set only
until the pool exists, so terminals and git never inherit it.
