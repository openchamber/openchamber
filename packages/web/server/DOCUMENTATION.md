# OpenChamber server

## Ownership

`index.js` composes the HTTP server and feature runtimes for web, desktop and
mobile clients. Each feature owns its contract in `lib/<feature>/DOCUMENTATION.md`.
This document covers composition, process-wide helpers, enterprise policy and
server update ownership. VS Code runs its own host and shares only the helpers
it imports.

## Invariants

- The fetch trust guard is installed before feature runtimes capture `fetch`.
  Every server-side OpenCode client follows the proxy's directory trust checks.
  A space directory never executes on the host, and an untrusted directory
  cannot become the fallback for server-side reads.
- Runtime dependencies declared later in startup are resolved when called.
  Capturing them during composition reads an uninitialized binding or retains
  a null runtime after startup or a live feature switch.
- OpenCode process state survives HMR and stays synchronized with the
  module-local bindings, so a reload cannot orphan a managed child.
- OpenChamber events use one control-stream broadcaster and the WebSocket
  fan-out. Permission requests and modes reach both global and control streams,
  because SSE windows rely on the latter. OpenCode's proxy carries upstream
  events only. Metadata broadcasts carry the merged record so a client can
  recover after missing a patch.
- Metadata writes arm the goal loop directly, independently of event-stream
  connectivity. A restored connection also settles goals whose idle event was
  missed. Hidden session ids are learned before their events reach clients.
- The event hub translates the upstream wire vocabulary once. Browser bridges
  forward raw wire payloads and derive synthetic client frames from the
  translated event, using the event's turn start if it precedes local state.
- Directory trust answers live until the upstream reports the folder closed.
  A disconnected stream gives them a short lifetime, and reconnection clears
  them because folder-close events may have been missed.
- Tracker and source-control ids share one namespace. A tracker load failure
  leaves other trackers running and permits a later retry.
- Memory's switch gates actions, routes and the session index together. The
  index additionally requires a managed OpenCode with the tool. The global
  event watcher starts whenever OpenCode is available, because session assist
  also depends on it. Failed legacy metadata migrations retain their entries
  for a later write or startup.
- A notification visibility report clears the server's pushed badge state when
  the device clears its own badge. Goal-settle notifications obey the same
  toggle as the per-turn ready notices they replace.
- Browser dispatch counts clients capable of the requested action. Opening a
  page needs a panel; driving one needs a capable browser client. File and plan
  opens are one-way broadcasts, so their delivery count is the agent's only
  confirmation. Memory change broadcasts use `openchamber:agent-memory-changed`, the
  name the UI subscribes to.
- Runtime tool gates remain authoritative after plugin generation. Turning off
  knowledge or page rendering prevents an older generated plugin from writing
  or paging. A pending answer-later page seeds waiting state, broadcasts the
  change and emits the input-needed notification even without an upstream event.
- Git's credential-helper address file is written after the listener port is
  known and before OpenCode starts shells that can use the helper.
- Pairing LAN candidates derive from the actual server bind. A loopback-only
  listener advertises no LAN path. The requesting client's reached address is
  preferred to interface scanning, which can select an unroutable virtual
  bridge. Refresh includes other non-internal IPv4 interfaces for DHCP changes.
- A data directory has one relay identity and one hosting owner. Development
  instances suppress passive relay hosting so paired devices do not land on a
  debug instance; explicit enabling or pairing can still request hosting.
- Relay demand includes paired relay devices and unexpired relay pairing
  sessions. Any affirmative read wins; otherwise a store read failure aborts
  reconciliation and preserves current hosting. Polling also observes CLI
  writes and pairing expiry that bypass HTTP routes.
- Space dispatch follows API authentication and precedes every directory reader
  and the OpenCode proxy. Its upgrade handler runs first so host handlers do
  not take a space's socket. Feature-off state creates no place or manager and
  runs no Docker commands. Archived space chats remain read-only with either
  switch value.
- Only a managed OpenCode exposes a process id and port to the desktop killer.
  An external endpoint supplies no kill target even if a caller misreads the
  managed flag.
- Every OpenChamber-owned user folder follows the selected data root. Legacy
  folders copy only into absent destinations; a failed copy removes its partial
  destination and reports the failure while startup continues. Managed chats
  exist before the UI attempts its first workspace read. A relocated chats
  root permits a separate OpenCode user that cannot traverse the server's home.
- Injected environment names are recorded only when OpenChamber changes a
  value. Unchanged inherited credentials stay user-owned, so startup helpers
  can distinguish user exports from OpenChamber configuration without a
  separate list of variable names.
- AppImage list cleanup removes launcher entries and launcher-created empty
  entries, while preserving the user's empty PATH entries. Outbound proxy
  configuration always bypasses loopback and writes that bypass into the
  environment for child processes and runtimes that read it themselves.
- TLS defaults add system trust once without discarding a selected OpenSSL
  store. A runtime lacking the TLS API leaves its trust settings unchanged.
  Proxy defaults are applied again at startup after the desktop login-shell
  environment becomes available.
- Session lineage is learned from translated creation events, metadata changes
  and records already read. User takeover can change a child's parent status;
  bounded eviction returns it to unknown, so stale ancestry is not permanent.

## Enterprise policy invariants

- The machine policy and server environment can each enable enterprise mode.
  An unreadable or invalid existing policy enables protection, pins nothing
  and allows nothing. Policy is read at use time and watched for managed-config
  changes, so a policy change applies to a running instance.
- A file enabling enterprise mode is the sole authority for endpoint and
  network allowances. Otherwise file values take precedence and environment
  values fill missing fields. Fixed policy paths precede Windows ProgramData
  lookup, so user-controlled environment changes cannot hide installed policy.
- The OpenCode binary pin and built-in skill-catalog hiding are file-only
  controls even outside enterprise mode. A pinned binary never falls back to
  bundled or PATH discovery and OpenChamber never installs or upgrades it.
- Provider connection and credential creation are refused at server boundaries.
  Configured MCP sign-in, cancelling a connection and selecting or removing an
  existing credential remain allowed. Ambiguous upstream path parsing fails
  closed, and no UI client can read the upstream credential collection.
- Jev requires an administrator-pinned endpoint. Private relay hosting and
  outgoing or received shared pages require the pinned self-hosted relay;
  uploads and link opening cannot choose another relay. External tunnels are
  refused, speech stays on this machine, push omits conversation content and
  update checks omit usage reporting.
- Settings and service environment overlays do not reach managed OpenCode,
  because a variable can add a provider key. Git, terminals and exec still
  receive them. Image generation and the Claude Code provider plugin remain
  covered by OpenCode's `provider.use` policy.
- Network binds require explicit allowance. A policy change cannot rebind a
  running listener, so nonlocal connections are dropped until restart.
  Conversation-capable extensions require an administrator-approved Git
  repository or an allowed local folder; a package id alone cannot establish
  provenance. Policy changes rewrite managed plugin and skill configuration.
- Allowed extension notification channels receive generic titles only;
  trackers receive searches, ids and fixed-label session links; usage providers
  receive only approved providers' credentials. A clicked extension link alone
  does not grant network or conversation access.
- Browser-only disclosures are gated in the UI: draw.io opens as XML, public
  CDN fonts use system fallbacks without erasing the choice, the built-in
  integrations catalog and Claude Code install card stay hidden. VS Code uses
  this same policy reader for its own supported operations.

## Decisions

### Why streaming paths bypass compression and not only content negotiation

Compression filters run before handlers set Content-Type. Clients can omit
Accept, so explicit SSE paths also bypass compression to keep events streaming.

### Why OpenChamber credentials stop at the proxy and not at OpenCode

UI client bearer tokens authenticate this server. Forwarding them to managed
OpenCode replaces its own authentication and turns valid upstream calls into 401s.

### Why HTTP defaults account for proxies and not only direct browser traffic

Idle sockets outlive reverse-proxy pools to prevent reuse-time 502s, and
headersTimeout stays above keepAliveTimeout. CORS lists every custom client
header and caches preflights because packaged origins otherwise repeat them
for each request; the app shell remains excluded from search indexing even
before authentication.

### Why user folders copy and not move during data-root migration

A default-root instance can coexist with a custom-root instance. Moving its
projects would remove the other instance's files.

### Why desktop skips package-manager detection and not merely update execution

Electron ships a bundle with its own updater. Global package-manager probes
can synchronously block its main thread for multiple timeouts and cannot
establish ownership of that bundle.

### Why updates require install ownership and not a guessed package manager

Ownership evidence precedes environment and command hints. Tarballs, containers
and source checkouts have no owning package manager, so the retained detection
reason must prevent a later call from offering an ineffective install command.

### Why updates pin and verify the offered version and not the latest tag

Registry caching and release-age policy can resolve a tag behind the update
check. An exact target pins the install and reads the global version afterward;
a zero exit status alone does not prove the requested update landed. pnpm build
approvals stay aligned with `scripts/install.sh` and the package's blocked
dependencies so unattended updates do not wait for an approval prompt.

### Why update channels belong to the installed runtime and not every client

The server's saved channel controls npm server updates. Without a selection a
Canary install follows Canary; choosing Stable can intentionally offer an older
release. Desktop, VS Code and phones ask about their own builds. Android takes
the newest Canary APK, iOS uses TestFlight, and mirrors keep downloads available
when GitHub release delivery fails. Enterprise checks still deliver security
updates without reporting usage.
