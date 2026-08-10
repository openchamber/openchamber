# Reproduction: Chat UI stops updating until the desktop app is restarted (#2638)

Reproduces https://github.com/openchamber/openchamber/issues/2638 using the
real server modules (`lifecycle.js`, `global-hub.js`, `network-runtime.js`),
real processes, and real ports — no mocks.

## Run

```sh
# Windows-orphan scenario (the reported bug):
node scripts/repro/issue-2638/reproduce-2638.mjs

# Control: healthy restart on Linux (hub reconnects, UI keeps updating):
node scripts/repro/issue-2638/reproduce-2638.mjs --baseline
```

Requires `lsof` (used only for cleanup). The default run simulates Windows
(`process.platform` is temporarily overridden to `win32`) because the bug is
specific to the Windows process-lifecycle path.

## What it demonstrates

1. A managed OpenCode process starts; the global message-stream hub connects to
   its `/global/event` SSE stream and chat events flow to the UI.
2. The managed process "exits" but the actual server process survives on the
   old port (on Windows `killProcessOnPort` is a no-op and `taskkill` cannot
   reach the orphaned tree — the report shows leftover `opencode.exe serve`
   processes on historical ports).
3. `restartOpenCode()` gives up after 5 s — logs
   `Timed out waiting for OpenCode port <old> to be released` — and spawns a
   fresh server on a NEW port, leaving the orphaned process running.
4. HTTP/proxy traffic follows `state.openCodePort` to the new server, but the
   hub's upstream SSE reader stays pinned to the OLD server's `/global/event`
   stream (that connection never closed), so events emitted by the new server
   never reach the UI: the chat UI goes stale while the new server keeps
   persisting session data — visible only after restarting the app.

The `--baseline` control proves the reconnect logic itself is fine: when the
old process dies and the port is properly released, the hub reconnects to the
new port and events are delivered.

## Files

- `reproduce-2638.mjs` — the reproduction driver (assertions + summary).
- `fake-opencode-serve.mjs` — a fake `opencode serve` binary whose launcher
  spawns a detached server core that survives the launcher's death
  (Windows-style orphan), plus an in-process mode for the baseline control.
