# Managed MCP Reconnect

## Purpose

OpenCode connects each configured MCP server once, when a project directory is
first used. A server that does not come up then is marked `failed` and never
retried; a server whose live connection later drops is marked `failed` too and
stays that way until OpenCode restarts. This module injects a small plugin into
the OpenCode process OpenChamber launches that reconnects those servers, so a
server that was slow to start or crashed mid-session comes back on its own.

## Runtime flow

1. `prepareManagedOpenCodeEnv(configContent)` materializes the plugin under
   `<openchamber-data-dir>/mcp-reconnect/` and appends its `file://` URL to
   `OPENCODE_CONFIG_CONTENT` through the shared merge in
   `packages/web/server/lib/opencode/managed-plugin-config.js`.
2. It is always on for managed OpenCode. There is no setting, because it only
   acts on servers OpenCode has already given up on.
3. OpenCode loads the plugin once per project directory with an SDK client
   scoped to that directory, so each directory reconnects its own servers.
4. The plugin makes no status call and runs no timers until its directory
   publishes the first `mcp.tools.changed` event. Reading MCP status
   initializes that directory's MCP servers as a side effect, and OpenChamber
   creates an instance for every known project and chat directory at startup,
   so a plugin that polled from load spawned every configured stdio server in
   every background instance within seconds of launch. An instance publishes
   `mcp.tools.changed` only once its MCP is actually running, which makes that
   event the arming signal. Once armed, the plugin reads status, calls connect
   for every server in the `failed` state, then re-reads status after a
   per-server delay that doubles from one second to a cap of thirty, jittered
   by up to ±20% so directory instances retry out of phase. A server seen in
   any other state resets its counter. While nothing is failed it checks every
   thirty seconds.
5. Every reconnect spawns a child process, so two bounds apply:
   - a server is retried at most five consecutive times before the plugin
     gives up on it; it is left alone until it is seen healthy again (a manual
     reconnect counts), disappears from the config, or OpenCode restarts;
   - at most two reconnects run at once per OpenCode process, a budget shared
     across every directory instance through `globalThis`; servers that do not
     get a slot are reconsidered five seconds later without counting as a
     failed attempt.
6. A dropped connection publishes `mcp.tools.changed`, which the plugin uses to
   check right away instead of waiting out the idle interval, and which arms
   the loop in the first place. Events naming a
   server the plugin has given up on are ignored, so a permanently broken
   server cannot keep waking every directory instance; an event that does not
   name a server still wakes the loop.
7. OpenCode calls the plugin's `dispose` hook when it tears the directory down,
   which stops the loop.

## Invariants

- Only `failed` is retried. `disabled` is the user's choice, and `needs_auth`
  or `needs_client_registration` need the user to act; retrying those would
  either re-enable a server the user turned off or loop on a login prompt.
- An instance whose MCP has never run must never run any because of this
  plugin: reading status initializes MCP, and OpenChamber creates instances
  for every known project and chat directory at startup. The plugin may only
  touch MCP after that directory published an `mcp.tools.changed` event. The
  cost of getting this wrong is not a missed reconnect, it is the whole stdio
  server fleet times the instance count.
- Retry work is bounded from every direction that multiplies it: per server
  (attempt cap), per process (concurrency budget), and across instances
  (jitter). A config with many failing stdio servers and several open
  directories must settle, not stampede.
- The plugin swallows every error and logs one line: a warning when it gives
  up on a server, because OpenCode reports each failed attempt but never the
  decision to stop.
- One check runs at a time; a wake-up arriving during a check is honored once
  it finishes rather than starting a second loop.

## What the UI sees

OpenCode publishes no event when a reconnect succeeds. The chat picks the
server up on the next prompt because tools are resolved from live state, but
the MCP page reads status on bootstrap and refresh, so it can show `failed` for
a while after the server is back.

## Runtime parity

- Web and Desktop managed OpenCode: injected automatically.
- External OpenCode (`OPENCODE_HOST` or skip-start) and VS Code's separate
  OpenCode lifecycle: not injected, because OpenChamber does not control that
  process environment.
