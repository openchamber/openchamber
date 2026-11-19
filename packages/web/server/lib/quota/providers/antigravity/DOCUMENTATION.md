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

### Why some implementations remain JavaScript

The shared `readJsonFile` utility returns unchecked JSON. Account-file guards
establish only objects and the existing array check; their fields remain unknown.
`client.js` and `transforms.js` remain JavaScript. Their exact unchecked operations
are `isThirdPartyGroup` in `client.js`, and `parseBucket` and `transformSummary`
in `transforms.js`: each calls `.toLowerCase()` on a truthy JSON field without a
string check. `boundaries.test.js` requires native `TypeError` failures for numeric
display names, windows and bucket ids, and accepts false display names and null
buckets. The fallback expressions must retain those acceptance and failure rules.

VS Code's
`fetchAntigravityQuotaSummary` casts unchecked HTTP JSON to `QuotaSummaryPayload`. The
transforms also call string methods on unchecked display names and bucket labels.
Introducing validation would change the existing malformed-input failures;
declaring those values as strings would promise checks that do not exist.
The client declaration stays paired with its unconverted implementation.
The warning's declaration accepts unchecked input, matching the web HTTP boundary
and the malformed-input tests, without promising string display names.
`index.ts` composes the remaining JavaScript exports through their inferred types
and returns the shared `QuotaResult` produced by `buildResult`. It does not declare
a checked provider payload or add validation to the remaining JavaScript.

`api.ts` forwards the account parser's `string | null` refresh token to the shared
`google/oauth.ts` exchange. Successful JSON passes through without a provider
shape check. Both quota requests return
`Promise<JsonValue>` using the shared quota JSON contract and the same JSON guard
as the Google provider. This checks the JSON vocabulary only and preserves null,
primitive and malformed provider payloads. No provider schema is implied by a
successful HTTP response.

VS Code's `quotaProviders.ts` HTTP boundary is its local
`fetchAntigravityQuotaSummary`: its `Promise<QuotaSummaryPayload | null>` return
comes from a cast rather than validation. An honest return type is `Promise<unknown>`
until that reader checks its payload. Checking display names there and at the web
HTTP boundary would allow a shared checked summary type, but would change the
current malformed-input failures. The transforms also receive unchecked model
data from the web HTTP boundary. These unchecked operations cannot acquire string
types merely because neighbouring implementations are TypeScript.

Correcting or exporting another server module's declared types cannot establish
these missing checks: `fetchAntigravityModels` and
`fetchAntigravityQuotaSummary` already return the honest `JsonValue` type.
Narrowing either return to a provider interface would contradict its unchanged
JSON pass-through behavior. No untyped helper or dependency declaration owns the
string operations, so helper conversion and dependency augmentation cannot resolve
this boundary either. VS Code's unchecked `QuotaSummaryPayload` cast supplies no
runtime evidence for a narrower shared client parameter.
