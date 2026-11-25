# Review of `docs/design-install-auth.md`

Reviewed `plugins/opencode-antigravity/docs/design-install-auth.md` against `docs/decisions.md`, `docs/design-sessions-runtime.md`, T3 Code's `app.asar` and cached `agy` 1.5.15 binary, OpenCode 2.3.0 packages under `node_modules/.bun/`, OpenChamber's provider settings UI, and the prototype in `src/`.

Findings: 3 blockers, 7 major, 7 minor.

## Blockers

### IA-1: `authorize()` acquires `auth.lock` before superseding an in-process pending login

- **Severity:** blocker
- **Doc section:** 10.2 (`authorize()` sequence), 10.4 (Timeouts, concurrency, cleanup)
- **What is wrong:** Section 10.2 puts `auth lock (waitMs 0)` at step 2 and `pending login in this process -> supersede it` at step 3, while Section 10.4 states `auth.lock` is held from step 2 until `callback` finishes or the 5-minute abandon timer fires. When a user clicks Cancel in OpenChamber and clicks Connect again in the same OpenCode process, the old pending login still owns `auth.lock`. Step 2 hits `EEXIST` with `waitMs: 0` and throws `Sign-in is already in progress in another OpenCode window.` before step 3 can ever run. Retry after Cancel is broken for 5 minutes.
- **Evidence checked:** `docs/design-install-auth.md` lines 404 to 407 and 460 to 461; `packages/ui/src/components/sections/providers/ProviderOAuthMethods.tsx` lines 80 to 85 and 292 to 297, where Cancel calls `integration.oauth.cancel`, and `@opencode/core/dist/chunks/app-3hm8m6zg.js` lines 308 to 321, which closes the attempt scope with no cancel callback to the plugin.
- **Suggested fix:** Serialize `authorize()` calls in-process with a mutex. Inside that mutex, if a pending login exists in this process, kill its child, clear its abandon timer, wait for its cleanup to release `auth.lock` (or transfer lock ownership via a new in-process generation token while retaining the `DirLock`), and only then acquire `auth.lock` if not already held. Guard the old `callback` and abandon timer with a login attempt id so the superseded attempt never releases the new attempt's lock or `hold("login")`.

### IA-2: Re-pasting into the same OAuth attempt after bad input is impossible in OpenCode 2.3.0 `code` mode and leaks resources

- **Severity:** blocker
- **Doc section:** 10.3 (`callback(code)`), 10.4 (Timeouts, concurrency, cleanup)
- **What is wrong:** Section 10.3 step 2 instructs `checkLoginResponse` to throw `Paste the code from the Antigravity page, or that page's full address.` without touching `agy`, so the user can paste again in the same attempt. That contradicts both OpenCode 2.3.0 and OpenChamber, and conflicts with step 9's `finally` block at line 448. In `code` mode, any rejection from `callback(code)` permanently fails the OAuth attempt in OpenCode and unmounts the code input box in OpenChamber. If the plugin skips cleanup on validation failure, the `agy acp --login` process, run dir, `hold("login")`, and `auth.lock` remain leaked for up to 5 minutes, blocking other OpenCode windows and, combined with IA-1, blocking retries in the same window.
- **Evidence checked:**
  - `@opencode/core/dist/chunks/app-3hm8m6zg.js` lines 502 to 529: `Integration.oauth.complete` marks `completing: true` before invoking `callback(input.code)` and calls `settle(input.attemptID, exit)` on failure, which moves the attempt to `status: "failed"` and closes `attempt.scope` (lines 227 to 237). Any subsequent `complete` call hits `if (attempt.status !== "pending") return;` at line 515.
  - `@opencode/plugin/dist/promise/adapter.js` lines 311 and 317 to 320: only `mode: "auto"` `submit` preserves an attempt on rejection; `mode: "code"` `callback` settles the attempt.
  - `packages/ui/src/components/sections/providers/ProviderOAuthMethods.tsx` lines 253 to 273: `submitCode` catches any error and transitions `flow` to `{ phase: "failed" }`, clearing `activeAttemptRef.current` and replacing the input with a Try again button.
  - `docs/decisions.md` line 22 locks `code` mode.
- **Suggested fix:** Remove the "without touching agy, so the user can paste again in the same attempt" requirement. Run `checkLoginResponse` inside the `try / finally` block so invalid input always kills the child, removes the run dir, releases `hold("login")`, and releases `auth.lock`. Update the validation error text to tell the user to start sign-in again.

### IA-3: `Integration.Service` is per-location in OpenCode 2.3.0, while `AuthManager` is a process-global singleton

- **Severity:** blocker
- **Doc section:** 11.1 (Trigger), 12.1 (Signed out mid-session), 12.2 (Re-auth), 13.3 (Sinks)
- **What is wrong:** `AuthManager` is a process-global singleton under `Symbol.for("openchamber.opencode-antigravity.auth.v1")`, and calls `ctx.integration.get({ integrationID: "antigravity" })`, `ctx.integration.connection.active("antigravity")`, and `ctx.integration.connection.status(...)`. The design treats `ctx.integration` as a single global handle. In OpenCode 2.3.0, `Integration.Service` is a per-location service with an in-memory `statuses` map per project directory, and each plugin `setup(ctx)` receives a `ctx.integration` bound to that location's fiber scope. With a single stored `ctx.integration`:
  1. Setting or clearing `needs_auth` updates only one location; every other open project location, including the one OpenChamber Settings queries via `opencodeClient.getDirectory()`, keeps stale status.
  2. When that first location is evicted or reloaded, its `ctx.integration` belongs to a disposed scope and subsequent calls fail.
  3. A new location opened while `AuthManager` is already `signed_out` starts with an empty `statuses` map and displays Connected.
  4. `ctx.integration.get({ integrationID: "antigravity" })` returns `{ location, data: IntegrationInfo }`, and rejects with `IntegrationNotFoundError` if `"antigravity"` was not registered; the doc assumes a direct `IntegrationInfo` result.
- **Evidence checked:**
  - `@opencode/core/dist/chunks/app-3hm8m6zg.js` lines 124 and 565: `const statuses = new Map;` inside `makeLocationNode({ service: Service85, ... })`.
  - `@opencode/plugin/dist/promise/adapter.js` lines 126 to 136, 177 to 183, 278, 332 to 336: `adaptApiMethod` returns the full `Location.response(Integration.Info)` (`{ location, data }`) because `Location.response` has two properties (`location` and `data`), and `connection.*` runs inside the location's captured `runtime`.
  - `packages/ui/src/lib/opencode/integration-catalog.ts` lines 36 to 38 and 49 to 56: Settings queries `integration.list()` scoped to the active directory.
- **Suggested fix:** Have `AuthManager` track a set of live location handles registered in `setup(ctx)` and removed in `setup`'s cleanup function. Fan out `connection.status(...)` writes to every registered handle (ignoring failures from closing locations), push the current `signed_out` status to any newly attached location in `setup`, try registered handles in order for `connection.active` reads, and unwrap `.data` from `ctx.integration.get` while catching `IntegrationNotFoundError`.

## Major

### IA-4: Contract mismatches with `docs/design-sessions-runtime.md`

- **Severity:** major
- **Doc section:** 3 (Configuration), 6.3 (Download), 8 (Messages a user sees), 13.3 (Sinks), 15 (Interfaces to the runtime design)
- **What is wrong:** Several requirements that `design-install-auth.md` relies on are absent from or conflict with `docs/design-sessions-runtime.md`:
  1. Section 15 adds three methods to `InstallAuthBridge` (`beforeSpawn()`, `reportAuthenticated()`, `reportSignInRequired(message)`), calling them "two additions marked new", while `design-sessions-runtime.md` Section 9 (lines 704 to 721) and Section 3.2 (lines 105 to 109) define and call none of them.
  2. Section 6.3 and Section 8 expect the runtime to emit the SSE status note `Downloading Google's Antigravity CLI (<n> of <m> MB). This happens once.` from `BinaryManager.status()`. `InstallAuthBridge` has no status or progress method, and `design-sessions-runtime.md` Section 3.2 step 6 and Section 6.3 only emit a generic startup note.
  3. Section 15 lines 617 and 637 assume the runtime's `AcpClient` detects `AUTH_URL_STDOUT_PREFIX` (`Open the following link to authenticate the ACP server: `) on stdout, throws `SignInUrlLineError`, and kills that process generation. `design-sessions-runtime.md` never mentions `SignInUrlLineError` or `AUTH_URL_STDOUT_PREFIX`, and `src/acp-client.ts` lines 359 to 362 silently discard non-JSON stdout lines. Note also that T3 Code checks both stdout and stderr for that prefix.
  4. Section 13.3 relies on the runtime's proxy to enforce the `Authorization: Bearer agy-managed` gate; `design-sessions-runtime.md` Sections 8 and 9 never mention this gate.
  5. Section 5 line 200 runs `verifyAgy` on `binaryPath`, which requires `agentInfo.name === "Antigravity ACP Server"`, `agentCapabilities.auth.logout`, and `authMethods` containing `oauth-personal`. `design-sessions-runtime.md` Section 11 (line 768) specifies `test/fixtures/mock-agy.ts` without those three fields, which would break every runtime E2E test that injects the mock via `binaryPath`.
  6. `design-sessions-runtime.md` Section 10 line 760 delegates `proxyPort` to the install/auth design, while `design-install-auth.md` Section 3 omits `proxyPort`.
- **Evidence checked:** `docs/design-install-auth.md` lines 108 to 135, 241, 341, 558, 593 to 639; `docs/design-sessions-runtime.md` lines 103 to 110, 491 to 498, 699 to 731, 760, 768; `src/acp-client.ts` lines 357 to 362; T3 Code `server-8K5Ixyrs.mjs` lines 12791 to 12843.
- **Suggested fix:** Reconcile `InstallAuthBridge` and both docs before implementation: add `beforeSpawn`, `reportAuthenticated`, `reportSignInRequired`, and a `binaryStatus()` or `onDownloadProgress` hook to `design-sessions-runtime.md` Section 9; add `SignInUrlLineError` (checking both stdout and stderr) and the proxy auth gate to the runtime doc; update `mock-agy.ts` in runtime Section 11 to satisfy `verifyAgy`; assign `proxyPort` to `config.ts` in one place.

### IA-5: Streaming `tar.gz` extractor contradicts itself and misses key tar validation checks

- **Severity:** major
- **Doc section:** 6.4 (Extract)
- **What is wrong:** Section 6.4 has an internal contradiction and omits required tar parsing defenses:
  1. Bullet 4 requires refusing a second regular file and trailing garbage before the two zero blocks, while bullet 5 says the parser "stops at the end of the entry". Stopping at the end of the first entry skips the rest of the archive, so a second entry, trailing non-zero blocks, or a corrupt gzip CRC32/ISIZE trailer go undetected.
  2. The parser ignores the POSIX `ustar` `prefix` field (bytes 345 to 499). An entry with `name = "antigravity"` and `prefix = "../evil"` or `prefix = "/etc"` would pass a name-only check on bytes 0 to 99.
  3. Header checksum verification (bytes 148 to 155, unsigned byte sum with checksum field as spaces) is omitted.
  4. Skipping PAX `x`/`g` and GNU `L` headers "only to apply a long name" leaves three gaps: PAX `x` can also carry a `size` override, PAX `g` applies globally to every later entry, and no byte cap is specified on PAX/`L` payloads.
  5. No cap is placed on total decompressed bytes after the entry (e.g. a gzip stream of gigabytes of zero blocks after a valid file would spin CPU until EOF).
  6. A 0-byte executable is not explicitly rejected (T3 Code checks `extractedBytes === 0`).
- **Evidence checked:** `docs/design-install-auth.md` lines 246 to 254; T3 Code `server-8K5Ixyrs.mjs` lines 17780 to 17803.
- **Suggested fix:** Continue reading after the entry's 512-byte padding until the two zero blocks and gzip stream EOF so `zlib.createGunzip()` validates CRC32/ISIZE and any second entry or non-zero trailing block is rejected. Enforce a total decompressed cap (512 MiB + 1 MiB margin), verify header checksums, reject any non-empty `ustar` `prefix`, reject `NUL` or `\` in names and 0-byte executables, cap PAX/`L` metadata at 64 KiB, and reject PAX `size` overrides or unsupported `g` headers.

### IA-6: Download redirect, scheme, `Content-Encoding`, and header-stall gaps

- **Severity:** major
- **Doc section:** 6.2 (Manifest), 6.3 (Download)
- **What is wrong:**
  1. Both sections check only the final `response.url` host (`antigravity-cli-auto-updater-...` and `storage.googleapis.com`), with no `protocol === "https:"` or port check. A redirect to `http://storage.googleapis.com/...` passes the host check.
  2. Using `fetch(url, { redirect: "follow" })` lets a compromised server or MITM redirect through an internal or foreign URL (such as `http://127.0.0.1:...` or cloud metadata endpoints) before the final host check runs.
  3. `downloadAsset` checks `Content-Length` against received bytes and feeds `response.body` into SHA-512, without sending `Accept-Encoding: identity` or rejecting a `Content-Encoding` header. If the server or a proxy sends `Content-Encoding: gzip`, `fetch` transparently decompresses the body, breaking both the `Content-Length` check and the SHA-512 digest.
  4. `downloadAsset` does not reject `Content-Length > 512 MiB` before streaming, and does not state whether the 60 s stall timeout applies while waiting for initial HTTP response headers (leaving a silent TCP hang to wait the full 30 min total timeout).
- **Evidence checked:** `docs/design-install-auth.md` lines 225 and 236 to 239.
- **Suggested fix:** Use `redirect: "manual"` with a hop limit (at most 5), validating the full `origin` (`https://` scheme, exact hostname, default port) on every redirect target before following it. Send `Accept-Encoding: identity`, reject responses carrying `Content-Encoding`, validate `Content-Length` up front against the 512 MiB cap and `> 0`, and arm the 60 s stall timer before awaiting `fetch()` response headers.

### IA-7: Cross-process directory lock races, async `exit` bug, and laptop-sleep false takeover

- **Severity:** major
- **Doc section:** 6.6 (Locking)
- **What is wrong:**
  1. **Startup window between `mkdirSync` and `owner.json`:** `mkdirSync(lockDir)` runs before `owner.json` is written (and `owner.json` write is not specified as atomic). Another process polling in that gap sees `EEXIST` and gets `ENOENT` or a partial JSON read on `owner.json`. The spec does not define how contenders handle missing or unreadable `owner.json`; treating it as stale steals a live lock.
  2. **Async `release()` on `process.on("exit")`:** `DirLock.release()` returns `Promise<void>`, yet line 290 says it is called on `process.on("exit")`. Node and Bun drop pending async work inside `exit` handlers, so the lock stays behind on exit. Registering an `exit` listener per lock without removing it on normal release also leaks listeners.
  3. **Release TOCTOU:** Checking `owner.json.token` and then removing `lockDir` can delete a different process's lock if the lock was taken over between the read and the `rm`.
  4. **Laptop sleep breaks `now - mtime > staleMs`:** Line 289 marks a lock stale when `now - mtime > staleMs` OR the same-host PID is dead (`ESRCH`). After a 35-second laptop sleep during a download, another waking process sees `now - mtime > 30 s` before the holder's heartbeat fires and steals the lock from a live local PID, allowing two processes to mutate `versions/` and `active.json` concurrently.
  5. **Windows directory `utimes`:** Calling `utimes` on a directory fails with `EPERM` on Windows under some Node/Bun builds.
  6. **35-minute lock wait vs OpenCode's 5-minute `headerTimeout`:** A chat request calling `resolveBinary()` while another window downloads waits up to 35 minutes, exceeding OpenCode's 5-minute `headerTimeout` (`design-sessions-runtime.md` Section 1 line 30), and `BinaryManager.status()` has no `"waiting_for_lock"` phase.
- **Evidence checked:** `docs/design-install-auth.md` lines 274 to 293 and 347; `docs/design-sessions-runtime.md` line 30.
- **Suggested fix:**
  - Write the owner file atomically (`wx`) as `owner-<token>.json` inside `lockDir`, and treat missing or invalid owner files as non-stale until `now - dirStat.mtimeMs > staleMs`.
  - Release by unlinking only `lockDir/owner-<ourToken>.json` followed by non-recursive `rmdirSync(lockDir)` (synchronously, so both `release()` and `process.on("exit")` use the exact same code, and deregister the `exit` listener on release). If another process already replaced `lockDir`, `unlink` fails with `ENOENT` and `rmdirSync` fails with `ENOTEMPTY`, so a foreign lock can never be deleted.
  - On the same hostname, require `ESRCH` (dead PID) or a much larger grace window before declaring a live PID stale, or bump `staleMs` and check `process.kill(pid, 0)` before stealing a same-host lock.
  - Touch `owner-<token>.json` (or a `heartbeat` file inside `lockDir`) for the heartbeat so it works on Windows too.
  - Document `BinaryManager.status()` while waiting on the cross-process lock, and let `resolveBinary()` accept a caller-specified lock wait budget (or emit SSE progress while waiting).

### IA-8: Logout races with login, triggers unwanted binary downloads, and can leave `beforeSpawn()` stuck

- **Severity:** major
- **Doc section:** 11.1 (Trigger), 11.2 (Sequence), 13.1 (State), 15 (Interfaces to the runtime design)
- **What is wrong:**
  1. **Logout clobbers a new login:** Removing the last credential starts a 500 ms debounce (`onCredentialChanged`). If the user clicks Connect within those 500 ms, `authorize()` transitions to `login_pending` and takes `auth.lock`. When the debounce fires, `connection.active` is still `undefined`, so `logout()` runs step 1 (`state = logging_out`, overwriting `login_pending`) and then blocks or fails at step 2 (`auth.lock`, `waitMs: 10 s`).
  2. **Stuck `logging_out` state:** Step 1 sets `state = logging_out` before acquiring `auth.lock` in step 2, with no `try / finally` resetting `state` if step 2 fails. A failed lock acquisition leaves `beforeSpawn()` waiting indefinitely.
  3. **Download during logout:** Step 6 spawns `agy acp` (kind `logout`) without stating how the binary is resolved. Calling `resolveBinary()` when no binary is installed would start a 230 MB download just to sign out.
  4. **Double `runtime.stop("auth-changed")`:** Section 11.2 step 3 emits `onAuthChanged({ reason: "logout" })` (which triggers `pool.stop("auth-changed")` in `design-sessions-runtime.md` Section 9 line 727), and step 4 immediately calls `await runtime.stop("auth-changed")`. Neither doc specifies that `AgyProcessManager.stop()` returns the in-flight stop promise when already in `stopping`. If the second call returns early, step 6's `agy acp` logout process runs concurrently with the exiting pooled `agy` process on the same profile.
  5. **`beforeSpawn()` state ambiguities:** Section 15 line 606 says `beforeSpawn()` waits during "logout or login finalization" and rejects while `signed_out` after logout. Section 13.1 has no `login_finalizing` state (only `login_pending`, which lasts up to 5 minutes while waiting for paste). Also, rejecting while `signed_out` without re-reading `auth-epoch` first would permanently reject spawns in this process even after another OpenCode process signs back in.
- **Evidence checked:** `docs/design-install-auth.md` lines 476 to 502, 533 to 548, 563, 606 to 607, 618; `docs/design-sessions-runtime.md` line 727.
- **Suggested fix:**
  - Skip `logout("credential-removed")` in `onCredentialChanged()` when `state.kind === "login_pending"` or `"logging_out"`, and wrap `logout()` in `try / finally` so `state` always exits `logging_out` and unblocks `beforeSpawn()` waiters.
  - Resolve an existing binary without downloading (`resolveExistingBinary()`) in step 6; if none exists, go straight to the isolated-mode token file deletion fallback.
  - Specify `AgyProcessManager.stop()` as idempotent and promise-sharing while `stopping`, and have `logout()` own the `await runtime.stop("auth-changed")` call (or let `onAuthChanged` wait for listeners).
  - Track login finalization separately from the 5-minute paste wait, and have `beforeSpawn()` check `authEpoch()` before rejecting on `signed_out`.

### IA-9: Proxy gate must require both `x-antigravity-proxy-token` and `Authorization: Bearer agy-managed`

- **Severity:** major
- **Doc section:** 13.3 (Sinks)
- **What is wrong:** Section 13.3 says a `/v1/*` request without `Authorization: Bearer agy-managed` returns 401 `auth_required`, and `x-antigravity-proxy-token` "stays the proxy's own access check". In the current prototype (`src/proxy.ts` lines 300 to 308), `isAuthorizedApiRequest` uses OR logic: it accepts either `x-antigravity-proxy-token` matching `apiSecret` OR `Authorization: Bearer <apiSecret>`. Because `agy-managed` is a hardcoded public constant, any local process can send `Authorization: Bearer agy-managed`. If an implementer leaves OR logic in place or substitutes `agy-managed` into the existing check, the proxy's loopback auth secret is bypassed. Conversely, if `GET /v1/models` is called without the `model.request` hook, requiring `x-antigravity-proxy-token` on `/v1/*` must also be clear.
- **Evidence checked:** `docs/design-install-auth.md` line 558; `src/proxy.ts` lines 300 to 308 and 330 to 348; `src/index.ts` lines 157 to 175; `@opencode/core/dist/chunks/app-36g6rx54.js` lines 282 to 295 and 345.
- **Suggested fix:** Explicitly state that `/v1/*` enforces two independent checks in order, both required (AND): first verify `x-antigravity-proxy-token` against `apiSecret` in constant time (401 `Unauthorized` on failure, removing the prototype's `Authorization` fallback for `apiSecret`); second verify `Authorization: Bearer agy-managed` (401 `auth_required` with `x-should-retry: false` and the Section 13.3 sign-in text on failure).

### IA-10: Shared-mode login shortcut runs `probe()` before `resolveBinary()`, and skipping `integration.transform` on unsupported `authMethod` shows a broken API key form in OpenChamber

- **Severity:** major
- **Doc section:** 3 (Configuration), 10.1 (Registration), 10.2 (`authorize()` sequence)
- **What is wrong:** Two concrete flow bugs:
  1. In Section 10.2, step 4 runs `probe()` in shared mode before step 5 calls `resolveBinary()`. `probe()` needs the `agy` binary; running it before step 5 either fails when a first download is still running or bypasses step 5's 120 s wait budget. Step 4 also returns early without stating how `auth.lock` is released, whether `AuthState` becomes `signed_in`, or whether `auth-epoch` is bumped.
  2. In Section 3 line 139 and Section 10.1 line 390, when `authMethod` is a known unsupported method (such as `oauth-business`), the plugin skips `ctx.integration.transform` completely. In OpenChamber, `findIntegrationForProvider(integrations, "antigravity")` then returns `undefined`, and `shouldShowApiKeyAuth(undefined)` returns `true`, rendering an API key input form that fails with `IntegrationNotFoundError` when submitted, while `getProviderCardStatus` returns `null` (no status badge).
- **Evidence checked:** `docs/design-install-auth.md` lines 139, 390 to 396, 408 to 410; `packages/ui/src/components/sections/providers/providerAuth.ts` lines 57 to 58 and 109 to 116; `packages/ui/src/components/sections/providers/ProvidersPage.tsx` lines 652 to 656.
- **Suggested fix:**
  1. Move `resolveBinary()` (with the 120 s wait) ahead of the shared-mode `probe()` shortcut, and in the shortcut path update `AuthState` to `signed_in`, bump `auth-epoch`, and release `auth.lock` before returning.
  2. Always run `ctx.integration.transform` to register `integrations.update(INTEGRATION_ID, (info) => { info.name = PROVIDER_NAME; })` even when `config` has an auth issue, registering zero methods in that case. Then OpenChamber receives a defined integration with `methods: []`, hides the API key form, and displays the provider status cleanly.

## Minor

### IA-11: Security hardening gaps in profile permissions, record reads, Windows env stripping, error sanitization, and `stdin` `EPIPE`

- **Severity:** minor
- **Doc section:** 4 (Files on disk), 5 (Binary resolution order), 6.7 (Publish and activate), 9.2 (Env per spawn kind), 9.3 (Profile settings), 10.2 (`authorize()` sequence), 10.3 (`callback(code)`)
- **What is wrong:** Several smaller security and robustness details are missing:
  1. Section 4 and Section 9.3 never specify `chmod 0700` on `<data>`, `<data>/gemini`, or `<data>/gemini/antigravity-acp` (T3 Code enforces `0700` on all three directories on POSIX to protect tokens and conversation DBs on multi-user machines).
  2. Section 6.7 checks symlinks on `bin/<dirKey>`, `versions/`, release dir, executable, and `.install-complete.json`, omitting `lstat` on `active.json`, `isFile()` checks, and a file-size cap (`RECORD_MAX_BYTES = 8192` in T3 Code) when reading `active.json` and `.install-complete.json` (both in managed and `t3code` caches).
  3. Section 9.2 reuses `src/binary.ts`'s `STRIPPED_ENV_KEYS` logic, which checks keys case-sensitively (`stripped.has(key)`). On Windows, environment variable names are case-insensitive; T3 Code compares `key.toUpperCase()` so `Gemini_Api_Key` cannot slip through.
  4. Section 10.2 step 8 echoes raw `<last stderr/stdout line, 300 chars>` in the early-exit error message, which could leak an OAuth URL, `state`, or account email if `agy` prints it before exiting.
  5. Section 10.3 step 4 writes to `child.stdin` without specifying an `error` listener on `child.stdin`; if `agy --login` exits just before the write, an unhandled `EPIPE` can crash OpenCode.
  6. Section 9.3 (`writeAuthSettings`) and `design-sessions-runtime.md` (`prepareProfileDir` writing `toolPermission`) both perform read-modify-write on `antigravity-acp/settings.json` with no mutual exclusion, risking lost keys if they run concurrently.
  7. Section 11.2 step 6 deletes `acp_token.json` and `antigravity-oauth-token` in isolated mode without checking `isPluginOwnedProfile()` or refusing symlinks, which matters if a user sets `geminiDir` to a non-plugin directory while `isolatedAuth` stays `true`.
- **Evidence checked:** `docs/design-install-auth.md` lines 159 to 166, 193, 306, 374, 384, 415, 434, 497; `src/binary.ts` line 147; T3 Code `server-8K5Ixyrs.mjs` lines 12529, 12719 to 12729, 17297, 17392 to 17396.
- **Suggested fix:** Specify `0700` on profile dirs; add `lstat` on `active.json`, `isFile()`, and an 8 KiB read cap on JSON records; strip `STRIPPED_ENV_KEYS` case-insensitively via `.toUpperCase()`; redact URLs, tokens, and emails from early-exit error snippets; attach `child.stdin.on("error", () => {})`; funnel all `settings.json` updates through one helper (locked or serialized); require `lstat` non-symlink and `isPluginOwnedProfile()` before fallback token file deletion.

### IA-12: Release activation rollback, `pruneReleases` previous-version tracking, and step 1 re-validation

- **Severity:** minor
- **Doc section:** 6.7 (Publish and activate), 6.9 (Cleanup)
- **What is wrong:**
  1. Section 6.9 says `pruneReleases` keeps "the active release, the previous active release, and any release this process resolved since it started", yet Section 4 (`active.json` holds only `{ "releaseId" }`) and Section 6.7 never specify how `pruneReleases` knows which release was the previous active one.
  2. Section 6.7 step 3 sets `versions/<releaseId>` to mode `0500` before step 4 renames `active.json`, and does not state that a step 4 failure must `chmod 0700` and remove `versions/<releaseId>` (and restore any displaced directory), as T3 Code does.
  3. Section 6.7 step 1 skips straight to step 4 when `versions/<releaseId>` exists and inspects valid, omitting `verifyAgy` and the `MIN_AGY_VERSION` check (T3 Code still runs `validate()` before activating an existing release directory).
- **Evidence checked:** `docs/design-install-auth.md` lines 152, 299 to 304, 320; T3 Code `server-8K5Ixyrs.mjs` lines 17730 to 17738 and 17839 to 17873.
- **Suggested fix:** Capture the prior `releaseId` from `active.json` before overwriting it in step 4 and pass it in the `keep` set to `pruneReleases`; run `MIN_AGY_VERSION` and `verifyAgy` on step 1 hits; document unlocking and removing `versions/<releaseId>` (and restoring any displaced dir) if step 4 fails.

### IA-13: Configuration and binary resolution ambiguities an implementer must guess

- **Severity:** minor
- **Doc section:** 3 (Configuration), 5 (Binary resolution order), 16 (Module layout)
- **What is wrong:**
  1. Section 3 line 140 marks a relative `binaryPath` (not starting with `~/`) as an issue, without stating whether `binaryPath` is cleared (falling back to managed download, contradicting Section 5 step 1's "no fallback") or kept as a hard error. Also `~/` expansion does not mention Windows `~\`.
  2. Section 3 states "Option wins over env" for `binaryPath` only, leaving precedence and accepted boolean strings (`"0"`, `"1"`, `"true"`, `"false"`) unspecified for `binarySource`, `autoUpdate`, `offline`, `isolatedAuth`, and `geminiDir`.
  3. Section 5 step 2 searches for both `agy` and `antigravity` on `PATH` (T3 Code searches only `agy` on `PATH` because `antigravity` can belong to the separate Antigravity IDE app) and does not say whether step 2 tries later `PATH` candidates if the first hit fails `verifyAgy` or is a directory.
  4. Section 16 makes `BinaryManager` and `AuthManager` singletons (`getBinaryManager(config)`, `getAuthManager(config)`), without specifying what happens when a second OpenCode location or reload passes different `ctx.options`.
- **Evidence checked:** `docs/design-install-auth.md` lines 124 to 142, 191 to 201, 657, 666; T3 Code `server-8K5Ixyrs.mjs` lines 17600 to 17604.
- **Suggested fix:** State explicitly that an invalid relative `binaryPath` stays a hard error with no fallback; specify option-over-env precedence and boolean parsing for all config keys; require `isFile()` in `findOnPath`, prefer searching `agy` only (or continue past candidates that fail `verifyAgy` while logging why); define singleton config policy (first config wins with a warning on mismatch, or key singletons by `(dataDir, geminiDir, binarySource, binaryPath)`).

### IA-14: Minor factual inaccuracies about OpenCode 2.3.0 and OpenChamber UI

- **Severity:** minor
- **Doc section:** 2.4 (OpenCode 2.3.0 plugin API), 2.5 (OpenChamber's sign-in UI), 12.2 (Re-auth), 13.2 (Sources), 17.3 (Manual, before release)
- **What is wrong:** Three verified discrepancies:
  1. **Duplicate labels on re-auth:** Section 12.2 line 521 says re-auth creates `Antigravity 2`. In `@opencode/core/dist/chunks/app-3hm8m6zg.js` lines 187 to 194 and 262 to 267, OpenCode only generates `Antigravity`, `Antigravity 2` when `label` is `undefined`. Because Section 10.3's `label(credential)` always returns a string (`Google (<email>)` or `Google account`), re-auth inserts a second row with the exact same label.
  2. **OAuth error path in OpenChamber:** Section 2.5 line 93 cites `normalizeOpencodeError` in `packages/ui/src/lib/opencode/client.ts` for OAuth dialog errors. `ProviderOAuthMethods.tsx` calls `sdk().integration.oauth.*` directly and formats errors with `describeOAuthError` in `provider-oauth.ts`, never calling `normalizeOpencodeError`. (An HTTP 500 defect still shows a generic `ClientError` message, so the Section 10.5 conclusion stands.)
  3. **Live `needs_auth` updates in an open Settings view:** OpenCode's `connection.status(...)` publishes only `integration.updated` (`app-3hm8m6zg.js` line 488), and `Provider.Service` does not emit `provider.updated` when only connection status changes (`app-gmxz9m62.js` line 435). OpenChamber's `packages/ui/src/lib/opencode/events.ts` line 738 ignores `integration.updated` (`return []`). As a result, if Settings -> Providers is already open when `reportSignInRequired()` or the 10-second setup probe sets `needs_auth`, the card does not update until the user re-opens Providers or a credential changes.
- **Evidence checked:** `@opencode/core/dist/chunks/app-3hm8m6zg.js` lines 187 to 194, 262 to 267, 480 to 489; `@opencode/core/dist/chunks/app-gmxz9m62.js` lines 435 to 452; `packages/ui/src/components/sections/providers/ProviderOAuthMethods.tsx` lines 126 to 130, 181, 264; `packages/ui/src/components/sections/providers/provider-oauth.ts` lines 118 to 138; `packages/ui/src/lib/opencode/events.ts` lines 724 to 739.
- **Suggested fix:** Return `undefined` from `label()` when email is unknown (so OpenCode numbers fallback rows `Antigravity`, `Antigravity 2`) and update Section 12.2 to describe duplicate email labels accurately; fix the Section 2.5 reference to `provider-oauth.ts` (`describeOAuthError`); note the `integration.updated` refresh limitation in Section 18 (Open risks) and Section 17.3.

### IA-15: `probe` and `logout` spawns omit `--disable-telemetry` and `--include-default-customizations=false`

- **Severity:** minor
- **Doc section:** 9.2 (Env per spawn kind), 11.2 (Sequence), 13.2 (Sources)
- **What is wrong:** Section 6.5 (`verifyAgy`) passes `--disable-telemetry`, and `design-sessions-runtime.md` Section 3.2 passes both `--include-default-customizations=false` and `--disable-telemetry`, while Section 9.2's `agyBaseArgs()` omits both. As a result, `probe` and `logout` spawn `agy acp` with telemetry enabled and default customizations enabled (which can load workspace or default MCP servers and skills during a quick auth probe or logout).
- **Evidence checked:** `docs/design-install-auth.md` lines 258 and 380; `docs/design-sessions-runtime.md` line 108; `antigravity acp --help` output confirming `--include-default-customizations` defaults to `true` and `--disable-telemetry` exists.
- **Suggested fix:** Pass `--disable-telemetry` and `--include-default-customizations=false` on `verify`, `probe`, and `logout` ACP spawns (keeping `--login` arguments limited to flags verified to work with `--login`, or verifying `--disable-telemetry` with `--login` in the opt-in E2E test).

### IA-16: Section 19 still lists open questions already locked in `docs/decisions.md`

- **Severity:** minor
- **Doc section:** 9.1 (Modes), 10.5 (Errors in OpenChamber), 19 (Open questions for the user)
- **What is wrong:** Section 19 asks two open questions (shared-mode Disconnect behavior and `code` vs `auto` mode), and Sections 9.1 and 10.5 still cross-reference "open question 1" and "open question 2", even though `docs/decisions.md` lines 21 to 22 already settled both decisions.
- **Evidence checked:** `docs/design-install-auth.md` lines 366, 467, 806 to 809; `docs/decisions.md` lines 17 to 22.
- **Suggested fix:** Remove Section 19 and replace the inline cross-references with references to `docs/decisions.md`.

### IA-17: Missing unit and integration test cases in Section 17

- **Severity:** minor
- **Doc section:** 17 (Test plan)
- **What is wrong:** Section 17 omits tests for several high-risk security and concurrency paths:
  - `test/install-extract.test.ts`: non-empty POSIX `ustar` `prefix`, bad header checksum, trailing non-zero garbage after a valid entry, GNU `L` longname, PAX `g` header and oversized metadata cap, base-256 size, 0-byte executable, and gzip zero-block decompression bomb.
  - `test/install-download.test.ts`: HTTPS-to-HTTP protocol downgrade on the same allowed host, multi-hop redirect through a foreign host back to an allowed host, `Content-Encoding: gzip` rejection / `Accept-Encoding: identity` header check, and initial response-header stall timeout.
  - `test/install-lock.test.ts`: missing `owner.json` right after `mkdir` is not stolen before `staleMs`, same-host live PID survives past `staleMs` (laptop sleep), and synchronous exit cleanup without leaking `process` listeners.
  - `test/auth-login.test.ts`: Cancel followed by Connect in the same process (superseding when this process holds `auth.lock`), bad paste releasing child/lock/hold so a fresh `authorize()` succeeds immediately, and `stdin` `EPIPE` when child exits early.
  - `test/auth-manager.test.ts`: multi-location `needs_auth` fan-out, cleanup when one location unloads, new location inheriting `signed_out`, and `beforeSpawn()` recovering after another process bumps `auth-epoch`.
  - `test/auth-logout.test.ts`: debounced `credential.updated` firing during `login_pending` does not clobber login, failed lock acquisition does not leave `logging_out` stuck, and logout with no installed binary does not trigger a download.
  - `test/plugin.test.ts` and `test/e2e-proxy.test.ts`: unsupported `authMethod` still registers the `antigravity` integration with zero methods; request with `Authorization: Bearer agy-managed` and no `x-antigravity-proxy-token` returns 401 `Unauthorized`; case-insensitive `STRIPPED_ENV_KEYS` stripping.
- **Evidence checked:** `docs/design-install-auth.md` lines 674 to 767.
- **Suggested fix:** Add those cases to their respective test files in Section 17.1.

## Verified and found correct

- **T3 Code manifest, URL, cache, validation, and auth support claims (Sections 2.1 and 2.2):** Verified against `apps/server/dist/server-8K5Ixyrs.mjs` and `ManagedEndpointRuntime-DBgt8khC.mjs` inside `/Applications/T3 Code (Beta).app/Contents/Resources/app.asar`. Manifest base URL, target keys, musl paths, GCS asset URL grammar, SHA-512 prefix `releaseId`, `.install-complete.json` schema, 512 MiB caps, read-only modes (`0555`/`0400`/`0500`), Windows retry behavior, `antigravityProfileSettings`, `parseAntigravityAuthorizationUrl`, `antigravityLoginResponse`, `isAntigravitySignInRequiredError`, `AUTH_URL_STDOUT_PREFIX`, and ACP `logout` all match.
- **Local T3 cache and `agy` 1.5.15 binary (Sections 2.1 and 2.3):** Verified `~/.t3/tools/antigravity-acp/darwin-arm64/active.json`, `.install-complete.json` (`1.5.15`, `229617904` bytes, mode `0400`), `antigravity` binary (`0555`, signed by `EQHXZ8M8AV`), `--version`, `acp --help` flags, and keyring fallback strings.
- **OpenCode 2.3.0 plugin and model-resolver behavior (Section 2.4):** Verified `@opencode/plugin/dist/promise/integration.d.ts`, `event.d.ts`, `adapter.js` lines 294 to 330 (`Effect.promise` defect wrapping for `authorize` and code-mode `callback`, `Effect.tryPromise` for `submit`), `@opencode/server/dist/chunks/auth-91858wp1.js`, `@opencode/schema/dist/credential.js`, `@opencode/core/dist/chunks/app-36g6rx54.js` (`ModelResolver` setting `apiKey = credential.access` for OAuth and `Auth.none` for `activation: "enabled"` with no credential or `settings.apiKey`), and `sameMethod` allowing only one `key` method per integration.
- **OpenChamber provider card and accounts UI (Section 2.5):** Verified that dropping `settings.apiKey` makes an unauthenticated provider card show Sign in needed (`providerAuth.ts`), `needs_auth` shows Sign in again and account subtitle message (`ProviderAccounts.tsx`), Disconnect and Remove call `credential.remove` (`ProvidersPage.tsx`), and empty `url` is not opened (`provider-oauth.ts`, `shouldOpenAuthorizationUrl`).
- **Locked decisions compliance:** Scope matches `docs/decisions.md` (Q1 managed SHA-512 binary with override and offline fallback, Q6 `isolatedAuth: true` default, Q7 `oauth-personal` only with `AuthMethodSpec` seams, no new npm dependencies).
