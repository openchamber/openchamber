# Shared server helpers

## Purpose

`packages/web/server/lib/shared/guards.js` exposes the small value predicates and
coercions that several feature modules used to define privately. It is neutral:
it knows nothing about git, OpenCode, projects, or any other domain, and it
imports nothing. Consolidating the copies means a value can no longer be a
string on one route and not a string on another because two files spelled the
check differently.

Only the dominant, behavior-defining spelling of each guard belongs here.
Variants that answer differently for real inputs stay with their owner.

## Public exports

- `isString(value)`: `typeof value === 'string'`, a type predicate. True only
  for primitive strings, so a caller may use string methods on the value. Boxed
  `String` objects and objects with `Symbol.toStringTag` set to `"String"` are
  rejected: neither arrives through JSON, and the second has no string methods.
- `isPlainObject(value)`: true only for a plain `{}`-shaped object. Rejects
  `null`, arrays, boxed primitives, `Date`, `Map`, class instances, functions,
  and null-prototype objects (`Object.create(null)`).
- `isRecord(value)`: true for any non-null, non-array object. Accepts plain
  objects, class instances, `Date`, `Map`, boxed primitives, and null-prototype
  objects.
- `isBoolean(value)`: true only for a primitive boolean (`true` or `false`).
  Use it where a value crosses a JSON boundary and must be a real boolean, not
  the string `"true"`.
- Modules that call the predicate `isObjectRecord` import `isRecord` under that
  local name; the shared module exposes one canonical export.
- `asNonEmptyString(value)`: trims a string and returns it, or returns `null`
  when the input is not a string or is empty/whitespace after trimming. The
  `null` answer (not `''`) keeps "absent" distinguishable from "present".

## Behavior matrix

| input | `isString` | `isPlainObject` | `isRecord` / `isObjectRecord` | `isBoolean` | `asNonEmptyString` |
|---|---|---|---|---|---|
| `'s'` | true | false | false | false | `'s'` |
| `''` | true | false | false | false | `null` |
| `'  s  '` | true | false | false | false | `'s'` |
| `'   '` | true | false | false | false | `null` |
| `true` / `false` | false | false | false | true | `null` |
| `new Boolean(true)` | false | false | true | false | `null` |
| `new String('s')` | false | false | true | false | `null` (not a primitive) |
| `42` / `NaN` | false | false | false | false | `null` |
| `null` / `undefined` | false | false | false | false | `null` |
| `{}` | false | true | true | false | `null` |
| `[]` | false | false | false | false | `null` |
| `new Foo()` (class) | false | false | true | false | `null` |
| `new Date()` | false | false | true | false | `null` |
| `new Map()` | false | false | true | false | `null` |
| `Object.create(null)` | false | false | true | false | `null` |

## What stays out

These look adjacent but are not the same predicate, so each keeps its private
copy:

- `terminal/runtime.js` and `terminal/shells.js` use `String(value) === value`,
  which rejects boxed strings and throws on null-prototype objects.
- `guests/oauth.js`, `settings/settings-files.js`, and `opencode/config-files.js`
  expose a loose `isPlainObject` that uses `typeof value === 'object'` and so
  accepts values the strict predicate rejects. They keep their own name and
  shape; only modules asking for `isRecord` were migrated.
- `source-control/mutation-executor.js` accepts null-prototype objects under an
  `isPlainObject` name, and `github/mappers.js` /
  `github/repo/fork-detection.js` classify by `[object Object]`; all three are
  divergent and stay put.
- `quota/utils/transformers.js` exports an array-accepting `asObject`; it is not
  a guard for a record and is out of scope.
- `projects/project-config.js` owns its config normalization pipeline and keeps
  it local.

## Re-exported public APIs

The modules below keep their exported names and signatures and now re-export
the shared functions, so existing importers are unaffected:

- `opencode/config-v2.js`: `isRecord`
- `linear/parse.js`: `isString`, `isPlainObject`
- `gitlab/validation.js`: `isString`, `isPlainObject`
- `quota/utils/transformers.js`: `asNonEmptyString`

## Notes for contributors

- Add a predicate here only when two or more feature modules need the exact
  same behavior. If a caller needs a stricter or looser answer, keep the
  variant local and document the difference with its owner.
- Do not add feature imports to this module. It must stay free of domain
  dependencies so every runtime can safely depend on it.
- When a guard's answer changes, update the behavior matrix test beside this
  file; the test is the contract.

## Bounded mapping

`map-limited.ts` owns the identical worker loop used by Gitea and Gerrit resource
reads. `mapLimited(items, limit, task)` runs at most `limit` tasks at once and
returns results in input order. Callers supply a positive integer limit. A task
receives only its item. A rejection stops that worker and rejects the returned
promise; other workers continue taking items. It adds no retries or cancellation.

Provider-specific limits and error handling stay in the resource modules.
`map-limited.test.js` covers ordering, concurrency, empty inputs and failures.

### Why task inputs include undefined

The worker reads every index, including holes in sparse arrays, and passes that
value to the task. Its input type includes `undefined` to preserve this behavior
without skipping holes or asserting that an indexed item exists. The helper
imports nothing and reads only the supplied items, limit and task.

## Typed guards and parsers

`object-guards.ts` owns `isPlainObject`, `isRecord`, `isBoolean`, `isString`
and `asNonEmptyString`.
The JavaScript entry re-exports these functions themselves, preserving identity
for Linear, GitLab and OpenCode consumers. Unknown inputs narrow to
`Record<string, unknown>` or `boolean`. An already typed object uses a boolean
overload: retaining its existing shape avoids inventing unknown properties in a
discriminated union or replacing optional fields in a weak interface.

The dictionary lint rule permits unknown field values inside a type predicate
result because the predicate proves only the container. Ordinary dictionary
parameters, return values and storage contracts still require a value contract.

### Why parsers accept unknown input

`asNonEmptyString(value: unknown): string | null` parses arbitrary external
input. Its primitive-string check keeps non-string inputs away from `.trim()`.
The `allowInParsers` option in `anti-slop/no-unknown-parameters` and
`anti-slop/no-runtime-typeof` admits this boundary alongside type predicates.
The configured path pattern covers only TypeScript files directly in this
shared folder. A parser must be directly exported, take exactly one plain
`unknown` parameter and declare a union return containing `null`. Unknown and
any return branches, internal helpers, extra parameters and nested callbacks
do not receive the exception.

### Why the entry remains a JavaScript re-export

`guards.js` contains only re-exports from `object-guards.ts`, so callers retain
their import paths and function identity. The standalone Node fixture in
`fs/routes.test.js` already emits `object-guards.ts` and copies this entry.
Keeping the entry preserves that packaged-layout contract without changing
the filesystem module's fixture.

## HTTP and WebSocket contracts

`json-values.ts` describes decoded JSON and in-memory JSON documents that may
omit a property with explicit undefined. Settings and activity declarations use
that syntax-level vocabulary without claiming any field has been validated.
Markdown frontmatter remains unknown because YAML can decode other values;
the markdown writer accepts an enumerable metadata object and delegates value
serialization to YAML.

`http-contracts.ts` owns the shared structural Express contracts. The installed
Express package has no bundled declarations and `@types/express` is absent.
`express.d.ts` types its existing default factory, JSON middleware and router
without replacing the runtime import. Folder workers import request, response,
handler and app types from `http-contracts.js`. Requests expose unchecked JSON
and parsed query values; these contracts perform no validation.

`websocket-contracts.ts` owns the installed `ws` constructors, upgrade callback,
raw frame union and socket/server events. `ws.d.ts` connects the bare import to
those type-only contracts. Runtime constructors still import from `ws`.
Protocol arrays retain unchecked elements because `ws` validates
them itself. These declarations do not alter authentication, origins or transport.

`contracts.test.ts` exercises Express over HTTP and a WebSocket upgrade and
frames. The compiler includes ES2023 array declarations while retaining the
existing ES2022 emit target and browser web API types. Native fetch's explicit
undefined body and the DOM/Node `Readable.fromWeb` type mismatch remain separate
platform declaration boundaries.
