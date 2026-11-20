# Antigravity quota

## Ownership

This folder owns account-file selection, Google quota requests, client identity
and model-window transforms. Google OAuth exchange and shared quota utilities
remain owned by their neighbouring folders. VS Code imports the client identity
module and implements its own quota reader.

## Invariants

- Successful HTTP JSON is returned unchanged, including null, primitives and
  malformed provider shapes.
- Account files accept an accounts array and select the active index, falling
  back to the first account only when the indexed value is nullish. A selected
  account without a truthy refresh token does not try another account.
- A truthy non-string refresh token still reaches Google's existing token parser
  and resolves to null. Email remains unchecked and retains its original value.
- Request order, timeout, headers and endpoint fallback remain unchanged.

## Decisions

### Why label reads keep their native failures

Account files, Google quota responses and VS Code's summary cast establish no
string fields. `client.ts` and `transforms.ts` read display names, windows and
bucket ids through the fields they use, each typed `unknown`, and lower-case
them through `lowerCaseLabel` (`../../utils/labels.ts`). A truthy non-string
label throws the same `TypeError` message the original method call threw, and
a falsy one still reads as empty. `boundaries.test.js` pins both. Declaring the
labels as strings would promise a check nothing makes; validating them would
change the malformed-input results.

`warnIfGeminiGroupMissing` and the transforms take any payload, as both the web
HTTP boundary (`JsonValue` from `api.ts`) and VS Code's unchecked
`QuotaSummaryPayload` cast supply one. Successful JSON still passes through
`api.ts` without a provider shape check.

The platform and architecture names are `Map` lookups. Only `process.platform`
and `process.arch` values reach them, so no inherited object key can.
