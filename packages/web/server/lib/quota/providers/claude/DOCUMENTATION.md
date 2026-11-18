# Claude quota

## Ownership

This folder owns Claude credential discovery, OAuth usage parsing and the
credential-scoped rate-limit cache. The quota registry and shared formatters
belong to the parent module. Its Claude semantics are documented in
`../../DOCUMENTATION.md`.

## Invariants

- Credential discovery checks the macOS Keychain, the Claude Code credentials
  file, OpenCode credentials and the environment in that order. OpenCode is
  queried only when the local sources have no token.
- Credentials are read-only. Expiry is epoch milliseconds when reported, and
  absent refresh tokens, expiry and subscription labels remain null.
- Keychain and file JSON are unchecked external values. Object checks accept
  arrays, matching the shared `asObject` helper. Individual fields still pass
  through the shared string and timestamp validators.
- The Keychain wins over the credentials file because Claude Code leaves stale
  credentials files on macOS.

## Decisions

### Why usage implementations remain JavaScript

`../../utils/formatters.d.ts` declares only `formatCredits`, hiding the runtime
exports `buildResult`, `toUsageWindow` and `formatMoney` from TypeScript. Those
contracts belong to the shared utilities assignment. The usage implementations
remain JavaScript until that boundary can be typed without replacement shims.
