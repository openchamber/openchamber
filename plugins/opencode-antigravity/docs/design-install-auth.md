# Install and auth design

Status: design, ready to implement. Scope: decisions Q1 (managed `agy` binary), Q6 (`isolatedAuth` defaults to `true`) and Q7 (Personal Google sign-in only, with seams for the other three methods). Sessions, the shared `agy acp` process, stalls and the system prompt are in `docs/design-sessions-runtime.md`. Section 15 states what this design gives that one and what it assumes.

## 1. Decisions at a glance

| Topic | Decision |
| --- | --- |
| Binary source | Managed by default: the plugin downloads Google's `agy` into `<data>/bin/<platform>-<arch>/versions/<releaseId>/`, SHA-512 verified, from `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<target>.json`. PATH and T3 Code's cache are used only when configured, or as an offline fallback |
| Install trigger | Background at plugin setup when nothing is installed; blocking on first spawn or first sign-in if still missing |
| Updates | Manifest check at most every 6 h; a newer version installs in the background and becomes active atomically; the running process keeps its binary until the runtime restarts it; never downgrades |
| Cross-process safety | Directory lock with heartbeat per platform dir; one download at a time; other processes wait and reuse |
| Auth storage | Isolated by default: `AGY_ACP_FORCE_FILE_STORAGE=1`, tokens in `<data>/gemini/antigravity-acp/`. `isolatedAuth: false` drops file storage so agy uses the OS keyring |
| Sign-in | `agy acp --login` code flow, surfaced to OpenCode as an OAuth method in `code` mode. Tokens never leave agy's files; the OpenCode credential is a marker |
| Sign-out | Removing the last Antigravity credential in OpenCode stops the runtime, then calls ACP `logout` (isolated mode) |
| Status | Derived from agy (`authenticate` results), pushed to OpenCode with `integration.connection.status` (`needs_auth`), and enforced by the proxy: no OpenCode credential, no request |
| Later methods | `AuthMethodSpec` registry; only `oauth-personal` has `supported: true` |

## 2. What was verified, and where

### 2.1 T3 Code: acquiring and verifying agy

Source: `/Applications/T3 Code (Beta).app/Contents/Resources/app.asar`, file `apps/server/dist/server-8K5Ixyrs.mjs`, extracted read-only with `npx @electron/asar extract-file` into the scratch dir. Line numbers refer to that bundle. `app.asar.unpacked` holds only `node_modules`, nothing Antigravity-specific.

| Fact | Where |
| --- | --- |
| Manifest base `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests`, fetched as `<base>/<target>.json` with a 10 s timeout | `src/provider/antigravityCliRelease.ts`, line 16953; fetch at line 17890 |
| Manifest is `{ version: /^\d+\.\d+\.\d+$/, url, sha512: /^[a-fA-F0-9]{128}$/ }` | line 16954 |
| Target key: `darwin_arm64`, `darwin_amd64`, `linux_amd64`, `linux_arm64`, `linux_*_musl`, `windows_amd64`, `windows_arm64`. Musl detected by `/lib/libc.musl-x86_64.so.1` or `/lib/libc.musl-aarch64.so.1` | `antigravityCliTarget`, line 16960; musl check line 17888 |
| URL must equal `https://storage.googleapis.com/antigravity-public/antigravity-cli/<version>-<digits>/<folder>/cli_<os>_<cpu>[_musl].<tar.gz|exe>` with folder `darwin-arm`, `darwin-x64`, `linux-arm`, `linux-x64`, `*-musl`, `windows-x64`, `windows-arm` | `parseAntigravityCliRelease`, line 16968 |
| Executable `antigravity` (POSIX, from a tar.gz) or `agy.exe` (Windows, the asset itself) | line 16983 |
| Cache `<baseDir>/tools/antigravity-acp/<platform>-<arch>/`, `active.json` = `{ releaseId }`, `versions/<releaseId>/` with `.install-complete.json` = `{ releaseId, version, executable: { name, bytes } }`; `releaseId` is the first 64 hex chars of the archive SHA-512 | `src/provider/AntigravityInstallation.ts`, lines 17290 to 17360, 17694 |
| Download streams through SHA-512 with a 512 MiB cap and a 45 min timeout; mismatch fails with "The Antigravity download failed its size or checksum check. Nothing was installed." | lines 17760 to 17775 |
| Free space check 1280 MiB via `statfs` | line 17744 |
| tar.gz must list exactly one regular file named like the executable; extracted with system `tar -xOzf` (Windows `%SystemRoot%\System32\tar.exe`), 512 MiB cap | lines 17777 to 17803; `cliArchiveTarCommand` in `ManagedEndpointRuntime-DBgt8khC.mjs` |
| After extraction T3 spawns `agy acp` in a temp profile and requires `agentInfo.name === "Antigravity ACP Server"`, `agentInfo.version === manifest.version`, `loadSession`, `sessionCapabilities.resume`, `auth.logout`, and an `oauth-personal` auth method; 90 s timeout. IPv6 and 16K/64K page-size kernels get their own messages | `validate`, lines 17650 to 17672 |
| Staging in `versions/.install-<rand>/`, rename into `versions/<releaseId>`, pointer written as `active.json.<rand>/contents.tmp` with `wx` mode 0600 then renamed over `active.json`. Rollback on failed activation | lines 17702 to 17860 |
| Cross-process lock `proper-lockfile` on the platform dir, stale 30 s, update 10 s, 60 retries; in-process semaphore plus a lease count per release dir | `withManagedLock`, line 17458; `acquire`, line 17617 |
| Read-only release: exec 0555, record 0400, dir 0500; symlinked roots, dirs or files are refused | `lockReleaseDirectory`, line 17425 |
| Prune: every `versions/<64hex>` except the active one and leased ones | `pruneInactiveReleasesBody`, line 17673 |
| Windows: rename and remove retried 40 times every 250 ms on `EPERM`/`EBUSY` | `retryWhileWindowsHoldsHandles`, line 17362 |
| Update check at most hourly when the user enabled update checks; install is user-started from settings; an installed version newer than the manifest is kept | `refreshRelease`, lines 17882 to 17905 |
| Resolution: custom path, then managed `active.json`, then `agy` on PATH; files are accepted only if named `agy`/`antigravity` | `resolveUnlocked`, line 17583 |

Observed cache: `~/.t3/tools/antigravity-acp/darwin-arm64/active.json` holds `{"releaseId":"b03a84..."}`; `versions/b03a84.../` holds `antigravity` (mode `r-xr-xr-x`, 229617904 bytes) and `.install-complete.json` `{"releaseId":"b03a84...","version":"1.5.15","executable":{"name":"antigravity","bytes":229617904}}`. The binary is signed, `TeamIdentifier=EQHXZ8M8AV`.

Live manifests, fetched on this machine: all eight targets answer 200 with version `1.5.16` and URLs of the shape above. The darwin-arm64 asset is 86506312 bytes; its SHA-512 matched the manifest; it contains one GNU-tar entry `antigravity` (`-rwxr-xr-x`, 230641440 bytes, magic `ustar `), no pax headers. The Windows x64 asset is a bare 240597392-byte `.exe`.

### 2.2 T3 Code: running agy and signing in

| Fact | Where |
| --- | --- |
| Profile per provider instance at `<stateDir>/providers/antigravity/<sha256(instanceId)>/` (observed under `~/.t3/userdata/`). Spawn: `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp` | `resolveAntigravityInstanceDirectories`, `buildAntigravityAcpSpawnInput`, `src/provider/antigravityAuthSupport.ts` |
| Env strips `GEMINI_API_KEY`, `GOOGLE_*`, `GEMINI_HOME`, `BROWSER` and others, then sets `GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE=1`, `AGY_CLI_DISABLE_AUTO_UPDATE=1`, `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0` for `oauth-personal`, `BROWSER` = a node helper that prints the URL, `TMPDIR`. On Linux it sets `SSL_CERT_FILE` to the first existing CA bundle when none is set | `antigravityEnvironment`, `prepareAntigravityProfile` |
| `settings.json` in `antigravity-acp/` is `{ auth: { type }, gcp?: { project, location } }`; the comment says `auth.type` makes a native logout clear only that method's credentials | `antigravityProfileSettings` |
| Personal sign-in runs `agy acp ... --login` with `DISPLAY`/`WAYLAND_DISPLAY` removed, reads the line starting `https://accounts.google.com/`, writes the pasted response plus `\n` to stdin, success is exit code 0 | `codeLogin`, `src/provider/Drivers/AntigravityDriver.ts` |
| Auth URL check for the code flow: origin `https://accounts.google.com`, path `/o/oauth2/auth`, exactly one `state` (1 to 512 chars), one `redirect_uri` equal to `https://antigravity.google/oauth-callback`, `response_type=code`, no userinfo or hash, at most 16384 chars | `parseAntigravityAuthorizationUrl` |
| Pasted response accepted if it matches `/^[\w./~-]{1,2048}$/`, or is a URL whose origin+path equals the redirect URI, with exactly one `code` and a `state` equal to the pending one; anything with whitespace is refused | `antigravityLoginResponse` |
| One flow at a time, 5 min deadline, hints after 30 s and 90 s; after the code is accepted, T3 starts a throwaway runtime and session to confirm access and load models | `src/provider/AntigravityAuth.ts`, `runSignIn` |
| Sign-in-required detection: ACP error `-32000`, or `-32603` whose message starts with `No browser is available here` | `isAntigravitySignInRequiredError` |
| Logout: stop sessions and owned processes, start a runtime, require `initialize().agentCapabilities.auth.logout`, send ACP `logout` `{}`, 90 s timeout | `AntigravityAuth.logout` |
| Status shown as `unauthenticated` until a session starts; `onAuthRequired` and `onSignedOut` clear models and set the sign-in message | `src/provider/AntigravityProvider.ts` |
| Settings seams: `authMethod`, `apiKey` (secret), `gcpProject`, `gcpLocation`, `binaryPath` | `AntigravitySettings`, `ManagedEndpointRuntime-DBgt8khC.mjs` |

T3's isolated profile holds `antigravity-acp/acp_token.json` and `antigravity-acp/antigravity-oauth-token`, both mode 0600. Key names only were read: `acp_token.json` has `client_id, client_secret, project_id, refresh_token, scopes, token_uri`; `antigravity-oauth-token` has `auth_method, id_token_email, token`.

### 2.3 agy itself (1.5.15 from the T3 cache)

Run read-only with `AGY_CLI_DISABLE_AUTO_UPDATE=1`, against empty temp profiles in the scratch dir.

- `agy --version` prints `1.5.15`. `agy acp --help` lists `--gemini-dir` (default `.gemini`), `--app-data-dir` (default `antigravity-cli`), `--login` ("Log in with Google interactively, then exit (ACP terminal auth)"), `--disable-telemetry`, `--include-default-customizations`, `--log-file`, `--process-per-session`.
- ACP `initialize` answers `protocolVersion: 1` even when asked for 2, `agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" }`, `agentCapabilities.auth.logout: {}`, `_meta.antigravity: { tier: true, systemPrompt: { append: true } }`, and four `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`.
- `authenticate { methodId: "oauth-personal" }` on a signed-out profile with `SSH_CONNECTION` set answers within about 100 ms: error `-32603` `No browser is available here (this is a remote (SSH) session...). Run \`agy acp --login\` in a terminal on this machine, then retry; or use a Gemini API key.` Nothing opens and nothing waits. This is the status probe.
- `agy acp --login` prints, within 60 ms: `Open this link in a browser to log in with Google:`, a blank line, two spaces and the URL (redirect `https://antigravity.google/oauth-callback`, PKCE `code_challenge`, `access_type`, `prompt`), then `Then paste the authorization code, or the full URL of the page you land on, and press Enter:`.
- Closing stdin without a code: `login cancelled: no authorization code was entered`, exit 1. A bad code: `couldn't log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."`, exit 1, about 0.3 s after the write.
- Binary strings show keyring handling with a file fallback: `Using file-based token storage because a keyring timeout was recorded within the last %v`, `healKeyringTokenFromFile`, `migrateKeyringAndApplyFileMetadata`.

Not run: a real login, ACP `logout`, `--login` on a signed-in profile, keyring mode.

### 2.4 OpenCode 2.3.0 plugin API

From the installed packages under `node_modules/.bun/` of the OpenChamber checkout. The reference checkout `~/projects/opencode` is not on this machine.

- `@opencode/plugin/dist/promise/integration.d.ts`: methods `oauth { id, label, form? }`, `key { label?, form? }` (no id), `external`, `command`, `env`. OAuth registration `{ integrationID, method, authorize(answer), refresh?, label?(credential) }`. `authorize` returns `{ url, instructions, expiresAt? }` plus `{ mode: "code", callback(code) }` or `{ mode: "auto", callback: Promise, submit?(redirect) }`. `ctx.integration.connection.active(id)`, `.resolve(connection)`, `.status({ integrationID, connection, status: { status: "needs_auth", message, url? } | undefined })`. `ctx.integration.get({ integrationID })` lists connections. There is no remove or logout hook; `ctx.credential` exposes only `activate`.
- `@opencode/schema/dist/credential.js`: `Credential.OAuth = { type: "oauth", methodID, refresh, access, expires: NonNegativeInt, metadata? }`. Event `credential.updated` `{ integrationID, credentialID }` on every add, rename and remove.
- `@opencode/plugin/dist/promise/event.d.ts` and `@opencode/client/dist/shared-events.d.ts`: `ctx.event.subscribe({ types?, signal? })` returns an `AsyncIterable`; events carry `data`. The prototype's `subscribe(handler)` with `event.properties` never fires. This breaks its interrupt handling too; the runtime design owns that fix.
- Core `app-3hm8m6zg.js`: attempts live 10 min unless `expiresAt` is set; each successful attempt calls `createCredential`, which inserts a new row (`Antigravity`, `Antigravity 2`, ...); credentials are never deduplicated.
- Core `app-36g6rx54.js` (`ModelResolver`): with an active credential, OpenCode sets `apiKey = credential.access` for `openai-compatible`; with `activation: "enabled"`, no credential and no configured key, it sends no auth at all.
- `adapter.js` lines 294 to 330 wrap `authorize()` and the code-mode `callback()` in `Effect.promise`, so a rejection is a defect. The server's `integration.oauth.*` handlers map only typed failures to a 400 with the message (`@opencode/server` chunk `auth-91858wp1.js`). Auto-mode `callback` rejections reach the attempt status as `failed.message`; `submit` rejections are typed.

### 2.5 OpenChamber's sign-in UI

- `packages/ui/src/components/sections/providers/ProviderOAuthMethods.tsx`: Connect calls `integration.oauth.connect`, opens `url` when it is non-empty (`provider-oauth.ts`, `shouldOpenAuthorizationUrl`), shows `instructions` in an info box, then for `code` shows "Copy the authorization code from your browser and paste it here." with an input, and for `auto` polls status every 1.5 s with "Waiting for authorization..." and a paste box only when `paste: true`. Errors go through `describeOAuthError` in `provider-oauth.ts`, which shows `error.message`; for an undeclared HTTP status that message is the client's generic one. A failed code-mode `complete` moves the dialog to the failed phase with a Try again button (`submitCode`), so one attempt takes one paste.
- OpenCode's `Integration.Service` is a location node (`makeLocationNode`, `app-3hm8m6zg.js` line 565): every project location has its own `statuses` map, and each `setup(ctx)` gets a `ctx.integration` bound to its location. `ctx.integration.get` returns `{ location, data }` and rejects with `IntegrationNotFoundError` for an unknown id. `connection.status` publishes `integration.updated`, which OpenChamber's `events.ts` ignores, so an open Providers page shows a new `needs_auth` only after it reloads.
- `providerAuth.ts`, `getProviderCardStatus`: any connection with `needs_auth` shows "Sign in again"; one credential, or a non-empty `provider.settings.apiKey`, shows Connected.
- `ProvidersPage.tsx`: Disconnect and Remove only call `DELETE /api/credential/:id`.
- `ProviderAccounts.tsx`: the account row shows `status.message`; its Sign in button only opens `status.url`.

Result: the design works in OpenChamber with no UI change. Two prototype choices must change on the plugin side. `settings.apiKey = <proxy secret>` makes the card read Connected while signed out, and puts the proxy secret into provider settings. The loose auth-URL regex accepts any `accounts.google.com` path.

## 3. Configuration

Plugin options (`ctx.options`) and env overrides. These merge into the runtime design's `config.ts` as `resolveInstallAuthConfig(options, env)`.

```ts
export type AuthMethodId = "oauth-personal" | "oauth-business" | "gemini-api-key" | "agent-platform";
export type BinarySource = "managed" | "path" | "t3code";

export interface InstallAuthOptions {
  binaryPath?: string;          // explicit executable; wins over everything
  binarySource?: BinarySource;  // default "managed"
  autoUpdate?: boolean;         // default true
  offline?: boolean;            // default false; true never touches the network
  offlineFallback?: boolean;    // default true; PATH, then T3 cache, when managed is missing and install fails
  isolatedAuth?: boolean;       // default true
  geminiDir?: string;           // GEMINI_HOME override; default <data>/gemini
  authMethod?: AuthMethodId;    // default "oauth-personal"
  auth?: {                      // reserved for later methods, ignored by oauth-personal
    gcpProject?: string;
    gcpLocation?: string;
  };
}
```

| Option | Env | Default |
| --- | --- | --- |
| `binaryPath` | `OPENCODE_ANTIGRAVITY_BIN` | unset. Option wins over env |
| `binarySource` | `OPENCODE_ANTIGRAVITY_BINARY_SOURCE` | `managed` |
| `autoUpdate` | `OPENCODE_ANTIGRAVITY_AUTO_UPDATE=0` | `true` |
| `offline` | `OPENCODE_ANTIGRAVITY_OFFLINE=1` | `false` |
| `offlineFallback` | | `true` |
| `isolatedAuth` | `OPENCODE_ANTIGRAVITY_ISOLATED_AUTH=0` | `true` |
| `geminiDir` | `OPENCODE_ANTIGRAVITY_GEMINI_DIR` | `<data>/gemini` |
| data dir | `OPENCODE_ANTIGRAVITY_DATA_DIR`, else `$XDG_DATA_HOME/opencode-antigravity`, else `~/.local/share/opencode-antigravity` on every OS | |
| `authMethod` | | `oauth-personal` |
| `proxyPort` | `OPENCODE_ANTIGRAVITY_PROXY_PORT` | `0`, a random loopback port. Owned here because the runtime design delegates its default; it lives in the runtime's `config.ts` with the rest |

Every key: a set option wins over its env var, and the env var wins over the default. Booleans from env accept `1`, `true`, `yes` and `0`, `false`, `no`, case-insensitive; anything else is an issue and the default applies.

Validation, in `resolveInstallAuthConfig`, returns `{ config, issues: string[] }` and never throws:

- An unknown `authMethod` or `binarySource` is an issue; the value falls back to the default.
- A known but unsupported `authMethod` (`oauth-business`, `gemini-api-key`, `agent-platform`) stays in the config and produces the issue `Antigravity sign-in method "<id>" is not available in this plugin version. Use "oauth-personal" or remove authMethod.` The provider and the integration still register (section 10.1), with zero methods; every `/v1/chat/completions` request answers 401 `auth_required` with that text.
- `binaryPath` starting with `~/` or `~\` expands against the user's home. Any other relative path stays in the config as given and makes `resolveBinary()` fail with the section 5 step 1 message: an explicit path is never silently dropped in favor of the download.
- Issues log once to stderr with the `[opencode-antigravity]` prefix.

Singletons: `BinaryManager` and `AuthManager` are process-global and keyed by `(dataDir, geminiDir, isolatedAuth, binarySource, binaryPath)`. The first config for a key creates the instance. A later `setup` with the same key reuses it; one with a different key gets its own instance and logs `[opencode-antigravity] Two plugin configurations are active in one OpenCode process; they use separate profiles.` once.

Test-only injection, never env: `BinaryManager` and `AuthManager` constructors take `fetch`, `manifestBase`, `assetUrlCheck`, `clock`, `spawn` and timeouts. Production code has no way to point downloads at another host.

## 4. Files on disk

```
<data>/                                   ~/.local/share/opencode-antigravity, 0700
  bin/<platform>-<arch>/                  e.g. darwin-arm64, linux-x64, win32-x64
    .lock/                                cross-process lock dir (section 6.6)
      owner-<token>.json                  { pid, hostname, token, createdAt }, heartbeat by mtime
    active.json                           { "releaseId": "<64 hex>" }       0600
    manifest.json                         { target, fetchedAt, checkedAt, manifest, error? }
    previous.json                         { "releaseId": "<64 hex>" }, the release active before the current one
    progress.json                         { bytes, total }, written by the installing process
    versions/
      <releaseId>/                        0500 after activation
        antigravity | agy.exe             0555
        .install-complete.json            0400
      .install-<rand>/                    staging, removed on exit or after 1 h
  gemini/                                 GEMINI_HOME, isolated and shared modes, 0700
    .opencode-antigravity-profile         marker: this profile is plugin-owned
    antigravity-acp/                      0700
      settings.json                       { auth: { type }, toolPermission, gcp? }  0600
      acp_token.json                      agy-written, isolated mode only
      antigravity-oauth-token             agy-written, isolated mode only
      conversations/ brain/ log/ ...      agy-written
    config/agents/opencode-bridge.md      runtime design
  auth-epoch                              decimal counter, section 13.4
  locks/auth.lock/                        cross-process login/logout lock
  models.json                             unchanged
```

`.install-complete.json`:

```json
{
  "releaseId": "33f5617dc74f...",
  "version": "1.5.16",
  "sha512": "33f5617dc74f...d18",
  "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/darwin-arm/cli_mac_arm64.tar.gz",
  "executable": { "name": "antigravity", "bytes": 230641440 },
  "installedAt": "2026-11-25T01:46:00.000Z"
}
```

The first three fields and `executable` match T3 Code's record, so the same reader handles both caches.

## 5. Binary resolution order

`resolveBinary()` runs before every spawn (runtime design, section 3.2) and returns `{ path, version, source }`.

1. `binaryPath` option, else `OPENCODE_ANTIGRAVITY_BIN`. Must exist, be a regular file, executable on POSIX. Missing or not executable is a hard error, with no fallback: `The Antigravity executable at <path> is missing or not executable. Fix binaryPath or remove it to use the managed download.`
2. `binarySource: "path"`: every `agy` on `PATH` in order (Windows: `agy.exe`, honoring a case-insensitive `Path` key), then `~/.local/bin/agy`, `~/.antigravity/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`. Only `agy` is searched, as T3 Code does, because an `antigravity` on PATH can be the Antigravity IDE launcher. A candidate must be a regular file (`stat().isFile()`), executable, and pass the identity check below; a candidate that fails is skipped with one debug line naming the reason, and the search continues. None found: `binarySource is "path" but no agy executable is on PATH.` An explicit `binaryPath` may still name a file called `antigravity`.
3. `binarySource: "t3code"`: `${T3CODE_HOME:-~/.t3}/tools/antigravity-acp/<platform>-<arch>/active.json`, then `versions/<releaseId>/.install-complete.json`; accept only if both JSON files pass `lstat` as regular non-symlink files of at most 8 KiB, `releaseId` is 64 lowercase hex, the record's `releaseId` matches, the executable exists with exactly `executable.bytes`, and no path component is a symlink. Read-only; the plugin never writes under `~/.t3`. Not found: `binarySource is "t3code" but T3 Code has no Antigravity runtime installed.`
4. `binarySource: "managed"` (default):
   1. `active.json` present and its release inspects valid (`active.json` and the record pass `lstat` as regular non-symlink files of at most 8 KiB, record parses, sizes match, executable bit, no symlinks, path inside `versions/`): return it. Schedule an update check when due (section 6.8), without waiting.
   2. Otherwise install (section 6), holding the lock. Success: return the new release.
   3. Install failed, or `offline` is set: if `offlineFallback`, try step 2's PATH search, then step 3's T3 lookup. Use the first hit and log once: `[opencode-antigravity] Managed agy unavailable (<reason>); using <source> at <path>.`
   4. Nothing: throw `BinaryNotFoundError` with the install failure's message.

External binaries (steps 1 to 3 and fallbacks) get the identity check from section 6.5 once per `(realpath, size, mtimeMs)` in this process, so a non-agy file at `binaryPath` fails at once with a clear message. The version found there is what `resolveBinary()` returns.

`MIN_AGY_VERSION = "1.5.1"`. Older releases offer non-Gemini models only to allowlisted clients (T3, `antigravityClientInfo`) and predate prompt steering (1.5.0). A managed release below it is never activated. An external binary below it fails with `Antigravity <version> at <path> is too old; this plugin needs 1.5.1 or newer.`

## 6. Managed install

### 6.1 Platform target

```ts
export interface AgyTarget {
  key: string;          // "darwin_arm64", "linux_amd64_musl", "windows_amd64", ...
  folder: string;       // "darwin-arm", "linux-x64-musl", "windows-x64", ...
  assetName: string;    // "cli_mac_arm64.tar.gz", "cli_linux_x64_musl.tar.gz", "cli_windows_x64.exe"
  format: "tar.gz" | "executable";
  executableName: "antigravity" | "agy.exe";
  dirKey: string;       // `${process.platform}-${process.arch}`, the bin/ subdir
}
export function agyTarget(platform: NodeJS.Platform, arch: string, musl: boolean): AgyTarget | null;
export function detectMusl(): boolean;
```

Mapping, from T3's `antigravityCliTarget` and `parseAntigravityCliRelease`: platform `darwin`/`linux`/`win32`, arch `x64`/`arm64`; os token `mac`/`linux`/`windows`; cpu token `x64`/`arm64`; target arch `amd64`/`arm64`; folder arch `x64`/`arm`. `detectMusl()` is true on Linux when `/lib/libc.musl-x86_64.so.1` or `/lib/libc.musl-aarch64.so.1` exists. Any other platform or arch returns `null`.

### 6.2 Manifest

- `GET <base>/<target.key>.json` through `safeFetch` (section 6.3), `Accept: application/json`, 10 s timeout, allowed origin `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app`. Body cap 16 KiB.
- `parseManifest(json, target)` accepts exactly the T3 shape: `version` matches `^\d+\.\d+\.\d+$`, `sha512` matches `^[a-fA-F0-9]{128}$` (lowercased), and `url === "https://storage.googleapis.com/antigravity-public/antigravity-cli/" + version + "-" + /\d+/ + "/" + target.folder + "/" + target.assetName`. Extra fields are ignored. Anything else returns `null` and counts as a fetch failure.
- `manifest.json` caches the last good manifest with `fetchedAt`, and `checkedAt`/`error` for the last attempt. A failed fetch never overwrites the last good manifest and never reads as "no update": it is recorded as `error` and the next check is due in 30 min.

The manifest is unsigned. Trust rests on HTTPS to two Google hosts plus the SHA-512 it carries, the same trust T3 Code uses.

### 6.3 Download

`downloadAsset(manifest, stagingDir, opts): Promise<{ file: string; bytes: number }>`

`safeFetch(url, { allowedOrigins, signal, stallMs })`, used for the manifest and the asset:

- `fetch` with `redirect: "manual"` and `Accept-Encoding: identity`. A 301, 302, 303, 307 or 308 is followed by hand, at most 5 hops. Before each request, the target URL must be `https:`, have the default port, no userinfo, and an origin in `allowedOrigins`. Anything else aborts before any request goes there. The manifest allows only the update-service origin; the asset allows only `https://storage.googleapis.com`.
- The stall timer is armed before `fetch()` is awaited, so a server that never sends headers aborts after `stallMs` as well.
- A response with any `Content-Encoding` other than `identity` is refused: transparent decompression would break the length check and the digest.

Download steps:

1. Free space: `fs.statfs(versionsDir)` when available; require 700 MiB (archive plus executable, with margin). Below that: `Antigravity needs at least 700 MiB of free space in <dir> to install.` If `statfs` is missing or throws, skip the check.
2. `safeFetch(manifest.url, ...)` with `stallMs: 60_000`; status must be 200. If `Content-Length` is present it must be a positive integer of at most 512 MiB, else abort before reading the body.
3. Stream `response.body` into `<staging>/download`, opened `wx` mode 0600, updating a `createHash("sha512")` per chunk.
4. Caps: 512 MiB total; when `Content-Length` is present it must equal the bytes received; 60 s without a chunk aborts as a stall; 30 min total.
5. Compare the hex digest with `manifest.sha512` (lowercase, full 128 chars). Mismatch: delete the staging dir, error `The Antigravity download failed its checksum check. Nothing was installed.`

Progress: `BinaryManager.status()` reports `{ phase: "downloading", bytes, total }` updated at most every 250 ms. The runtime's status note and the sign-in wait use it.

### 6.4 Extract

- `format: "executable"` (Windows): copy `download` to `<staging>/runtime/agy.exe`.
- `format: "tar.gz"`: a built-in reader, no system `tar`. `zlib.createGunzip()` piped into a streaming tar parser that reads the whole archive to gzip EOF, so gunzip checks the CRC32 and ISIZE trailer, and:
  - reads 512-byte headers and verifies each header checksum (bytes 148..155: the unsigned byte sum of the header with that field read as spaces);
  - reads the size from octal field 124..135, or base-256 when the high bit is set; accepts magic `ustar\0` and GNU `ustar ` (verified in the real asset);
  - takes the name from bytes 0..99 and refuses a non-empty `ustar` prefix field (bytes 345..499); refuses names containing NUL, `\`, `..`, or starting with `/`;
  - accepts pax `x` and GNU `L` headers only before the executable entry, with payloads of at most 64 KiB, and uses only their `path`; a pax `size` override, a pax `g` header, or any other pax key that changes the entry is refused;
  - requires exactly one entry, of type `0` or `\0`, whose name after stripping a leading `./` equals `antigravity`, with size above 0;
  - after that entry and its padding, requires only zero blocks until EOF; a second entry, a directory, link, device, or any non-zero block is refused;
  - caps decompressed bytes at 513 MiB over the whole stream and the executable at 512 MiB;
  - writes `<staging>/runtime/antigravity` opened `wx` mode 0700; the file counts as extracted only after gzip EOF passes.
- Delete `download` after extraction. POSIX: `chmod 0755`.

Errors: `The Antigravity archive must contain exactly one executable.` and `Could not extract the Antigravity executable.`

### 6.5 Identity check

`verifyAgy(executablePath, expectedVersion | null, timeoutMs = 90_000)` spawns `agy acp --gemini-dir <tmp> --app-data-dir antigravity-acp --include-default-customizations=false --disable-telemetry` with a fresh temp `GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE=1`, `SSH_CONNECTION`, `AGY_CLI_DISABLE_AUTO_UPDATE=1`, sends `initialize`, and requires:

- `agentInfo.name === "Antigravity ACP Server"`;
- `agentInfo.version === expectedVersion` when one is given, and `>= MIN_AGY_VERSION`;
- `protocolVersion` 1 or 2;
- `agentCapabilities.auth.logout` present;
- `authMethods` contains `oauth-personal`.

Then it kills the child and removes the temp dir. The 90 s budget matches T3 Code: the first start of a fresh 230 MB executable on macOS can be slow while the system scans it. Failure messages follow T3's: stderr matching `AF_INET6|enforce_kernel_ipv6_support` gives `Antigravity needs IPv6 socket support. Enable IPv6 on this machine; on WSL remove ipv6.disable=1 from .wslconfig and run wsl --shutdown.`; `page-size.cc|Compile-time page size does not match` gives `Google's linux-arm64 Antigravity build needs a kernel with 4 KiB pages (Asahi Linux and Raspberry Pi 5 use larger ones). Set binaryPath to a compatible agy build.`; anything else gives `The downloaded Antigravity runtime could not start on this machine.`

### 6.6 Locking

Two levels.

In-process: `BinaryManager` is a process-global singleton under `Symbol.for("openchamber.opencode-antigravity.binary.v1")`, since setup runs once per OpenCode location and again on plugin reload. Concurrent `install()` calls share one promise.

Cross-process: `acquireDirLock(dir, opts)` in `src/install/lock.ts`:

```ts
export interface DirLock { readonly token: string; releaseSync(): void }
export function acquireDirLock(lockDir: string, opts: {
  staleMs?: number;       // 30_000, other hosts and unreadable owners only
  heartbeatMs?: number;   // 10_000
  waitMs?: number;        // how long to wait for a holder
  pollMs?: number;        // 500
  onWait?: (holder: { pid: number; hostname: string } | null) => void;
  signal?: AbortSignal;
}): Promise<DirLock>;
```

- Acquire: `mkdirSync(lockDir)` (atomic; `EEXIST` means held), then write `lockDir/owner-<token>.json` `{ pid, hostname, token, createdAt }` opened `wx`. The token is 16 random bytes in hex.
- Heartbeat: `utimes` on our owner file every `heartbeatMs` while held; timers are `unref()`ed. A file is used because it behaves the same on every OS.
- Stale check by a contender:
  - Owner file on this hostname: stale only when `process.kill(pid, 0)` throws `ESRCH`. A live pid is never stolen from, however old the heartbeat is; this keeps a holder that slept with the laptop. The cost is a pid reused by an unrelated process, which keeps the lock until `waitMs` runs out with the "another window" message.
  - Owner file from another hostname, or no readable owner file: stale when the newest mtime of the owner file, or of `lockDir` itself when there is none, is older than `staleMs`. A lock dir without an owner file is the normal gap right after `mkdir` and is never stale sooner.
  - Takeover: rename `lockDir` to `<lockDir>.stale-<rand>` (atomic; only one contender wins), remove that, retry `mkdir`.
- Release, `releaseSync()`, the same code from normal paths and from `process.on("exit")`: `unlinkSync(lockDir/owner-<ourToken>.json)`, then non-recursive `rmdirSync(lockDir)`. If the lock was taken over meanwhile, the unlink fails with `ENOENT` or the `rmdir` fails with `ENOTEMPTY`, so a foreign lock is never removed. The `exit` listener is added on acquire and removed on release.
- Install waits up to 35 min for another holder (download plus verify), polling. While it waits, `BinaryManager.status()` reports `{ phase: "waiting_for_lock" }` with the holder's progress read from `manifest.json`'s sibling `progress.json`, which the holder rewrites at most every second as `{ bytes, total }`. When the lock frees, the waiter re-inspects `active.json` first and reuses a release another process installed. Read paths (`resolveBinary` step 4.1) never take the lock: they read `active.json`, which only ever changes by atomic rename.
- A chat request does not wait 35 min in silence: the runtime starts its SSE stream after 2 s (its section 3.2 step 6) and shows `binaryStatus()` as status notes, so OpenCode's header timeout does not apply. `resolveBinary()` takes an optional `{ waitMs }`; sign-in passes 120 s (section 10.2).

The auth lock `<data>/locks/auth.lock` uses the same code with `waitMs: 0` (section 10.4).

### 6.7 Publish and activate

Inside the lock:

1. `releaseId = sha512.slice(0, 64)`. If `versions/<releaseId>` exists and inspects valid with the same version, run the identity check (section 6.5, which includes `MIN_AGY_VERSION`) on it, as T3 does before activating an existing directory, then skip to step 4.
2. Staging `versions/.install-<rand>/` (same filesystem, so the rename is atomic), download, extract, identity check with the manifest version.
3. Write `.install-complete.json` (`wx`, 0600), then POSIX: exec 0555, record 0400. Rename `staging/runtime` to `versions/<releaseId>`. If the destination exists but is damaged, rename it aside into staging as `displaced`, publish, and restore it if publishing fails (T3's rollback). Then dir 0500.
4. Read the current `active.json` releaseId, if any. Write `active.json.<rand>.tmp` (`wx`, 0600) with `{ "releaseId": ... }`, `fsync`, rename over `active.json`. This is the only commit point; a crash before it leaves the old release active. Then write `previous.json` the same way with the releaseId read at the start of this step, when it differs.
5. Step 4 failed before the rename: `chmod 0700` the new `versions/<releaseId>` and its files, remove it, restore `displaced` if there is one, and fail with `Could not activate Antigravity. The previous runtime is unchanged.` When the new dir was an existing valid release from step 1, it is kept.
6. Emit `onBinaryChanged({ path, version })` if the active path changed.
7. Prune (section 6.9). Remove staging.

Symlink rules from T3: refuse to install or resolve when `bin/<dirKey>`, `versions/`, a release dir, its executable or its record is a symlink (`lstat`), or when the `realpath` of the executable is outside `versions/`. Message: `The managed Antigravity directory contains a symbolic link. Delete <dir> and restart OpenCode to reinstall.`

Windows: every rename and remove retries up to 40 times, 250 ms apart, on `EPERM`, `EBUSY`, `EACCES` (antivirus scanners hold new files).

### 6.8 Update policy

- When: at plugin setup (background, after the provider is registered) and at each `resolveBinary()`, if `autoUpdate`, not `offline`, and the last check is older than 6 h (30 min after a failed check).
- What: fetch the manifest. If its version is greater than the active release's (semver compare) and `>= MIN_AGY_VERSION`, install it in the background. If it is equal or lower, keep the active release; the plugin never downgrades, matching T3 Code.
- Effect: the new release becomes active at step 4; the shared process keeps running on the old binary; `onBinaryChanged` lets the runtime restart once idle. A request never waits on an update.
- `autoUpdate: false`: the manifest is fetched only when no managed release exists. This is the pinning mechanism; the manifest only ever names the latest release, so pinning an older version means `autoUpdate: false` after it is installed, or `binaryPath`.
- First install: at plugin setup, if `binarySource` is `managed`, no explicit path is set, no active release exists and not `offline`, start `install()` in the background. A first request or sign-in that arrives meanwhile waits on the same promise (section 10.2 for the sign-in budget).

### 6.9 Cleanup

- Keep the active release, the release named in `previous.json`, and any release this process resolved since it started (an older process generation may still run from it). Remove the rest: `chmod 0700` the dir, then `rm -rf`. Failures are ignored and retried on the next prune. On POSIX, deleting a release another OpenCode process is running is safe: the inode stays until that process exits. On Windows the delete fails with `EBUSY` and is retried later.
- Staging dirs `.install-*` with mtime older than 1 h are removed at the start of every install and at setup.
- Locks: a stale `.lock.stale-*` left by a crash is removed when seen.
- The prototype's leftovers `opencode-agy-login-*` in `os.tmpdir()` are the runtime design's sweep (its section 3.6).

## 7. Platform handling

| Platform | Asset | Handling | Verified here |
| --- | --- | --- | --- |
| macOS arm64 | tar.gz | chmod; no quarantine xattr is set by `fetch`, so Gatekeeper does not prompt; the binary is signed by `EQHXZ8M8AV` | Manifest, download, SHA-512, tar layout, ACP initialize, `--login` output, sign-out probe |
| macOS x64 | tar.gz | Same. Under Rosetta, `process.arch` is `x64` and the x64 build is used | Manifest only |
| Linux x64, arm64, glibc or musl | tar.gz | Musl detection; `SSL_CERT_FILE` set to the first existing of `NIX_SSL_CERT_FILE`, `/etc/ssl/certs/ca-bundle.crt`, `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/cert.pem` when neither `SSL_CERT_FILE` nor `SSL_CERT_DIR` is set (T3 does this for NixOS); IPv6 and page-size messages | Manifest only |
| Windows x64, arm64 | .exe | No chmod or read-only dirs; rename/remove retries; `TEMP` and `TMP` set per spawn; `Path` key case-insensitive; data dir is `%USERPROFILE%\.local\share\opencode-antigravity` | Manifest only. Not run on Windows: process spawning of `agy.exe`, locked-file behavior, `--login` stdin handling |
| Anything else | none | `Google does not publish an Antigravity CLI for <platform>-<arch>. Set binaryPath to an agy executable.` | |

## 8. Messages a user sees

Binary messages surface through the runtime's `binary_not_found` failure (its section 6.6): HTTP 503 with `x-should-retry: false` when the SSE stream has not started, and a mid-stream error with code 400 `invalid_request_error` once it has, because OpenCode retries a mid-stream 503 up to 10 times. They also appear in the sign-in error. All are plain text with no paths to token files.

| When | Message |
| --- | --- |
| Download in progress at first use | `Downloading Google's Antigravity CLI (<n> of <m> MB). This happens once.` (status note while the request waits) |
| No network, nothing installed, no fallback | `Could not download Antigravity from Google: <reason>. Check the network connection and proxy settings, or set binaryPath.` |
| Manifest unreadable | `Google's Antigravity update service returned an unexpected answer. Try again later, or set binaryPath.` |
| Checksum | `The Antigravity download failed its checksum check. Nothing was installed.` |
| Size cap | `The Antigravity download is larger than expected. Nothing was installed.` |
| Disk | `Antigravity needs at least 700 MiB of free space in <dir> to install.` |
| Lock held too long | `Another OpenCode window is installing Antigravity. Try again in a minute.` |
| Identity check | from section 6.5 |
| Unsupported platform | from section 7 |
| Explicit path broken | from section 5 |
| Too old | from section 5 |
| Symlink | from section 6.7 |

## 9. Auth storage

### 9.1 Modes

| | Isolated (`isolatedAuth: true`, default) | Shared (`isolatedAuth: false`) |
| --- | --- | --- |
| `GEMINI_HOME`, `--gemini-dir` | `<data>/gemini` or `geminiDir` | same |
| `--app-data-dir` | `antigravity-acp` | same |
| `AGY_ACP_FORCE_FILE_STORAGE` | `1` | unset |
| Where tokens live | `<gemini>/antigravity-acp/acp_token.json`, `antigravity-oauth-token`, mode 0600, written by agy | OS keyring, as agy decides; agy falls back to files after a keyring timeout |
| Terminal `agy` sees the login | no | intended yes, unverified (section 17) |
| Plugin may delete token files | yes, as logout fallback, only in a plugin-owned profile (section 11.3) | never |
| Disconnect signs agy out | yes | no; Disconnect only stops OpenCode from using it (`docs/decisions.md`, install-auth follow-up 1) |

Both modes set `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0` for every spawn. With it, a signed-out `authenticate` returns `-32603 No browser is available here` at once (section 2.3); without it, agy may try to open a browser on the server machine during a status probe. The prototype set it only in isolated mode and left `isolatedAuth` undefined, so it ran file-isolated directories with keyring storage; both change.

### 9.2 Env per spawn kind

`buildAgyEnv({ kind, tmpDir })` with `kind: "runtime" | "login" | "probe" | "logout" | "verify"`:

1. Copy `process.env` minus `STRIPPED_ENV_KEYS` (unchanged list, which covers T3's). The comparison uses `key.toUpperCase()`, as T3 does, so on Windows a key like `Gemini_Api_Key` is stripped too.
2. Set `GEMINI_HOME`, `TMPDIR` (POSIX) or `TEMP`/`TMP` (Windows), `AGY_CLI_DISABLE_AUTO_UPDATE=1`, `PYTHONUNBUFFERED=1`, `SSH_CONNECTION`, and `AGY_ACP_FORCE_FILE_STORAGE=1` in isolated mode.
3. Linux CA bundle per section 7.
4. `login`: also remove `DISPLAY` and `WAYLAND_DISPLAY` (T3 does).
5. `AuthMethodSpec.spawnEnv(config)` adds method env; empty for `oauth-personal`.

Spawn args: `agyBaseArgs() = ["acp", "--gemini-dir", geminiHome, "--app-data-dir", "antigravity-acp"]`. The `verify`, `probe` and `logout` kinds add `--include-default-customizations=false --disable-telemetry`, so a quick check loads no default MCP servers or skills and sends no telemetry. Login appends only `--login`, the one combination verified to work; the opt-in test in 17.2 checks `--login --disable-telemetry` and the flag is added if it passes.

### 9.3 Profile settings and permissions

`updateProfileSettings(geminiHome, patch)` in `src/auth/settings.ts` is the one writer of `antigravity-acp/settings.json`. It reads, merges the patch over the existing keys, writes a temp file in the same dir and renames it, mode 0600. Calls in one process are serialized through a promise queue keyed by the file path. The auth design passes `{ auth, gcp }` before every login, logout, probe and runtime spawn; the runtime design's `prepareProfileDir` passes `{ toolPermission }` through the same function. Cross-process writes are rare and write the same values, so they take no lock.

On POSIX, `<data>`, `<data>/gemini` and `<data>/gemini/antigravity-acp` are created with mode 0700 and `chmod 0700` on every start, as T3 does for its profile, because they hold tokens and conversation databases. The marker file `.opencode-antigravity-profile` is created when the plugin creates the profile dir; `isPluginOwnedProfile()` is true when the marker exists.

## 10. Login

### 10.1 Registration

In every `setup`, whatever the config says:

```ts
ctx.integration.transform((integrations) => {
  integrations.update(INTEGRATION_ID, (info) => { info.name = PROVIDER_NAME; });
  if (issues.length === 0) for (const spec of supportedMethods(config)) spec.register(integrations, authManager);
});
```

The integration always exists, so OpenChamber finds it by provider id. With a config issue it has zero methods: `shouldShowApiKeyAuth` sees a defined integration without a key method and hides the key form, and the card shows a status. Skipping the transform would show a key form that fails with `IntegrationNotFoundError` (`providerAuth.ts`, `findIntegrationForProvider`, `shouldShowApiKeyAuth`).

`oauth-personal` registers `{ integrationID: "antigravity", method: { id: "oauth-personal", type: "oauth", label: "Sign in with Google" }, authorize, label }`. The provider registers without `settings.apiKey` (section 13.3).

### 10.2 `authorize()` sequence

`authorize()` calls run one at a time in this process, through a promise mutex in `AuthManager`. Each call gets an attempt id; the pending login, its abandon timer and its `callback` act only while their attempt id is still the current one, so a superseded attempt can never release the lock or hold of a newer one.

```
authorize()                                      under the in-process mutex
  1. config issue?                 -> throw issue text
  2. pending login in this process -> supersede: kill its child, clear its timer, mark its
                                      attempt id dead; keep the auth lock and the hold, which
                                      pass to this attempt
  3. no lock held by this process  -> auth lock (waitMs 0)
                                      held elsewhere: throw "Sign-in is already in progress in another OpenCode window."
  4. resolveBinary({ waitMs: 120 s }) -> waits for a running first install, else throws the download status text
  5. shared mode and no OpenCode credential and probe() == signed_in
                                   -> state signed_in, bump epoch ("login"), release lock,
                                      return { mode: "auto", url: "", instructions: SHARED_READY, callback: resolve(marker) }
  6. updateProfileSettings, runDir = await createRunDir("login") (runtime design), runtime.hold("login") unless step 2 passed one on
  7. spawn agy acp ... --login     stdin, stdout, stderr piped; child.stdin.on("error", ignore)
  8. read stdout until a line whose trim() starts with "https://accounts.google.com/"
       60 s timeout -> cleanup, throw "Antigravity did not start sign-in within 60 seconds."
       exit first   -> cleanup, throw "Antigravity sign-in exited early (exit <code>)." plus the last output line after redaction
  9. parseAuthUrl(line)            -> invalid: cleanup, throw "Antigravity returned an unexpected sign-in link."
 10. state login_pending; deadline = now + 5 min; abandon timer at deadline runs cleanup
 11. return { mode: "code", url, instructions: CODE_INSTRUCTIONS, expiresAt: deadline, callback }
```

`cleanup` for the current attempt: kill the child, `await runDir.release()` (the sweeper owns deleting the dir), release the hold, release the auth lock, and put the state back to what it was before step 10. It runs at most once per attempt.

Redaction for any agy output put into an error: drop the whole line when it contains `https://`, `state=`, `code=`, `token`, or an `@`; otherwise cut to 200 chars.

`CODE_INSTRUCTIONS`: `Sign in with Google in the browser tab that opened. Antigravity then shows an authorization code. Copy the code, or that page's full address, and paste it below.`

`SHARED_READY`: `Antigravity is already signed in on this machine. Connecting to it.`

Step 5 returns an empty URL, which OpenChamber does not open, and resolves at the first status poll. It applies in shared mode only: an isolated profile that is signed in without a credential is stale, and a full login replaces it. It runs after step 4, because the probe needs the binary.

The 120 s wait in step 4 keeps the dialog spinner honest for a typical download. A slower download fails with the progress message; the user retries.

### 10.3 `callback(code)`

OpenCode 2.3.0 settles a code-mode attempt on the first `callback` result: a rejection marks it failed (`Integration.oauth.complete`, `claim`, `app-3hm8m6zg.js`), and OpenChamber replaces the input with Try again. So every path through `callback` ends the attempt, and the whole body runs inside `try / finally { cleanup() }`.

1. If the attempt id is no longer current: throw `This sign-in was replaced by a newer one.` (the `finally` does nothing for a dead attempt).
2. Clear the abandon timer.
3. `checkLoginResponse(pending, code)`: trimmed value matches `/^[\w./~-]{1,2048}$/`, or is a URL whose origin and path equal `https://antigravity.google/oauth-callback`, with one `code`, one `state` equal to the URL's `state`, no userinfo, no hash, at most 16384 chars, no whitespace. Otherwise throw `That is not an Antigravity authorization code. Start sign-in again and paste the code, or the full address of the Antigravity page.` The check runs before anything is written, so a pasted newline can never put a second line on agy's stdin.
4. If the child already exited: throw `Antigravity sign-in stopped. Start sign-in again.`
5. Write `value + "\n"`, end stdin, wait for exit, 60 s timeout. A stdin `EPIPE` is ignored by the listener from 10.2 step 7; the exit code decides.
6. Exit 0: continue. Non-zero: map the last output line: `invalid_grant` gives `Google rejected that code. It may be expired or already used. Start sign-in again.`; `access_denied` or `cancelled` gives `Google sign-in was not approved. Start sign-in again.`; `SUBSCRIPTION_REQUIRED` gives `Google requires an eligible Antigravity subscription for this account.`; else `Antigravity could not finish Google sign-in. Start sign-in again.`
7. State `login_finalizing`. Verify: `probe()` must return `signed_in` within 30 s. A failure gives `Signed in, but Antigravity could not confirm access. Try again.` The probe also reads the account email in isolated mode (section 12.3).
8. Bump the auth epoch with reason `login`, or `account-changed` when the email differs from the last known one; emit `onAuthChanged`. State `signed_in`.
9. Clear `needs_auth` on every Antigravity connection in every attached location (section 13.3).
10. Return the marker credential:

```ts
{ type: "oauth", methodID: "oauth-personal", access: "agy-managed", refresh: "agy-managed", expires: 0,
  metadata: { profile: isolated ? "isolated" : "shared" } }
```

`label(credential)` returns `Google (<email>)` when the email is known and `undefined` otherwise. With `undefined`, OpenCode numbers the rows itself (`Antigravity`, `Antigravity 2`); a returned string is used verbatim, so two sign-ins with the same email give two rows with the same label.

### 10.4 Timeouts, concurrency, cleanup

| Stage | Limit | On expiry |
| --- | --- | --- |
| Binary wait | 120 s | throw download progress text |
| URL | 60 s | cleanup, throw |
| Waiting for paste | 5 min, also `expiresAt` | cleanup; OpenCode expires the attempt at the same time |
| Code exchange | 60 s | cleanup, throw |
| Verify probe | 30 s | cleanup, throw |

- One login per process: the mutex plus "latest wins" in 10.2 step 2. Cancel in OpenChamber closes the attempt in OpenCode without telling the plugin, so the next Connect in the same process must supersede the pending login, including the auth lock it holds.
- One login per profile across processes: the auth lock, held from 10.2 step 3 until that attempt's cleanup.
- Kill: SIGTERM, then SIGKILL after 3 s. `process.on("exit")` kills a pending child and calls the lock's `releaseSync()`.
- `AuthManager` is a process-global singleton (section 3), independent of the proxy pool, so a plugin reload during sign-in keeps the pending login and its callback.

### 10.5 Errors in OpenChamber

`code` mode is settled (`docs/decisions.md`). OpenCode 2.3.0 turns a rejected `authorize()` or code-mode `callback()` into a defect (section 2.4), so OpenChamber most likely shows a generic error in place of the texts above. The attempt's own status does record the message (`claim` squashes the cause), but OpenChamber does not poll status in code mode. The texts still go to OpenCode's log and to the plugin's stderr when `debug` is set. Not verified against a live server. The fix is upstream, to be reported separately: the promise adapter should use `Effect.tryPromise` for both, which the existing `authorize` mapper then turns into a 400 with the message. OpenChamber needs no change for that.

## 11. Logout

### 11.1 Location handles

OpenCode keeps integrations, connection statuses and credentials reads per location (section 2.5). `AuthManager` therefore keeps a set of attached locations, one per `setup(ctx)`:

```ts
interface LocationHandle { directory: string; integration: IntegrationDomain }
authManager.attach(handle): () => void;   // returned function is called from setup's cleanup
```

- Writes (`connection.status`) fan out to every attached handle. A failing handle, such as one whose location is closing, is skipped and logged under `debug`.
- Reads (`connection.active`, `get`) try attached handles in attach order and use the first that answers. `get` results are unwrapped from `{ location, data }`; `IntegrationNotFoundError` counts as "no connections in this location".
- `attach` pushes the current status to the new location at once: when the state is `signed_out` and that location lists Antigravity credentials, it marks them `needs_auth`.

### 11.2 Trigger

OpenChamber's Disconnect and Remove delete the OpenCode credential and nothing else. Each attached location runs:

```ts
for await (const event of ctx.event.subscribe({ types: ["credential.updated"], signal })) {
  if (event.data.integrationID !== INTEGRATION_ID) continue;
  authManager.onCredentialChanged();   // debounced 500 ms, process-global
}
```

`onCredentialChanged()`:

1. State `login_pending`, `login_finalizing` or `logging_out`: refresh statuses only. A Connect clicked right after Disconnect must not be signed out by the debounce.
2. Read `connection.active("antigravity")` through the handles. A credential left: refresh statuses only. No handle answered: do nothing, because a read failure must not read as "no credentials" and sign the user out.
3. None left: `logout("credential-removed")`.

The debounce and the singleton make one logout per change, however many locations subscribe. The loop's `AbortController` is aborted in the setup cleanup.

### 11.3 Sequence

```
logout(reason)
  1. take the in-process auth mutex (the one authorize() uses)
  2. auth lock, waitMs 10 s           fails: log, leave state unchanged, return
  3. try {
       state = logging_out             beforeSpawn() now waits (section 15)
       bump epoch, emit onAuthChanged({ reason: "logout" })
       await runtime.stop("auth-changed")   in-flight turns fail 401, process exits
       shared mode: skip the next step
       binary = resolveExistingBinary()     never downloads
       binary found: control process kind "logout": initialize,
         if capabilities.auth.logout: request "logout" {}
         else, or on error: fallback deletion
       binary missing: fallback deletion
       90 s overall timeout
     } finally {
       state = signed_out; release lock; release mutex
     }
```

Fallback deletion runs only when `isPluginOwnedProfile()` is true. It `lstat`s `antigravity-acp/acp_token.json` and `antigravity-acp/antigravity-oauth-token` and unlinks each one that is a regular file, never following a symlink. A profile the user pointed at with `geminiDir` and no marker keeps its files; the proxy gate still blocks requests.

`runtime.stop` is called once, here; the `onAuthChanged` listener in the runtime must not start a second stop for reason `logout`, or must return the same in-flight promise (section 15).

Logout failure keeps `signed_out` anyway: with no credential, the proxy refuses every request (section 13.3), so the sign-out takes effect in OpenCode even when agy could not be reached. The failure is logged.

## 12. Re-auth and signed out mid-session

### 12.1 Signed out mid-session

Cases: Google revoked the refresh token, the token files were deleted, terminal agy logged out in shared mode, or another OpenCode process logged out the same profile.

1. The runtime sees a sign-in error from `authenticate` at spawn, or from `session/new` or `session/prompt`. `isSignInRequired(err)` (section 15) classifies it.
2. The runtime fails the request with 401 `auth_required` and the text `Antigravity is signed out. Open Settings, Providers, Antigravity and connect again.`, and calls `install.reportSignInRequired()`.
3. `AuthManager` sets `signed_out` and marks every Antigravity connection in every attached location `needs_auth` with message `Signed out of Antigravity. Connect again to sign in.` OpenChamber's card shows "Sign in again" and the account row shows the message, after the Providers page reloads its integration list (section 2.5).
4. It asks the runtime to `stop("auth-changed")`, so a process with a dead session does not keep serving.

A probe timeout or crash is `unknown`, never `signed_out`; only the classified errors in section 15 set it.

### 12.2 Re-auth

The user clicks Connect again; section 10 runs. Effects:

- OpenCode adds another credential row, because every successful attempt inserts one (section 2.4) and the plugin cannot remove rows. With a known email both rows carry the same `Google (<email>)` label; without one OpenCode labels them `Antigravity` and `Antigravity 2`. The card then reads "2 accounts". Both rows point at the same agy login. Removing one leaves the other, and no logout happens until the last one goes.
- Step 9 of 10.3 clears `needs_auth` on every Antigravity connection in every attached location. Without it the old row keeps the card on "Sign in again".

### 12.3 Account email

In isolated mode, after a successful probe, `lstat` `antigravity-acp/antigravity-oauth-token` (regular file, at most 64 KiB), parse JSON, take only `id_token_email` when it is a string under 320 chars, and drop the rest of the object at once. Never log it, never put it in `/health`. Shared mode has no file to read; the label is left to OpenCode.

## 13. Auth status

### 13.1 State

```ts
export type AuthState =
  | { kind: "unknown" }
  | { kind: "signed_in"; checkedAt: number; email?: string }
  | { kind: "signed_out"; checkedAt: number; message: string; epoch: string }
  | { kind: "login_pending"; deadline: number }
  | { kind: "login_finalizing" }
  | { kind: "logging_out" };
```

```
unknown --probe/authenticate ok--> signed_in
unknown --sign-in error--> signed_out
signed_in --sign-in error--> signed_out
any --authorize()--> login_pending --code accepted by agy--> login_finalizing --probe ok--> signed_in
login_pending | login_finalizing --timeout/error/replaced--> previous state
any --logout()--> logging_out --> signed_out
signed_out --auth-epoch changed by another process--> unknown
```

`login_pending` is the paste wait, up to 5 min; spawns are allowed during it. `login_finalizing` lasts from agy's exit 0 to the end of the verify probe, at most 30 s; spawns wait during it.

### 13.2 Sources

- The runtime reports each `authenticate` result through `reportAuthenticated()` or `reportSignInRequired(message)`.
- `probe()`: resolve the binary without downloading, spawn kind `probe`, `initialize`, `authenticate { methodId }`, kill. 30 s timeout. Classifies: result means signed in; section 15 errors mean signed out; timeout, crash, missing binary or any other error means unknown. Used after login, by the shared-mode shortcut, and once at setup when a credential exists and the runtime has not started within 10 s, so a stale credential gets "Sign in again" without a chat message first.

### 13.3 Sinks

- OpenCode connection status: `needs_auth` on all Antigravity connections in all attached locations while `signed_out` and credentials exist; `undefined` when `signed_in`. Calls are skipped when the status already matches (OpenCode also deduplicates). OpenCode keeps these in memory per location, so the plugin re-derives them after every OpenCode restart and on every `attach`.
- Proxy gate, applied by the runtime design's proxy. `/v1/*` runs two independent checks, both required:
  1. `x-antigravity-proxy-token` must equal the per-process secret, compared in constant time. Failure: 401 `Unauthorized`. The prototype's fallback that also accepts `Authorization: Bearer <secret>` is removed, since `Authorization` now carries the marker. This check applies to every `/v1` route, `/v1/models` included.
  2. On `/v1/chat/completions` only: `Authorization` must be exactly `Bearer agy-managed`. Failure: 401 `auth_required`, `x-should-retry: false`, text `Sign in to Antigravity in Settings, Providers before using it.` The marker is a public constant, so it proves only that OpenCode holds an Antigravity credential; access control is check 1.
  OpenCode sends the marker as `apiKey` because the provider's `settings.apiKey` is now unset (section 2.4). Dropping `settings.apiKey` also fixes the card reading Connected while signed out, and keeps the proxy secret out of provider settings. Every request then depends on the `model.request` hook adding the proxy token; a request path that skips the hook fails with 401 `Unauthorized` (section 18).
- `/health` gains `auth: AuthState["kind"]` and `binary: { source, version, phase }`, with no email, path or token.

### 13.4 Auth epoch

`<data>/auth-epoch` holds a decimal counter. `bumpEpoch(reason)` increments it under the auth lock, writes by temp file and rename, and emits `onAuthChanged({ epoch, reason })`. `authEpoch()` returns the cached value and re-reads the file at most once per second, so a login in another OpenCode process changes the epoch here too; a change seen this way also emits `onAuthChanged` with reason `login`, and a `signed_out` state whose `epoch` differs from the file becomes `unknown`.

## 14. Seams for later methods

```ts
export interface AuthMethodSpec {
  id: AuthMethodId;
  label: string;
  supported: boolean;                                  // only oauth-personal is true now
  usesBrowserLogin: boolean;
  configIssue(config: InstallAuthConfig): string | null;
  profileSettings(config: InstallAuthConfig): { auth: { type: AuthMethodId }; gcp?: { project?: string; location?: string } };
  spawnEnv(config: InstallAuthConfig, credential?: CredentialValue): Record<string, string>;
  register(editor: IntegrationEditor, auth: AuthManager): void;
}
export const AUTH_METHODS: Record<AuthMethodId, AuthMethodSpec>;
export function supportedMethods(config: InstallAuthConfig): AuthMethodSpec[];
```

| Method | OpenCode method type | Config and credential | agy | Notes for later |
| --- | --- | --- | --- | --- |
| `oauth-personal` | `oauth`, code mode | none; marker credential | `--login`, file or keyring tokens | this design |
| `oauth-business` | `oauth`, with `form` fields `gcpProject`, `gcpLocation` | answers saved to `settings.json` `gcp` | `--login`, or ACP `authenticate` loopback flow, to be verified | T3 requires project and location |
| `gemini-api-key` | `key` | key stored by OpenCode, read with `connection.resolve` | env `GEMINI_API_KEY` at spawn | key change means a runtime restart; the proxy must ignore the key in `Authorization` and read it from the credential |
| `agent-platform` | `external` with form, or `key` | API key, or project plus location with ADC | env `GOOGLE_API_KEY`, or `gcp` in settings | OpenCode 2.3.0 allows one `key` method per integration (`sameMethod`), so this and `gemini-api-key` cannot both be `key` |

Adding a method touches only its spec in `src/auth/methods.ts`, its flow file, and tests. `STRIPPED_ENV_KEYS` stays as is; `spawnEnv` adds back what a method needs after stripping.

## 15. Interfaces to the runtime design

The runtime design (its section 9) asks for `InstallAuthBridge`. This design implements every member it lists and needs the members marked "added". The runtime doc has to adopt the added members and the requirements in 15.3 before implementation; until then the two docs disagree on exactly those points.

### 15.1 The bridge

```ts
export interface InstallAuthBridge {
  resolveBinary(opts?: { waitMs?: number }): Promise<{ path: string; version: string }>;
  buildSpawnEnv(input: { tmpDir: string }): Record<string, string>;   // = buildAgyEnv({ kind: "runtime", tmpDir })
  readonly geminiDir: string;
  readonly authMethod: string;
  authEpoch(): string;
  onAuthChanged(listener: (e: { epoch: string; reason: "login" | "logout" | "account-changed" }) => void): () => void;
  onBinaryChanged(listener: (e: { path: string; version: string }) => void): () => void;
  isSignInRequired(err: unknown): boolean;
  isPluginOwnedProfile(): boolean;
  /** added: before every spawn. Waits while login_finalizing or logging_out. Then, if signed_out after a
   *  logout and the auth epoch is unchanged, rejects with SignInRequiredError; otherwise resolves. */
  beforeSpawn(): Promise<void>;
  /** added: authenticate outcomes and classified mid-session sign-in errors */
  reportAuthenticated(): void;
  reportSignInRequired(message: string): void;
  /** added: download and lock-wait progress for status notes */
  binaryStatus(): BinaryStatus;
  /** added: the one writer of antigravity-acp/settings.json (section 9.3) */
  updateProfileSettings(patch: Record<string, unknown>): Promise<void>;
}

export type BinaryStatus =
  | { phase: "ready"; source: "explicit" | "managed" | "path" | "t3code"; version: string }
  | { phase: "downloading"; bytes: number; total: number | null }
  | { phase: "waiting_for_lock"; bytes: number | null; total: number | null }
  | { phase: "verifying" }
  | { phase: "missing"; message: string };
```

What it provides:

- `resolveBinary()` follows section 5. It may download on the first call and rejects with `BinaryNotFoundError` (`code = "binary_not_found"`, user message from section 8). It is cheap after the first call: one `stat` of `active.json` and the release. Every path it returns is kept from pruning for this process's lifetime, so a running generation's binary is never removed.
- `isSignInRequired(err)` is true for an `AcpError` with code `-32000`; code `-32603` with a message starting `No browser is available here`; any message containing `agy acp --login`; a `SignInUrlLineError`; and a `SignInRequiredError` from `beforeSpawn()`.
- `onAuthChanged` fires after the epoch file is written. For `logout`, `AuthManager` itself awaits `runtime.stop("auth-changed")` before calling ACP `logout`, which is how logout tears down the live process.
- `onBinaryChanged` fires after `active.json` is renamed, never for the release already running.
- Constants exported from `src/auth/errors.ts`: `AUTH_URL_STDOUT_PREFIX = "Open the following link to authenticate the ACP server: "`, `SignInUrlLineError`, `SignInRequiredError`, `SIGNED_OUT_MESSAGE`, `SIGN_IN_GATE_MESSAGE`.

### 15.2 What this design needs from the runtime

```ts
export interface RuntimeControl {
  stop(reason: "auth-changed"): Promise<void>;   // AgyProcessManager.stop
  hold(reason: "login"): Lease;                  // AgyProcessManager.hold
}
export type CreateRunDir = (kind: RunDirKind) => Promise<RunDir>;   // tmp-sweeper.ts; types live in src/contracts.ts
export interface RunDir { readonly path: string; release(): Promise<void> }
```

`AuthManager` receives these through `attachRuntime(control, createRunDir)` from `index.ts` once the pool exists. Before that, login works without the hold and uses a local `RunDir` over `mkdtemp` whose `release()` removes the dir. A live login's dir stays in the sweeper's live set until `release()`, so a sweep never deletes it.

### 15.3 Requirements the runtime doc must adopt

1. Spawn calls `beforeSpawn()`, then `resolveBinary()`, then `buildSpawnEnv` unmodified (its section 3.2). `resolveBinary` failing maps to `binary_not_found`: HTTP 503 with `x-should-retry: false` before the stream starts, code 400 `invalid_request_error` after it started. `beforeSpawn` rejecting maps to 401 `auth_required`.
2. While a spawn waits on `resolveBinary()`, the status notes (its section 6.3) show `binaryStatus()`: `downloading` gives `[Antigravity] Downloading Google's Antigravity CLI (<n> of <m> MB). This happens once.`; `waiting_for_lock` gives `[Antigravity] Another OpenCode window is installing Antigravity. Waiting for it.`
3. `AcpClient` checks every non-JSON stdout line and every stderr line for `AUTH_URL_STDOUT_PREFIX`, as T3 Code does on both streams. On a hit it rejects the pending requests of that process with `SignInUrlLineError` and kills that generation. Today the prototype drops non-JSON stdout lines, so a pending `authenticate` would hang.
4. After each `authenticate`, call `reportAuthenticated()` or, when `isSignInRequired`, `reportSignInRequired(message)`; the same for sign-in errors from `session/new` and `session/prompt`.
5. The proxy applies both checks in section 13.3, in that order, with the statuses and texts given there, and removes the `Authorization: Bearer <secret>` fallback.
6. `AgyProcessManager.stop()` is idempotent: while `stopping`, a second call returns the in-flight promise. The `onAuthChanged` listener does not start its own stop for reason `logout`, because `AuthManager` already does.
7. `prepareProfileDir` writes `toolPermission` through `updateProfileSettings`, never by its own read-modify-write.
8. The fake agy in `test/fixtures/mock-agy.ts` answers `initialize` with `agentInfo.name: "Antigravity ACP Server"`, `agentCapabilities.auth.logout: {}` and an `authMethods` entry `{ id: "oauth-personal" }`, so tests that pass it as `binaryPath` get through the identity check in section 6.5. A scenario switch turns each off for the identity-check tests.
9. `proxyPort` is defined in section 3 of this doc and lives in the runtime's `config.ts`.

### 15.4 Assumptions

- Idle shutdown only stops the shared `agy acp` process. Login runs its own `agy acp --login` child owned by `AuthManager`, so idle shutdown cannot end it; the `hold("login")` additionally keeps the pool from restarting mid sign-in, as the runtime design asks.
- The runtime never writes the `auth` or `gcp` keys of `settings.json`.
- The runtime fixes event subscription (`subscribe({ types, signal })`, `event.data`); this design's credential loop uses the same pattern.
- The runtime sends `protocolVersion: 1` in `initialize`, or accepts 1 in the reply (section 2.3).

## 16. Module layout

New and changed files under `src/`. The runtime design's `profile.ts` keeps the agent file and hooks and decides the `toolPermission` value; every write of `settings.json` goes through `src/auth/settings.ts`.

| File | Status | Exports |
| --- | --- | --- |
| `src/install/config.ts` | new | `InstallAuthOptions`, `InstallAuthConfig`, `resolveInstallAuthConfig(options, env)` |
| `src/install/paths.ts` | new | `resolveDataDir(env)`, `resolveGeminiDir(config, env)`, `managedDirs(dataDir, target)`, `PROFILE_MARKER` |
| `src/install/platform.ts` | new | `AgyTarget`, `agyTarget(platform, arch, musl)`, `detectMusl()`, `linuxCaBundle(env)` |
| `src/install/manifest.ts` | new | `MANIFEST_BASE`, `AgyManifest`, `parseManifest(json, target)`, `fetchManifest(target, deps)`, `readManifestCache`, `writeManifestCache` |
| `src/install/download.ts` | new | `safeFetch(url, opts)`, `downloadAsset(manifest, stagingDir, deps)` |
| `src/install/extract.ts` | new | `extractSingleExecutable(archive, dest, name)`, `TarFormatError` |
| `src/install/verify.ts` | new | `verifyAgy(path, expectedVersion, deps)`, `MIN_AGY_VERSION`, `compareSemver` |
| `src/install/lock.ts` | new | `acquireDirLock(dir, opts)`, `DirLock` |
| `src/install/release.ts` | new | `inspectRelease(dirs, releaseId)`, `installRelease(manifest, dirs, deps)`, `activateRelease`, `pruneReleases(dirs, keep)` |
| `src/install/resolve.ts` | new | `findOnPath(env)`, `findT3Binary(env)`, `checkExplicitBinary(path)` |
| `src/install/binary-manager.ts` | new | `BinaryManager` (singleton `getBinaryManager(config)`, keyed per section 3), `resolveExistingBinary()`, `BinaryNotFoundError`, `BinaryStatus` |
| `src/install/env.ts` | new, from `binary.ts` | `buildAgyEnv({ kind, tmpDir, config, baseEnv })`, `agyBaseArgs(geminiDir)` |
| `src/auth/methods.ts` | new | `AuthMethodSpec`, `AUTH_METHODS`, `supportedMethods(config)` |
| `src/auth/settings.ts` | new | `updateProfileSettings(geminiDir, patch)`, `authSettingsPatch(spec, config)`, `ensureProfileDirs(dataDir, geminiDir)` |
| `src/auth/login.ts` | new, from `auth.ts` | `startCodeLogin(deps)`, `parseAuthUrl(line)`, `checkLoginResponse(pending, value)`, `mapLoginFailure(text)` |
| `src/auth/probe.ts` | new | `probeAuth(deps): Promise<"signed_in" | "signed_out" | "unknown">`, `readAccountEmail(geminiDir)` |
| `src/auth/logout.ts` | new | `logoutProfile(deps)` |
| `src/auth/errors.ts` | new | `isSignInRequired(err)`, `SignInUrlLineError`, `SignInRequiredError`, `AUTH_URL_STDOUT_PREFIX`, `SIGNED_OUT_MESSAGE`, `SIGN_IN_GATE_MESSAGE`, `redactAgyOutput(line)` |
| `src/auth/epoch.ts` | new | `AuthEpoch` (`read`, `bump(reason)`) |
| `src/auth/manager.ts` | new | `AuthManager` (singleton `getAuthManager(config)`, keyed per section 3; `attach(handle)`, `attachRuntime(control, createRunDir)`), `AuthState`, `LocationHandle`, `RuntimeControl`, `createInstallAuthBridge(binary, auth): InstallAuthBridge` |
| `src/auth.ts` | removed | moved to `src/auth/login.ts` |
| `src/binary.ts` | removed | resolution to `src/install/*`, env to `src/install/env.ts`, `prepareProfileDir` to the runtime's `profile.ts` |
| `src/index.ts` | changed | builds config, singletons and bridge; always registers the integration, plus methods when the config has no issue; drops `settings.apiKey`; attaches its location to `AuthManager` and detaches it in cleanup; starts first install and update check in the background; runs the credential event loop |
| `src/auth/constants.ts` | new | `MARKER_ACCESS = "agy-managed"`, auth timeouts from section 10. `index.ts` and the runtime's proxy import it, so the auth package touches no shared file |
| `src/constants.ts` | changed | install timeouts from section 6 |

The `InstallAuthOptions` fields join the runtime design's options table under `config.ts`.

## 17. Test plan

`bun test test/`. Every test uses temp dirs under `os.tmpdir()`, injected `fetch`/clock/spawn where noted, and the shared fake agy `test/fixtures/mock-agy.ts` from the runtime design. No test touches `~/.t3`, `~/.gemini`, the keyring or the network unless marked opt-in.

### 17.1 Unit

`test/install-platform.test.ts`
- `agyTarget` table: all eight supported combinations give the key, folder, asset name, format and executable seen in the live manifests; `freebsd`, `ia32` and `linux` + `riscv64` give `null`.

`test/install-manifest.test.ts`
- Accepts the live `darwin_arm64` manifest verbatim; lowercases an uppercase `sha512`.
- Rejects: `version: "1.5"`, `sha512` of 127 chars, URL on another host, URL with another folder or asset name, URL with a non-numeric build segment, a `win32` manifest pointing at a tar.gz, a non-object body, a body over 16 KiB.
- A failed fetch leaves the cached good manifest in place and records `error`.

`test/install-download.test.ts` (local `Bun.serve`, injected host check)
- Good bytes: file written, digest matches.
- Digest mismatch: throws the checksum message, staging dir removed.
- `Content-Length` larger than the body, `Content-Length` over 512 MiB (refused before the body is read), body over the cap, 404, a redirect to a foreign host: each throws its message, nothing left behind.
- Redirects: `https` to `http` on the allowed host is refused before the second request; allowed host to foreign host to allowed host is refused at the foreign hop (the fixture server records that the foreign hop got no request); six hops is refused.
- Encoding: the request carries `Accept-Encoding: identity`; a response with `Content-Encoding: gzip` is refused.
- Stall: the server pauses longer than an injected 200 ms stall timeout mid-body, and in a second case before sending headers; both abort.

`test/install-extract.test.ts` (archives built in-test with a small tar writer and `zlib.gzipSync`)
- One `antigravity` entry, `ustar\0` and GNU `ustar ` magic, with and without `./` prefix: extracted byte-exact, mode 0700 before chmod.
- Rejected: two regular files; a directory entry; a symlink entry; `../antigravity`; `/antigravity`; a name with `\\` or NUL; another file name; a non-empty `ustar` prefix field with name `antigravity`; a bad header checksum; a non-zero block after the entry; truncated gzip; a corrupted gzip CRC; a 0-byte `antigravity`; entry larger than an injected cap; a gzip stream of zero blocks past the 513 MiB total cap (injected small cap); a pax `size` override; a pax `g` header; a pax or GNU `L` payload over 64 KiB.
- Accepted: a pax `x` header with only `path` before the entry; a GNU `L` long name `antigravity`; a base-256 size field.

`test/install-lock.test.ts`
- Second `acquireDirLock` with `waitMs: 0` fails while the first holds.
- Two child processes (`bun` scripts) race; exactly one holds at a time; both finish.
- Same host, dead pid: taken over. Same host, live pid (another `bun` child that sleeps), heartbeat older than `staleMs` as after laptop sleep: not taken over.
- Other hostname with an owner file older than `staleMs`: taken over. Lock dir with no owner file and a fresh mtime, as right after `mkdir`: not taken over; the same with mtime older than `staleMs`: taken over.
- Release only removes its own lock: after a takeover, the old holder's `releaseSync()` leaves the new lock in place (`ENOENT`, then `ENOTEMPTY`).
- `releaseSync()` runs from a child's `process.on("exit")` and the lock dir is gone afterwards; acquiring and releasing 20 times leaves no extra `exit` listeners.

`test/install-release.test.ts` (fake manifest server; the asset wraps a mock agy that answers `initialize` like 1.5.15 with a configurable version)
- Fresh install: `active.json`, record fields, POSIX modes 0555/0400/0500, staging gone.
- Same release twice: no second download (server hit count 1).
- Identity check fails (wrong `agentInfo.name`, wrong version, missing `auth.logout`): nothing activated, previous `active.json` unchanged.
- Version below `MIN_AGY_VERSION`: refused.
- `active.json` pointing at a missing dir: inspect is repairable, the next resolve reinstalls.
- Executable size changed on disk: inspect reports changed, reinstall.
- Symlinked `versions/`: refused with the symlink message.
- Two processes install at once: one download, both end with the same active release.
- Prune keeps active, the `previous.json` release and in-process-resolved releases, removes others, ignores a failing delete.
- An existing valid release dir reached through step 1 still runs the identity check; one below `MIN_AGY_VERSION` is not activated.
- Activation failure injected at the `active.json` rename: the new release dir is removed, a displaced dir is restored, `active.json` is unchanged.
- `active.json` or the record replaced by a symlink, or grown past 8 KiB: refused.
- Stale `.install-*` older than 1 h removed; younger kept.

`test/install-resolve.test.ts`
- Order: explicit option beats env beats source; explicit broken path throws with no fallback.
- `binarySource: "path"` finds a fake `agy` on an injected `PATH`; Windows-style `Path` key honored; an `antigravity` on PATH is ignored; a directory named `agy` and an `agy` that fails the identity check are skipped and the next `PATH` entry is used.
- A relative `binaryPath` such as `bin/agy` fails with the section 5 step 1 message and never downloads.
- `binarySource: "t3code"` with a fixture `~/.t3`-style tree under `T3CODE_HOME`: valid tree resolves; size mismatch, non-hex `releaseId`, record id mismatch and symlinked executable are refused.
- Managed with an unreachable manifest and `offlineFallback: true`: PATH hit used, one log line; `offlineFallback: false`: `BinaryNotFoundError`.
- `offline: true`: no fetch call at all.
- Update: manifest newer, background install, `onBinaryChanged` fires once; manifest older: no install.

`test/auth-login.test.ts` (mock agy `--login` printing the exact text from section 2.3, reading one stdin line, exiting 0 on `good-code` after writing a fake `antigravity-oauth-token` with `id_token_email`, printing the real `invalid_grant` line and exiting 1 otherwise, printing `login cancelled...` on EOF)
- `parseAuthUrl`: the real URL shape passes; `/o/oauth2/v2/auth`, wrong redirect, two `state` params, a hash, userinfo, over 16384 chars all fail.
- `checkLoginResponse`: plain code passes; callback URL with matching `state` passes; wrong `state`, two `code`, `code\nother`, embedded space, wrong origin all fail without writing to stdin.
- Success: credential is the marker, `label` gives `Google (<email>)`, epoch bumped with `login`, `onAuthChanged` fired, `needs_auth` cleared on two fake connections, child gone, `RunDir.release()` called once on the fake `CreateRunDir`, lock released. Without the token file, `label` returns `undefined`.
- Bad code: `callback` rejects with the `invalid_grant` message; child reaped.
- Bad paste (fails `checkLoginResponse`): `callback` rejects, nothing written to stdin, and child, `RunDir`, hold and auth lock are all released, so a new `authorize()` succeeds at once.
- Cancel then Connect in one process: the first attempt is never completed, a second `authorize()` succeeds without waiting for the abandon timer, and the first attempt's late abandon timer does not release the second attempt's lock or hold.
- The child exits right before the code is written: no unhandled `EPIPE`; `callback` rejects with the stopped message.
- Abandon timer (injected 100 ms): child killed, lock and hold released.
- Second `authorize()` while pending: first child killed, first `callback` rejects with the replaced message.
- Child exits before the URL; no URL within an injected timeout: both reject and clean up.
- Auth lock held by another process: `authorize()` rejects at once.
- Shared mode with a probe answering signed in and no credential: returns `mode: "auto"`, empty `url`, resolved callback, state `signed_in`, epoch bumped, auth lock released; isolated mode with the same probe runs the full login.
- Early-exit error text contains no line with `https://`, `state=`, `code=`, `token` or `@`.
- `hold("login")` taken at step 6 and released in every exit path.

`test/auth-probe.test.ts` (mock ACP)
- `authenticate` result: `signed_in`. Error `-32603` with the real `No browser is available here...` text: `signed_out`. Error `-32000`: `signed_out`. The stdout auth-URL line: `signed_out`, process killed. Timeout and crash: `unknown`.
- `isSignInRequired` truth table for the same inputs plus an unrelated `-32603` (`false`).
- `readAccountEmail`: valid file gives the email; missing file, bad JSON, non-string or 400-char email give `undefined`.

`test/auth-logout.test.ts`
- Mock ACP supporting `logout`: order is epoch bump, `runtime.stop` awaited, then `logout` request (recorded by the mock); state `signed_out`.
- Mock without `auth.logout`: token files deleted in an isolated plugin-owned profile; nothing deleted in shared mode, in a profile without the marker, or when a token path is a symlink.
- Mock that hangs: 90 s budget (injected 200 ms) ends in `signed_out` with a logged failure.
- No installed binary: logout does not download (fetch spy not called) and uses the file fallback.
- Auth lock held by another process past 10 s: state stays as it was, `beforeSpawn()` does not block.
- `runtime.stop` is called exactly once per logout.
- `beforeSpawn()` waits during logout, then rejects with `SignInRequiredError`; after another process bumps `auth-epoch`, it resolves.

`test/auth-manager.test.ts` (fake `ctx.integration` recording calls)
- `reportSignInRequired` with two credentials: `connection.status` called with `needs_auth` for both; with zero credentials: no call.
- `reportAuthenticated` after that: status cleared for both.
- `credential.updated` delivered to three subscribed locations with zero credentials left: one logout. With one left: no logout.
- `connection.active` throwing in every handle: no logout.
- `credential.updated` with zero credentials while `login_pending`: no logout, the login completes.
- Three attached locations: `reportSignInRequired` calls `connection.status` in all three; one handle that throws does not stop the other two; after one location detaches, it gets no more calls; a location attached while `signed_out` gets `needs_auth` at once.
- `get` returning `{ location, data }` is unwrapped; `IntegrationNotFoundError` counts as no connections.
- Epoch file changed by another process: `authEpoch()` picks it up within one second and fires `onAuthChanged`.

`test/config.test.ts`
- Defaults: `isolatedAuth: true`, `binarySource: "managed"`, `autoUpdate: true`, `authMethod: "oauth-personal"`.
- Unsupported `authMethod` keeps the value and yields the issue text; unknown values fall back with an issue.
- Env overrides from section 3; option beats env for every key; booleans `1`, `true`, `yes`, `0`, `false`, `no` in any case; `maybe` is an issue and the default applies.
- Two configurations in one process with different `geminiDir`: two `AuthManager` instances and one log line.

`test/plugin.test.ts` (changed)
- `buildAgyEnv`: `SSH_CONNECTION` set in both modes; `AGY_ACP_FORCE_FILE_STORAGE` only when isolated; `DISPLAY` removed only for `login`; `Gemini_Api_Key` and `google_api_key` stripped; Linux CA bundle chosen from a fixture list.
- `agyBaseArgs` plus kind flags: `verify`, `probe` and `logout` carry `--include-default-customizations=false --disable-telemetry`; `login` carries only `--login`.
- The provider registered by `setup` has no `settings.apiKey`; the integration method has id `oauth-personal`; with an unsupported `authMethod`, the `antigravity` integration still registers with its name and zero methods.
- `updateProfileSettings`: two concurrent patches (`auth` and `toolPermission`) both survive; mode 0600; POSIX profile dirs are 0700.

`test/e2e/auth-bridge.test.ts` (owned by the runtime package, which owns `proxy.ts`; these cases reach it as a change request)
- Chat request with the proxy token and without `Authorization: Bearer agy-managed`: 401 `auth_required`, `x-should-retry: false`, section 13.3 text. With both: passes.
- `Authorization: Bearer agy-managed` without `x-antigravity-proxy-token`: 401 `Unauthorized`. `Authorization: Bearer <secret>` alone, the old fallback: 401 `Unauthorized`. `/v1/models` without the proxy token: 401.
- Mock ACP that prints the auth-URL line on `authenticate`: request answers 401 and `reportSignInRequired` is called, no hang.

### 17.2 Opt-in end to end

Gated by `AGY_E2E=1`, run on demand, never in the default suite.

`test/e2e-install.test.ts`
1. Real manifest and download into a temp data dir: SHA-512 verified, archive extracted, identity check passes with the manifest version, `resolveBinary()` returns it. Records duration and size.
2. Same data dir, second run: no download.
3. Real binary, empty profile: `probeAuth()` returns `signed_out` in under 5 s.
4. Real binary `--login`: URL parses with `parseAuthUrl`; writing `bad` exits 1 with the `invalid_grant` mapping. No real sign-in.
5. Real binary `--login --disable-telemetry`: same output as step 4. If it passes, section 9.2 adds the flag to login.

### 17.3 Manual, before release

With a real Google account, OpenCode 2.3.0 and OpenChamber, on macOS arm64 and one Linux x64 machine:

1. Fresh data dir, plugin loaded: download happens in the background; Settings, Providers, Antigravity shows "Sign in needed".
2. Connect: browser opens, paste the code, card shows Connected, label shows the email, a chat turn works.
3. Restart OpenCode: still Connected, no download.
4. Delete `antigravity-acp/acp_token.json` and `antigravity-oauth-token`, send a message: 401 text in the chat; after reopening Settings, Providers, the card shows "Sign in again". With Providers left open, the card does not change until it reloads (section 18).
5. Connect again: card shows "2 accounts" with the same email label twice, no "Sign in again", chat works.
6. Remove one account: still signed in. Remove the last: token files gone, chat answers the sign-in text.
7. `isolatedAuth: false` with terminal `agy` signed in: Connect connects without a browser (shared shortcut), chat works, terminal `agy` stays signed in after Disconnect. This step answers the shared-mode risks in section 18.
8. `--login` on an already signed-in isolated profile with a second account: tokens replaced, epoch reason `account-changed`.
9. Two OpenCode processes on one data dir started together on a fresh dir: one download.
10. Windows x64, when a machine is available: steps 1, 2, 6 and 9.
11. Two projects open in OpenChamber: after step 4, both projects' Providers pages show "Sign in again".

## 18. Open risks

1. Plugin errors during sign-in most likely show as a generic error in OpenChamber (section 10.5). Cause in OpenCode's promise adapter; not verified on a live server.
2. `agy acp --login` on a profile that is already signed in was not run; this design assumes it replaces the tokens (manual step 8).
3. Shared mode is unverified: whether agy reads the keyring with `SSH_CONNECTION` set, and whether a login stored by terminal `agy` (gemini dir `~/.gemini`, app data dir `antigravity-cli`) is visible to a profile with another gemini dir. If either fails, shared mode needs a different gemini dir or env, which changes section 9.1 only.
4. Re-auth adds a credential row that the plugin cannot remove (section 12.2).
5. ACP `logout` was not run: its result and which files it clears are taken from T3 Code's code. The file-delete fallback covers isolated mode.
6. Linux and Windows were verified only up to the manifest and asset URLs. Windows file locking, `agy.exe` stdin handling and paths are untested.
7. No withdrawn-release list: T3 Code checks versions against its own compatibility manifest; this plugin trusts Google's manifest and never downgrades, so a pulled release stays until Google publishes a newer one or the user sets `binaryPath`.
8. Disk: each release is about 230 MB unpacked; two are kept.
9. agy answers `protocolVersion: 1` when the client asks for 2. The runtime should send 1, or accept 1 in the reply.
10. The account email comes from an agy-internal file format (`id_token_email`), which may change without notice; the label then falls back to OpenCode's numbering.
11. OpenChamber ignores `integration.updated`, the only event `connection.status` publishes, so an open Providers page shows a new "Sign in again" only after it reloads. Fixing that is an OpenChamber change in `packages/ui/src/lib/opencode/events.ts`, outside this plugin.
12. Without `settings.apiKey`, every model request depends on the `model.request` hook adding the proxy token. A request path in OpenCode that skips the hook fails with 401 `Unauthorized`; the e2e test and manual step 2 cover chat, titles and compaction.

## 19. Settled questions

Both questions this design raised are settled in `docs/decisions.md`: Disconnect in shared mode does not sign terminal agy out of the keyring, and the OAuth method uses `code` mode.

## Review response

Response to `docs/review-plan-install-auth.neon.md`. Each finding was checked against the cited source before the change.

| Id | Result | Reason |
| --- | --- | --- |
| IA-1 | Fixed | Holds: step 2 took the lock the pending login still held. 10.2 now supersedes first under an in-process mutex, hands the lock and hold to the new attempt, and guards timers and callbacks with an attempt id |
| IA-2 | Fixed | Holds: `Integration.oauth.complete` settles a code-mode attempt on the first rejection (`claim`, `app-3hm8m6zg.js`) and `submitCode` shows Try again. 10.3 now runs entirely inside `try / finally { cleanup() }` and the text says to start again |
| IA-3 | Fixed | Holds: `Integration.Service` is a `makeLocationNode` with its own `statuses`, and `get` returns `{ location, data }`. New 11.1: `AuthManager.attach(handle)` per setup, fan-out writes, ordered reads, status push on attach, `.data` unwrap, `IntegrationNotFoundError` handled |
| IA-4 | Fixed | Holds: the runtime doc's bridge lacks the added members. 15.3 now lists nine requirements the runtime doc must adopt, including `binaryStatus()`, `updateProfileSettings`, `SignInUrlLineError` on stdout and stderr, the proxy gate, mock-agy fields and `proxyPort` |
| IA-5 | Fixed | Holds: "stops at the end of the entry" contradicted the trailing checks. 6.4 now reads to gzip EOF and adds header checksum, prefix, NUL and backslash, pax and `L` caps, total cap and 0-byte checks |
| IA-6 | Fixed | Holds. 6.3 adds `safeFetch`: manual redirects up to 5 hops with `https`, default port and origin checked before each hop, `Accept-Encoding: identity`, `Content-Encoding` refused, `Content-Length` cap up front, stall timer armed before headers |
| IA-7 | Fixed | Holds, with one sub-point kept as a precaution: Windows directory `utimes` likely works through libuv, but the heartbeat now touches an owner file anyway. 6.6 adds `wx` owner files, a synchronous token-scoped release, no same-host steal from a live pid, the `waiting_for_lock` phase and a `waitMs` option |
| IA-8 | Fixed | Holds. 11.2 and 11.3: no logout during `login_pending`, `login_finalizing` or `logging_out`; `try / finally` resets state; `resolveExistingBinary()` never downloads; one `runtime.stop`; new `login_finalizing` state; `beforeSpawn()` rechecks the epoch |
| IA-9 | Fixed | Holds: the prototype's OR check plus a public marker would bypass the secret. 13.3 now requires both checks in order and drops the `Bearer <secret>` fallback |
| IA-10 | Fixed | Holds: `shouldShowApiKeyAuth(undefined)` is true. 10.1 always registers the integration, with zero methods on a config issue; 10.2 resolves the binary before the shared-mode probe and sets state, epoch and lock in that path |
| IA-11 | Fixed | Holds for all seven points: 0700 profile dirs, `lstat` and 8 KiB caps on records, case-insensitive env stripping, redacted error snippets, a stdin `error` listener, one serialized `updateProfileSettings`, and fallback deletion only in a plugin-owned profile without following symlinks |
| IA-12 | Fixed | Holds. `previous.json` records the prior release; step 1 hits run the identity check; a failed activation removes the new dir and restores a displaced one |
| IA-13 | Fixed | Holds. Relative `binaryPath` stays a hard error; option over env and boolean parsing for every key; PATH searches only `agy`, requires `isFile()` and skips failing candidates; singletons keyed by profile config |
| IA-14 | Fixed | Holds for all three: `label()` returns `undefined` without an email and 12.2 describes same-label rows; 2.5 cites `describeOAuthError`; the `integration.updated` refresh gap is in 2.5, 12.1, risk 11 and manual step 4 |
| IA-15 | Fixed | Holds. `verify`, `probe` and `logout` add `--include-default-customizations=false --disable-telemetry`; login keeps `--login` only, and opt-in step 5 tests the telemetry flag with it |
| IA-16 | Fixed | Holds. Section 19 now points to `docs/decisions.md`; 9.1 and 10.5 cite it |
| IA-17 | Fixed | Holds. 17.1 adds the listed cases to the extract, download, lock, release, resolve, login, logout, manager, config, plugin and proxy-gate test files |
| AR-1 | Fixed | `docs/architecture.md`: a bare path cannot leave the sweeper's live set. `CreateRunDir` is now `(kind) => Promise<RunDir>` with `release()`, which login calls in its cleanup (10.2, 15.2) |
| AR-2 | Fixed | `docs/architecture.md`: a mid-stream 503 has no headers and OpenCode retries it 10 times. `binary_not_found` is 503 with `x-should-retry: false` before the stream and code 400 `invalid_request_error` after (8, 15.3) |
| AR-3 | Fixed | `MARKER_ACCESS` moves to `src/auth/constants.ts`, and the proxy-gate cases move to `test/e2e/auth-bridge.test.ts`, owned by the runtime package (16, 17.1) |
