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
4. The plugin reads MCP status one second after load, calls connect for every
   server in the `failed` state, then re-reads status after a per-server delay
   that doubles from one second to a cap of thirty. A server seen in any other
   state resets its counter. While nothing is failed it checks every thirty
   seconds.
5. A dropped connection publishes `mcp.tools.changed`, which the plugin uses to
   check right away instead of waiting out the idle interval.
6. OpenCode calls the plugin's `dispose` hook when it tears the directory down,
   which stops the loop.

## Invariants

- Only `failed` is retried. `disabled` is the user's choice, and `needs_auth`
  or `needs_client_registration` need the user to act; retrying those would
  either re-enable a server the user turned off or loop on a login prompt.
- The plugin logs nothing and swallows every error. OpenCode already logs each
  failed attempt, and a status call failing during an OpenCode restart is not
  news.
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
