# Server composition

## Ownership

`index.js` composes auth, settings, feature runtimes and transports for the web
server used by web, connected desktop and mobile clients. Module contracts live
beside their implementation. VS Code's extension-host runtime is separate.

The agent/front-door boundary is defined in
`lib/agent-server/DOCUMENTATION.md`. Its environment is read before constructing
session runtimes. `OPENCHAMBER_AGENT_SERVER=1` keeps the normal agent/project
composition but disables owner delivery, relay, tunnels, Spaces, protected MCP
admin and update installation. Front-door mode keeps owner services and gates
project/session executors before they can subscribe or start.

## Invariants

- A front door never starts, restarts or stops a managed local OpenCode process.
- Its authenticated forwarding middleware precedes feature routes and the
  OpenCode proxy, while API body parsing leaves forwarded bodies unread.
- Startup and every successful settings write enqueue the safe agent mirror.
  Project activation is a registry operation with pre-save authorization.
- Notifications may observe live session state locally. Project metadata is
  delegated; session metadata writers, automation and local terminal execution
  stay on the agent server.
- Memory dreaming, extension service lifetimes, waits, session todos and shared
  pages run only on the agent side. The front door creates neither their
  executors nor their background schedules; their project routes are forwarded.
- Plain single-server mode retains the existing runtime composition.

## Decisions

### Why construction gates rather than route-only gates

Several executors start at module initialization. Forwarding HTTP alone would
leave automation running as the owner even when no local route reached it.
The composition therefore gates construction, subscriptions and startup under
the same mode flag.
