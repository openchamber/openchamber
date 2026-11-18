# Tunnel providers

## Ownership

Providers expose capability descriptors, dependency checks, doctor diagnostics and
controller operations. The parent tunnel service owns request normalization and
capability validation. The sibling tunnel helpers own executable discovery,
process startup and cleanup.

## Invariants

- Provider wrappers preserve helper arguments, validation order and failure messages.
- Controller operations accept absent controllers and absent optional methods.
- Tailscale's local port check accepts integers using `Number.isInteger` without
  adding a range restriction. An absent HTTPS port uses the first advertised port.
- Doctor summaries preserve missing dependency, authentication and configuration
  failures, including Cloudflare's saved-profile fallback only when neither token
  nor hostname was explicitly supplied.

## Decisions

### Why Serve shares Funnel's HTTPS ports

[Funnel permits only specific HTTPS ports](https://tailscale.com/kb/1223/funnel).
Serve shares that list so switching modes preserves the saved port.

### Why Cloudflare and ngrok remain JavaScript

Their helper contracts need changes in the owning sibling modules before strict
conversion can preserve the existing calls:

- In `../../cloudflare-tunnel.ts`, `LocalCloudflareOptions.configPath` and
  `.hostname` must accept explicit `undefined`. Doctor requests and normalized
  start requests forward it to `inspectManagedLocalCloudflareConfig` and
  `startCloudflareManagedLocalTunnel`; optional properties currently accept only
  `string | null` when present.
- `startCloudflareManagedRemoteTunnel` accepts omitted token and hostname fields,
  but its optional fields exclude explicit `undefined`. Direct provider starts
  can forward that value; those fields must also accept explicit `undefined`.
- `startCloudflareQuickTunnel` accepts only `originUrl`, although the provider
  also passes `port`. Its options contract must include
  `port?: number | null | undefined` to describe the existing call.
- In `../../ngrok-tunnel.ts`, `startNgrokQuickTunnel` requires `port: number`.
  The service context supplies `number | null`, and a direct provider start can
  omit context altogether. The helper's port input must accept
  `number | null | undefined`; it already rejects missing and nonfinite ports
  after dependency and authentication checks.

The earlier `tokenFilePath` and `checkNgrokAuthtokenConfigured` blockers are
resolved in the typed helpers. No provider calls, validation order or helper
contracts change here.

### Why optional port fields include undefined

The service explicitly passes `activePort` as null before a local port exists,
and normalized requests explicitly include an undefined `httpsPort`. Direct
provider calls also omit the context and HTTPS port.
