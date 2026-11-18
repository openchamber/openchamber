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

### Why selected implementations remain JavaScript

`path-realpath-cache.ts` declares its injected realpath callback and retained
cache entries. The bare Node fixture in `fs/routes.test.js` emits the helper
alongside the filesystem modules before importing them without dependencies.
Its string and callable guards retain the existing JavaScript fallback for
invalid injected values.

`tailscale-tunnel.js` can now pass approval details to the typed
`TunnelServiceError` constructor. Its remaining boundary is
`tunnels/providers/tailscale.ts`, in `createTailscaleTunnelProvider().diagnose`.
That caller passes `target` to `checkTailscaleRunning` after checking
`dependency.available`. The availability result does not narrow the separate
`target` binding, whose type remains `{ command: string; env: NodeJS.ProcessEnv }
| null`. The caller must establish a non-null target before calling the helper,
which dereferences `target.command`. A strict conversion reports TS2322 at that
call. Accepting null in the helper would promise support its implementation
does not provide.

`web-package-paths.js` passes unchecked manifest `main` and `bin.openchamber`
values directly to Node's `path.resolve`, whose segments must be strings.
Only `manifest.name` is checked. Its owner must settle the manifest parsing
contract without replacing Node's existing malformed-input failures. The
`web-package-paths.test.js` installed-layout fixture also copies the source
verbatim as JavaScript.

`package-manager.js` passes through unchecked manifest versions, saved
update-channel values and registry tags. In particular, `getCurrentVersion`
returns `pkg.version || 'unknown'`, and `getLatestVersion` returns the unchecked
`dist-tags.latest` value. These can be non-string truthy JSON values.
`changelog/update-notes.ts` exports `fetchUpdateNotes` with string-only
`fromVersion` and `toVersion` parameters, while `fetchChangelogNotes` forwards
those unchecked values. That contract must account for the actual forwarded
values before conversion; declaring the producers' results as strings would
promise validation they do not perform. The local `compareVersions` contract
also accepts only strings. Adding validation or coercion at these call sites
would change acceptance or failure behavior.

The external `fetchUpdateNotes` contract would need to accept the unchecked
JSON versions that this folder forwards, including truthy numbers, arrays and
objects. A compiler probe using `shared/json-values.ts` reports TS2345 at that
call. The same probe reports TS2345 when forwarding an unchecked manifest entry
to Node's `path.resolve`. Node's string-only path contract must stay intact;
claiming that the manifest entry is a string would invent validation.

Even widening `fetchUpdateNotes` and the local `compareVersions` to decoded JSON
does not type `checkForUpdatesFromApi`: its existing
`/-canary\./.test(currentVersion)` passes the unchecked manifest version directly
to the standard library's string-only `RegExp.test`. A compiler probe reports
TS2345 for this call and for the manifest entry passed to `path.resolve`.
Changing standard-library declarations, asserting a string or adding coercion
would exceed a type-only server-module correction.

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
