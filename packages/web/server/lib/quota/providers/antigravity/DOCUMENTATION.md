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
`api.js`, `client.js` and `transforms.js` remain JavaScript. The warning's
handwritten declaration assumes string display names, while VS Code's
`fetchAntigravityQuotaSummary` casts unchecked HTTP JSON to that shape. The
transforms also call string methods on unchecked display names and bucket labels.
Introducing validation would change the existing malformed-input failures;
declaring those values as strings would promise checks that do not exist.
The client declaration stays paired with its unconverted implementation.
`index.ts` composes the remaining JavaScript exports through their inferred types
and returns the shared `QuotaResult` produced by `buildResult`. It does not declare
a checked provider payload or add validation to the remaining JavaScript.

The shared `google/oauth.ts` export `refreshGoogleAccessToken` accepts only string
refresh tokens, while the existing account parser returns null for truthy
non-string refresh tokens and empty packed-token prefixes. `api.js` forwards that
null to the OAuth exchange.
Converting the wrapper requires its input and the neighbouring
`refreshGoogleAccessToken` and `exchange` inputs to accept `string | null`,
preserving the existing URLSearchParams coercion of null.
The OAuth contract remains outside this folder's assignment.

VS Code's `quotaProviders.ts` HTTP boundary is its local
`fetchAntigravityQuotaSummary`: its `Promise<QuotaSummaryPayload | null>` return
comes from a cast rather than validation. An honest return type is `Promise<unknown>`
until that reader checks its payload. Checking display names there and at the web
HTTP boundary would allow a shared checked summary type, but would change the
current malformed-input failures. The transforms also receive unchecked model
data from the web HTTP boundary. These unchecked operations cannot acquire string
types merely because neighbouring implementations are TypeScript.
