# Implementation review (Opus)

Scope: `src/` against `docs/architecture.md`, `docs/design-install-auth.md`, `docs/design-sessions-runtime.md` and `docs/decisions.md`. The full suite passes (`bun test test/`: 572 pass, 5 skip, 0 fail). Every finding below was checked by reading the code path end to end; the ones marked "Reproduced" were run with a scratch test against the real modules and the fake agy. Scratch files live outside the repo and are not part of the change.

Counts: 0 blocker, 6 major, 6 minor.

## Findings

### O-1 (major): a spawn that starts during a logout deadlocks the logout and every later spawn

- **Where:** `src/auth/manager.ts:248`, `src/auth/manager.ts:540-542`, `src/agy-process.ts:276-291`.
- **Defect:** `logoutLocked` sets `logging_out`, then awaits `bumpEpoch`, then awaits `runtime.stop("auth-changed")`. A request that reaches `AgyProcessManager.start()` in between enters `beforeSpawn()`, which loops while the state is `logging_out`. `stop()` in state `starting` awaits the start promise. The start waits for logout to leave `logging_out`, and logout waits for the stop. Nothing else moves the state: `reportAuthenticated` and `reportSignInRequired` return early during `logging_out`.
- **Scenario:** the user removes the Antigravity credential while another session (a subagent, an OpenCode retry) sends a chat request in the few milliseconds of the epoch write. Result: logout never finishes, the auth state stays `logging_out`, the request hangs, every later spawn waits in `beforeSpawn` forever, and `authorize()` queues behind the auth mutex, so sign-in hangs too. Only an OpenCode restart clears it.
- **Evidence:** Reproduced. A scratch test wires the real `AuthManager` (mock login agy) to a real `AgyProcessManager`, calls `logout()`, and calls `acquire("turn")` as soon as the state is `logging_out`. After 3 s (logout budget 2 s): `auth state: logging_out manager state: starting logout settled: false spawned: 0`. No existing test covers this: `auth-manager.test.ts` uses `FakeRuntime`, and the runtime tests use `FakeInstallAuthBridge`, so the two real halves never meet.
- **Fix:** let a cancelled start leave `beforeSpawn`: either `stop()` in `starting` with no child yet resolves at once (and the start checks `cancelledStart` after `beforeSpawn`), or `beforeSpawn` takes an abort signal that `stop()` fires. Add a test with the real `AuthManager` and the real `AgyProcessManager`.

### O-2 (major): an epoch change from another OpenCode window detaches the session mid-request and drops its lock

- **Where:** `src/proxy.ts:648`, `src/proxy.ts:1289-1307`; trigger in `src/auth/epoch.ts:31-45` and `src/auth/manager.ts:704-710`.
- **Defect:** `AuthManager.authEpoch()` re-reads the epoch file and calls `onAuthChanged` synchronously when another process moved it. `handleMain` calls `this.bridge.authEpoch()` inside the session mutex, after `entryFor(key)` returned the entry. The listener `onAuthChanged` then deletes that same entry from `this.sessions` and releases its binding lock, because the entry has no live turn yet. `handleMain` goes on with the detached entry: it registers the new turn on it, and since `entry.lock` still points at the released handle, it never locks again.
- **Scenario:** the user signs in (or out) in a second OpenCode window, then sends a message in an existing session in the first one. That turn runs without a cross-process lock (the `.lock` file is gone). If it parks on a tool call, the tool-result request finds no entry, builds a new one with no parked turn, and runs as `fresh` with a full replay, so agy may run the tool again. The parked turn on the detached entry stays until the 30 min parked TTL, holding a process lease (no idle stop; see O-6 for what a held lease does during an update). Its ACP session and MCP scope are never closed.
- **Evidence:** Reproduced with the proxy harness, real session modules, and a bridge whose `authEpoch()` notifies listeners the way `AuthEpoch.read()` does. Output: `entry in sessions map while parked: false live turns: 1`, `binding lock files on disk while the turn runs: 0`, `tool result request: tool_calls new sessions opened by it: 1 live turns after: 2`. The fake bridge never notifies from `authEpoch()`, which is why the e2e tests miss it.
- **Fix:** do not emit from inside `read()`; queue the external-change notification (`queueMicrotask`) or emit it from a timer. In `onAuthChanged`, skip entries a mutex holder is using, or let `handleMain` re-fetch the entry and re-lock after reading the epoch. Make the fake bridge notify synchronously in one test.

### O-3 (major): a same-host lock owner is never stale while its pid is reused, whatever the heartbeat says

- **Where:** `src/install/lock.ts:137` (install lock and auth lock), `src/session-store.ts:416-421` (binding locks).
- **Defect:** for an owner on this host, staleness is only `!pidAlive(pid)`. The heartbeat mtime (written every 10 s for dir locks, every 60 s for binding locks) is ignored. Locks are released on `process.on("exit")`, which does not run when OpenCode is killed by SIGTERM or SIGKILL, or on power loss. After a reboot the old pid is often taken by another long-lived process.
- **Scenario:** OpenCode is killed during the first download or with a sign-in code pending, the machine restarts, and the old pid now belongs to a daemon. Every install waits `lockWaitMs` (35 min) and then fails with "Another OpenCode window is installing Antigravity"; every sign-in fails at once with the "other window" text; a binding lock left this way makes that session ephemeral forever (full replay every turn), and prune skips it. Nothing recovers until the user deletes the lock dir by hand.
- **Evidence:** Reproduced. An owner file with `pid: 1`, this hostname and a heartbeat 3 days old: `acquireDirLock(dir, { waitMs: 1500 })` throws `LockBusyError`.
- **Fix:** treat a same-host owner as stale when its newest heartbeat is older than `staleMs` as well (a live holder always touches it), or compare `createdAt` with the boot time / the pid's start time. The binding lock already has the uptime check for its own pid; apply the mtime rule to other pids too.

### O-4 (major): the run-dir root is a fixed, shared name under `/tmp` on Linux and its ownership is never checked

- **Where:** `src/tmp-sweeper.ts:29-31`, `src/tmp-sweeper.ts:66-71`.
- **Defect:** `createRunDir` does `mkdir(<os.tmpdir()>/opencode-antigravity, { recursive: true, mode: 0o700 })`. An existing directory is accepted whoever owns it and whatever its mode. On Linux `os.tmpdir()` is `/tmp` for every user.
- **Scenario:** on a shared Linux host, the first user who runs the plugin creates `/tmp/opencode-antigravity` with mode 0700. Every other user's runtime, login and probe spawn then fails with `EACCES` at `mkdir(run-…)`, which reaches OpenCode as a retryable 502, so the plugin never works for them. A hostile user can instead pre-create the root with mode 0777; they can then rename a victim's `run-…` dir and put a symlink in its place, so the victim's agy uses an attacker-controlled `TMPDIR` (which agy uses for its unpacked runtime, per the start note).
- **Evidence:** `createRunDir("runtime", { root })` on a pre-existing root with mode 0777 succeeds and leaves the root at 0777 (scratch run: `root mode: 777`).
- **Fix:** use a per-user root (`opencode-antigravity-<uid>`, or under the data dir), and after `mkdir` `lstat` it: not a symlink, owned by `process.getuid()`, `mode & 0o077 === 0`; refuse otherwise.

### O-5 (major): multibyte characters split across stdout chunks are corrupted in the stream

- **Where:** `src/acp-client.ts:300-301`.
- **Defect:** `chunk.toString()` decodes each stdout `Buffer` on its own. A UTF-8 sequence cut by a chunk boundary turns into U+FFFD on both sides. The log tail uses a `StringDecoder`; the ACP client does not.
- **Scenario:** a reply in Ukrainian, Chinese or with emoji streams while agy writes faster than the pipe drains. Some characters show up as `���` in OpenCode, and the corrupted text is stored in the session. The emitted text hash is computed on the same corrupted text, so it does not trigger a fresh session; the damage just stays.
- **Evidence:** Reproduced. One `session/update` line with `"Привіт 👋"` written to the client's stdout in two pieces, cut inside the emoji: the listener receives `"Привіт ���"`.
- **Fix:** `stdout.setEncoding("utf8")` and `stderr.setEncoding("utf8")` in `defaultSpawner`, or a `StringDecoder` per stream in `AcpClient`.

### O-6 (major): after a binary update, every new request in every session waits for parked turns, up to 30 minutes

- **Where:** `src/agy-process.ts:231-234` with the parked-turn lease (`src/proxy.ts:889-892`, released only in `onTurnEnded`).
- **Defect:** this follows the SR 3.1 table ("`acquire()` in `draining` waits until `stopped`"), but together with SR 3.3 ("a turn parked on an OpenCode tool call holds its lease") it means one parked turn blocks the whole pool. The background update check runs every 6 h and drains without warning.
- **Scenario:** session A is parked on a tool call that waits for the user's permission answer in OpenCode. The auto-update activates a new agy. Every new request in sessions B, C and D hangs with only `: ping` until A's tool returns or the 30 min parked TTL reaps it. No status note says why.
- **Evidence:** `test/unit/agy-process.test.ts` "draining keeps existing leases…" asserts that the new `acquire` stays pending until the old lease is released. Parked turns hold `turn.lease` until `done`.
- **Fix:** allow a second child while draining (new leases go to the new generation, the old one stops when its leases reach 0), or stop treating parked turns as blocking a drain beyond a short bound. At least send a status note while a request waits on `draining`. This needs a design change, so it is for the maintainer to decide.

### O-7 (minor): concurrent `settings.json` writers in two processes can drop `toolPermission: "strict"`

- **Where:** `src/auth/settings.ts:21-42`; `toolPermission` is written once per pool start (`src/profile.ts:267`), while `{ auth, gcp }` is written before every spawn (`src/auth/manager.ts:660-663`).
- **Defect:** `updateProfileSettings` serializes writers only within one process. Two OpenCode processes on one profile do read-merge-write independently, so one can overwrite the other's key. `auth` is rewritten at every spawn and recovers; `toolPermission` is not rewritten until the next pool start.
- **Scenario:** two OpenCode processes start at the same time (OpenChamber's managed server and a TUI after login). One process's spawn write lands over the other's start write, and agy runs without strict tool permission for the life of both pools. With the guard hook installed the hook still denies built-in tools; in a foreign profile (no hook), layer 3 is no longer consulted. What agy does without the key was not checked.
- **Evidence:** Reproduced the lost update: two `bun` processes, each calling `updateProfileSettings` with one key at the same moment, 20 runs: 20 lost a key.
- **Fix:** include `toolPermission: "strict"` in the patch written before every spawn, or take a file lock around the read-merge-write.

### O-8 (minor): an isolated (meta or ephemeral) session cancelled during `session/new` is never closed

- **Where:** `src/proxy.ts:1075-1078`, cleanup in `src/proxy.ts:1157-1166`.
- **Defect:** `runIsolated` stores `isolatedLive.set(turn, opened.live)` after `openSession` resolves. If the turn was cancelled while `session/new` ran, `onTurnEnded` already ran and found nothing to clean. The map entry, the MCP scope and the ACP session stay until the process stops; the session is not written to the ephemeral ledger, so prune never deletes its conversation file.
- **Scenario:** OpenCode aborts a title or compaction request during agy's slow first `session/new` (or the client closes a direct call). Each such abort leaks one agy session.
- **Fix:** after `openSession`, if `turn.done`, close the scope and the session at once instead of registering it.

### O-9 (minor): non-streaming responses drop the text that came before tool calls

- **Where:** `src/turn.ts:850-852`.
- **Defect:** `JsonResponder.toolCalls` answers with `toolCallsResponse(model, calls, false)`, which has `content: null`; the collected `texts` and `thoughts` are discarded. The binding still records `emittedTextHash` of that text (`turn.responseText`).
- **Scenario:** a non-streaming client gets a reply with text and a tool call. The user never sees the text, and the next request echoes an assistant message without it, so `echoMatches` fails and every tool round runs `fresh` with a full replay.
- **Fix:** put `this.texts.join("")` (and `reasoning_content`) into the tool-calls message.

### O-10 (minor): a code pasted after the 5 minute window is answered "replaced by a newer one"

- **Where:** `src/auth/manager.ts:399` with the paste timer at `src/auth/manager.ts:373-375`.
- **Defect:** the paste timer runs `cleanupAttempt`, which clears `this.attempt`. A later `complete()` sees `this.attempt !== attempt` and throws `LOGIN_MESSAGES.replaced`.
- **Scenario:** the user takes six minutes in the browser and pastes the code. OpenCode says "This sign-in was replaced by a newer one." although no other sign-in started.
- **Fix:** mark the attempt as expired in the timer and throw an expiry text for it.

### O-11 (minor): the sweep retires agy's `antigravity-acp/tmp` while this process's own login or probe child may use it

- **Where:** `src/tmp-sweeper.ts:164-176`, `src/tmp-sweeper.ts:250-263`.
- **Defect:** the retire runs when `OwnerRegistry.othersAlive()` is false. That registry only knows other processes and other pools. The login, probe and logout children of the same pool run on the same gemini dir and are not counted.
- **Scenario:** the setup probe (or a pending login) runs while the first chat request spawns the runtime; the sweep renames `<gemini>/antigravity-acp/tmp` under the running child. Whether agy keeps files there that the child needs was not checked against a real agy.
- **Fix:** skip the retire while any `login`, `probe` or `logout` run dir of this process is live (the live set already knows their kind through `owner.json`).

### O-12 (minor): the auth epoch and the auth lock are per data dir, so two profiles in one data dir disturb each other

- **Where:** `src/install/paths.ts:89-95`, used by `src/auth/manager.ts:167` and `:316`.
- **Defect:** `auth-epoch` and `locks/auth.lock` sit in the data dir, while the session store and the profile are per gemini dir.
- **Scenario:** two configurations share the data dir with different `geminiDir` (the "Two plugin configurations" case). Signing in to profile X bumps the shared epoch: profile Y's runtime stops with "sign-in changed", its bindings are dropped, and the next prune deletes Y's binding records and conversation files as "other epoch". A sign-in in Y is refused while X's sign-in is pending.
- **Fix:** key the epoch file and the auth lock by profile id, the way `SessionStore` keys its dir.

## Checked and found correct

- Download: hand-followed redirects with an origin check on every hop, no userinfo or ports, `Content-Encoding` refused, `Content-Length` and streamed size caps, SHA-512 over the streamed bytes, staging removed on failure, `wx` on the download file.
- Manifest: strict version, SHA-512 and URL shape tied to the target asset path; a failed fetch keeps the last good manifest.
- Extraction: single regular entry with the exact executable name, `..`, absolute, backslash and NUL names refused, ustar prefix refused, pax keys allow-listed, link and device types refused, header checksums, gzip read to EOF, size caps, `wx` output removed on failure.
- Release install: realpath containment and symlink checks on every level, record and size check, read-only modes, activation by atomic `active.json` with rollback, prune keeps active, previous and every release this process resolved.
- Binary resolution order, explicit path without fallback, PATH candidates with the identity check, T3 Code cache read-only.
- Spawn env: stripped Google and agy variables, forced file storage in isolated mode, `SSH_CONNECTION` so a signed-out `authenticate` fails instead of opening a browser.
- Login: URL shape check (origin, path, one `state`, redirect URI, `response_type`), paste check refuses whitespace and a foreign `state`, URL and code never enter the tail or errors, `redactAgyOutput` on every quoted line.
- Logout: ACP `logout` with a token-file fallback only in a plugin-owned profile, no symlink following.
- Sign-in detection: the auth-URL line on stdout and stderr fails pending RPCs at once and kills the generation; sign-in exits do not count toward the breaker.
- Classification: prefix chain, echo check against our own emitted text and tool calls, parked resume only for emitted ids, steering only with input messages after the results, redo only for a clean failure of `append` or `redo`. I found no path that reads an edit as an append.
- Tool guard: layer 3 needs every server and tool name in `args` and `rawInput` to agree and the tool to be in this turn's allowlist; `allow_always` is never chosen; fs and terminal callbacks are refused; the hook is written only after its exact command passed the probe and only in a plugin-owned profile.
- Proxy gate: loopback `Host`, no `Origin`, constant-time proxy token, marker bearer on chat, MCP token plus scope id, conversation id cross-check on `tools/call`.
- Error mapping: `binary_not_found` is 503 with `x-should-retry: false` before the stream and code 400 after it; auth failures are 401 and not retried; retryable texts avoid OpenCode's quota and context phrases.
- Privacy: debug lines carry ids, counts and kinds only; `test/e2e/privacy.test.ts` checks prompt, tool arguments, tool results, proxy token, MCP token and the marker.
- Pool sharing across reloads: ref count with a grace period, a key whose stop is running is awaited before a new pool starts, a failed setup hands its lease back.
