# OpenChamber server

## Ownership

`index.js` enables source maps before dynamically loading `runtime.ts` (through its `.js` specifier). Node collects maps only for modules loaded after `setSourceMapsSupport` is called, which is why the runtime is a dynamic import; Bun handles maps itself and does not expose that API, hence the optional call. In a source checkout, the Node entry also registers source resolution before that import.
`runtime.ts` composes the HTTP server and feature runtimes for web, desktop and
mobile clients. Each feature owns its contract in `lib/<feature>/DOCUMENTATION.md`.
This document covers composition, process-wide helpers, enterprise policy and
server update ownership. VS Code runs its own host and shares only the helpers
it imports.

## Invariants

- Installed server and CLI code runs from `build/server` and `build/bin`.
  Sibling assets retain their relative locations. The server enables Node source
  maps so emitted stack traces identify the original source and line.
- Source CLI commands resolve their sibling server directly, so checkout
  development does not depend on generated output or the package's published
  entry fields.

- Package-owned paths come from `lib/web-package-paths.js`, which locates the
  ancestor manifest named `@openchamber/web` and caches the resolved paths.
  Server and CLI entries follow that manifest; UI assets remain in package-root
  `dist`, with `OPENCHAMBER_DIST_DIR` taking precedence. Importer-relative sibling
  assets and the built-in extensions override retain their own contracts.

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

## Converting a folder to TypeScript

One worker owns the implementation files directly inside one assigned folder.
Nested folders are separate assignments. Run in an isolated checkout. In a
shared checkout, workers run focused tests only and the coordinator runs the
combined checks and builds serially.

1. Read this document, the folder's documentation and every caller of its
   exports. Run its existing tests before changing code. List its imports and
   externally read inputs so defaults, missing values and failure behavior
   remain explicit.
2. Rename each implementation with `git mv file.js file.ts`. Keep `.js` in
   relative imports and re-exports, including type-only imports. Tests stay
   JavaScript unless a compile-time contract needs a TypeScript test. Delete
   every paired `file.d.ts` as its implementation converts. Declaration-only
   contracts remain until their owning assignment moves them.
3. Declare each boundary data type once, export it from its owning module or a
   folder-local contract module, and import it with `import type`. Give
   parameters and state their actual domain types. Keep inferred return types
   when they already express the contract; name public result shapes shared
   by callers. Preserve the existing optional-versus-null contract.
   Use `shared/http-contracts.js` for Express `Request`, `Response`,
   `RequestHandler`, `Router` and `Application`. Its request body and query
   fields remain unchecked until the route validates them. `shared/express.d.ts`
   connects the installed Express factory to these structural contracts.
   WebSocket constructors, frame data and events live in
   `shared/websocket-contracts.js`, connected to `ws` by `shared/ws.d.ts`.
   Import constructors from `ws` at runtime and contracts with `import type`.
   Import these owner contracts rather than declaring another folder's copy.
   `shared/object-guards.js` supplies record, boolean and string predicates,
   also re-exported from the `shared/guards.js` entry. `isString` is true only
   for primitive strings and narrows to `string`.
   OpenCode's declaration-only boundary exposes markdown frontmatter as
   `unknown` and optional activity-probe signals; the settings module's
   exposes merged settings as unchecked records. The matching implementations
   remain owned by those modules.
4. Keep runtime validation at HTTP, file, environment and process-message
   boundaries. Parse external values before using them. Use a small type guard
   when a runtime check establishes a shape. Remove `typeof` branches that
   merely recheck an internally typed value. No explicit `any`, non-null
   assertions, blind casts, widened escape types or suppression without a
   concrete reason. Product-code explanations belong in documentation.
5. Run the worker proof below, inspect the diff for behavior changes and obtain the
   `review-changes` second look. Hand over the folder, removed declaration paths,
   commands and results, and any boundary mismatch outside the assignment.
   A mismatch in another folder is a coordinator handoff, never permission to
   weaken this folder's types.

### Mixed JavaScript and TypeScript

Keep server and bin implementation imports inside `packages/web`, including
`import type`; shared packages must supply built declarations rather than
workspace sources. Both `type-check:server` and `build:server` inspect the
compiler's file list and reject escaping implementation sources before emit.

Before converting a folder, trace its importers through to process entrypoints.
Node links static imports before executing any module body. Each owned
server/bin process entry keeps a `.js` bootstrap with Node builtin static imports,
registers the source hook, then dynamically imports its implementation. Keep
these bootstrap files JavaScript when converting their containing folder.
The CLI implementation detects execution against `bin/cli.js`, so moving the
implementation does not change package-bin or symlink behavior.

For a Node script outside server/bin, register the hook before dynamically
importing server/bin modules. A fork or spawn starts a separate resolver scope:
use a bootstrapped process target, or preload the hook with `--import` when a
test intentionally imports a helper directly. Changing the parent's imports
alone does not protect the child.

Run the entry regression with the folder tests:

```sh
bun run --cwd packages/web test scripts/node-source-entries.test.mjs
node packages/web/bin/cli.js --version
```

The regression copies sources into a disposable checkout and gives every listed
entry a static dependency on a type-bearing `.ts` module through a `.js`
specifier. It starts plain Node without inherited `NODE_OPTIONS`, runs the
worker over IPC, and covers direct-helper tests with explicit preloads. Add any
new owned Node process target or direct-source test target to that inventory.
The regular CLI suite separately checks exit codes and output modes.

The launch audit groups callers by their actual process target:

- `bin/cli.js`: package scripts, verify stand, perf/design tools, session seed
  scripts, startup services and update/restart commands. Bun callers retain
  their arguments; plain Node callers now use the same self-bootstrapping entry.
- `server/index.js`: direct server tests, daemon fallback and standalone server
  startup. Its source bootstrap runs before the runtime graph.
- Git's credential, repository-credential and SSH helpers: `process.execPath`
  through `helper-launch.js`, with `ELECTRON_RUN_AS_NODE` retained for desktop.
- Dictation's worker: `fork` of `worker-process.js`, with the existing IPC,
  serialization and native-addon boundary unchanged.
- Build extensions, release mirror, tool-use bench and dev-server watcher:
  Node scripts register the hook before their server imports. Electron's dev
  launcher already preloads the hook and passes it to Electron; packaged
  Electron and the VS Code bundle consume emitted or bundled JavaScript.
- Direct-source tests: storage fixtures, outbound proxy, provider registry,
  disabled providers, auth stores, model installation and guest service registry
  preload the hook. Tests of emitted bundles and standalone copied-JavaScript
  fixtures keep their no-source-hook contract.
- Guest service entries, generated CJS programs, container scripts and inline
  `node -e` programs own their own code; the server resolver does not extend to
  external guest packages or container files.

`tsconfig.server-check.json` checks every `.ts` under server and bin with
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride` and `erasableSyntaxOnly`. It emits nothing. `allowJs` and
`checkJs: false` let TypeScript read unconverted implementations and infer their
exports. Import those modules through their existing `.js` specifiers. Use a
remaining handwritten declaration when one exists; do not create a replacement
shim or convert a dependency outside the assignment.

`type-check:server` rejects an implementation that still has its paired
declaration. `lint:server` enforces the TypeScript rules and the existing
OpenChamber rules on all converted implementations, independently of the
changed-file backlog. Both checks run through the normal package/root gate.
TypeScript suppressions require a reason of at least 10 characters. External
input guards with an explicit `value is DomainType` predicate may accept
`unknown` and use `typeof`; unparsed helper parameters and internal `typeof`
   branches remain lint errors.
   Exported input parsers in `lib/shared/*.ts` may also accept one `unknown`
   parameter and declare a nullable union result. Both rules scope this exception
   through `allowInParsers`; other folders and internal callbacks remain checked.
The dictionary rule also admits an unknown-valued dictionary in a type
predicate's result. A record predicate establishes the container only;
each property still needs its own check. Ordinary dictionary parameters,
returns and stored values remain subject to the rule.

Bun, Vitest and the VS Code esbuild bundle resolve `.js` imports to converted
`.ts` files. Node source consumers, including Electron development, preload
`packages/web/scripts/register-server-sources.mjs` and use the
`openchamber-source` export condition. The hook falls back only for a missing
`.js` whose real `.ts` file belongs to this package's server or bin. Installed
Node and Electron read emitted JavaScript and never use this hook. The source
server entry automatically loads it before its runtime graph, so plain Node
foreground CLI, daemon fallback and perf/design launchers remain supported.
Tests that import a converted helper directly under Node preload the same hook.
Perf/design launchers also preload it before the source CLI, so converting a
CLI dependency cannot break its static import graph. Older comparison
checkouts without this hook keep their original launch arguments.

### Pilot judgments

- Diagnostics has a fixed privacy vocabulary. HTTP JSON is still parsed at
  the boundary; an invalid or failed read remains `null`, while a valid empty
  list remains zero. An integer pid uses `Number.isInteger`, preserving the
  old acceptance rule rather than adding safe-integer or positive-only limits.
- An absent optional field stays absent. `exactOptionalPropertyTypes` is on
  from the first file. Add `| undefined` only when a real caller intentionally
  supplies an explicit undefined value; do not add it to every optional field.
- The diagnostic ring buffer has occupied and empty slots. Its local
  `retainedEntry` accessor checks occupancy before returning the entry,
  preserving an invariant failure without a cast or non-null assertion.
  Public data types live once in `diagnostics/contracts.ts`.

### Worker proof commands

Run from the repository root, replacing the folder in the first command.
The package test argument is relative to `packages/web`.

```sh
folder=server/lib/diagnostics
bun run --cwd packages/web test "$folder"
bun run --cwd packages/web type-check:server
bun run --cwd packages/web lint:server
```

These commands establish the baseline, preserve behavior after conversion and
check all currently converted consumers. In a shared checkout, run only the
focused test command; the coordinator runs the two all-folder checks.

### Coordinator proof commands

Run these once on the combined wave, after workers stop editing.

Knip 5.80 applies `.gitignore` patterns to absolute package-export globs.
A checkout below a directory named `.local` can therefore lose TypeScript
importers through the `*.local` ignore pattern and report live JavaScript
exports as unused. Validate the identical diff in a checkout outside `.local`;
keep those exports and the dead-code rules intact.

```sh
bun run --cwd packages/web test
bun run --cwd packages/vscode type-check
bun run --cwd packages/vscode test
bun run --cwd packages/vscode build:extension
bun run build:server
bun run --cwd packages/web smoke:server-build
bun run verify -- --changed
bun run check:changed
```

The focused tests compare the folder's behavior before and after conversion.
The strict check includes all converted server and CLI consumers. Lint checks
every converted implementation without a backlog allowance. The web suite
checks JavaScript consumers, source resolution and build regressions. VS Code's
checks and extension build exercise its cross-package contracts and bundler.
`build:server` proves declaration and JavaScript emission; `smoke:server-build`
starts that emitted entry under Node with isolated data, checks UI, health and
the diagnostic routes, then stops it. The behavior net selects mapped user
flows; report any uncovered files it prints. The final gate also runs knip and
the existing file-size and changed-file rules.

For the pilot, `scripts/server-types-bundle.test.mjs` additionally bundles and
executes diagnostics with VS Code's esbuild flags, and
`scripts/register-server-sources.test.mjs` executes its unchanged package import
from the Electron workspace under Node.

Never change behavior, defaults, error handling or acceptance rules to make a
type pass. Never touch another folder's files beyond an import specifier.
Shared gate configuration, emitted output, package exports and generated files
belong to the coordinator. A folder assignment does not authorize a dependency
addition, a branch change, a commit, a push, or a wider refactor. The `git mv`
rename in step 2 is the assignment's only authorized git write.

### The conversion is closed

Every implementation module under `server` and `bin` is TypeScript, and
`type-check:server` fails on a new `.js` one. Six files stay JavaScript because
Node, git or a child process runs each by file name, without a loader:
`bin/cli.js`, `server/index.js`, `lib/git/credential-helper.js`,
`lib/git/repository-credential-helper.js`, `lib/git/ssh-wrapper.js` and
`lib/dictation/local/worker-process.js`. They hold no logic of their own; each
imports its typed runtime. The list is `JAVASCRIPT_ENTRIES` in
`packages/web/scripts/check-server-types.mjs`. Tests, fixtures and the
gatekeeper's `.cjs` program are outside the rule.

## Decisions

### Why the entry loads the runtime dynamically

Node collects maps while loading modules. Enabling maps inside the full static
import graph misses that graph, and dependencies under `node_modules` also need
explicit inclusion. The small entry enables both before loading the runtime,
while keeping the same exports and CLI entry identity.

### Why package discovery follows the manifest

Server files can run at different depths in a checkout or an installed package.
The named ancestor manifest establishes ownership without counting parent folders.
Checkout-only tools and the registry user agent recognize `openchamber-monorepo`
only when it owns this package at `packages/web`. An npm install has no local
tools checkout and keeps the registry user agent's `dev` fallback.

### Why streaming paths bypass compression and not only content negotiation

Compression filters run before handlers set Content-Type. Clients can omit
Accept, so explicit SSE paths also bypass compression to keep events streaming.

### Why OpenChamber credentials stop at the proxy and not at OpenCode

UI client bearer tokens authenticate this server. Forwarding them to managed
OpenCode replaces its own authentication and turns valid upstream calls into 401s.
Browser fetch-metadata headers also stop at this hop. OpenCode 2.2.6 rejects
cross-site fetch metadata, while packaged clients terminate that request at
OpenChamber.

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
