# Quota providers

## Ownership

This folder owns the built-in quota readers and registry. Nested provider folders
own their authentication and transforms. `../utils` owns shared formatting and
result construction; `../credentials` owns managed credential storage.

## Invariants

- Codex CLI credentials are read fresh from `$CODEX_HOME/auth.json`, falling back
  to `~/.codex/auth.json`. Missing or unusable access tokens return `null`.
  The account ID stays nullable. Decoded profile claims only label an account.
- File JSON and decoded JWT claims are untrusted. Object checks accept arrays,
  matching the shared `asObject` helper; string checks trim and reject blanks.
- MiniMax status fields remain unchecked values until their existing `Number`
  and `String` conversions. Status `0` is success; `1004` reports that MiniMax
  does not share limits for this key; other failures keep the supplied message.
- Cursor reads environment tokens before token files and managed credentials.
  Refreshing persists an access token only for managed credentials; importing
  credentials is a separate explicit write.
- Cursor JSON is checked as JSON data without promising a provider-specific
  shape. Numeric and timestamp coercion still happen at each meter.
- xAI accepts flat protobuf usage fields and nested response envelopes. The
  current-period percentage paths are `[1]` and `[1, 1]`, following the
  billing responses documented by https://github.com/steipete/CodexBar.

## Decisions

### Why MiniMax status fields remain unknown

The provider response does not validate their types. Declaring numeric codes or
string messages would promise more than the boundary checks. Both web and VS Code
use this same status mapping.

### Why Cursor JSON accepts non-finite numbers

`JSON.parse` accepts overflowing exponents such as `1e999` as infinity. The
JSON guard retains that acceptance; expiry checks and `toNumber` keep their
existing treatment of those numbers. A finite-number schema would change both
token refresh and meter fallback behavior.

### Why the registry remains JavaScript

`../extension-registry.js` stores providers in an untyped `Map`. Its
`extensionQuotaProvider` and `extensionQuotaProviderEntries` exports need an
owner-defined provider contract covering IDs, names, configuration checks and
quota results before the registry can consume them without unchecked types.
`../utils/auth.js` also leaves `getAuthEntry` and `normalizeAuthEntry` untyped;
credential readers must narrow their results before promising credential fields.

### Why the Cursor summary remains JavaScript

VS Code imports this reader directly. Converting it exposes
`../utils/transformers.ts`, whose `asNonEmptyString` re-export points to
`../../shared/guards.js` without a declaration. That owning boundary needs
`asNonEmptyString(value: unknown): string | null` before VS Code can check the
converted reader. The reader's returned percentages must also retain their
checked numeric type when using the broader `toUsageWindow` result.
