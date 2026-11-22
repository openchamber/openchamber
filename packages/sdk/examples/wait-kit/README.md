# Wait Kit

A service-only extension that gives agents two things to wait on without
holding a turn open: a timer, and a URL that starts answering. It declares
`contributes.waits` next to its `contributes.service`; an agent starts one with
the `openchamber` tool's `wait.start`, ends its turn, and OpenChamber wakes the
session with one message when the service reports the wait fired.

| Source | Arguments | Fires when |
|---|---|---|
| `wait-kit/timer` | `seconds`, 1 to 86400 | That many seconds have passed |
| `wait-kit/url-ready` | `url`, optional `status` | The URL answers any 2xx, or exactly `status` |

The service (`service/main.ts`, built to `service/main.js`) keeps nothing.
OpenChamber stores each wait with the `state` the service handed back and posts
it again on every check, so the service can stop between checks.

## Install and try it

1. In **Settings → Extensions**, add this folder.
2. In the approval dialog, allow the local service and **Wake agents that wait
   on it**, which lists Timer and URL ready.
3. In a chat, ask the agent: `Wait 30 seconds with wait-kit/timer, then tell me
   the time.` The agent calls `wait.start`, ends its turn, and a row
   `Timer (30 s): 30 seconds passed.` wakes it about half a minute later.
4. For `url-ready`, start a server after asking the agent to wait for it, for
   example `Wait until http://localhost:5173 answers, then open it.`

Pause the extension while a wait runs and the agent is woken with a note that
the wait ended without firing.

## Rebuild

```bash
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/wait-kit/service/main.ts packages/sdk/examples/wait-kit/service/main.js
```

`scripts/wait-kit-example.test.ts` runs the built service the way OpenChamber
does and checks both waits start, keep waiting and fire.
