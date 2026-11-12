# Ownership

This module owns the read-only OpenCode transport for extension services: its loopback listener, service-process leases, request authorization, the list of allowed reads, upstream selection and cancellation. `service.js` registers the service token before spawning and revokes it on stop or exit. Server composition supplies current catalog lookup and the host's connection URL and authentication getters.

The SDK owns the `opencode` role and approval capability. Extension business logic and OpenCode client serialization stay in the extension. The JSON callback listener for Git, trackers and notifications is separate and unchanged.

# Invariants

- A service declaring `provides: ["opencode"]` needs both `service` and `opencode` grants and every other capability it requests. Existing service grants alone do not authorize OpenCode access. No stored grant-scope format changes.
- The listener binds only `127.0.0.1` and is absent until a service needs it. It is never registered on Express, so Relay, tunnels, UI cookies and OpenChamber API routes cannot reach it. Requests with `Origin` are refused.
- The service receives `OPENCHAMBER_OPENCODE_URL` and uses its own `OPENCHAMBER_SERVICE_TOKEN` as the bearer. The host's OpenCode connection credentials are never injected into that service. The lease lasts for the service process, allowing background reads and the event stream between panel requests.
- Every request and every chunk of a response rechecks the current catalog, including effective grants and enterprise extension policy, so a stream stops at its next chunk once approval is gone, whether or not anything revoked its lease. An administrator's policy change works this way: it changes the catalog row and revokes nothing. A failed lookup stops the transfer. Removing approval, pausing, replacing or removing a package, process exit and shutdown revoke its lease and abort in-flight calls. A lookup finishing after revocation cannot dispatch.
- `READS` in `index.js` is the whole grant: `GET` on the listed paths and nothing else. A path is matched on the raw request line, with session and message ids in their own shape, so an encoded separator or dot segment cannot pass as an id. Everything unlisted gets 403 and makes no upstream call, including every write, configuration change, operation start, plugin RPC and any route OpenCode adds later.
- A listed read changes nothing and starts nothing on OpenCode: `/api/project`, the session list, `/api/session/active`, a session, its messages, and `/api/event`. Each is answered without a location, so none of them starts MCP servers. A new entry has to hold to this: read its OpenCode handler and its middleware before adding it.
- Only the path, the query and `Accept` reach OpenCode, with the upstream authentication substituted. A request body, directory headers and cookies do not. Redirects are refused. There is no discovery, process launch or fallback, and each incoming call makes one upstream call.
- Each call uses the OpenCode the host has selected when it arrives. When the host moves to another OpenCode, a transfer still open ends at its next chunk, before that chunk reaches the service. The event stream has a heartbeat every 15 seconds, so it ends within that time. Multiple calls are not an atomic snapshot across instance changes.
- Transfers are capped at the existing guest response limit, the event stream included. An oversized or interrupted stream terminates; it never becomes a complete truncated payload. Upstream inactivity uses the guest timeout.
- Web and Electron use this backend-owned transport, whether their UI reaches the host directly or through Relay. VS Code exposes no extension catalog. Hosted mobile and Capacitor read the catalog of the host, and the transport runs there as it does for any client.

# Decisions

### Why an explicit list of reads and not the whole OpenCode API

Accepted issue #6332 asks for queries. A pass-through with a deny list would hand a service configuration changes, prompts, plugin RPC and whatever OpenCode adds next, none of which the user approved. The list costs a line here when a read is missing, and a read that is missing fails visibly.

### Why not every GET

A GET can start work or reveal the server. On OpenCode 2.x a read that goes through the location middleware (agents, models, providers, files, config, MCP) starts that directory's MCP servers, session routes such as `diff` and `context` build the session's location, and `/api/info` returns the server's address, which the service must not learn. `GET /api/credential` returns every stored key. Plugin RPC cannot be listed at all, since nothing guarantees a plugin's method is read-only.

### Why approval and the selected OpenCode are checked on each chunk

The selected address lives behind `buildOpenCodeUrl` and the policy lives in the catalog read, so checking both as data arrives keeps this module out of the OpenCode lifecycle and the policy watcher. It covers the case that matters, whatever changed: no bytes reach the service after a switch or a withdrawal. Checks on one stream run one at a time, and each costs a cached catalog read plus the policy file read every catalog read makes. A check on a timer would be cheaper and would leave a window in which session content still arrives.

### Why a separate listener instead of the OpenChamber API

Routing directly to OpenCode keeps OpenChamber's management endpoints outside the grant. The existing callback listener carries JSON operation envelopes; a native HTTP listener keeps the standard OpenCode client and SSE working without adding a second serialization protocol.

### Why process leases instead of request handles

The user approves a local process with their user access. Its OpenCode authorization remains useful for background work and the event stream. Tying it to an enclosing panel request would cancel those reads and require request-specific plumbing in every extension.
