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

### Provider conversion contracts

The Cloudflare helper accepts explicit undefined for config, hostname and token
options and the quick provider's unused port. Ngrok accepts a missing or null
port at entry, retaining dependency, authentication and finite-port checks in
that order. Provider conversion preserves the existing calls.

Cloudflare and ngrok use the parent module's controller, request and context
contracts. Cloudflare doctor accepts partial requests because direct calls omit
fields. Its token and mode string guards preserve validation of doctor input,
including absent values, before calling string methods.

### Why optional port fields include undefined

The service explicitly passes `activePort` as null before a local port exists,
and normalized requests explicitly include an undefined `httpsPort`. Direct
provider calls also omit the context and HTTPS port.
