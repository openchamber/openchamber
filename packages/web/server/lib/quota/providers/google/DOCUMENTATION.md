# Google quota provider

## Ownership

This folder owns Google credential selection, quota requests, daily model windows
and the OAuth refresh shared with Antigravity and VS Code. OpenCode owns credential
storage. Shared quota utilities own credential normalization and window formatting.

## Invariants

- Credential aliases remain `google` and `google.oauth`. Nested OAuth objects take
  precedence, including arrays accepted by the shared object normalizer.
- Missing access and refresh tokens produce no source. Missing project context
  uses `rising-fact-p41fc`. Expiry remains a nullable timestamp.
- Quota reads preserve every JSON shape, including primitive responses and numeric
  overflow. Only the consumer checks whether buckets are an array. Model entries
  retain the existing `Object.entries` behavior for strings and arrays.
- Refreshes try Gemini first. Only HTTP 400/401 with `unauthorized_client` enables
  the optional Antigravity attempt. Credentials remain unchanged.
- Antigravity may forward a null refresh token. The exchange accepts it and
  retains URLSearchParams' `"null"` serialization without adding validation.
- Each request has a 15-second deadline. HTTP, JSON and transport failures retain
  their existing null or allowlisted OAuth failure results.

## Decisions

### Why HTTP readers return JSON values

Successful JSON decoding establishes no quota or model shape. The readers validate
the JSON value vocabulary without tightening numeric acceptance, and consumers
narrow the fields they use. Declaring model interfaces here would promise fields
the response has never checked. Validation uses a worklist so deeply nested,
valid JSON does not exhaust the JavaScript call stack.

### Why model reset dates have a local constructor overload

`transformModelData` passes an unchecked, truthy HTTP `quotaInfo.resetTime` directly
to `new Date`. JavaScript coerces booleans, arrays and objects, while TypeScript's
standard `DateConstructor` accepts only strings, numbers and Dates. For example,
`true` becomes timestamp 1 and an empty object becomes `NaN`. A string/number
validator or the shared `toTimestamp` helper changes this behavior.
`date-coercion.d.ts` augments the standard library's `DateConstructor` with the
JSON input vocabulary already forwarded at runtime. It adds no validation and
preserves invalid-date results and coercion failures.

Transforms narrow JSON containers before reading their fields. Primitive and
missing values retain their empty-window behavior. Model remaining fractions
still require a number, while quota buckets use the shared numeric-string parser.
Refresh-token parsing accepts unchecked credential fields through a schema whose
inferred result keeps every nullable token and project field.

### Why timeout detection uses a shape guard

Fetch and body reads can throw plain objects or functions with a timeout name.
The guard retains the name-based classification without requiring `Error` identity.

### Why installed-app client constants stay in source

Google's installed-app OAuth flow embeds its client ID and client secret in the
application, as described in the
[installed-app protocol](https://developers.google.com/identity/protocols/oauth2#installed).
These constants identify the application and are shared by the two refresh callers.
