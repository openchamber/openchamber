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
- Session parent ids prefer OpenCode's nonempty string, then a schema-validated
  workflow/operator metadata link. Creation/deletion events still use their
  schemas. Bounded eviction makes forgotten ancestry unknown, and takeover
  clears a previously learned child link.

## Decisions

### Why runtime guards remain at external inputs

YAML, HTTP JSON, policy-file JSON, process output, thrown values and optional
runtime APIs are not established by TypeScript. Guards keep their existing
acceptance rules, including inherited dictionary members and malformed values.
The checked optional fields of tunnel data do not imply a complete provider
record.

### Why selected implementations remain JavaScript

`path-realpath-cache.js` is copied verbatim by `fs/routes.test.js` into a bare
Node fixture without a source resolver or transpilation. Its owner must change
that fixture before the copied helper can contain TypeScript.

`realtime-proxy.js` imports `ws`, whose declaration package is absent from this
workspace. A local shim would replace the dependency's actual contract.

`tailscale-tunnel.js` passes approval details to `tunnels/types.js`.
That JavaScript constructor's inferred third parameter accepts only null;
its owner must declare the existing details contract.

`web-package-paths.js` passes unchecked manifest `main` and `bin.openchamber`
values directly to Node's path validation. `package-manager.js` also passes
through unchecked manifest versions, saved update-channel values and registry
tags. Declaring those values as strings would promise validation they do not
perform. Adding schema validation would change their malformed-input behavior.
Their consumers need a settled parsing contract before conversion.
