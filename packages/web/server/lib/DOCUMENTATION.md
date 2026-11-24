# Process-wide server helpers

## Ownership

The files directly in this folder own process environment cleanup, network
defaults, administrator policy, package installation discovery, tunnel child
processes, desktop realtime forwarding and session lineage. Feature runtimes
live in the nested folders. Server composition and the source-entry contract
belong to `../DOCUMENTATION.md`.

## Invariants

- Relative imports keep `.js` specifiers in both source languages. The source
  hook resolves converted implementations; installed processes use emitted
  JavaScript.
- Environment cleanup mutates and returns the same environment. Injected names
  are recorded only when their value changes. User overrides remove their
  names from that record.
- AppImage cleanup removes launcher-added directories and launcher-created
  empty library/data entries. Empty PATH entries and system XDG defaults stay.
  `ARGV0` changes zsh's external-command argv and can break virtual environments.
  Bun's native environment may retain it after a JavaScript deletion, so Linux
  also attempts libc `unsetenv`. Missing FFI support remains harmless.
- POSIX PTYs launch through `env -u` when available to remove `ARGV0` and
  `NODE_CHANNEL_FD` from the native environment before executing the shell.
  Windows and systems without `env` retain their original launch.
- Address-family attempts allow 5 seconds for distant providers while retaining
  IPv6-to-IPv4 fallback. System certificates augment the default trust store
  unless OpenSSL trust was explicitly selected. Unsupported runtime APIs
  retain the existing catch-and-return behavior.
- Outbound proxy environment resolution accepts uppercase and lowercase names,
  appends loopback bypasses and writes both NO_PROXY spellings. Node's optional
  global proxy API and Bun's environment-based fetch retain their own behavior.
- Enterprise policy parses file JSON through its existing schema. Invalid or
  unreadable policy enables protection. Environment values cannot override a
  file that enables enterprise mode. Policy polling rewrites managed config
  when its effective value changes, including when the policy file first
  appears.
- Provider-route matching retains case folding, duplicate separators, escapes,
  MCP OAuth exceptions and refusal of ambiguous paths. MCP integration ids
  contain 16 hexadecimal digits. Credential creation is refused in enterprise
  mode; credential listing is refused for all UI clients.
- Cloudflare YAML ingress and ngrok JSON logs/API responses remain untrusted.
  Optional fields are `unknown` until their existing array or string test
  succeeds. Invalid ngrok log lines still fall back to text matching.
- Tunnel stdout remains drained without exposing managed Cloudflare stdout.
  Stderr, readiness patterns, timeout values, token-file permissions, cleanup
  order and SIGINT behavior stay unchanged. Child interruption errors remain
  ignored.
- Cloudflare provider options accept explicit undefined for optional config,
  hostname and token fields. Quick-tunnel options also carry the unused port
  forwarded by providers. Ngrok accepts a missing or null port at entry and
  retains its dependency, authentication and finite-port checks in that order.
- Session parent ids prefer OpenCode's nonempty string, then a schema-validated
  workflow/operator metadata link. Creation/deletion events still use their
  schemas. Bounded eviction makes forgotten ancestry unknown, and takeover
  clears a previously learned child link.
- Realtime forwarding retains raw WebSocket data and its binary flag, including
  queued frames before the upstream opens. Runtime configuration fields remain
  unchecked until their string or object guard succeeds. Header arrays retain
  their enumerable string entries; authorization and malformed headers are
  excluded. Authentication, origin and target allowlists remain independent gates.

## Decisions

### Why runtime guards remain at external inputs

YAML, HTTP JSON, policy-file JSON, process output, thrown values and optional
runtime APIs are not established by TypeScript. Guards keep their existing
acceptance rules, including inherited dictionary members and malformed values.
The checked optional fields of tunnel data do not imply a complete provider
record.

### Why copied helper fixtures emit TypeScript

`path-realpath-cache.ts` declares its injected realpath callback and retained
cache entries. The bare Node fixture in `fs/routes.test.js` emits the helper
alongside the filesystem modules before importing them without dependencies.
Its string and callable guards retain the existing JavaScript fallback for
invalid injected values.

`web-package-paths.test.js` strips types before writing its installed-layout
JavaScript fixture. It runs without a workspace source resolver, preserving
the installed package's self-discovery contract.

### Why package entry fields retain Node validation

`web-package-paths.ts` reads the package-owned manifest contract, whose `main`
and `bin.openchamber` fields are strings. The name check selects the web package
before using these fields. JSON decoding adds no schema or coercion, so missing
or malformed entry fields still produce the original property-access or Node
`path.resolve` errors. The malformed-entry fixture covers these failures.

### Why Tailscale diagnosis checks the target

`tailscale-tunnel.ts` requires a resolved target when checking backend status.
Availability can be true only when a target exists; diagnosis checks both
bindings so TypeScript can establish the same invariant. A missing target keeps
the dependency-installation result and never runs a status command.
The macOS app binary receives `TAILSCALE_BE_CLI=1`, and foreground Serve/Funnel
configuration ends with its CLI process. Approval links, backend state names,
SIGINT cleanup and startup timeout behavior follow the existing CLI contract.

### Why update versions retain decoded JSON types

`getCurrentVersion` and registry fallback results pass through truthy version
values without checking for strings. Their types retain numbers, booleans,
arrays and objects. The version comparator already coerces its inputs with
`String`; release-note range types let that comparator receive the original
values without claiming validation in the functions that forward them.

The API channel regex makes its existing string coercion explicit. `RegExp.test`
performs the same conversion for decoded JSON, so this preserves array and object
versions without changing standard-library declarations. Package discovery
passes a file URL's `href` to the JavaScript helper, whose inferred parameter is
a string; `fileURLToPath` resolves that href identically to the original URL.

JSON object guards establish field access only. String, number and array checks
still decide which API fields are usable. A missing or malformed installed
version retains the existing fallback; truthy unchecked versions remain visible
in update results.

### Why package-manager output accepts two version separators

[pnpm list](https://pnpm.io/cli/list) separates package names and versions with
whitespace; npm, Bun and Yarn print `name@version`. Global version detection
accepts both formats.

[pnpm add](https://pnpm.io/cli/add#--allow-build) restricts dependency build
scripts in pnpm 10+. Update commands approve the existing `msgpackr-extract` and
`node-pty` builds only from 10.4 onward, because earlier releases reject
`--allow-build`.

### Why WebSocket send accepts raw Buffer arrays

The installed `ws` implementation forwards non-string send data through
`buffer-util.toBuffer`, which calls `Buffer.from` for arrays. `SendData` includes
`Buffer[]` to describe that existing acceptance without converting or
concatenating received frames in the proxy. This does not promise fragment
concatenation: the contract test retains the installed array-to-byte conversion.

The upstream WebSocket receives an explicit HTTP origin derived from its target.
The `ws` client makes origin optional, while protected upstreams require it.
The pending queue checks that a shifted frame exists before reading its tuple;
the synchronous queue loop guarantees occupancy during normal forwarding.
