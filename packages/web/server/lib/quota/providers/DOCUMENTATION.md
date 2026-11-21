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
- Copilot reads only the premium-interaction snapshot. Fractional
  `quota_remaining` takes precedence over `remaining` when deriving spent credits,
  matching `CopilotUserQuotaInfo` in `microsoft/vscode-copilot-chat`.

## Decisions

### Why Codex reads the CLI token fields separately

The CLI's ChatGPT sign-in is usable when `auth.json` contains a nonblank
`tokens.access_token`. A missing account ID stays null. A signed-out CLI or
an API-key sign-in without `tokens` provides no fallback login. JWT claims
provide an optional display email only; decoding them does not verify the token.

### Why Copilot fields remain unknown

Copilot's HTTP payload and normalized credentials do not validate their fields.
The local field parsers preserve null, undefined, arrays, primitives and inherited
properties without copying or filtering them. Each numeric or string conversion
retains its existing acceptance rules. In particular, string `credits_used`
values are trimmed before numeric conversion so blank strings remain unavailable.

### Why MiniMax model names keep their native failure

`pickChatModel` checks only that a model name is truthy. The prefix test still
converts it with `String`, as `RegExp.prototype.test` did, and the text-model
match lower-cases it through `lowerCaseLabel`, which throws the original
`m.model_name.toLowerCase is not a function` for a truthy non-string.
`fetchQuota` returns that message to the caller as before. Count comparisons
treat a missing count as not positive, the result `null > 0` gave.

### Why MiniMax status fields remain unknown

The provider response does not validate their types. Declaring numeric codes or
string messages would promise more than the boundary checks. Both web and VS Code
use this same status mapping.

### Why Cursor JSON accepts non-finite numbers

`JSON.parse` accepts overflowing exponents such as `1e999` as infinity. The
JSON guard retains that acceptance; expiry checks and `toNumber` keep their
existing treatment of those numbers. A finite-number schema would change both
token refresh and meter fallback behavior.

### Why registry IDs retain null

The extension registry exposes nullable IDs in its entries and provider objects.
The dispatcher retains that contract, including nullable IDs and names in an
unsupported result. Result construction copies these fields without validation.
Built-in property lookup converts an ID to its JavaScript property key explicitly
and retains the own-property check, so inherited names remain unsupported.

Configuration failures skip only the failing provider. Pending requests remain
keyed by the original ID and are removed only when that same promise settles.
Claude owns its pending requests so the registry cannot join requests for
different homes; its reads still pass the registry's error normalization.

`getAuthEntry` and `normalizeAuthEntry` do not validate credential fields.
Credential readers narrow the fields they use.

### Why shared readers retain precise window fields

VS Code imports the Console, Mistral and Cursor summary readers directly. The
transformer's string-parser re-export resolves to its TypeScript owner, and the
formatter preserves its supplied percentage type. A shared reader's window
contract retains the numeric fields established by its own parsing, without
promising the same validation for other providers' windows.

### Why OpenCode Go response fields remain unknown

The object parsers establish only a non-null object, including arrays, without
copying it or checking its properties. Each optional field stays unknown until
the existing string, number, timestamp or nested-object check. Inherited fields
remain readable, matching the shared `asObject` contract.

Console meters retain fractional usage that the API-key usage endpoint floors.
An ended Go subscription may retain its product while omitting access; it keeps
the absent-subscription error. A captured Console failure keeps its unchecked
thrown value so the expired-key fallback preserves both its identity and its
truthiness rule.

### Why Zen fields remain unknown

The Console object parser accepts arrays and retains unchecked property values.
Pagination counts narrow only after the existing safe-integer check. The numeric
parser keeps its string check because blank strings are unavailable here, while
the shared numeric parser accepts them as zero. A nullish-only page-info guard
preserves property reads on primitives and inherited properties.

The formatter's percentage return type retains the supplied input type because
it copies that field unchanged. Zen windows preserve their known numeric or null
reset timestamps. The transformer's string-parser re-export points directly to
its TypeScript owner, retaining function identity while exposing its declaration
to VS Code without converting the JavaScript guards entry used by Node fixtures.

### Why unchecked provider fields remain unknown

The field predicates retain identity and inherited properties. A nullish-only
predicate preserves JavaScript property access on primitives; an object predicate
is used where the reader already called `asObject`, which also accepts arrays.
Neither predicate validates individual fields. Credential fields, numeric inputs
and timestamps narrow only at their existing parsing sites. NanoGPT retains its
existing response schema, including unavailable and degraded quota windows.

DeepSeek keeps number and string checks on the raw balance so a blank string
remains unavailable. Its parsed balance is already a number or null, so the
positive-balance filter needs only the null check. OpenRouter retains its
own-property period lookup after converting the JSON field to its property key;
inherited names remain unsupported. Mistral retains dictionary fallback and
truthiness checks. DeepInfra interprets a negative Stripe balance as spendable
funds and a positive balance as money owed, as documented by its account API.

### Why coding plan readers keep coercion and gift resets stay optional

The expiry pattern still tests the string form of the supplied value. A date
inside an array can match the pattern, but it cannot supply a text expiry.
This aborts the entire optional gift-reset read, keeping the quota windows
without attaching partial gift-reset metadata.

Kimi's legacy durations retain the original truthiness check and numeric
coercion. A numeric string can supply the duration; a nonnumeric truthy value
can produce `NaN`. Only the recognized time-unit strings select a multiplier.
The coding-plan unit lookup retains inherited keys and coerces counts only when
the lookup returns a truthy value. The resulting duration can be `NaN`.
Zhipu reads the merged OpenCode config without a working directory, so no
project layer participates. The provider's `options.apiKey` remains unchecked
until the shared resolver reads it.

### Why the internal OpenAI reader keeps raw window fields

The internal OpenAI reader copies unchecked percentages and window durations to
its result, and uses numeric coercion for reset timestamps. Its result type keeps
those copied fields unchecked. Only finite numeric percentages produce a derived
remaining percentage. The reader stays outside the dispatcher's numeric usage
contract.
