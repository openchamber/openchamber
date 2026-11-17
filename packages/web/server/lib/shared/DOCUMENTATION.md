# Shared Guards Documentation

## Purpose

`packages/web/server/lib/shared/guards.js` holds the small value predicates and
coercions that several feature modules used to define privately. It is neutral:
it knows nothing about git, OpenCode, projects, or any other domain, and it
imports nothing. Consolidating the copies means a value can no longer be a
string on one route and not a string on another because two files spelled the
check differently.

Only the dominant, behavior-defining spelling of each guard belongs here.
Variants that answer differently for real inputs stay with their owner.

## Public exports

- `isString(value)`: `Object.prototype.toString.call(value) === '[object String]'`.
  True for primitive strings and boxed `String` objects. This is wider than
  `typeof value === 'string'`, which is why callers that only accept primitives
  keep their own `typeof` check.
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
| `new String('s')` | true | false | true | false | `null` (not a primitive) |
| `42` / `NaN` | false | false | false | false | `null` |
| `null` / `undefined` | false | false | false | false | `null` |
| `{}` | false | true | true | false | `null` |
| `[]` | false | false | false | false | `null` |
| `new Foo()` (class) | false | false | true | false | `null` |
| `new Date()` | false | false | true | false | `null` |
| `new Map()` | false | false | true | false | `null` |
| `Object.create(null)` | false | false | true | false | `null` |

## Atomic rename

`atomic-rename.js` holds the rename retry for atomic writes, shared by the
web server's temp-file-then-rename stores: agent-memory, project-context,
walkthrough, the git/GitHub/GitLab and source-control credential stores,
environment, linear, quota, routing, spaces, relay, guests, projects, and
the other persisted-state writers under `server/lib`. On Windows, renaming
a temp file over a destination another process is reading fails with `EPERM`
(also seen as `EACCES` or `EBUSY`), and giving up loses the write.

- `renameWithRetry(rename, source, destination)`: async; retries only those
  three codes with 10/25/50/100 ms delays, then surfaces the last error.
- `renameSyncWithRetry(renameSync, source, destination)`: the same policy
  for synchronous callers; the wait between attempts uses `Atomics.wait`.

The caller passes its own rename function, so a store that receives
`fsPromises` by injection keeps that seam. Every other error code throws on
the first attempt. Temp-file cleanup stays with the caller, which owns the
temp path.

## What stays out

These look adjacent but are not the same predicate, so each keeps its private
copy:

- `terminal/runtime.js` and `terminal/shells.js` use `String(value) === value`,
  which rejects boxed strings and throws on null-prototype objects.
- `guests/oauth.js`, `opencode/settings-files.js`, and `opencode/shared.js`
  expose a loose `isPlainObject` that uses `typeof value === 'object'` and so
  accepts values the strict predicate rejects. They keep their own name and
  shape; only modules asking for `isRecord` were migrated.
- `source-control/mutation-executor.js` accepts null-prototype objects under an
  `isPlainObject` name, and `github/routes.js` /
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

## Bounded-call primitives (design #802 phase 1, #803)

Three outbound-call primitives live here beside the guards, under the same
admission rule: the dominant, behaviour-defining spelling is shared, and a
variant that answers differently stays with its owner.

- `bounded-fetch.js` — `fetchWithDeadline(fetchImpl, url, init, { timeoutMs, signal, headersOnly })` and the exported `combineAbortSignals(signals) -> { signal, detach }` composition helper (the one shared copy; callers import it instead of re-implementing signal composition).
  A per-attempt deadline that **composes** with the caller's signal (either
  firing aborts the call; `AbortSignal.any` where available, a composed
  controller otherwise) and never replaces it — the gitlab
  `fetchWithTimeout` overwrite-and-clear-at-headers behaviour is the
  anti-pattern this replaces. By default the deadline stays armed until the
  response body has been fully read (the returned Response's body stream is
  raced against the deadline); `headersOnly: true` is the explicit opt-in
  to clear it when the headers arrive. Only the wrapped Response's status,
  headers and body are contractual; other Response metadata of the original
  is not carried over.
- `response-body.js` — `readBoundedResponseText` / `readBoundedResponseBytes` /
  `readBoundedResponseJson`
  (plus `discardResponseBody`). The cap is enforced **during** the read: a
  declared `content-length` over the cap refuses before reading, the stream
  is cancelled the moment the cap is crossed, and oversize is reported as
  `{ tooLarge: true }` — never a truncated body returned as complete.
  `readBoundedResponseJson` parses only a complete body and returns `null` for
  an over-cap, unreadable, or invalid JSON response, preserving the caller's
  existing failure policy.
  `guests/response-body.js` re-exports all three, so the guests importers
  keep working unchanged. Phase 2 (#804) pointed the two importers outside
  guests/ at this module directly (`opencode/proxy.js`,
  `opencode/mcpx-daemon.js`), and `opencode/model-discovery.js` /
  `opencode/theme-catalog.js` now compose `readBoundedResponseBytes` under
  their own error shapes instead of keeping private reader loops.
- `parse-int.js` — `parsePositiveIntWithDefault` and
  `parseBoundedIntWithDefault`. The strict plain-decimal judgement the eight
  private copies used to spell per module: optional surrounding whitespace,
  ASCII digits only, caller-supplied fallback for anything else (`'1e3'`,
  `'0x10'`, `'5000junk'`, `'5.9'`, `''`, `'-5'` never parse). The positive
  spelling requires a value above zero; the bounded spelling checks an
  inclusive `[min, max]` and lets `'0'` be a real value when the range
  allows it. Phase 2 (#804) migrated seven of the eight private copies
  (`fs/routes.js` and `guests/upload.js` through their `parsePlainDecimalInt`
  delegations, `fs/search.js`, `opencode/lifecycle.js`,
  `opencode/draining-opencode.js`, `relay/host-client.js`,
  `ui-auth/ui-auth.js`); call sites with no upper bound pass
  `Number.MAX_SAFE_INTEGER` as the max, which no safe-integer value can
  cross.

- `gitlab/network.js` `fetchWithTimeout` delegates to `fetchWithDeadline`
  (phase 2, #804), keeping its exported name and signature; its callers in
  `verify.js` and `device-flow.js` get the composed-signal, body-covering
  contract. `gitlab/client.js` keeps its own `deadlineSignal`: its retry
  policy has to tell a deadline abort from a caller abort (`timedOut()`),
  which the primitive does not expose, and its downloader bounds the wait
  for headers only because the body streams to the route caller.

### What stays out

- `opencode/self-handoff.js` `resolveHandoffTimeoutMs` (phase 2, #804):
  the strict parser with a timer bound. Its spelling judgement matches
  the shared spellings — plain decimal only, `Number.isSafeInteger` —
  so a digit string beyond the safe-integer range (26 digits, say)
  yields the fallback there too, not a huge value. What differs is the
  accepted range: 1 to 2_147_483_647 ms, because the value feeds a
  timer and a delay above Node's 2^31 - 1 ms maximum fires after ~1 ms
  instead; a larger configured timeout falls back to the 30 s default
  rather than killing every handoff successor immediately. It stays
  local for that bound — a property of the timer it feeds, not of the
  shared parser's caller-supplied range.
- Parsers that accept a sign, a fraction, or a non-decimal spelling: no
  shared copy accepts them, and a caller that truly needs one keeps a
  local, differently-named variant.
- Deadline policies (which timeout, retry, or backoff a call site wants):
  the primitive supplies the bound, the caller supplies the number.
- Domain-shaped readers and fetchers (quota, gitlab, proxy): they compose
  these primitives in phase 2 instead of moving here.

## Durable JSON store (design #976 phase 1, #977)

`durable-json-store.js` holds the one read/write contract for the web
server's JSON state files — the stores whose contents are user data,
credentials, or provenance. It composes `atomic-rename.js` and adds the
three pieces the per-store fixes of 2026-10-30 each hand-wrote: a strict
reader, a preserve-aside helper, and a mode-explicit atomic writer, each
in async and sync spellings, each taking the caller's fs surface by
injection. The contract rules:

1. **Three read states, never two.** `readDurableJsonFile` /
   `readDurableJsonFileSync` answer `missing | valid | malformed`, with
   the caller's value judgement (`isJsonObject` for an object-shaped
   store; a parsed value the predicate rejects is `malformed`). A
   read-only consumer may degrade `malformed` to its empty answer and
   says so at the call site; a read-modify-write cycle may never seed
   from a degraded read. An absent or empty file is `missing`; a read
   failure other than absence throws.
2. **Malformed is preserved before it is replaced — or the write
   refuses.** `preserveMalformedJsonFile` /
   `preserveMalformedJsonFileSync` rename the malformed file to
   `${file}.corrupt-${Date.now()}-${process.pid}-${random}` — the
   collision-proof spelling, so two preservations in the same
   millisecond both survive. The preserve step re-reads and re-judges
   the on-disk bytes first, re-judges them again after the
   preserve-name check, and verifies the preserved bytes after the
   rename — a valid replacement caught in any of those windows is
   restored to the live path atomically (hard link, never an
   overwriting rename) and answers `replaced`, and one that cannot be
   restored safely answers `failed`, so a concurrent writer's valid
   replacement is never renamed away; the result names the outcome (`preserved`,
   `replaced`, `missing`, `failed`), and `failed` is fail-closed: the
   caller must refuse its write. Raw parse errors are never logged or
   attached to a result — they can quote file contents.
3. **Writes are atomic and permission-explicit.**
   `writeDurableJsonFile` / `writeDurableJsonFileSync` require a stated
   integer `mode` (0o600 for secret-bearing stores) and write a unique
   temp file (pid + time + random) in the same directory, renamed over
   the destination via `renameWithRetry` / `renameSyncWithRetry`.
4. **Reads are bounded and regular-file-checked (#1649).** Every read
   in the module — both reader spellings and all three read points of
   both preserve spellings — goes through one handle-judged bounded
   read: open once with `O_NONBLOCK`, judge from the handle, enforce
   the cap in flight at cap+1 bytes. The cap is
   `DEFAULT_DURABLE_JSON_MAX_BYTES` (32 MiB, derived at its definition
   from the fifteen callers' write-side bounds, with headroom over the
   one unbounded caller, the session-metadata index) unless a caller
   passes `options.maxBytes`. An over-cap or non-regular file is a
   coded refusal (`DURABLE_JSON_STORE_TOO_LARGE` /
   `DURABLE_JSON_STORE_NOT_REGULAR`): the readers throw it (their
   existing read-failure branch — never `malformed`, never `missing`),
   and preserve answers `failed` at whichever read point refused.
   Where an injected fs surface has no handle API (the unit-test
   seam), the cap is enforced on the bytes its `readFile` returns.
5. **Both clock styles, fs injection preserved.** Async stores that
   receive `fsPromises` and sync stores both use the same contract by
   passing their fs surface in `options.fs`; no store loses its test
   seam, and the module imports nothing beyond platform APIs and
   `atomic-rename.js`.
6. **Divergent policies stay local and are named** (see below). The
   contract governs stores whose loss is the failure; policies that
   answer differently for real inputs are recorded, not redefined.

### What stays out

- `relay/key-store.js` — throw-and-stop: an identity file a human must
  repair ("fix or remove it, then retry"). Not migrated, not redefined.
- `agent-memory/runtime.js` — malformed is a failure and throws.
- `walkthrough/store.js` and the other caches (including
  `guests/service-registry.js`'s per-record drop) — corrupt is a cache
  miss and never throws; losing a cache is free.
- `opencode/settings-runtime.js` — the multi-writer shared
  `settings.json` with migration semantics of its own; folding it in is
  a settings-file decision, not a spelling migration. It is excluded
  from the phase-2 migration (#978) by name.
- Store shapes, defaults, serialization formatting, and domain error
  surfaces: the primitive knows paths, bytes, JSON and modes only, and
  callers keep the rest.

## Bounded file read (design #1254, #1256 and #1255)

`bounded-file-read.js` holds one handle-judged, byte-bounded read for files
whose caller owns the parse, retention and error policy. That includes
project and user files and append-only logs, as opposed to response bodies
(#802) and durable JSON stores (#976). It generalises
`skills-catalog/scan.js`'s `readSkillMdFile`, the family's one correct
embodiment. Phase 2 (#1255) migrated the call sites: scan's
`readSkillMdFile`, snippets' `parseMarkdownFile`, plugins'
`readPluginDirFile`, the guests entry-HTML read in `guestBuiltScriptsReady`,
git's `readFileDiffWorkingTreeFile`, and routing's `readPlanStore`,
`readPoolPlanLinks`, and `readFeedback` all read through this module now.
Each caller maps the coded outcomes back onto its own existing contract,
so error surfaces and missing-file behaviour are unchanged.

- `readBoundedFile(filePath, maxBytes, { fs } = {})` /
  `readBoundedFileSync(filePath, maxBytes)` answer identically:
  `{ ok: true, buffer, size }` for a complete read at
  or under the cap, or a coded refusal — `too-large` (carrying `path`,
  `size` and `limit`), `missing`, or `not-regular`. Unexpected I/O errors
  throw; the three expected outcomes never do. The async spelling defaults
  to Node's `fs.promises` and accepts an injected implementation so a store
  can use the same filesystem for its bounded read and write.

The contract (rules 1–5 of #1254):

1. Every read of a file whose size the reader does not control goes
   through this reader; the cap is stated at the call site (mechanism
   shared, values local — 1 MiB plugins, 4 MiB config/SKILL.md/snippets,
   the diff readers' larger caps all stay as they are).
2. Open once, judge from the handle: `O_NONBLOCK` where available,
   handle stat, non-regular files refused — never stat-by-path then
   read-by-path, which follows a symlink to a device or FIFO and races
   a growing file.
3. The cap is enforced during the read (at most cap+1 bytes are read),
   so a file that grows after the stat is over-cap, not buffered whole.
4. One uniform over-cap answer, coded `BOUNDED_FILE_TOO_LARGE` and
   carrying path, size and limit; the caller states its policy —
   `refuse`, or `skip`-with-warning. Truncation is not a policy: a
   truncated config or markdown file parses as a different file.
5. Sync and async spellings answer identically; missing ≠ over-cap ≠
   non-regular, so adopting the reader never changes a caller's
   missing-file behaviour.

### What stays out

- `diagnostics/local-files.js` — offset sampling of diagnostic logs is
  a sampling policy, not a bounded whole-file read; partial reads there
  are the point and stay.
- Response bodies stay `response-body.js` (#802): a stream is not a
  file, and its cap is enforced by cancelling the stream.
- Durable JSON stores stay on `durable-json-store.js` (#976): their
  preserve-on-malformed and atomic-write contract is separate. The routing
  plan maps keep their existing coded 409 errors through this reader, and
  append-only logs use their own retention policy. Since #1649 the durable
  store applies the same bound-and-judge discipline internally, so its
  exclusion is about disposition, not about the bound.
- Cap values, error surfaces and HTTP shapes at the call sites: the
  primitive knows paths, bytes and caps only.

## State-file reader inventory (design #1655 phase 2, #1656)

Every hand-rolled reader in `packages/web/server/lib` that reads one of the
server's own state files whole, re-grepped on main `8cc23ba52d`
(2026-11-05) — not the filing-day list. Each row is dispositioned against
both halves of design #1655 rule 2: the **bound** (open once, judge from
the handle, cap enforced in flight, non-regular refused) and the
**disposition** (#976's three states — missing / valid /
malformed-preserved; malformed never read as empty, never rewritten from
an empty base). "In place" below means a malformed file is left
byte-identical where it lies and the read refuses — preserved in place,
not preserved aside by rename as the durable store does. Stores on
`durable-json-store.js` are not rows here: they are **migrated** and
covered by phase 1 (#1649, closed; the bounded composition merged in
PR #1676) — client-auth pairing and remote-clients, dispatch-results,
magic-prompts, message-queue, notifications APNs and push runtimes,
openchamber-sessions archive and session-metadata, routing
route-settings and route-overrides (its JSON store), session-warming,
TTS voice-keys, tunnels managed-config (its main store), and UI
passkeys.

| Store (file — reader) | Sync/async | Bound half | Disposition half | Overall |
|---|---|---|---|---|
| routing store (`routing.json`, `routing-auth.json`, `classification.json`, `classifier-endpoint.json`, `auto-sessions.json` — `routing/store.js` `readJsonFile` / `readJsonFileSync`) | both | bound-complete (#1608): handle-judged `readBoundedFile` / `readBoundedFileSync`, per-file caps from write-side schema/runtime bounds, including sync startup reads | private: missing/empty → null; malformed/over-cap/non-regular config throws; auth, classifier, endpoint and Auto-session failures warn and return null/[] | conforming-on-both-halves |
| routing plans (`plans.json` — `routing/plans.js` `readPlanStore`) | sync | conforming: handle-judged `readBoundedFileSync`, 8 MiB cap | malformed / over-cap / non-regular → coded 409 `PLAN_STORE_MALFORMED` throw, in place; missing → empty | conforming-on-both-halves |
| pool plan links (`pool-plan-links.json` — `routing/pool-plan-links.js` `readPoolPlanLinks`) | sync | conforming: handle-judged `readBoundedFileSync`, 1 MiB cap | malformed / over-cap / non-regular → coded 409 `POOL_LINKS_MALFORMED` throw, in place; missing → empty | conforming-on-both-halves |
| Linear mapping (`linear-mapping.json` — `linear/mapping.js` `readStoredLinearMapping` + the `setStoredLinearMapping` re-read) | sync | none — covered-by-open-issue #1621 | malformed → coded `MALFORMED` throw, in place; empty → empty mapping | covered-by-open-issue (#1621, bound) |
| Linear session status (`linear/status.js` `readRecords`) | sync | none — covered-by-open-issue #1621 | malformed → coded `MALFORMED` throw, in place; records individually dropped | covered-by-open-issue (#1621, bound) |
| model choices (`model-choices.json` — `model-choices/store.js` `read`) | async | none — covered-by-open-issue #1610 | malformed → coded store error, never an empty history (a read-modify-write never seeds from it) | covered-by-open-issue (#1610, bound) |
| relay identity (`relay-identity.json` — `relay/key-store.js` `readStore`) | async | none — covered-by-open-issue #1614 | excepted: throw-and-stop, a human repairs the file (named under "What stays out" in the durable-store section above) | covered-by-open-issue (#1614, bound); disposition excepted-with-reason |
| managed OpenCode state (`state.json`, `draining.json` — `opencode/managed-opencode-state.js` `readManagedOpenCodeState` / `readDrainingOpenCodeRecords`) | sync | none — covered-by-open-issue #1622 | read-as-empty hazard: any failure → null / [], no distinction between missing and malformed | covered-by-open-issue (#1622, bound); disposition hazard recorded for phase 3 |
| merged settings, sync (`settings.json` + `preferences.json` — `opencode/settings-files.js` `readMergedSettingsSync`) | sync | none — covered-by-open-issue #1631 | read-as-empty by design on a read-only hot path (missing or unreadable contributes nothing); the settings family carries its own migration semantics (see the durable-store "What stays out" note) | covered-by-open-issue (#1631, bound) |
| skills installed sources (`skills-installed-sources.json` — `skills-catalog/installed-sources.js`) | sync | none — covered-by-open-issue #1627 | split: the lenient reader reads malformed as an empty map (read-only provenance badge); the strict for-update reader is three-state in place — missing → empty, malformed → coded `MALFORMED` throw (#936) | covered-by-open-issue (#1627, bound) |
| skills disk cache (`skills-catalog/disk-cache.js` `readDiskCache`) | sync | none — covered-by-open-issue #1627 | cache semantics: missing / unreadable / malformed → null (a cache miss) | covered-by-open-issue (#1627, bound); disposition excepted-with-reason (cache) |
| space records (`spaces/records/<id>.json` — `spaces/space-records.js` `read`) | sync | none — covered-by-open-issue #1628 | three-state by status: `missing` / `ok` / `unreadable`; an update refuses to write over an unreadable record; unreadable grants/setup fragments are dropped with a warning | covered-by-open-issue (#1628, bound) |
| tracked items (`tracked-items.json` — `tracked-items/persistence.js` `load`) | async | bound-complete (#1662, closed; PR #1837): handle-judged `readBoundedFile`, 8 MiB cap | cache restore: missing / non-regular / over-cap / wrong version / wrong shape → []; a file that does not parse as JSON throws and the restore failure is logged (the next save overwrites it); the file is a rebuildable cache, never the only copy | conforming-on-both-halves |
| quota auth files (`quota/utils/auth.js` `readJsonFile` and the `resolveConfigApiKey` `{file:}` read) | sync | bound-complete (#1645): handle-judged `readBoundedFileSync`, 1 MiB cap for the JSON credential/accounts files and 64 KiB for a `{file:}` apiKey target, caps enforced during the read, `O_NONBLOCK` so a FIFO is refused promptly | read-as-empty: any failure → null (read-only lookup of credential files the server never writes); over-cap / non-regular take the same null answer | conforming-on-both-halves |
| OpenCode service env (`service.json` — `environment/opencode-service-env.js` `readOpenCodeServiceEnv`) | sync | bound-complete (#1636): handle-judged `readBoundedFileSync`, 1 MiB cap enforced during the read, FIFO refused promptly | read-as-empty: any failure → {} (the OpenCode CLI's file, read-only) | conforming |
| environment store (`environment.json` — `environment/store.js`) | sync | conforming: `readBoundedFileSync`, 64 MiB cap derived from the write-side clamps at the read site (#1609, closed) | private three-state in place: a file that cannot be read or parsed is an error, never an empty store | conforming-on-both-halves |
| git identity store (`git/identity-storage.js` internal `readFile`) | sync | conforming: handle-judged, `MAX_STORE_BYTES` 4 MiB enforced in flight at cap+1 (#1635, closed) | malformed → coded invalid-store throw, in place; missing → empty state / legacy migration | conforming-on-both-halves |
| git network-operation and worktree-bootstrap stores (`git/network-operation-storage.js`, `git/worktree-bootstrap-storage.js`) | async | bound-complete (#1684): handle stat judges `size > maxBytes` (2 MiB) and regular-file before the read, the cap is re-enforced in flight by the chunked handle read (at most maxBytes + 1 buffered), and the open carries O_NONBLOCK on POSIX so a FIFO is refused promptly instead of wedging the serialized chain | malformed → coded invalid-store throw, in place; missing → empty state | conforming-on-both-halves |
| source-control stores (mutation / audit / binding `readState` — `source-control/*-storage.js`) | async | bound-complete (#1663, closed) via the family's gated reads | private: malformed → throw, never seeded from empty | conforming-on-both-halves |
| quota credentials store (`quota/credentials/store.js`) | sync | bound-complete (#1613, closed, PR #1671) | private strict read (the #907-pattern strict readers) | conforming-on-both-halves |
| GitHub auth store (`github/auth.js` `readState`, plus the shared `settings.json` read) | async | bound-complete (#1651, closed, PR #1666) | private strict read, malformed never read as empty | conforming-on-both-halves |
| settings runtime, async (`settings.json` / `preferences.json` — `opencode/settings-runtime.js`) | async | bound-complete (#1653, closed, PR #1673) | the settings family's own migration semantics (named exclusion in the durable-store section) | conforming-on-both-halves (bound); disposition excepted-with-reason |
| agent-memory and project-context stores (`agent-memory/runtime.js`, `project-context/runtime.js`) | async | bound-complete (#1607, closed) via the bounded reader | agent-memory is named under "What stays out": malformed is a failure and throws | conforming-on-both-halves |
| session folders (`session-folders/routes.js`) | async | bound-complete (#1623, closed) | private strict read | conforming-on-both-halves |
| session-goal objectives (`session-goal/objectives.js`) | async | bound-complete (#1582, closed) | private strict read | conforming-on-both-halves |
| Linear auth strict reader (`linear/auth.js`) | sync | bound-complete (#1615, closed) | three-state strict read (#907): malformed never read as empty | conforming-on-both-halves |
| guest extension and auth stores (`guests/` `readExtensionStore` / `readGuestAuthStore`) | async | bound-complete (#1620, closed) | private strict reads | conforming-on-both-halves |
| space archive entries (`spaces/space-archive.js` `readEntries`) | sync | bound-complete (#1639, closed); the module now reads through the bounded path | cache/startup semantics: an unreadable entry is skipped, not fatal | conforming-on-both-halves |
| space setting file (`spaces/space-setting-file.js`) | sync | conforming: the gate is judged on the opened file, not the path (#1659, closed) | private: over-gate or non-plain file is refused, not read as a setting | conforming-on-both-halves |
| git contributor-provenance store (`git/contributor-provenance-storage.js` `readState`) | async | none: the handle is judged (regular file, mode) but no byte cap is stated and `handle.readFile` buffers whole; the record count is capped only after parsing | private three-state in place: missing → empty, malformed → coded invalid-store throw | follow-up-filed (#1678) |
| managed SSH credential store (`git/ssh-credential-storage.js` `readState`) | async | none: same handle shape as contributor-provenance, no byte cap (credential-bearing) | private three-state in place: missing → empty, malformed → coded invalid-store throw | follow-up-filed (#1678) |
| GitLab auth store (`gitlab/auth-storage.js` `readState`) | async | none: plain `readFile` whole, no stat, no cap, no regular-file check (credential-bearing) — covered-by-open-issue #1677 (filed by the new-issue-creator job during this audit; this audit's own duplicate filing #1679 was closed in its favour) | private three-state in place: missing → empty, malformed / wrong version → coded invalid-state throw | covered-by-open-issue (#1677, bound) |
| guest extension storage documents (`guest-storage/<id>.json` — `guests/storage.js` `runGuestStorage`) | async | bound-complete (#1784): read through the shared `readBoundedFile` — the handle stat judges regular-file and `GUEST_STORAGE_TOTAL_BYTES` (2 MiB), the cap is re-enforced in flight (at most cap + 1 bytes read, so a file grown after the stat is refused, not buffered), and the open carries O_NONBLOCK on POSIX so a FIFO is refused promptly instead of wedging the serialized storage lock | malformed / schema-invalid throws out of the storage lock; missing → empty entries; over-cap → the size-limit error; non-regular → a coded not-a-regular-file refusal | conforming-on-both-halves |
| guest service registry records (`guests/service-registry.js`) | async | none, and none owed | excepted: ephemeral service-lifecycle records; a corrupt record is dropped by the reaper and hosts rewrite their own — losing one is free | excepted-with-reason (ephemeral registry) |
| walkthrough cache (`walkthrough/store.js` `readJson` + the pointer prune read) | both | bound-complete: handle-judged `readBoundedFileSync` / `readBoundedFile`, with the 4 MiB cap enforced during the read | cache semantics: missing / over-cap / non-regular / unreadable / corrupt all answer "no usable walkthrough"; pruning skips unreadable pointers and deletes only for a missing repository | bound-complete; disposition excepted-with-reason (cache) |
| managed-process registry (`<pid>.json` entries, `<pid>.claim-from-<owner>` — `opencode/managed-process-registry.js`) | both | bound-complete (#1736): handle-judged `readBoundedFileSync` / `readBoundedFile`, entry cap 64 KiB and claim cap 1 KiB enforced during the read, `O_NONBLOCK` so a FIFO is refused promptly | every failure answers "no claim / no owner", which is the safe answer for a liveness question; over-cap / non-regular files take the same safe-default / corrupt-file path as unparseable ones | conforming-on-both-halves |
| relay host lock (relay host claim — `relay/host-lock.js`) | sync | bound-complete (#1739): handle-judged `readBoundedFileSync`, 64 KiB cap enforced during the read, `O_NONBLOCK` so a FIFO is refused promptly; the write path likewise refuses to open a non-regular claim path | every failure answers no claim, which is the safe answer for a liveness question; missing / over-cap / non-regular / unparsable all take that same safe answer, exactly as missing and unparsable always have | conforming |
| mcpx daemon discovery (`daemon-*.json` — `opencode/mcpx-daemon.js`) | sync | bound-complete (#1773): handle-judged `readBoundedFileSync`, 4 KiB cap enforced during the read, `O_NONBLOCK` so a FIFO is refused promptly | every failure answers no daemon discovered, which is the safe answer for a discovery question; missing / over-cap / non-regular / unparsable entries are skipped, exactly as missing and unparsable always have | conforming |
| legacy named-tunnels migration source (`cloudflare-named-tunnels.json` — `tunnels/managed-config.js` legacy migration read) | async | conforming (#1692): bounded via the durable-store primitive, `LEGACY_NAMED_TUNNELS_MAX_BYTES` = `DEFAULT_DURABLE_JSON_MAX_BYTES` (32 MiB, the managed store's own bound), handle-judged with the cap enforced in flight, non-regular refused (O_NONBLOCK, so a FIFO cannot wedge the persist lock) | missing / empty → empty config, no write; malformed / over-cap / non-regular / unreadable → empty config with a warning, nothing written over anything, and no file content in the warning (the file holds tunnel tokens) | conforming-on-both-halves |
| Muse CLI login store (`quota/providers/meta.js`) | sync | bound-complete (#1774): handle-judged `readBoundedFileSync`, 64 KiB cap enforced during the read, `O_NONBLOCK` so a FIFO is refused promptly | missing / over-cap / non-regular / unreadable / unparsable stores have no usable Muse account token; token values and read errors are never logged or returned | conforming |
| foreign read-only files (Cursor token files — `quota/providers/cursor.js`; cloudflared user config — `cloudflare-tunnel.js`; enterprise machine policy — `enterprise-mode.js`) | both | none, and none owed in this inventory | excepted: files owned by another program or the machine administrator, read read-only and never written by the server; any failure degrades to "not configured / absent" (the enterprise policy reader names its three states — absent / ok / invalid — explicitly). The managed-config main store is durable (migrated), and its legacy migration source has its own row above (#1692) | excepted-with-reason (foreign-owned, read-only) |
| UI auth JWT secret (`ui-auth/ui-auth.js`) | sync | none, and none owed | excepted: a raw secret file, not a JSON store; it is read as bytes for a key, and no disposition question arises | excepted-with-reason (not a JSON store) |

Adjacent, deliberately not rows: project and user files (the #1254
family — `projects/project-config.js` stays covered by open #1490,
`opencode/npm-registry-config.js`'s `.npmrc` read by open #1654, and the
`fs/routes.js` reads by open #1605), repository and git-internals reads
(`git/service.js` and friends), system files (`/proc`, `/etc/shells`),
package manifests, and test fixtures (`spaces/code-in-bait.js`). They
are named so the inventory's edge is explicit, not silent.

### Append-only logs

| Log (reader) | Bound half | Disposition |
|---|---|---|
| event-stream replay (`global-replay.jsonl` — `event-stream/replay-store.js` `load`) | none — covered-by-open-issue #1632 | per-record: a torn final line ends the read, a malformed record mid-file discards everything after it with a warning |
| route feedback (`route-overrides-store.js` `readFeedback`) | bound-complete (#1624): handle-judged 4 MiB read cap; append compacts over-cap logs to the newest complete lines within 3 MiB | per-line: unparseable lines are dropped; missing reads as no feedback; over-cap / non-regular warns and reads as no learned choices. The store's JSON half is durable (migrated) |
| plan notes (`plan-notes.jsonl` — `routing/plans.js` `readNotes`) | bound-complete (#1638, closed, PR #1646): the notes read is bounded | per-line append-only semantics, as recorded on #1656 |

### VS Code mirror rows (mirror inventory — not audited as web code)

| Mirror reader | Coverage |
|---|---|
| bridge settings runtime (three shared files) | covered-by-open-issue #1641 |
| quota local-file readers (credential / auth / config) | covered-by-open-issue #1643 |
| `opencode.ts` `readOpenChamberSettings` (shared `settings.json`) | bound-complete (#1644, closed) |
| `openchamberSessionState.ts` (shared archive and legacy metadata files) | handle-judged regular-file reads capped at 32 MiB while reading; over-cap and non-regular files remain unknown and block writes (#1780) |

Phase 3 of design #1655 (migration shape, the append-only-log answer,
the VS Code mirror question, and a ratchet) is not decided by this
inventory; rows marked as hazards or private spellings stay on the
inventory until phase 3 answers them.

## Stream-output inventory (design #1740 phase 2, #1741)

Every incremental-stream consumer in `packages/web/server/lib` that turns
child-process or pipe output into text, re-grepped on main `2ca4d6df9`
(2026-11-07) — `data` handlers, `chunk.toString`, `+= chunk`,
`StringDecoder`, buffer-and-decode-once captures, and every `spawn` /
`execFile` site — not the filing-day list. Each row is dispositioned
against the four rules of design #1740: **(1)** stream-decoded
(`StringDecoder`, or buffered as bytes and decoded once), never per
chunk — forwarding counts as consuming; **(2)** every cap judged in the
unit its name claims (`*_BYTES` in bytes, `*_CHARS` in chars);
**(3)** matching/classification on completed lines or bounded rolling
text, never on chunk text; **(4)** flush (decoder end + held final line)
before settlement. Phase 1 (#1705, closed) has landed: the shared
accumulator lives at `lib/shared/bounded-output-accumulator.js`
(`createBoundedOutputAccumulator`, `BOUNDED_OUTPUT_MAX_CHARS` judged in
chars), and both tunnel modules import it — neither keeps a local copy.

| Consumer (file — site) | 1 Decode | 2 Cap unit | 3 Match on lines | 4 Flush before settle | Overall |
|---|---|---|---|---|---|
| cloudflare managed-tunnel readiness (`cloudflare-tunnel.js` `waitForManagedTunnelReady`) | conforming: shared accumulator per stream | conforming: `*_MAX_CHARS` rolling text, in chars | conforming: ready/fatal matched on completed lines only | conforming: `flush()` inspected on stream `end` and on `exit` (exit can precede end) | conforming-on-all-rules |
| cloudflare quick tunnel (`cloudflare-tunnel.js` `startCloudflareQuickTunnel`) | conforming: shared accumulator; the decoded text it forwards to the server log comes from the accumulator, not the chunk | conforming: `*_MAX_CHARS`, in chars | conforming: tunnel URL matched against bounded rolling `recentText`, never chunk text | n/a to settlement: readiness settles on the URL match or a timeout/exit error that carries no accumulated text | conforming-on-all-rules |
| cloudflare managed starters' stderr forwarding (`cloudflare-tunnel.js` `startCloudflareManagedRemoteTunnel` / `startCloudflareManagedLocalTunnel`) | per-chunk `chunk.toString('utf8')` forwarded to `process.stderr` — covered-by-open-issue #1734 | none (unbounded forwarding) | none (no matching on this text) | none | covered-by-open-issue (#1734, rule 1) |
| ngrok tunnel (`ngrok-tunnel.js`) | conforming: shared accumulator per stream; forwarded stderr is the accumulator's decoded text | conforming: `*_MAX_CHARS`, in chars | conforming: URL extraction and diagnostics on completed lines / rolling text | stdout and stderr flush on stream `end`; settlement on `exit` builds its error from `recentOutput` before that flush can run — covered-by-open-issue #1693; the stdout flush regression-test gap was #1694 (closed) | covered-by-open-issue (#1693, rule 4); rules 1–3 conforming |
| content-search ripgrep stdout (`fs/content-search.js`) | conforming: `StringDecoder`; parsed on completed lines, an unfinished line held as pieces | conforming: line cap `CONTENT_SEARCH_MAX_LINE_BYTES` counted with `Buffer.byteLength` | conforming: JSON events parsed per completed line only | conforming: `decoder.end()` piece is consumed on `close` before results settle | conforming-on-all-rules |
| content-search ripgrep stderr (`fs/content-search.js`) | per-chunk `chunk.toString` — covered-by-open-issue #1690 | byte-named `STDERR_MAX_BYTES` judged against string `.length` (chars) and sliced in bytes — covered-by-open-issue #1690 | none (diagnostic only) | none | covered-by-open-issue (#1690, rules 1–2) |
| dictation worker stderr (`dictation/local/worker-client.js`) | conforming: `StringDecoder` | conforming: tail cap `STDERR_TAIL_MAX_CHARS` in chars, and the tail slice skips a leading low surrogate so it never splits a pair | none (diagnostic tail) | conforming: `decoder.end()` remainder is appended to the tail on worker `close`, before exit handling | conforming-on-all-rules |
| dictation model tar extraction stderr (`dictation/local/model-downloader.js`) | per-chunk `chunk.toString()` appended to a string, tail-sliced in chars (can split a surrogate pair) — covered-by-open-issue #1695 | char slice against an unnamed 4096 bound; no byte-named cap | none (the tail is the failure message) | settles on `close` with whatever the per-chunk decode produced | covered-by-open-issue (#1695, rules 1–2) |
| guest service collector (`guests/service.js` `collectProcessOutput`) | per-chunk `chunk.toString('utf8')` — covered-by-open-issue #1696 | conforming in isolation: the cap is a `maxChars` parameter and is sliced in chars | none (snapshot diagnostic) | no decoder to flush; the snapshot can be taken before stream end by design (startup probe) | covered-by-open-issue (#1696, rule 1) |
| guest clone (`guests/clone.js`) | conforming: stdout buffered as bytes and decoded once on `close`; stderr kept as a byte tail and decoded once | conforming: stdout cap counted in chunk bytes; stderr tail `STDERR_TAIL_BYTES` kept in bytes | none (whole-output result) | decode-once is the flush: nothing is held by a decoder | conforming-on-all-rules (decode-once special case, rule 5) |
| environment command runner (`environment/runtime.js` `runCommand`) | conforming: `StringDecoder` | conforming: `MAX_COMMAND_OUTPUT_BYTES` counted in chunk bytes; over-cap kills the child | none (whole-output result) | conforming: result is `stdout + decoder.end()` on `close` | conforming-on-all-rules |
| fs exec route (`fs/routes.js` `/api/fs/exec` runner) | conforming: one `StringDecoder` per stream; a cap-truncated stream drops the decoder's held tail rather than flushing a cut character | conforming: `execOutputMaxBytes` counted in bytes per stream | none (output returned verbatim) | conforming: `flushDecoded` runs on both `error` and `close` settlement (skipped only where the cap already truncated) | conforming-on-all-rules |
| fs search / routes git check-ignore (`fs/search.js`, and the duplicated copy in `fs/routes.js`) | conforming: `StringDecoder` | none stated (git's own output for one directory's names; timeout-bounded) | conforming: names split from the completed decoded text | conforming: settles with `stdout + stdoutDecoder.end()` on `close` | conforming-on-all-rules |
| git untracked listing (`git/service.js` `listUntrackedFilesBounded`) | conforming: `StringDecoder` | conforming: the bound is a record count, applied per completed record | conforming: records split on `\0` from decoded text; a trailing partial record is held, never parsed early | conforming: `decoder.end()` remainder is pushed as the final record on `close` before finishing | conforming-on-all-rules |
| git worktree start command (`git/service.js` `execWorktreeStartCommand`) | conforming: chunks buffered as bytes, decoded once in the settle function | conforming with note: `START_COMMAND_MAX_BUFFER` counted in chunk bytes; a stream stops being *kept* once the count passes the cap but is still drained, so the kept bytes can exceed the cap by less than one chunk — the cap is a memory bound on kept output, not a refusal | none (whole-output result) | decode-once is the flush; settlement is on `close` (or the timeout path, which finishes only after the kill escalation) | conforming-on-all-rules (decode-once special case) |
| git network runner (`git/network-operations.js`, incl. the trusted-directories `git config` read) | conforming: chunks buffered as bytes, decoded once at settle (`Buffer.concat(...).toString('utf8')`) | conforming: `appendBounded` counts chunk bytes against byte-named limits and truncates the final chunk to the remaining bytes | none (whole-output result) | decode-once is the flush; settlement is on `close` | conforming-on-all-rules (decode-once special case) |
| git credential resolver runner (`git/credential-resolver.js` `runFile`) | conforming: chunks buffered, decoded once on `close` | none stated (ssh-keygen's own bounded output; deadline-bounded) | classification is the exit code, not output text | decode-once is the flush | conforming-on-all-rules (decode-once special case) |
| workspace file names (`fs/workspace-file-names.js`) | conforming: chunks buffered, decoded once on `close` | conforming: `maxOutputBytes` counted in chunk bytes; over-cap kills the child and yields no index | conforming: names split on `\0` from the completed decoded text | decode-once is the flush | conforming-on-all-rules (decode-once special case) |
| dev-server listener scan (`dev-servers/routes.js` `runCommand`) | conforming: `StringDecoder` (the #1691 fix) | conforming: `MAX_SCAN_OUTPUT_BYTES` counted with `Buffer.byteLength` | conforming: listener tables parsed from the completed decoded text | conforming: `decoder.end()` appended on `close` before the result is chosen | conforming-on-all-rules |
| spaces command runner (`spaces/run-command.js` `exec`) | conforming: chunks buffered as bytes, decoded once on `close`; the keep-tail window and the too-large gate both work on the buffered bytes | conforming: `maxOutputBytes` counted in bytes in both the gate and the tail window | none (whole-output result, plus a stderr file read back as bytes) | decode-once is the flush; settlement is on `close` | conforming-on-all-rules (decode-once special case) |
| spaces command stream (`spaces/run-command.js` `CommandStream` / `openCommandStream`) | excepted: stdout is forwarded as raw bytes to the place transport — no text is ever decoded from it, so there is no decode to corrupt; stderr is buffered as bytes and decoded once when a failure message is built | conforming: stdout counted in bytes (flow control only); stderr held under `STREAM_STDERR_BYTES` counted in bytes | none on stdout; the failure classification is the exit code/signal | stderr decode-once is the flush | excepted-with-reason (raw-byte forwarding, no text consumer) |
| `execFile` / `execFileSync` class (Node buffers the child's output whole and decodes it once; `maxBuffer` is a byte cap enforced by Node) — `git/service.js` runGitCommand and probe calls, `git/transport-config.js`, `skills-catalog/git.js`, `guests/service-registry.js` process probes, `terminal/shutdown.js`, `guests`/`opencode` registry and lifecycle probes, `environment/vault.js` (`op read`, output never logged), `opencode/cli-upgrade.js` (output deliberately discarded), `github/gh-cli-credential.js`, `gitlab/glab-credential.js`, `quota/providers/claude/auth.js`, `quota/providers/cursor.js` | conforming by construction: decode-once, performed by Node | conforming by construction: `maxBuffer` in bytes where set | per-site: version / token / listing parses run on the completed decoded output | decode-once is the flush | conforming-on-all-rules (decode-once special case, as a class; a site that outgrows `maxBuffer` semantics becomes its own row) |
| spawns with no output consumed (`stdio: 'ignore'` or `'inherit'`) — `opencode/v2-install.js` installer and tar extraction, `fs/routes.js` detached file-browser and Explorer launches, `git/ssh-wrapper.js` (stdio inherited by the terminal), `opencode/self-handoff.js` (stdio inherited; readiness arrives over IPC, not a pipe), `terminal/runtime.js` PTY provider (a byte stream handed to the terminal, never decoded as text by the server) | excepted: no pipe text is consumed — output is discarded, inherited by a terminal, or carried as PTY bytes | none owed | none | none | excepted-with-reason (no text consumer) |

### Body and stdin readers (recorded, not process output)

Whether body readers join this contract is design #1740's phase-3
question; the audit records these rows and decides nothing about them.

| Reader (file — site) | Decode / cap | Overall |
|---|---|---|
| gatekeeper control body (`spaces/gatekeeper-program.cjs` `readBody`) | per-chunk `text += chunk`; `CONTROL_BODY_BYTES` (1 MiB, byte-named) judged against string `.length` — a 1,200,037-byte body was accepted at filing | body-reader row — covered-by-open-issue #1727 (rules 1–2 as they would apply) |
| git credential broker request body (`git/credential-broker.js`) | conforming shape: chunks buffered, byte-counted against `MAX_BODY_BYTES`, decoded once on `end` | body-reader row — conforming shape, recorded only |
| git credential helper stdin + broker response (`git/credential-helper.js`); repository credential helper stdin + broker response, and its `child.stdout.pipe(process.stdout)` delegate forwarding (`git/repository-credential-helper.js`) | conforming shape: byte-counted against `MAX_INPUT_BYTES` / `MAX_BYTES`, buffered and decoded once (the delegate path forwards raw bytes undecoded) | body-reader row — conforming shape, recorded only |

Adjacent, deliberately not rows: HTTP response bodies (design #802's
family — bounded-fetch / `shared/response-body.js` and its per-site
relatives, including the APNs direct-request reader in
`notifications/apns-runtime.js`, which stream-decodes via
`setEncoding('utf8')` and counts its byte cap with `Buffer.byteLength`),
HTTP request uploads and downloads counted as bytes and never decoded
as text (`guests/install.js`, `guests/upload.js`,
`dictation/local/model-downloader.js`'s download, `routing/route-local-model.js`),
web/SSE response streams (`agent-tool/runtime.js` decodes a model
stream with a streaming `TextDecoder`; `realtime-proxy.js` and
`relay/tunnel-host.js` forward response bytes), socket and tunnel byte
forwarding (`dev-tunnel/*`, `spaces/websocket.js`, `spaces/dispatcher.js`,
`relay/tunnel-codec.js` — binary or protocol bytes, never decoded as
text), binary audio (`dictation/stream-manager.js` reorder buffer),
file-content streams (design #1254's family), and the generated
test-harness scripts embedded in `spaces/code-in-bait.js`,
`spaces/tools-filler.js` and `spaces/places/*` (strings the space
runner writes into a sandbox, not consumers in this server). They are
named so the inventory's edge is explicit, not silent.

### Mirror rows (record only — not audited as web code)

| Mirror consumer | Coverage |
|---|---|
| VS Code extension hand-rolled decoders | fixed per-site in #1558 / #1577 (closed); the per-runtime mirror is a phase-3 question |
| Electron main hand-rolled decoders | fixed per-site in #1590 (closed); the per-runtime mirror is a phase-3 question |

No follow-up issues were filed by this audit: every hand-rolled
consumer found violating a rule is already covered by an open issue
named in its row (#1734, #1690, #1695, #1696, #1693), and the one
body-reader violation is covered by #1727. Phase 3 of design #1740
(migration of the conforming hand-rolled decoders onto the shared
accumulator, the VS Code / Electron mirror, the gatekeeper body-reader
question, and a ratchet) is not decided by this inventory.

## Traversal budget (design #1391 phase 1, #1392)

`traversal-budget.js` holds the one counting core for recursive directory
walks over trees the server does not control — project trees, skills
roots, agent directories, a cloned catalog offered for install. It
replaces the three spellings the capped walks grew privately (a cap test
reading a BFS `visited` Set's size in `fs/search.js`, a `(maxDepth,
maxDirs)` parameter pair in `fs/routes.js` `findGitDirectories`, a
per-root counter and a threaded `{ visitedDirs }` object in
`opencode/agents.js`). Phase 1 (#1392) lands the primitive only; phase 2
(#1393) migrated the `fs/search.js` and `fs/routes.js`
`findGitDirectories` walks onto it with their values and behaviour
unchanged. The `opencode/agents.js` walks keep their spelling until
their own phase. The skill walks followed in #1465:
`opencode/shared.js` `walkSkillMdFiles` (5,000 directories, enumerate)
and `listSkillSupportingFiles` (5,000 directories and 5,000 files,
enumerate with the result's `truncated` flag read from the budget)
consult one budget object each, and their VS Code twins in
`opencodeConfig.ts` state the same budgets through the hand-mirrored
copy there.

- `createTraversalBudget({ maxDirs, maxEntries?, maxDepth?, deadlineMs? })`
  returns the one budget object a walk consults. `visitDir(depth?)`
  answers whether a directory may be entered, consulted **before
  descending**, and counts the directory when it is allowed;
  `visitEntry()` counts entries the same way. `visitedDirs` /
  `visitedEntries` expose the counters, `exhausted` whether a stopping
  dimension has been spent, and `truncated` whether any consultation has
  been refused — the enumerate disposition's signal. A refused
  consultation counts nothing, so repeated consultation after
  exhaustion keeps answering "stop" with no counter drift past the
  bound, and a walk that consumes exactly its bound and never consults
  again finishes with `truncated` unset. A directory past `maxDepth` is
  refused without consuming the directory count and without stopping
  shallower consultations.

The contract (rules 1–5 of #1391):

1. Every recursive directory walk over a tree whose size the walker
   does not control carries a named traversal budget. The budget's
   dimensions are stated where the walk is defined; values stay
   per-walk (100 / 5,000 / 50,000 are all legitimate and none changes
   under this design).
2. The budget counts what the walk consumes, not what it returns.
   Directories visited is the mandatory dimension — a results-only
   counter is vacuous on a directory-only tree (#1332). Entries seen
   and depth are optional dimensions where a walk's shape needs them;
   a deadline is an optional dimension for async walks only.
3. One budget object, one spelling. A followed link's directories
   count against the same budget as the root's — the budget is
   consulted per directory entered, however the walk reached it — so
   no link can expand a walk past its budget. Link policy (follow with
   an ancestor check, refuse, dedupe) stays per-walk.
4. Two named dispositions at the bound, chosen by what the walk
   produces. *Enumerate* (search, discovery, listing, index): stop,
   return what was found, and make the truncation visible to the
   caller — the result carries the signal, so no UI presents a partial
   list as complete. *Copy* (install): abort with a clear error and
   leave no partial destination — a partial copy is a corrupt install,
   not a partial result. Silently stopping and presenting the prefix
   as the whole is not a disposition of this contract. The budget
   supplies the counting and the signal; the disposition stays with
   the caller.
5. Sync and async walks answer identically, and web/VS Code twins
   state the same budget and disposition for the same walk. A sync
   walk is bounded by counts alone (it has no honest deadline) and
   must stop *at* the bound, not merely record passing it.

### What stays out

- Cap values: this module introduces no cap value for any real walk;
  each walk states its own where it is defined.
- The traversal itself: walks differ in ways callers depend on (BFS
  with a dedupe set, result order, per-entry symlink guards), so the
  budget is the shared part, never a universal walker function.
- Bytes: a walk's budget counts directories and entries, never bytes
  read from a file — file contents stay `bounded-file-read.js`
  (#1254), response bodies stay `response-body.js` (#802). A byte
  dimension belongs to the copy walk's phase, when its values have
  sizing evidence.
- The VS Code mirrors: the extension cannot import this module; its
  twins are hand-mirrored copies per walk, as with `bounded-file-read`,
  in the phase that migrates each walk.

## Notes for contributors

- Add a predicate here only when two or more feature modules need the exact
  same behavior. If a caller needs a stricter or looser answer, keep the
  variant local and name the difference in a comment.
- Do not add feature imports to this module. It must stay free of domain
  dependencies so every runtime can safely depend on it.
- When a guard's answer changes, update the behavior matrix test beside this
  file; the test is the contract.
