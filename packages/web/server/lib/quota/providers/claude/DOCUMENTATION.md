# Claude quota

## Ownership

This folder owns Claude credential discovery, OAuth usage parsing and the
credential-scoped rate-limit cache. The quota registry and shared formatters
belong to the parent module. Its Claude semantics are documented in
`../../DOCUMENTATION.md`.

## Invariants

- Without an explicit Claude home, credential discovery checks the macOS
  Keychain, the Claude Code credentials file, OpenCode credentials and the
  environment in that order. An explicit home checks only that home's Keychain
  entry and credentials file.
- Credentials are read-only. Expiry is epoch milliseconds when reported, and
  absent refresh tokens, expiry and subscription labels remain null.
- Keychain and file JSON are unchecked external values. Object checks accept
  arrays, matching the shared `asObject` helper. Individual fields still pass
  through the shared string and timestamp validators.
- The Keychain wins over the credentials file because Claude Code leaves stale
  credentials files on macOS.

## Decisions

### Why usage fields remain unknown until read

The HTTP response is unchecked JSON. The object parser accepts arrays and
leaves every field unknown, matching the shared object check without promising
an API schema. The limits parser checks only that the value is an array;
individual entries and fields are validated when read.

### Why cached usage belongs to a credential fingerprint

The last successful payload survives Anthropic rate limiting, but a hash of
both tokens keeps another account from receiving those values. A changed hash
also clears the cooldown so refreshed credentials can be tried immediately.

### Why a denied usage request differs from expiry

A valid `claude setup-token` token lacks `user:profile` and receives 403 from
`https://api.anthropic.com/api/oauth/usage`. Signing in again cannot add that
scope to a setup token, so the error names Claude Code's `/login` instead.
