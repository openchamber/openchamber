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

## Decisions

### Why MiniMax status fields remain unknown

The provider response does not validate their types. Declaring numeric codes or
string messages would promise more than the boundary checks. Both web and VS Code
use this same status mapping.

### Why some implementations remain JavaScript

`../utils/formatters.d.ts` declares only `formatCredits`, hiding the implementation's
other exports from TypeScript. Readers importing `buildResult`, `toUsageWindow`,
`formatMoney`, `durationToLabel` or `durationToSeconds` need that owning contract
corrected before conversion. VS Code also imports `codex-cli.js`, whose dependency
`../utils/index.js` has no declaration for its JSON reader or string guard.
Converting that reader requires types owned outside this folder. The two MiniMax
configuration wrappers retain the inferred exports of the unconverted factory.
