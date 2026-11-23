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

### Why the keyring is a first-class candidate source

The agy CLI's login lives in the keyring (Secret Service service `gemini`,
username `antigravity`), and the opencode fork's antigravity-auth bridge
reads it in place; on CLI-signed-in machines it is the only Antigravity
login, and the fleet's quota gatherer reads the pool through it. This
module's candidate set — accounts file and credential-store `google`
OAuth — never adopted it, so the server endpoint and the CLI reported a
working pool "Not configured" while the gatherer read it fine (code#2490).
`auth.ts` now resolves the keyring credential first, mirroring the fork's
candidate order (keyring, file, store) and its in-place read
(`secret-service.ts`, read-only, never written back), so every surface
resolves the same candidate set for the same machine. The keyring token is
Antigravity-issued by construction, so — like the accounts file — a
wrong-client rejection keeps the refresh-failure state; only store
candidates can reclassify as "Not configured". A failed keyring read adds
no candidate and manufactures no error state: the file and the store
still speak.


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
