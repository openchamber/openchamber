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
conversion can preserve the existing calls. `startCloudflareManagedRemoteTunnel`
infers `tokenFilePath` as required although it handles absence;
`startCloudflareQuickTunnel` accepts only `originUrl` although the provider also
passes `port`. `checkNgrokAuthtokenConfigured` infers its defaulted path parameter
as `null | undefined` although availability supplies a string path.

### Why optional port fields include undefined

The service explicitly passes `activePort` as null before a local port exists,
and normalized requests explicitly include an undefined `httpsPort`. Direct
provider calls also omit the context and HTTPS port.
