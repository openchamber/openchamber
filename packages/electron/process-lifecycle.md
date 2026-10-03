# Process ownership and issue #3589

## Launch paths

Desktop's main process hosts `@openchamber/web` in-process under Electron's
Node runtime. Its Git commands use Node `child_process` and `simple-git`, not
`Bun.spawn`.

| Owner | Children and workload | End of ownership |
|---|---|---|
| `web/server/lib/opencode/lifecycle.js` | One managed `opencode serve`; Windows package-manager shims are resolved by `env-runtime.js` | Failed startup, restart, or backend shutdown closes the owned process tree. An explicit external OpenCode is not stopped. |
| OpenCode | Agent shell tools, MCP servers, repository discovery, snapshots, and other upstream work | OpenCode owns command completion and cancellation. Managed server teardown also stops its descendants. |
| `web/server/lib/git/service.js` | Git status, diff, branch and worktree reads plus explicit mutations | Command completion. Status includes several subprocesses and runs at most once per directory at a time (see the git module documentation); branch discovery can contact remotes. Git never waits on a terminal prompt: `GIT_TERMINAL_PROMPT=0` makes an unanswerable credential prompt fail instead of holding a hidden console open. These commands are independent of the selected terminal shell. |
| `web/server/lib/fs/` | `git check-ignore` during file listing and search; explicit background exec jobs | Ignore checks finish with the command. Exec jobs have their own deadline. |
| `web/server/lib/terminal/runtime.js` | `node-pty` on Electron, with ConPTY on Windows; interactive shells and command-mode project actions | Exit, explicit close, force-kill, idle cleanup, or backend shutdown. Pending creates and restarts retain ownership until cleanup finishes. |
| `electron/main.mjs` | In-process backend and native SSH lifecycle | Quit, relaunch, and update installation await backend cleanup. A detached OpenCode killer remains a bounded-failure fallback. |

Git refreshes also follow completed agent tools, visible repository views, and
sidebar status requests. Client-side coalescing does not own server subprocess
lifetime. Worktree topology observation uses ordinary status/list requests,
not a separate filesystem watcher or polling process.

## Supplied evidence

Both issue attachments show a Task Manager application group of 39 processes.
The first includes repeated large Git entries around 338–371 MB beside small
Git entries, and multiple Console Window Hosts. The second contains the same
group count without resource columns. Neither supplies PIDs, command lines,
parent PIDs, or an exit timeline. The screenshots cannot attribute those
processes to one launch path. The reported growth over normal use and the
standalone OpenCode comparison remain important observations.

Desktop 1.23.2 pins OpenCode 1.18.31. Binary selection can override that pin
through settings or environment before considering the bundled CLI. The
controlled macOS run verified the staged CLI reports 1.18.31 and used Electron
43.7.0 with Node 24.21.0. The OpenCode release source pins Bun 1.3.14; this is
not the version of Node executing OpenChamber's own Git launches.

The referenced OpenCode issues 30495 and 11527 were closed for inactivity.
Bun PR 34694 fixes inline-terminal final-output/ConDrv reference handling and
was merged after Bun 1.3.14. It does not establish a cause for this report.
`windowsHide` controls visibility and `unref` controls parent event-loop
liveness; neither establishes that children exit.

## Confirmed defects and controlled evidence

- File search and listing created stderr pipes for `git check-ignore` without
  consuming them. Twelve real searches of a synthetic 2000-file repository
  with `GIT_TRACE=1` left twelve Git processes blocked, with roughly 64 KiB
  buffered in each Node stderr stream. Reading those same pipes let all twelve
  exit. Discarding unused stderr at spawn completed all twelve searches without
  blocked children. The portable regression emits 2 MiB through real OS stderr
  descriptors and checks both filtering and exit for search and listing.
- Malformed readiness output and thrown health checks left both startup
  attempts alive. Each controlled attempt launched a real server stand-in and
  a child, so four PIDs survived each failed two-attempt startup before cleanup
  was fixed. Regressions also cover timeout, shutdown during startup, repeated
  close, and a descendant that ignores SIGTERM.
- Windows managed teardown killed the parent before trying tree termination.
  The parent could exit before the fallback ran, leaving descendants outside
  cleanup. Tree termination now precedes root termination. Native Windows
  execution is still needed to validate OS behavior.
- Terminal shutdown ignored pending creates, and close/force-kill could retire
  a session while a restart was spawning its replacement. Deterministic
  delayed-spawn tests failed with an unowned live PTY and now verify cleanup.
- Desktop exited without calling the embedded backend's `stop()`. In real
  macOS Electron, three terminal commands ignoring SIGHUP and SIGTERM stayed
  alive and exit failed to finish within ten seconds. Awaiting backend teardown
  closed all three and the managed OpenCode before Electron exited. This was
  checked with both HMR and bundled UI, the same CLI, isolated profiles, and
  ten successful status reads plus ten directory listings per run. Ordinary
  commands accepting SIGHUP exited in both versions; that control alone did not
  expose the missing cleanup.

## Validation limits

These reproduce OpenChamber-owned defects, not the reporter's exact Windows
process tree. The investigation host is macOS, with no Windows VM/emulator or
available self-hosted Windows runner. Windows 10/11 ConPTY handle release,
console visibility, Git-for-Windows parentage, and the reported 15–30 minute
agent workload have not been observed after the fix. A native Windows runtime
is the remaining capability needed for that verification. The renderer DOM
retention fix in `c52a0b325` is separate from every process lifecycle above.
