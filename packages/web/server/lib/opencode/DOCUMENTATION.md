# OpenCode Module Documentation

## Purpose
This module provides OpenCode server integration utilities for the web server runtime, including configuration management and provider authentication.

Diagnostic logging for the timeline export (`proxy.js` error lines, the lifecycle journal, the local diagnostics route in `../server-frame/core-routes.js`) is described in `../diagnostics/DOCUMENTATION.md`.

## Ownership

This module owns the web server's OpenCode connection, managed process, and configuration adapters. Feature runtimes own the services composed here; UI sessions and passkeys belong to `../ui-auth`, and folder trust belongs to `../opencode-trust`. Shared configuration adapters also serve the VS Code extension host.

OpenChamber's own server features live beside it: settings persistence in `../settings`, the server frame (CLI, bootstrap, core routes, startup, shutdown, route composition) in `../server-frame`, themes, icons, logos and the PWA manifest in `../appearance`, OpenChamber's update routes in `../self-update`, snippets in `../snippets` and npm registry reads in `../npm`. A file here does not import from `../settings`, `../appearance`, `../server-frame`, `../self-update` or `../snippets`; the `openchamber/no-app-imports-in-opencode` lint rule enforces it and lists each deliberate exception with its reason.

## Invariants

- Credential sources resolve URL and authentication headers on each call because a managed restart can change both. Browser-login renewal creates the active replacement before deleting the old row, so host requests retain a login throughout; a row changed during token exchange wins over the exchanged tokens. Refresh tokens remain with OpenCode and the issuer exchange.
- Authorization-header redaction runs before generic key/value redaction. An unquoted authorization value contains a scheme and a credential separated by whitespace, so redacting only its first word exposes the credential.
- Disabled agents and providers remain discoverable from their configuration files because OpenCode omits them from its live catalogs and Settings must offer a way to enable them again.
- Partial agent updates preserve the caller's entity and translate cleared legacy fields to their native locations. A file-backed system prompt retains its reference while the referenced file receives the edit.
- Agent and command names are relative paths inside their owned directories. Express decodes encoded separators, so validation accepts nested names while refusing absolute paths and traversal. The disabled-agent catalog has a separate route so an agent named `disabled` remains addressable.
- MCP conversion preserves handwritten protocol and startup-timeout fields even though the editor has no controls for them. Agent markdown bodies override frontmatter `system`, matching OpenCode's reader.
- The minimum OpenCode version agrees with `engines.opencode` in the web package manifest. A future major remains unsupported until its contract is checked.
- A managed OpenCode, in the web server and the VS Code extension alike, starts with `OPENCODE_CLIENT=openchamber` (`managed-opencode-env.ts`), so its model requests carry `x-opencode-client: openchamber` and the `openchamber` user-agent suffix, and OpenCode can tell OpenChamber's traffic apart. An external OpenCode keeps its own name.
- An external connection requires explicit host, port, or skip-start configuration. Automatic attachment to a default port can take over a user's independent OpenCode instance and couple unrelated lifecycles.
- A pending restart with a stopped-process task runs that task in its own restart, even if another restart is already in flight. Task failure is reported after the managed server starts again so a failed upgrade does not leave it stopped.
- Process-registry cleanup considers only recorded children, verifies their current executable and known port against PID reuse, and requires evidence that the owner is gone. EPERM means a PID still exists; an identity that cannot be verified stays untouched.
- Instance-directory cleanup assumes a shared PID namespace. Registry storage and reaping also have a VS Code implementation that must retain the same on-disk contract.
- Message shells keep subagent results whole because older OpenCode versions put the child-session reference there. File-edit results also stay whole because their useful diff is already in metadata and shelling their short text saves no meaningful bytes. Shelled OpenChamber envelopes retain the outcome as well as the action so failed calls cannot read as successful actions.
- Pending permissions and forms are seeded from the upstream stream because reading a directory's pending list can initialize that location. Replies without a request ID clear that kind's unverifiable pending request; turn end clears permissions and waiting pages, and restart clears all pending requests.
- Running-image checks stop counting jobs older than OpenCode's image timeout plus a minute. An interrupted generation can remain listed after an OpenCode restart and otherwise hold a goal indefinitely.
- Skill-list fetch failure remains distinct from an authoritative empty list. Partial local discovery reports its incompleteness, and process-level discovery flags travel with the list because browsers cannot infer which external roots OpenCode enables. Built-in skill IDs remain separate from display names because policy statements use IDs.
- Skill installation provenance refines the Installed badge; provenance-write failure cannot fail a completed installation or deletion. Roots discovered in both user and project scope share disk reads while retaining discovery order and project precedence.
- Skill supporting-file walks and repeated ancestor probes stay out of list enrichment because bundled environments can contain thousands of files. Skill mutation serialization and exclusive creation protect the check-then-write interval against concurrent requests and processes.
- Installer options come only from host-owned callers. Commands, destinations, versions, URLs, and environments are never request-controlled, and installer output is discarded because it can contain registry or environment secrets. Windows extraction uses the system `tar.exe` because Git Bash tar interprets a drive-letter path as a remote host.

## Decisions

### Why the retired opencode-claude plugin is removed, and Bun is not shimmed

`@openchamber/opencode-claude` served Claude as the `claude-code` provider until OpenCode 2.2.3 shipped the same provider as `claude-agent`. It calls `Bun.serve` when it loads, so the desktop's bundled OpenCode, which runs on Node, fails every Claude turn with "Bun is not defined" while it is listed. Before each managed start, `retired-plugins.ts` removes it from the global config files. Once OpenCode answers, it connects Claude Agent through the Claude Code login, unless Claude Agent already has a connection, and the UI shows a toast that says which of the two happened (`opencode-claude-retired`, `opencode-claude-retired-unconnected`).

Saved `claude-code/...` selections are not carried over. The plugin stored concrete model IDs that Claude Agent mostly lists under aliases, and mapping them would change model resolution for every user, so the toast asks the user to pick Claude models again. A folder config is left as written, because it may be someone else's repository; a policy deny there loses to an earlier allow and would add a parse of `OPENCODE_CONFIG_CONTENT` to every launch, so none is added. An external OpenCode runs on Bun, where the plugin still works, so it is left alone. A partial `globalThis.Bun` would make other Bun-only plugins fail later and less clearly, so it stays out.

### Why config and wire fields stay unchecked until use

Markdown frontmatter can be any YAML value. `MarkdownDocument.frontmatter`
therefore stays `unknown`; the skill reader checks each name and description,
and the agent reader uses the canonical entity conversion. Agent updates keep
unvalidated fields until that same conversion runs.

MCP assignment files validate only their JSON object container. Their entries,
OAuth response fields and thrown error metadata remain unchecked until the
existing comparisons, record checks, numeric checks or URL conversion use them.
The field-access helpers accept primitives and inherited members and preserve
the TypeError of a direct nullish property read. A metadata-derived server name
is not declared a string merely because its source is MCP.

Config, environment and prompt-reference checks stay at their external
boundaries. A dictionary lookup can resolve an inherited member, so array,
plain-object and string checks must remain even where a declaration suggests
that only the expected value can occur. Worktree config object checks continue
to admit arrays, matching their existing property-reading behavior.

Compaction writes the background flag under both `compaction.background` and
`experimental.background_compaction`. OpenCode before 2.3.1 reads the latter;
newer versions read the former.

### Why hidden-session filtering keeps the schema's loose payload

Hidden metadata proves neither a session ID's type nor the rest of a session
record. Learned IDs retain their original values, and filtered pages expose
the values their Zod schemas actually checked. Filtering must not validate,
rewrite or discard unrelated payload fields.

### Why credential reads and writes have different token contracts

`projectCredentialValue` treats every non-key credential as OAuth for the
legacy view. OpenCode also lists external credentials, so token fields in
that projection can be `undefined`. Stored login reads select OAuth rows
before projection. The create route inserts the value from its request and
returns the inserted row by ID, so creating an OAuth row returns OAuth
tokens. The SDK's general create return type does not express that
relationship with the input.

### Why process records are per child and not one shared file

Concurrent web, desktop, and VS Code hosts share the registry. One file per spawned PID avoids a shared read-modify-write race that can erase another live host's ownership record.

### Why conversion inputs keep unchecked fields

Unwrapping an OpenCode response checks only its object container and envelope
keys. Its result stays unchecked until a consumer's existing guard or schema
reads it. Active-session dictionaries likewise establish only the container;
lineage, shell and job records use their existing schemas. A shell's metadata
still needs its session-ID string check after parsing the metadata dictionary.

Registry files establish an integer PID only. Owner and port fields remain
unchecked until their integer tests, and arrays or inherited properties are not
newly excluded. Error-property guards preserve property access on non-nullish
values, including primitives. Managed config settings keep unchecked tool and
failover selections until their existing boolean, string and array checks.

### Why dependency options have a local declaration

Node's `execFile` accepts an options object containing `stdio`, although its
published declarations omit that property and it does not forward the option
to the spawned process. `dependency-options.d.ts` admits that existing argument
without changing its runtime effect. The registry imports it only as a type so
the VS Code compiler also sees the declaration when following source imports.

The SDK's host-version parser also accepts an omitted version at runtime through
its string conversion, returning null. Its local overload preserves the
authoring skill's existing `latest` fallback when no app version is supplied.
The same declaration admits an undefined `replaceAll` replacement, which the
standard string operation accepts through string conversion. The authoring
template's parser-dependent branch cannot express that relationship to the
compiler; neither its branch nor its fallback changes.

### Why registry operations are asynchronous and not synchronous

The server can run inside Electron's main event loop, which also serves UI assets and event traffic. Reaping several records can require slow Windows process commands, so asynchronous filesystem and process operations keep that loop responsive.

### Why PATH discovery keeps explicit configuration and not WSL auto-detection

A user-configured PATH retains its ordering and gains only missing fallback entries; a minimal system PATH prefers the login-shell toolchain. Windows auto-detection stays on Windows because WSL paths identify different server-visible directories and can create duplicate or missing project state.

### Why binary probes are bounded and not allowed to wait indefinitely

Login-shell rc files, PowerShell profiles, and PATH entries on unavailable network drives can block startup. Probe deadlines allow resolution to continue, and injectable candidate and executable checks let a missing-install result remain testable on hosts with system-wide installs.

### Why clearing a binary setting preserves a user's environment override

The empty-string setting clears only a previously applied settings selection. An `OPENCODE_BINARY` supplied by the user's environment remains explicit configuration and survives that clear.

### Why Windows binary resolution prefers a baseline executable

Bypassing package-manager wrappers still needs to support CPUs without AVX2. Resolution prefers the baseline platform package and unwraps shims to native executables or explicit runtime/script pairs because raw cmd shims cannot run through `spawn` with `shell: false`.

### Why frontmatter parsing retries permissively and not only through strict YAML

OpenCode accepts unquoted colons inside scalar values, so the reader retries with those values expressed as block scalars. A BOM and a closing frontmatter delimiter at EOF also remain valid; rejecting them would turn existing frontmatter into body text and duplicate it on save.

### Why config removal uses scanned separators and not parser removal edits

Removing a property or array element also removes one adjacent separator while preserving comments in surrounding gaps. The scanner distinguishes commas in comments, avoiding parser removals that leave a trailing comma or discard a neighbour's comment; the write boundary JSON-normalizes desired values so undefined fields behave like serialized removals.

### Why proxy pools resolve at request time and not during registration

Proxy registration precedes OpenCode bootstrap, so an external HTTPS target may still look like the default HTTP loopback target. A lazy agent getter shares one pool per resolved scheme; its agent class matches TLS, concurrency remains unbounded, and the free-socket cap stays at 256 because a cap of 32 churns connections under 64 concurrent requests. Idle pooled sockets expire before upstream keep-alive deadlines to avoid reusing a closed connection.

### Why proxy responses hold readiness and not immediately return 503

A bounded readiness hold lets the first request succeed when OpenCode finishes starting. Immediate 503s put clients into retry backoff and delay bootstrap; a genuinely unavailable server still receives a bounded failure.

### Why streaming request framing survives header filtering

A stream without content length needs transfer encoding or OpenCode can read an empty prompt body. A parsed body replay instead sets content length and removes transfer encoding because OpenCode rejects requests carrying both.

### Why session lists use an allowlist and not a field blocklist

OpenCode can add heavy session fields without a client change. An allowlist bounds repeatedly fetched list records, while dropping obsolete delivered-knowledge metadata avoids transferring signatures no consumer reads.

### Why proxy records retain unchecked fields

The session allowlist copies fields without validating their values, so
`SanitizedSessionListItem` keeps them unchecked. Object guards include arrays
where the existing archive and metadata readers did; only the checks that
already rejected arrays exclude them. Archive lookups retain the own-property
check and numeric check. Stored metadata lookups retain the object and array
checks because names such as `constructor` can resolve to inherited members.

Thrown values retain unchecked message, code and cause fields until use.
`diagnosticErrorMessage` accepts these values through its existing length checks
and regular-expression coercion. `withUnreadBaseline` accepts unchecked records
because its time schema decides whether to return the original value. Their
public overloads expose those existing inputs without adding proxy-side filters.
Trust body readers likewise expose an unchecked HTTP body until the move schema
validates it.

### Why proxy dependency declarations are local

`http-proxy-middleware` imports `http-proxy` declarations that are absent from
the installed dependency tree. `proxy-middleware.d.ts` describes the options
and HTTP event callbacks used here, including the socket alternative on errors.
It adds no runtime implementation. `../../proxy-headers.js` resolves to its
typed implementation so collected headers expose every forwarded name, rather
than only the authorization property inferred from JavaScript.

### Why plugin switch reads keep thrown values unchecked

The switch store returns the original thrown value on a failed read. Only
`ENOENT` means there is no switch file. A corrupt file or other read error keeps
the last saved denials, and the warning uses the original value when it has no
message. A plugin's relative path is resolved against the config that declares
it; the last matching statement in the earliest matching config decides whether
the denial can take effect.

## Entrypoints and structure
- `packages/web/server/lib/opencode/index.js`: public entrypoint (currently baseline placeholder).
- `packages/web/server/lib/opencode/auth.js`: provider authentication file operations.
- `packages/web/server/lib/opencode/project-start-command.js`: the project's start command (`commands.start`) that the web server and the VS Code extension host run in every worktree they create. OpenCode 2.x keeps it on its project record, so the reader asks the running OpenCode in the directory the worktree is requested from (the contributor trust prompt asks in the primary checkout, never inside the fork's checkout): `GET /api/location` names the project, whose ID 2.x derives from the origin remote and so differs from OpenChamber's root-commit worktree ID, and `GET /api/project` holds the record. A failed read runs no command and logs a warning; the worktree is still created. Wired once per runtime with `configureProjectStartCommandSource`, the way `auth.js` is.
- `packages/web/server/lib/opencode/auth-state-runtime.js`: managed OpenCode server auth password/header runtime.
- `packages/web/server/lib/opencode/routes.js`: OpenCode/provider settings and auth-related route registration.
- `packages/web/server/lib/opencode/v1-migration-topup.js`: re-arms OpenCode's own V1 -> V2 session import for V1 sessions changed by 1.x after the last completed import; runs only before a managed spawn. See "v1-migration-topup.js" below.
- `packages/web/server/lib/opencode/lifecycle.js`: OpenCode process lifecycle runtime (startup, restart, readiness, health monitoring). It records each lifecycle transition (launch, ready, exit, restart, health failure and recovery, external connect) as a fixed action in the process-local diagnostic journal (`../diagnostics/server-journal.js`), which the diagnostic timeline exports; the journal never holds stderr, paths or error text. A configured external server that misses the startup readiness window is re-probed every five seconds until it answers, because the health monitor only speaks for a process OpenChamber started. The interval stays fixed rather than backing off, so a very late start is still found within seconds. One probe runs at a time, its timeout covers the response body, and an answer that arrives after shutdown began or the endpoint changed is dropped. After readiness it warms the last-used directory only (first entry of the `getWarmupDirectories` dep, best-effort) because OpenCode initializes each directory lazily on first request and that cost would otherwise be paid by the user's first interactive session open. It warms no other projects: on OpenCode 2 the first directory-scoped read boots that location's whole MCP fleet. The warmed directory is also `getDefaultOpenCodeDirectory()`, the scope for server-side reads that have no directory of their own (integrations in `auth.js`, the small model's model and provider lists, the agent check after a restart): v2 answers a location read without one for its own working directory, the user's home for a managed OpenCode, and would start an MCP fleet there. While no warmed directory is usable (no project open), the getter answers the `noProjectDirectory` dep instead, the managed chats root, which the UI also works in then. Once the UI saves the directory it moved to (`lastDirectory`, reported by the settings runtime's `onLastDirectoryChanged`), `noteCurrentDirectory` makes that directory the default: the UI runs it anyway, and the one used last at startup may be a chat the user left, whose location the UI stops; a read there, such as the quota's integration list every 3 minutes, started it again. The getter revalidates that directory on every read: once it is no longer a readable directory (deleted, moved, replaced by a file, or stripped of read/execute permission) it is never sent, and the lifecycle advances to another directory the warm pass validated or re-reads `getWarmupDirectories` (coalesced, with a short cooldown) so a currently-valid `lastDirectory` replaces the stale one. A stale cached path would otherwise make every directory-scoped read answer `500 FileSystem.realPath ... ENOENT` — the failure that took the quota credential read down with it.
- The managed OpenCode's environment also carries the user's variables from Settings and from `opencode service set env` (`getUserEnvironment`, see `../environment`), over the inherited environment and under everything OpenChamber sets for OpenCode itself; enterprise mode passes none. `getManagedOpenCodeProcessEnv()` therefore includes them, so a provider key given this way is visible to the credential reader like any other variable OpenCode reports.
- `packages/web/server/lib/opencode/provider-env-aliases.js`: mirrors known provider credential env aliases into the managed OpenCode process environment (for example `GEMINI_API_KEY` → `GOOGLE_GENERATIVE_AI_API_KEY`) so OpenCode connection detection and the upstream AI SDK agree on the same key names. Canonical implementation shared by web lifecycle and the VS Code managed spawn path (`packages/vscode/src/provider-env-aliases.ts` re-exports this module).
- `packages/web/server/lib/opencode/env-runtime.js`: OpenCode CLI/binary resolution and shell environment runtime. The bundled OpenCode is a server script (`packages/web/opencode-server`, resolved from `OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR`, Electron's `resourcesPath/opencode-server`, or the built web package's `build/opencode-server`, source `bundled`); `resolveManagedOpenCodeLaunchSpec` runs it on Node on every platform (Electron's executable with `ELECTRON_RUN_AS_NODE` in desktop, host `node` in web/CLI), and the version check and the spawn add the spec's `env`. It is never exported as `OPENCODE_BINARY` or put on PATH (maintainer decision, 2026-11-17): a terminal or an agent's shell runs the user's own `opencode` or none.
- `packages/web/server/lib/opencode/bundled-opencode-server.ts`: finds the desktop's bundled OpenCode server script among the directories `env-runtime.js` names and builds its launch spec (see the `env-runtime.js` entry).
- `packages/web/server/lib/opencode/env-config.js`: OpenCode-related environment variable parsing and validation (host/port/hostname).
- `packages/web/server/lib/opencode/hmr-state-runtime.js`: HMR-persistent runtime state initialization, auth-state bootstrap, and HMR sync helpers.
- `packages/web/server/lib/opencode/network-runtime.js`: OpenCode URL construction, health-probe readiness checks, and API prefix runtime.
- `packages/web/server/lib/opencode/config-entity-routes.js`: route registration for agent/command/MCP config orchestration. OpenCode 2 watches these files, so a write is live as soon as it lands and the route answers plain success.
- `packages/web/server/lib/opencode/mcp-oauth.js`: MCP OAuth from a browser on another machine: the start interception, the generated redirects, and the public callback. See "Remote MCP OAuth" below.
- `packages/web/server/lib/opencode/websearch-config.js`: writes OpenCode's `websearch` choice (`PUT /api/config/websearch` in `routes.js`; body `{ selection: false | null | "random" | "<provider id>" }`, `null` removes the key, so OpenCode falls back to the answer given in its chat consent form, which it keeps in its own store) to `OPENCODE_CONFIG` when set, else the user config. `GET /api/config/websearch` returns `{ projectPath }`: the project config whose `websearch` overrides that write (see the load order below), so Settings disables the choice and names the file instead of letting it snap back; `findWebSearchProjectOverride` in `config-v2.js` holds the rule. The pure transform is `writeWebSearchSelection` in `config-v2.js`, shared with the VS Code bridge (`api:config/websearch`). The same file writes OpenCode's compaction settings (`PUT /api/config/compaction`; body `{ auto?, buffer?, keepTokens?, background? }`, token counts (for `buffer` also a share of the window such as `"20%"`, the form Settings writes, which needs OpenCode 2.2.4) or `null` to remove the key and booleans written as they are, so `false` also overrides a `true` in a lower config layer; they set `compaction.auto`, `compaction.buffer`, `compaction.keep.tokens`, and `background` both `compaction.background` and `experimental.background_compaction`) to the same target; background compaction moved from that experimental flag (off by default) to `compaction.background` (on by default) in OpenCode 2.3.1, and each version ignores the other key, so the write covers every supported OpenCode and Settings reads the key the connected version reads (its version from `/api/opencode/compatibility`); `compactionUpdateSchema` and `writeCompactionSettings` in `config-v2.js` are shared with the bridge (`api:config/compaction`). Settings reads the global values back from OpenCode's config, not from the file. A project config can still set any of these for itself; Settings says so in one line and does not look for project overrides, since whoever wrote one knows it is there.

OpenCode 2 loads the user config, then `OPENCODE_CONFIG`, then project `opencode.json[c]` files from the filesystem root down, then `.opencode/opencode.json[c]` files the same way (`getFolderConfigPaths` in `config-files.js`); the last file that sets a key wins, so a project file beats `OPENCODE_CONFIG` too. `findWebSearchProjectOverride` follows that order.
- `packages/web/server/lib/opencode/config-mutation-response.js`: shared response builders for applied config mutations and external manual-restart guidance.
- `packages/web/server/lib/opencode/managed-process-stop.js`: how the lifecycle stops its managed OpenCode on Windows: closes the `serve --stdio` lease, waits a bounded grace period, then force-kills the tree (see the teardown paragraph below). Also owns `hasChildProcessExited` and `waitForChildProcessClose`.
- `packages/web/server/lib/opencode/opencode-resolution-runtime.js`: OpenCode binary resolution snapshot runtime for settings routes and diagnostics.
- `packages/web/server/lib/opencode/upgrade-capability.js`: authoritative upgrade ownership policy for the active OpenCode runtime. Bundled, external, and unresolved runtimes fail closed; only managed non-bundled runtimes delegate upgrades to OpenCode.
- `packages/web/server/lib/agent-tool/runtime.js`: managed OpenCode custom-tool materialization, environment injection, same-machine authentication (loopback, or the bound address for a concrete bind), and fixed CLI action dispatch.
- `packages/web/server/lib/opencode/managed-plugin-config.js`: the `OPENCODE_CONFIG_CONTENT` merge used only on the fallback path, when the user's own environment owns `OPENCODE_CONFIG`; it appends managed plugin directories, plugin-switch policies and permission rules.
- `packages/web/server/lib/opencode/managed-config-file.js`: the managed OpenCode config layer — materializes the enabled OpenChamber plugins (agent tools, the limit failover reporter from `../limit-failover/` while a fallback model or an account switch is set, and the session title prompt, always), writes the plugin-switch denials into `policies`, and publishes them in a file OpenCode watches.
- `packages/web/server/lib/opencode/plugin-switches.js`: OpenChamber's own record of the plugins switched off in its UI, stored under `<data-dir>/plugin-switches.json` and applied only to the managed OpenCode child.
- `packages/web/server/lib/opencode/session-title-plugin.ts`: the plugin that gives OpenCode's hidden `title` agent OpenChamber's title style and names a session started with attached context alone from that context. See "Session title prompt" below.
- `packages/web/server/lib/opencode/instance-dir.js`: this server's own folder under `<data-dir>/run/instances/<pid>/` for the files its managed OpenCode reads, and removal of folders left by servers that are gone.

### Managed plugins on OpenCode 2.x
A configured plugin must be a DIRECTORY holding a `package.json` that resolves an
entrypoint; a path to a `.js` file is skipped with "configured plugin path must
be a directory". The config key is `plugins` (an array of absolute directory
paths), not `plugin`.

The generated entrypoint has no imports. OpenCode loads it with a plain dynamic
`import()`, and resolution happens from the plugin's own directory, where nothing
is installed — `import { Plugin } from "@opencode/plugin"` fails there. None of
it is needed: a plugin only has to default-export `{ id, setup }`, and a tool's
`input` accepts plain JSON Schema.

Two v1 affordances are gone and the generated tools work around them: a tool
result has no `title` (it travels in `metadata`) and must not carry `output`
unless an output schema is declared; and a tool call no longer receives
`context.directory` or `context.abort`, so the callback sends `context.sessionID`
and OpenChamber resolves the directory itself.

The managed config file also carries `permissions` a managed tool needs
(`managedPermissionRules` in `../agent-tool/runtime.js`). OpenCode appends the
`permissions` of every config layer to each agent and reads a session's own
rules after the agent's, so a rule here adds to the user's rules and replaces
none, and a session can allow what this layer denies. A user rule after ours
(such as a project-wide allow-all) wins, which only puts the declaration back
in that user's sessions. On the fallback path the same rules are merged into
`OPENCODE_CONFIG_CONTENT` (`appendManagedPermissions`).
- `packages/web/server/lib/opencode/model-discovery.js`: bounded custom-provider `/models` discovery and optional models.dev enrichment. It accepts only http(s), does not follow redirects, filters transport headers, never returns credentials, and treats models.dev failure as unenriched success. Edit requests may name the provider so the host can fall back to a stored credential when the form leaves the key blank — the key from OpenCode's credential store or, failing that, the provider's stored config entry (`settings.apiKey`, else the first `env` variable name that is set in the server environment) — but only while the form's base URL still matches the saved one, so a changed URL never receives the stored credential; an explicitly entered replacement key wins.
- `packages/web/server/lib/opencode/skill-routes.ts`: route registration for skill config CRUD, supporting files, and skills catalog scan/install flows.
- `packages/web/server/lib/opencode/proxy.js`: OpenCode API/SSE forwarding and readiness-gate route registration.
- `packages/web/server/lib/opencode/session-runtime.js`: session status/activity runtime for OpenCode SSE events.
- `packages/web/server/lib/opencode/watcher.js`: global SSE watcher runtime for push/session event fanout.
- `packages/web/server/lib/opencode/config-files.js`: OpenCode config directories, scopes, config file paths, layered reading, structured writing, and the ancestor and worktree-root helpers.
- `packages/web/server/lib/opencode/markdown-files.js`: markdown files with YAML frontmatter and `{file:...}` prompt references.
- `packages/web/server/lib/opencode/skill-files.js`: skill discovery and skill supporting files.
- `packages/web/server/lib/opencode/atomic-write.js`: `writeFileAtomic(filePath, content)`, the one atomic file replace for files OpenCode watches (same-directory temp file, fsync, rename; mode of an existing file kept; a symlink, dangling or not, is followed to its file; a read-only file is refused like an in-place write; on Windows a rename refused with EPERM/EACCES/EBUSY falls back to a direct write). Used by `config-files.js`, `markdown-files.js` and the VS Code extension host's `opencodeConfig.ts`.
- `packages/web/server/lib/opencode/config-v2.ts`: the canonical OpenCode 2 shape layer — section-key resolution (v2 first, v1 fallback), permission map -> rule array translation, model `provider/model#variant` split/join, and the agent/command/MCP/provider/plugin entity conversions. Pure functions with no filesystem access; `packages/vscode/src/opencode-config-v2.ts` re-exports it so the web server and the extension host cannot write different files. See "Entity routes (v2 shapes)" below.
- `packages/web/server/lib/opencode/worktree-directory.js`: resolves OpenCode's `worktree.directory` into the absolute parent directory for new worktrees. Relative paths start at the canonical checkout, absolute paths are used as-is, and a leading `~` means home. Both the web server and VS Code's `gitService.ts` call `readWorktreeDirectorySetting` in `config-files.js`, which merges the global files, `OPENCODE_CONFIG`, and every discovered folder config in OpenCode order. Invalid JSONC or an unreadable file rejects the read; null means the setting is unset and keeps the data-dir default.
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI session authentication runtime (outside OpenCode module).
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: UI passkey storage and WebAuthn registration/authentication helpers (outside OpenCode module).

### Why unrecognized model modalities are kept

Model discovery (`model-discovery.ts`), provider config projection
(`config-v2.ts`) and the custom-provider validator (`providers.ts`) use
`model-modalities.ts` to map MIME types to the categories the form edits:
`text`, `image`, `audio`, `video`, and `pdf`. A MIME type maps by its top-level
type, with `application/pdf` mapping to `pdf`. Entries keep their first-seen
order without repeats.

An entry that names no category, such as `application/json`, stays as written,
the way OpenCode's own catalog keeps it, and an explicit empty list stays empty.
Modern capability blocks leave missing fields unset for OpenCode to resolve.
Dropping or defaulting either kind of reported list would
change the capabilities a provider declared on an unrelated edit, or show an
all-unknown list as Text and Image support. A save accepts such an entry only
when the stored model already lists it in that field, so the form round-trips
what it cannot edit and a request cannot add a new one. The form uses only
editable categories in newly discovered or inherited lists. The save merges
`tools`, `input`, and `output` individually, keeping stored values for any
omitted fields. An unrecognized entry is written back exactly as stored.

### Why worktree discovery has a separate config reader

Worktree placement must include ancestor configs above the repository and every checkout-local config. The Settings reader keeps its existing editable layers and write targets; broadening that reader would change unrelated configuration editing. The worktree reader shares `getFolderConfigPaths` with the other ancestor-aware readers and is used directly by both runtimes.

## Public exports (auth.js)
`auth.js` is read-only. OpenCode 2.x owns every credential and, since 2.0.20,
hands them back over `GET /api/credential`, secrets included. OpenChamber needs
the raw credential for provider quota lookups, voice keys and routing, so
`readOpenCodeCredentials()` asks the running OpenCode, through the connection
`server/index.js` wires with `configureOpenCodeCredentials()`. Concurrent
callers share one request; nothing is cached between calls. A failed read
throws, so an unreachable OpenCode never reads as "no keys".

Clients never get that list. `GET /api/credential` (any spelling OpenCode
routes the same way, matched by `isCredentialListRequest` in
`../enterprise-mode.js`) answers 403 `credential_list_refused` before the
generic proxy, in and out of enterprise mode: anyone signed in to the UI,
over a tunnel or a paired phone too, would otherwise read every key. Renaming,
switching and removing an account still reach OpenCode.

`POST /api/vcs/init` (OpenCode 2.0.23, runs `git init`) answers 400 with an
`InvalidRequestError` body when it would create a repository in the home
directory, at a disk root, or in OpenCode's own working directory because no
directory was named (`vcsInitRefusal` in `../git/repository-root.js`). Git
surfaces ignore a repository there, so the user would get a repository that
covers every file and a Git tab that still says "not a repository". The UI
hides its Initialize Git button in the same places.

Keys OpenCode takes from environment variables (`ZAI_API_KEY`, ...) are never
stored and `/api/credential` does not list them; `GET /api/integration` names
the variable behind each such connection, but not its value. For a managed
OpenCode the lifecycle keeps the exact environment it launched the process
with (`getManagedOpenCodeProcessEnv()`), and the reader takes the value from
there, only for variables OpenCode itself reports. A stored credential wins
over a variable, as in OpenCode. An external OpenCode runs with its own
environment, so its variable keys stay unknown and are left out.
`getProviderAuth()` answers stored credentials only: it asks whether a login
exists in OpenCode's store.

- `configureOpenCodeCredentials(source | null)`: wires the reader to a `{ list }` credential source; reads throw until it is wired.
- `openCodeCredentialSource({ buildOpenCodeUrl, getOpenCodeAuthHeaders, getLaunchEnvironment? })`: the running OpenCode as that source, URL and headers read per call; `getLaunchEnvironment` returns the managed launch environment or null.
- `readOpenCodeCredentials()`: each integration's active credential, keyed by
  integration id (the provider id for providers), in the legacy `auth.json`
  entry shape (`{ type: 'api', key }` /
  `{ type: 'oauth', methodID, access, refresh, expires, accountId?, enterpriseUrl?, server?, orgID? }`),
  plus the row's display `label` when OpenCode has one. OpenCode Go quota
  results use it as `accountLabel`.
  The method ID identifies the login method for consumers that need to distinguish plugin credentials.
  The OAuth projection keeps only `server` and `orgID` from OpenCode Console
  credential metadata, so quota providers can identify a Console sign-in
  without carrying account names or emails.
- `getProviderAuth(providerId)`: that map's entry for one provider, or null.
- `projectCredentialEntries(entries)`: the wire-to-legacy projection.
- `projectEnvironmentKeys(integrations, environment)`: variable values for the env connections OpenCode reports, by integration id.

The VS Code extension host uses this same module through
`packages/vscode/src/opencodeAuth.ts`, which only builds the source from its
OpenCode manager (`getManagedLaunchEnvironment()` there).

### v1-migration-topup.js

OpenCode 2.x imports the legacy `session`/`message`/`part` tables into
`session_v2`/`session_message` once and then records `{"phase":"completed"}`
under `migration.v1-v2` in the `kv` table. Anyone who kept using a bundled
OpenCode 1.x beside a v2 install created V1 sessions after that point, and
OpenCode never looks at them again — they are simply missing from the session
list. `topUpV1Migration()` hands OpenCode a resume cursor so its own migration
picks them up. OpenChamber never writes session rows itself.

It runs from `lifecycle.js` immediately before the MANAGED OpenCode is spawned:
never for an external, user-started OpenCode, and never while a managed one is
running, because the write would race OpenCode's own loop. Failure is never
fatal to startup. It opens `<data>/opencode.db` (or `OPENCODE_DB`), resolved
from the environment the managed process starts with, read-write through `node:sqlite` on Node or `bun:sqlite` on Bun, and skips silently on
neither. It returns
`{ status: 'skipped' | 'scheduled' | 'unsafe' | 'unavailable', missing, revisited, reason? }`
and logs one line; there is no HTTP route and no UI.

What it does: when the migration row says `completed` and some `session` rows
have no `session_v2` twin AND were changed by 1.x after the last completed
import (`session.time_updated` past the row's `time_updated`, which OpenCode
stamps on completion), it sets the row to `{"phase":"sessions","cursor":…}`.
The time test matters because a v2 delete leaves the legacy row behind
(`Session.remove` publishes `session.deleted`, `bus.remove` then wipes that
session's durable events, `session_v2` cascades), and only OpenCode 1.x writes
the legacy table: when nobody ran 1.x since the last import, nothing qualifies
and the top-up skips, so sessions deleted in v2 stay deleted.
The cursor is the largest missing id plus `U+FFFF`, because OpenCode's loop
walks `id < cursor` in descending id order and ids are fixed width, so nothing
real can fall between an id and that cursor. Ids are compared the way SQLite
does (BINARY/memcmp; neither id column declares a collation). Session ids
encode time descending in a field that wraps, so id order is **not** time
order — an August session can sort far below a newer one, and the code never
assumes otherwise.

Hard rules, verified against v2.0.8 (the completion stamp against v2.0.16)
`packages/core/src/database/v1-migration.bun.ts`:

- **Never clear or delete the `migration.v1-v2` row.** With no row at all
  OpenCode treats the database as pre-migration and DELETEs the whole `event`
  table, v2's durable event log.
- **Never make OpenCode revisit a session that has v2 activity.** Every session
  the loop visits gets its `session_message` rows deleted and replaced by the
  V1 transform. Before writing a cursor, the top-up lists the already-migrated
  sessions below it and looks for a message created after the migration
  completed, a `session_v2.time_updated` after it, or a message `type` the V1
  transform never emits (it only produces `user`, `assistant`, `synthetic`,
  `compaction`). Any hit and nothing is written: the outcome is `unsafe`
  (`revisited-sessions-have-v2-activity`) and a single warning names how many
  sessions stay missing.
- **Only 1.x activity triggers an import** (maintainer, 2026-09-24). When 1.x
  was used again, OpenCode's loop still walks every legacy row under the
  cursor, so a deleted session sorting below a fresh one comes back with it;
  avoiding that needs an upstream import route that takes explicit ids.

## Public exports (providers.js)
- `getProviderSources(providerId, workingDirectory)`: Resolves which OpenCode config layers define a provider. The user layer is both global files: when `opencode.jsonc` sits beside `opencode.json`, OpenCode loads both and the `.jsonc` wins, so `user.path` is the file that holds the provider (the `.jsonc` when the entry lives there, else the primary file). `upsertProviderConfig` and `removeProviderConfig` with scope `user` edit that same file, so a provider defined only in `opencode.jsonc` gets Edit in Settings and is changed in place; a new provider still goes to the primary file. Saving such a provider also takes it off `disabled_providers` in the primary file, where `setProviderDisabled` records it. `inheritedCanonical` is the `canonical` a layer under the one holding the entry sets, with that file's path (`readInheritedProviderCanonical`): OpenCode folds provider layers and has no way to unset `canonical` from a higher one, so the edit form says which provider still applies with None there. The VS Code bridge sends the same field.
- `listProviderConfigs(workingDirectory)`: Every provider a config layer defines, projected into the canonical v2 `ProviderEntity` shape, with `legacy` marking entries still stored under the v1 `provider` key.
- `upsertProviderConfig(providerId, config, workingDirectory, scope?, options?)`: Validates and writes a custom provider block into the user/project/custom config layer. The payload may use the v2 spelling (`package`, `settings.baseURL`, `headers`) or the v1 spelling (`npm`, `options.baseURL`); what lands on disk is always a v2 `providers` entry with `settings.baseURL`. AI SDK package names carry `aisdk:`; bundled `@opencode/ai/*` provider and model packages stay bare. The adapter may be OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. Existing provider, option, and retained-model fields not managed by the form are preserved, as far as the v2 projection (`toProviderEntity`) carries them; it carries a model's `type`, so a model marked `image` by hand stays an image model after a form save. A model `type` in the payload (the form's image generation checkbox sends `image` or `chat`, and a loaded type such as `decision` as it was) is written without checking its value: OpenCode's set of types is open-ended. Omitted models, headers, and env credentials remain explicit removals. A model's `variants` (reasoning levels) are replaced when the payload carries the array, cleared when it carries an empty one, and kept when the key is absent. The provider's `canonical` (the catalog provider OpenCode copies model defaults from) follows the client certificate's rule: a string replaces it, null removes it, absent keeps it, so a form that never read the stored entry cannot erase it; anything other than a provider ID without spaces is refused. Updating an entry still stored under the legacy `provider` key rewrites it under `providers` in the same file, dropping the fields v2 accepts but ignores; unrelated legacy siblings are untouched. Does not store API keys. Requires `config.env` or `options.hasStoredAuth`. OpenCode 2 keeps credentials in its own store, so `PUT /api/provider` sets `hasStoredAuth` from the request's `hasCredential` (the form is about to store a key, or the edited provider keeps its credential) as well as a credential OpenCode already stores for the provider. The key itself goes through `integration.connect.key` after this write, because OpenCode registers a custom provider's key method only once the provider is in config. Edit flows must pass the provider's effective existing layer (`custom` > `project` > `user`) so updates do not create a global user override.
- `validateCustomProviderConfig(providerId, config, options?)`: Structural validation for custom provider payloads (id format, the three supported AI SDK adapters and their bundled OpenCode Chat Completions, Responses and Anthropic counterparts, http(s) base URL, models, credentials via `env` or `hasStoredAuth`). Accepts both spellings and returns the normalized v2 value. A model's `capabilities` keep only the fields the payload sets (`tools`, `input`, `output`), and `toProviderEntity` reads a stored block the same way: OpenCode fills a missing field from the canonical provider's model, so a default written in its place would replace what the model inherits. An `aisdk:`-prefixed bundled package is refused. With `options.layers`, a newly chosen `canonical` whose config entry in any layer sets `settings`, `headers` or `body` is refused (`canonicalSourceConnectionError`): OpenCode copies those into the provider before its own values, so a gateway's TLS certificate or auth header would reach this provider's endpoint. A canonical the provider already names in some layer stays accepted.
- `mergeCustomProviderConfig(existingValue, normalizedConfig)`: The merge `upsertProviderConfig` writes: the stored entry, read through the v2 projection, under the validated form payload. Unmanaged provider and model fields stay; an empty `variants` list removes the levels; omitted headers and env are removals. `settings.tls` is the client certificate a gateway with mutual TLS asks for (OpenCode 2.3.0+): `cert` and `key` both or neither, usually `{file:path}` references that are stored, never read, here, and an optional `passphrase` kept byte for byte. `tls: null` removes it and an absent `tls` keeps it, because the edit form leaves it out while the stored entry is unknown (its read pending or failed), and a save then must not drop a certificate written by hand. The VS Code extension's `upsertProviderConfig` calls this function and `validateCustomProviderConfig` directly, so a change here changes what both runtimes write; run the extension's `opencodeConfig.providers.test.ts` too.
- `removeProviderConfig(providerId, workingDirectory, scope?)`: Removes a provider block from the selected config layer.

### Why bundled provider packages stay bare

`aisdk:` selects OpenCode's AI SDK installation path. Adding it to a bundled `@opencode/ai/*` package makes OpenCode try to install an implementation already inside its binary, which fails before a model request can run. Provider reads and retained-model saves therefore preserve the bare package name.

The fix prevents new damage but does not repair entries an earlier save already rewrote: `config-v2.js` leaves an existing `aisdk:@opencode/ai/*` value as it is. An affected user backs up the config file that defines the provider, restores the original bare bundled package (`@opencode/ai/...`) at the provider or model entry, and then retries.

### Why custom provider validation retains field checks

Provider edits and stored config contain unchecked values. Validation checks the
fields before building the normalized config. Map keys returned by
`Object.entries` are already strings. The model merge still checks that an
existing model is a record before spreading it because the lookup uses a
configured name.

## Public exports (config-files.js)
- `OPENCODE_CONFIG_DIR`, `AGENT_DIR`, `COMMAND_DIR`, `SKILL_DIR`, `CONFIG_FILE`: Path constants rooted at `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is non-empty, otherwise `~/.config/opencode`. These constants are evaluated when the module loads; no files are migrated. `OPENCODE_CONFIG` remains a separate explicit config-file path and is resolved at call time for the custom config layer; it does not replace the global config directory.
- `AGENT_SCOPE`, `COMMAND_SCOPE`, `SKILL_SCOPE`: Scope constants with USER and PROJECT values.
- `ensureDirs()`: Creates required OpenCode directories.
- `getConfigPaths(workingDirectory)`, `readConfigLayers(workingDirectory)`, `readConfig(workingDirectory)`: Config file operations with layer merging (user, project, custom). `readConfigLayers` isolates `INVALID_JSONC` per layer: a broken file is omitted from the merge (`{}` for that layer only), recorded on `layerErrors`, and does not block valid sibling layers. Writes still refuse to overwrite the broken file.
- `readConfigFile(filePath)`: Reads one config file. Missing, whitespace-only, and comment-only files return `{}`; a comment-only file is recognized by `ValueExpected` being the only parse error. A `jsonc-parser` error that produces a partial or non-object tree throws `INVALID_JSONC` — partial parse trees must never be treated as authoritative (avoids rewriting a `$schema`-only stub over a full config). Content that yields no JSON value for any other reason (YAML, plain text) also throws instead of reading as empty.
- `readConfigLayer(filePath)`: Same parse as `readConfigFile`, but isolates `INVALID_JSONC` to `{ config: {}, error }` so plugin/MCP/agent readers can skip one broken layer without aborting valid siblings. Writes still refuse to overwrite the broken file.
- `writeConfig(config, filePath)`: Writes config with automatic backup, replacing the file atomically through `writeFileAtomic` so a watcher or a crash never sees a partial config. Refuses to overwrite an existing non-empty file that fails the same JSONC parse check. Existing files are edited structurally, so comments, formatting, and line endings outside the changed values survive. Equal-length arrays are diffed by index, including objects and nested arrays, unless a retained value moves between changed positions; an array that only grew at its end or only lost elements is edited per element, and other resized arrays are replaced whole. Comment-only files keep their comments with the serialized config appended below, and the edited text must re-parse to exactly the intended config or the write falls back to a normalized rewrite.
- `getJsonEntrySource(layers, sectionKind, entryName)`: Resolves which config layer provides an entry. `sectionKind` is `agents`, `commands`, `providers`, or `mcp`, and both the v2 and the v1 spelling are searched (v2 wins). The result carries `sectionKey` (the spelling that actually held the entry) and `legacy`, so a writer can rewrite the same file in v2 shape. A failed custom or user layer throws `INVALID_JSONC` instead of treating that file as empty. A failed project layer is skipped so a valid user/custom entry can still be found.
- `getJsonWriteTarget(layers, preferredScope)`: Determines write target for config updates. Throws `INVALID_JSONC` when the chosen target file is the unparseable layer.
- `getFolderConfigPaths(workingDirectory)`: Every `opencode.json(c)` and `.opencode/opencode.json(c)` OpenCode 2 finds walking up from the project folder to the filesystem root, lowest priority first in OpenCode's order (`core/src/config/discovery.ts`): plain files outermost folder first, `.jsonc` after `.json`, then the `.opencode/` files the same way. Global config files are left out. Only MCP reads use it so far; agents, commands and providers still read the single project file.
- `getProjectConfigCandidates(workingDirectory)`, `getLayerError(layers, filePath)`: The project folder's own config files, and the parse error `readConfigLayers` recorded for one file.
- `getAncestors(startDir, stopDir)`, `findWorktreeRoot(startDir)`: Git worktree helpers.

### Why array edits keep existing positions

Replacing an entire array discards comments inside untouched entries, so equal-length arrays use edits at the changed indices. A value retained at another changed index triggers whole-array replacement to avoid leaving a moved entry's comments at its old position. An array that only grew at its end or only lost elements, such as `policies` under the skill switch, gets one edit per element: an appended element goes on its own line at the last element's indentation, because `jsonc-parser`'s insertion reformats the line it lands on, and a removed element takes its line with it when nothing else is on it. Comments next to a removed element stay. Any other length change and the legacy `plugin` to `plugins` conversion still replace the array and can discard its internal comments.


### Why config parsing retains object checks

JSONC parsing establishes JSON values, not an OpenCode schema. Layer contents keep
JSON-valued fields until their entity readers validate them. Recursive merges
retain object and array checks on dictionary lookups, including inherited names.
`isPlainObject` retains its original falsy return values for JavaScript callers.
The JSONC library publishes `SyntaxKind` as a const enum despite exporting a
runtime object; namespace destructuring keeps that runtime lookup. Its node lookup
returns undefined for an absent root, which the caller short-circuit preserves.

### Why external model fields remain unchecked

The models.dev reader checks only a non-null object container and still accepts
arrays. Its return type establishes no provider or model schema. The client
projection copies its allowlisted fields without validating their values.
Discovery narrows catalog and provider values through each existing Zod schema;
passthrough fields stay unchecked until their individual parsers run.

Plugin conversions preserve JSON-valued options when their input is JSON. Their
declaration overloads carry that fact without narrowing the general unchecked
input contract or removing array checks on config dictionaries.

### Why dependency declarations stay local

`dependency-contracts.d.ts` describes the optional Bun SQLite constructor and
query methods used by migration top-up because this checkout has no Bun SQLite
declarations. SQLite rows remain unchecked until their row schemas parse them.
The same file exposes Node's native web-stream readers through their compatible
DOM reader contracts, allowing `Readable.toWeb` output to reach `Response`
without a cast. The `parseInt` overload retains JavaScript's coercing inputs;
pre-converting a port with `String` would change how Symbols fail.

### Why state and route inputs have different types

The session runtime owns typed state maps and restart schedules. Its incoming
events and pending request fields remain unchecked until the existing string,
number and object checks. Object checks that accepted arrays retain that behavior.
The watcher removes only the duplicate object checks after its own unwrap step.
Password callbacks receive the string-or-null values already normalized by HMR,
and the network hostname comes from the environment resolver's string result.

HTTP bodies and rejected values retain unchecked fields. Settings and snippet
services arrive through dependency injection; route orchestration does not
establish their schemas. A checked object container is never a validated entity.
Entity-route error matching retains callable `includes` methods on message
objects, including inherited methods and non-boolean results. It observes only
the result's truthiness and invokes the method with its original receiver through
the native call intrinsic, so an overridden method `.call` property is ignored.
Nullish body destructuring retains the original Node error message.

## Public exports (markdown-files.js)
- `parseMdFile(filePath)`, `parseMdFileAsync(filePath)`, `writeMdFile(filePath, frontmatter, body)`: Markdown file operations with YAML frontmatter. A rewrite goes through `writeFileAtomic`; `flag: 'wx'` creates the file directly and passes EEXIST on.
- `isPromptFileReference(value)`, `resolvePromptFilePath(reference)`, `writePromptFile(filePath, content)`: Prompt file reference handling.

## Public exports (skill-files.js)
- `walkSkillMdFiles(rootDir)`: Async. Recursively finds SKILL.md files, following links and skipping a link back to its own ancestor. It applies these of OpenCode's discovery rules: hidden directories and `node_modules` are skipped, and a directory holding its own SKILL.md (a file, or a link that resolves to one) is one skill that is not searched further, so a dependency's bundled skills never list as ones the user installed (#6708). A dangling SKILL.md link is skipped and does not stop the search. Two OpenCode rules are not applied here: this walk has no six-directory depth limit, and it does not discover root-level `*.md` skills. Sibling directories are read in parallel, at most 8 file-system calls at once, and the result keeps depth-first readdir order: discovery lets a later file win a duplicate name, so the order is part of the contract.
- `pathExists(target)`: Async existence probe shared by the skill walk and source lookup. Returns false when access fails.
- `addSkillFromMdFile(skillsMap, skillMdPath, parsed, scope, source)`: Indexes an already parsed skill file; `parsed` null (unreadable file) adds nothing.
- `resolveSkillSearchDirectories(workingDirectory)`: Returns skill search path order (config, project, home, custom).
- `listSkillSupportingFiles(skillDir)` (async), `readSkillSupportingFile(skillDir, relativePath)`, `writeSkillSupportingFile(skillDir, relativePath, content)`, `deleteSkillSupportingFile(skillDir, relativePath)`: Skill supporting file management.

## Public exports (routes.js)
- `registerOpenCodeRoutes(app, dependencies)`: Registers OpenCode-owned HTTP routes and internal module runtime:
  - `GET /api/config/settings`
  - `PUT /api/config/settings`
  - `GET /api/config/opencode-resolution`
  - `POST /api/opencode/upgrade` (enforces the active runtime's upgrade capability, shares concurrent upgrade requests and runs the resolved CLI with `upgrade`; the existing Reload action restarts managed OpenCode afterwards)
  - `GET /api/opencode/upgrade-status` (returns version availability plus the authoritative `upgrade.supported`, `upgrade.manager`, and `upgrade.reason` capability). The npm registry lookup fails soft: an unreachable registry still answers 200 with the installed `currentVersion` and `available: null` and `latestVersion: null`, so a failed update check never renders the local version as unknown; clients read the missing `latestVersion` as an indeterminate check and retry it.
  - `GET /api/provider/:providerId/source`
  - `PUT /api/provider` (create/update custom OpenAI-compatible provider config in OpenCode user/project/custom layers via `scope`; secrets stay in auth via the OpenCode auth API)
  - `POST /api/provider/discover-models` (user-initiated custom-provider model discovery; fetches the configured `/models` path server-side and optionally enriches exact model matches from the shared models.dev cache). A form with a client certificate (`tls`) presents it on an `https` endpoint as OpenCode would: `{file:...}` and `{env:...}` are resolved here, the request goes through `node:https` on a connection of its own (the global fetch takes no certificate in Node, and the shared agent pools sockets without the passphrase in its key), and redirects are not followed.
  - `DELETE /api/provider/:providerId/auth`
  - Enterprise mode (`../enterprise-mode.js`): `PUT /api/provider` and the OpenCode writes that would otherwise pass the generic proxy — every `POST` under `/api/integration/:id/connect` (key, OAuth start and complete, command), `POST /api/credential` (stores a key, OpenCode 2.0.20) and `POST /api/experimental/integration/wellknown`, matched by `isProviderConnectRequest` — answer 403 `enterprise_mode`. The matcher mirrors how OpenCode 2.0.18 to 2.0.20 route a path (any letter case, doubled slashes, `\` for `/`, percent escapes, anything after `;`), refuses a dot segment or a bad escape, and needs rechecking when OpenCode changes its router. Signing in to a remote MCP server (`POST /api/integration/mcp_<16 hex>/connect/oauth` and its `/:attempt/complete`) passes: it reaches a tool server from the OpenCode config, not a model provider. The VS Code extension host refuses the same requests with the same matcher. Removing, activating or renaming an existing credential still reaches OpenCode. This closes the way in through the app; OpenCode's `provider.use` policy is the real lock.
- Owns lazy auth library loading for provider auth checks/removal.
- Keeps route behavior independent from composition root; `index.js` now supplies dependencies only.

### Server-owned read deadlines

Version and upgrade-status reads of `/api/info` use the health probe's 3-second
timeout. An aborted read returns the route's existing error response. These
routes register before the generic proxy and need their own deadline.

## CLI upgrades

`cli-upgrade.js` runs the host-resolved executable and wrapper arguments with
`upgrade`, without a shell or client-supplied arguments. OpenCode chooses the
installer. Web, hosted mobile, Capacitor, and Desktop with a separately installed
CLI use this server path. VS Code uses the same executor from its extension host.
Bundled Desktop, external URL connections, and unavailable CLIs remain
unsupported at the host boundary.

On macOS and Linux an upgrade leaves the current server running, and the toast's
Reload action restarts it using the installed version. On Windows the managed
server stops for the install and starts again afterwards, also when the install
fails (`restartOpenCode(reason, { whileStopped })`; VS Code does the same with
its own stop and start). Failed installations return an error and can be
retried; installer output is not returned or logged because it can contain registry
credentials. Requests from multiple clients share the in-flight operation. The
executor supplies EOF and bounds captured output; installation has no fixed time
limit, and the VS Code bridge does not apply its usual 30-second request timeout.

### Why Windows stops the server for an upgrade and not lets OpenCode handle it

Windows refuses to delete the last link of a running executable. OpenCode guards
its own upgrade process and `serve --service` by holding a second link in its
cache, but our `serve --stdio` server gets no such link. npm then cannot replace
`opencode.exe` and leaves the package without it, so every later start fails
until the user reinstalls OpenCode. Stopping the server costs a few seconds of
downtime that the Reload action would cost anyway.

### Migrating an installed v1 CLI

`GET /api/opencode/compatibility` reads the local CLI version without starting
its server, or probes an external server's JSON version contract (`/api/info`,
then v1's `/global/health` even when the first probe fails or hangs). When
`OPENCODE_HOST`/`OPENCODE_PORT` points at a server that identifies as v1 or a
2.x below the minimum, startup attaches to it as external and not ready rather
than spawning a managed instance, so this check reports its version. A confirmed
managed v1 CLI on macOS, Linux or Windows (x64/arm64) advertises `canInstall`;
bundled binaries and external connections do not.

`POST /api/opencode/install-v2` rechecks that capability and shares one operation
across concurrent clients. `v2-install.js` resolves a validated stable v2
release from npm. On macOS/Linux it downloads the official
`https://opencode.ai/v2/install` script and runs it with that release and
`--no-modify-path`. That script is bash, so on Windows it downloads the npm
platform package the script would fetch (`@opencode/cli-windows-arm64` on
arm64, `@opencode/cli-windows-x64-baseline` on x64, like the desktop bundle), checks it against the `sha512` integrity
npm publishes, and unpacks `opencode.exe` with the system `tar.exe`. Both
paths then verify the resulting executable.
It installs into the host user's standard `~/.opencode/bin`. Existing npm/Bun
packages remain installed; the host selects the new binary through
`opencodeBinary`, restarts OpenCode, and waits for v2 readiness before replying.

A filesystem lock prevents separate hosts sharing a home from installing at
the same time. The installer has a five-minute deadline and owns its subprocess
group. Existing executable/shim files are restored after an installation or
verification failure. If rollback fails, backups and the lock remain under
`.opencode/bin/.openchamber-install` for manual recovery. A successful install
followed by a settings/restart failure keeps v2 on disk; Check again can retry
the restart. A host crash may also leave the lock for manual recovery.
Installer output is discarded, not forwarded to clients or logs.

## Public exports (response-envelope.js)
- `unwrapOpenCodeResponse(body)`: strips OpenCode 2.x's response envelope. A single record (`GET /api/session/:id`, one message) arrives as `{ data }`, some routes as `{ location, data }`, pages as `{ data, cursor }`. Records and plain lists are unwrapped; pages keep the envelope for their cursor. Every server-side OpenCode read goes through it: unwrapping only on `location` left record envelopes in place, so `parentID` and message ids read as missing.

## Public exports (prompt-response.js)

`prompt-response.js` rejects a successful HTML app-shell response at server-owned dispatch boundaries. Raw prompt, context-restoration, and queue sends call `assertPromptResponse`; the session-route and scheduled-task SDK factories call `assertOpenCodeApiResponse` before the SDK decodes the body. The SDK still owns declared error statuses and their bodies. A rejected dispatch must not remove a queued item.

## Public exports (session-activity.js)
- `hasWorkingDescendants(id, statuses)` is the queue delivery check returned by the probe. It follows the running sessions' parent links through at most 8 ancestors. Reads share one timeout and each session record is read once per check. Failed or malformed records and cycles return `null` unless another chain proves a running descendant; a chain deeper than 8 counts as unrelated, matching the UI's `MAX_SUBAGENT_DEPTH`. Parent links are refreshed on the next check.
- `createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs, signal? })`: whether a session's turn really ended. A parent goes idle while a background subagent works and runs again when OpenCode hands the result back. `fetchActiveSessionStatuses()` reads `/api/session/active`. `hasWorkingChildren(id, statuses)` reads each active session's parent link (`parentID`, or a workflow agent's `metadata.openchamber.parentID`) and checks direct children only, plus subagents of a workflow agent linked to the session, with the same timeout and unknown-result rules as the descendant check. An empty active list requires no session reads. `fetchRunningBackgroundJobs(id)` reads OpenCode's global `job.list` (2.2.6+) for the running subagents, shells and images of the session and every subagent under it; it answers `undefined` on an OpenCode without the route (a bare 404, so callers keep the reads above) and `null` on a 404 that names an error, such as a missing session. Every read answers `null` when OpenCode could not be asked. An optional caller signal is combined with each read's timeout, including lineage walks and running-shell checks. Used by the goal loop (waits), the notification runtime (stays silent on the pause), and scheduled cleanup (cancels its outstanding reads on timeout or stop).

### Why child activity starts from active sessions

Paging historical children made the check unknown after eight pages, even when
all children were idle. Reading active sessions' parent links costs at most one
record read per active session for a direct-child check, independent of history.
An unreadable active record remains unknown because its parent cannot be ruled
out. Callers retain their own policy for unknown activity.

## Public exports (turn-start.js)
- `createTurnStartReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs?, fetchImpl? })` returns `readTurnStart(sessionId)`: the running turn's start read back from `GET /api/session/:id/message`, newest first. OpenCode 2 writes an `idle` record when a turn ends, so the turn began with the first message after the last one; settings records (`agent-switched`, `model-switched`, `location-switched`) are skipped because the user makes them while idle. Null when the read fails, the latest record ends a turn, or no `idle` record appears within 10 pages of 50.

## Public exports (session-runtime.js)
- `createSessionRuntime({ writeSseEvent, getNotificationClients, broadcastEvent?, readTurnStart?, buildOpenCodeUrl?, getOpenCodeAuthHeaders?, fetchImpl? })`: creates runtime-owned state machine and APIs for session status. `readTurnStart(sessionId)` resolves the running turn's start from history (`turn-start.js`), or null. OpenCode URL and auth dependencies enable restart recovery.
- Returned API:
  - `processOpenCodeSsePayload(payload, { spaceId? }?)`: the watcher supplies the event's space identity so host restart recovery never posts a space's continuation to the host OpenCode.
  - `adoptRunningSessions(sessionIds, readAt)`: sessions OpenCode lists as running when the event stream (re)connects, as read from `readAt` on. Marks them busy and reads back the starts of turns this server did not see begin. A host session held busy that the list leaves out lost its idle in the stream gap and settles idle, announced like any status change, and its pending permission is dropped as the idle event would; clients seed rows from this map, so without it a missed idle showed the session running on every client started in the seed's 30-minute window. A session that reported any status after `readAt`, a repeat the 5 s dedupe swallows included (`lastEventAt`), is skipped either way, and sessions of isolated spaces are never settled, because the host's list does not name them.
  - `getRunningTurnStart(sessionId)`: the running turn's start, or null.
  - `getSessionActivitySnapshot()`
  - `getActiveSessionCount()`
  - `getSessionStateSnapshot()`
  - `getSessionState(sessionId)`
  - `resetAllSessionActivityToIdle()`
  - `interruptBusySessionsAfterRestart()`: settles busy/retry sessions, broadcasts idle status and an OpenCode-shaped `session.error`, clears pending requests and turn starts, and resets activity. Returns `{ sessionIds, autoResumeSessionIds }` in stable order; only host sessions with an unused recovery budget and injected OpenCode access enter `autoResumeSessionIds`.
  - `dispose()`

### Why restart recovery has one continuation per user turn

A managed `opencode serve` without `--service` has no automatic boot sweep. The 60-second grace gives the user time to continue by hand. A user message or busy/retry status cancels the pending timer; otherwise recovery posts to `POST /api/session/:id/synthetic` with `resume: true`, `delivery: 'steer'`, and `metadata.notice: 'opencode-restart'`.

The first HTTP attempt consumes that user turn's budget before sending, because a lost response may still have admitted the message. Up to 3 transport attempts share one `createMessageId` ID at 15-second intervals. A 404 or 409 ends delivery. Only a new user message renews the budget; synthetic messages, status transitions, and managed OpenCode restarts do not. The budget lives in this OpenChamber process until a new user message, session deletion, or disposal. A stale request completion may only change its own schedule. Keeping the budget across managed restarts prevents a turn that hangs OpenCode from restarting and resuming indefinitely.

`../notifications/restart-notification.js` builds the notification from the recovery result. All sessions eligible uses `opencode-restart-resuming`; a batch containing any manual-only session keeps `opencode-restart-interrupted` and manual guidance. CLI and Electron servers own recovery. Web, hosted mobile, and Capacitor clients receive it from their connected server; VS Code's separate OpenCode and external OpenCode do not use this managed-restart callback.

The runtime keeps when each session's latest turn began, on OpenCode's clock, so every client counts "Active for" from the same moment. The start comes from the translated `session.execution.started` (`turnStartedAt`), and is reported as `turnStartedAt` on `openchamber:session-status` broadcasts of a busy or retry session and on `getSessionStateSnapshot()` entries. A busy or retry status without a running start (the turn began before this server was listening) reads the start back once per turn; the result is applied only if the same turn still runs, and announced with a fresh `openchamber:session-status`. A start outlives its turn with `running: false`: snapshots still report it for an idle session, because a parent idling while its background subagent works is still in that turn on clients, but it is never reported beside a busy status. Starts are dropped with the session's status entry, on deletion, and on an OpenCode restart. Both kinds of start are on OpenCode's clock, which is this server's for a managed OpenCode; with an external OpenCode on another machine, the skew between the two machines shows in the elapsed time. Stamping the live start on arrival would remove that skew but date a start replayed after a stream gap at the moment it arrived.

The runtime maintains active-session count incrementally from idempotent activity phase transitions. Upstream stall-timeout and lifecycle health checks read it in O(1); the hourly cleanup removes activity phases older than 24 hours without broadcasting synthetic state transitions. Snapshot generation remains reserved for the session-activity API.

## Public exports (lifecycle.js)
- `createOpenCodeLifecycleRuntime(dependencies)`: creates lifecycle runtime for managed/external OpenCode process orchestration. The optional `onOpenCodeRestarted` dependency (default `null`) fires after a successful managed restart. `index.js` rebinds event-stream readers to the possibly-new port (#2638), calls `interruptBusySessionsAfterRestart()`, and broadcasts recovery guidance when interrupted turns exist (#2943).

- Returned API:
  - `startOpenCode()`
  - `restartOpenCode()`
  - `waitForOpenCodeReady(timeoutMs?, intervalMs?)`
  - `waitForAgentPresence(agentName, timeoutMs?, intervalMs?)`
  - `refreshOpenCodeAfterConfigChange(reason, options?)`
  - `bootstrapOpenCodeAtStartup()`
  - `scheduleBootstrapRetry(bootstrap, onAlreadyRunning)`: when the last bootstrap left no managed OpenCode, runs `bootstrap` again after 5, 15, 30 and then every 60 seconds, or `onAlreadyRunning` if a restart has started OpenCode by then, and answers whether it scheduled a run
  - `startHealthMonitoring(healthCheckIntervalMs)`
  - `waitForPortRelease(port, timeoutMs, hostname?)`
  - `killProcessOnPort(port)`

### Why lifecycle errors retain unchecked fields

Lifecycle dependencies and process/network APIs can reject with arbitrary values.
Failure slots retain the original cause, including its truthiness and identity.
Error metadata stays `unknown` until its existing string conversion. Property-access
predicates admit primitives and inherited fields without changing the original
value. Optional reads accept nullish causes; direct message reads retain their
property-access TypeError for a nullish cause.
Health and agent JSON also stay unchecked until their individual property and
array checks. A successful health response without a string version remains
healthy under the existing major-version check.

### Why directory refresh and warmup failures stay best-effort

A failed directory refresh falls back to the no-project directory or OpenCode's
working directory for that read and can succeed later. A failed warmup leaves
the directory lazy, so the UI's next request initializes it.

Managed OpenCode launch also merges the environment returned by the agent-tool
runtime and the opt-in system prompt optimizer, each appending its `file://`
entry to the previous one's config. OpenChamber adds no automatic MCP reconnect
loop; recovery after a failed connection is manual for both local and remote
servers. Previously generated reconnect plugin files are inert because managed
launch no longer registers them. User-configured plugins remain user-owned.
PATH, `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD` remain lifecycle-owned
and cannot be replaced by injected or inherited values; OpenCode 2 prefers
`OPENCODE_PASSWORD`, so both carry the managed password. A user-provided
password is read with the same precedence, and Basic auth always uses the
`opencode` username because OpenCode 2 accepts no other. External OpenCode processes receive no
OpenChamber tool injection. Managed launch env strips AppImage `ARGV0` before
spawn so zsh-backed OpenCode tools do not rewrite child argv[0] to the AppImage
path (#2588).

Everything the lifecycle and `auth-state-runtime.js` set for OpenCode goes
through `assignInjectedEnv` (`../injected-env.js`), which records the names of
the variables it changed in `OPENCHAMBER_INJECTED_ENV`. The agent's shell
inherits that record, so `openchamber startup enable` run there leaves the
managed config and password out of the service while the user's own
`OPENCODE_*` exports carry over (#4604). A value the environment already had is
not recorded: a user-provided password passed through stays the user's.

Before spawn, `applyProviderEnvAliases` fills unset Google credential aliases
from any present sibling (`GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`,
`GEMINI_API_KEY`) so a shell that only exports `GEMINI_API_KEY` still satisfies
the Generative AI SDK path used at chat time. Existing non-empty values are
never overwritten.

Set `OPENCHAMBER_STARTUP_PERF=1` to emit bounded startup phase records for server listen, managed OpenCode preparation/readiness, and proxy readiness holds. Every OpenCode bootstrap emits one terminal `opencode.bootstrap.ready` or `opencode.bootstrap.error` event, including reused and external server paths. Records contain controlled phase/outcome/route labels and timing values only; they never contain request URLs, runtime keys, directories, session IDs, credentials, or content.

macOS `say` voice enumeration starts concurrently with server composition. The server listener and managed OpenCode startup do not wait for it; `/api/tts/say/status` awaits the same authoritative capability promise when queried before enumeration completes.

Upstream health is probed with `GET /api/info` (OpenCode 2.0.8 removed `/api/health`). A 200 is the whole readiness answer — the payload is `{ version, pid, urls, paths }` and carries no `healthy` field — and its `version` is what the major-version gate reads. OpenChamber's own `/api/opencode/health` keeps answering `{ healthy }` to its clients, derived from that status. With `?wait=<ms>` (capped at 8 s, `health-wait.js`) it holds an unhealthy answer and re-probes every 100 ms until OpenCode is ready, the wait ends, or the client disconnects, so a starting client learns of readiness within about 100 ms instead of on its next poll. Concurrent waiters share probes (`createSharedHealthProbe`): a probe started less than 100 ms ago answers them all, so several starting windows cost one probe per interval. An OpenCode that answers with an unsupported version is a final answer and returns at once. `GET /api/openchamber/models-metadata` sends the models.dev catalog projected to the provider ids and model fields the UI reads (`toClientModelsMetadata`); the small-model resolver and model discovery keep the full catalog.

Transport-triggered health checks share the periodic monitor's failure accounting interval. Rapid WS reconnect callbacks therefore cannot exhaust the managed-process restart threshold using one cached unhealthy result; an exited managed process still restarts immediately.

Managed health failures are classified as `timeout`, `connection_refused`, `connection_reset`, `invalid_response`, or `error`. The lifecycle retains the latest counted failure with a bounded detail string and source. Managed process wrappers continue capturing a sanitized, bounded stderr tail after readiness and retain exit code/signal. Before replacing a managed process, lifecycle snapshots the reason, latest health failure, process diagnostics/aliveness, busy-session count, and timestamp into `lastOpenCodeRestartDiagnostics`; successful startup does not clear this snapshot, and `/health` exposes it for post-restart diagnosis without process environment or credentials.

A bootstrap that leaves no managed OpenCode is retried for as long as the server runs, because the health monitor only watches a running process and nothing else would start one. `index.js` skips the steps that need OpenCode (health monitoring, the global watcher, legacy migrations) until a run succeeds. A retry and a restart never start OpenCode at once: a retry waits for a restart in flight, and a restart waits for a retry in flight and then still restarts, since that run may have read the configuration the restart is for. `lastOpenCodeError` keeps the last failure during a retry, so the UI goes on showing the real reason. A rejected binary (invalid path, unsupported version) is not retried, since it fails the same way until the user changes it; an external server is not retried, since OpenChamber does not start it.

Managed process ownership starts at spawn. The registry and runtime process
handle include children that have not announced readiness yet, so shutdown can
stop an in-flight startup. Readiness timeout, malformed startup output, and
health-probe errors close that child before retrying. Shutdown cancels further
startup attempts. Closing a process is single-flight and unregisters it only
after it exits.

On Windows, the managed OpenCode runs as `opencode serve --stdio` with a piped
stdin, and teardown first closes that stdin (`managed-process-stop.js`).
OpenCode reads EOF as the end of its ownership lease and shuts down the way
SIGTERM makes it on POSIX: running turns end as cancelled, so a chat waiting on
a question does not reopen as still working (#4988), and OpenCode stops its MCP
servers with their process trees. If OpenCode has not exited within 5 seconds,
teardown falls back to the tree termination command, which runs before the root
is terminated: calling `child.kill()` first loses the ancestry needed to find
Git, shell, and MCP descendants. `--stdio` prints its readiness line as
`{"url":"..."}`; the lifecycle accepts it next to `server listening on`. On
POSIX, the managed child
starts in its own process group and teardown escalates against that group even
if the root has already exited. A tool ignoring SIGTERM must not survive just
because the server closed its own pipes. The
`lifecycle-process.test.js` regressions launch real parent/child fixtures and
check PID exit plus registry cleanup. macOS results do not validate Windows
ConPTY or Console Window Host behavior.

## Public exports (env-runtime.js)
- `createOpenCodeEnvRuntime(dependencies)`: creates runtime that owns OpenCode CLI environment and binary discovery state.
- OpenCode CLI resolution order is persisted settings, environment overrides, bundled Desktop CLI when available, PATH, known install locations, then platform shell discovery. A path pinned by the administrator (`opencodeBinary` in the machine policy file, `../enterprise-mode.js`) comes before all of them and has no fallback: `applyOpencodeBinaryFromSettings()` and `ensureOpencodeCliEnv()` resolve only that path (source `policy`), an unusable pin fails strict start with `OPENCODE_BINARY_INVALID`, and a removed pin hands resolution back to the order above. While pinned, the install-v2 and upgrade capabilities report unsupported (`reason: 'policy'`) and upgrade status never announces a newer version.
- Automatic bundled resolution under `OPENCHAMBER_RUNTIME=desktop` stays in runtime state and is returned to the managed launch function, including on OpenCode restart. It does not populate `process.env.OPENCODE_BINARY`: AppImage updater relaunch inherits that environment and would mistake the previous bundle path for an explicit override. Explicit settings/env selections and non-desktop or non-bundled resolution retain their existing environment behavior. This prevents future inheritance; it does not reinterpret overrides already inherited from older releases.
- The login-shell snapshot (`$SHELL -lic 'echo __OPENCHAMBER_ENV__; env -0'`, parsed from after the last marker line so text an rc file prints to stdout never fuses with the first variable) is taken synchronously at import time, so it blocks whatever process embeds the server for as long as the user's shell startup files take. An embedding host that already probed the shell hands its result over before importing the server through `login-shell-env.js` (`provideLoginShellEnvSnapshot(snapshot | null)`); the runtime then uses that and never probes, `null` included. Desktop does this on macOS and Linux; on Windows the server keeps its own registry-based snapshot. The handoff is a module slot, never an environment variable: the snapshot is the user's whole shell environment and `process.env` reaches every child.
- Returned API:
  - `applyLoginShellEnvSnapshot()`
  - `getLoginShellEnvSnapshot()`
  - `ensureOpencodeCliEnv()`
  - `applyOpencodeBinaryFromSettings()`
  - `resolveOpencodeCliPath()`
  - `resolveManagedOpenCodeLaunchSpec(opencodePath)`: resolves the effective managed OpenCode launch target, unwrapping Windows package-manager shims to a direct native binary or explicit runtime+script when possible.
  - `resolveGitBinaryForSpawn()`
  - `isExecutable(filePath)`
  - `searchPathFor(binaryName, searchPath?)`: resolves an executable from the supplied PATH value, defaulting to the process PATH.
  - `clearResolvedOpenCodeBinary()`

### Why environment discovery keeps boundary checks

Settings only establish an object container; `opencodeBinary` stays unchecked
until its string guard, and an inherited setting remains ignored. Shell probes
can fail with a null status or stdout, so neither means a valid empty snapshot.
The environment dictionary retains string checks on PATH and existing values,
including inherited properties. An undefined snapshot cache means unprobed;
null means a completed probe with no snapshot and suppresses another probe.

## Public exports (env-config.js)
- `resolveOpenCodeEnvConfig(options?)`: resolves and validates OpenCode host/port/hostname environment configuration.
- Returned object fields:
  - `configuredOpenCodePort`
  - `configuredOpenCodeHost`
  - `effectivePort`
  - `configuredOpenCodeHostname`

## Public exports (hmr-state-runtime.js)
- `createHmrStateRuntime(dependencies)`: creates runtime for HMR state container initialization and runtime<->HMR state synchronization.
- Returned API:
  - `getOrCreateHmrState()`
  - `ensureUserProvidedOpenCodePassword(hmrState)`
  - `getUserProvidedOpenCodePassword(hmrState)`
  - `resolveOpenCodeAuthFromState({ hmrState, userProvidedOpenCodePassword })`
  - `syncStateFromRuntime(hmrState, runtime)`
  - `restoreRuntimeFromState({ hmrState, userProvidedOpenCodePassword })`

## Public exports (network-runtime.js)
- `createOpenCodeNetworkRuntime(dependencies)`: creates runtime for OpenCode network and URL concerns.
- Returned API:
  - `waitForReady(url, timeoutMs?)`
  - `normalizeApiPrefix(prefix)`
  - `setDetectedOpenCodeApiPrefix()`
  - `buildOpenCodeUrl(path, prefixOverride?)`
  - `ensureOpenCodeApiPrefix()`
  - `scheduleOpenCodeApiDetection()`

## Entity routes (v2 shapes)

Everything OpenChamber persists into OpenCode config now speaks OpenCode 2.
This section is the contract the Settings UI builds on.

### Ownership: which directory is written

OpenCode 2 still discovers the v1 directories, so OpenChamber READS all of them
and WRITES only the v2 one:

| Entity | Read from | Written to |
|---|---|---|
| Agents | `.opencode/{agent,agents,mode,modes}/**/*.md` | `.opencode/agents/<name>.md` |
| Commands | `.opencode/{command,commands}/**/*.md` | `.opencode/commands/<name>.md` |
| Skills | `.opencode/{skill,skills}/<id>/SKILL.md`, plus `.claude/skills` and `.agents/skills` | `.opencode/skills/<id>/SKILL.md` |
| Plugin files | `.opencode/{plugin,plugins}/` — `.ts`/`.js` files and plugin package directories | `.opencode/plugins/<file>` |

The same holds for the global config directory. Like OpenCode 2, agents,
commands and skills are looked up in every `.opencode` from the working
directory up to the worktree root, so a definition in a parent directory of a
monorepo package counts; a nested id (`team/reviewer`) maps onto the path.
Only files in the v2 `plugins/` directory are editable through the plugins
page; a package directory or a v1 `plugin/` file is listed as a package that
OpenCode loads and OpenChamber does not touch. A symlink is listed as the file
or package it points at, the way OpenCode loads it. Broken links are skipped.
A file already in a plugin directory is listed, read, saved, deleted and
switched under its exact on-disk name, mixed case included
(`isExistingPluginFileName` in `plugin-paths.ts`), because OpenCode loads any
`.js` or `.ts` name there. Only a new file has to match the lowercase naming
rule.

The plugins page lists entries from every config file OpenCode takes plugins
from: both global files (`opencode.json` and `opencode.jsonc`),
`OPENCODE_CONFIG`, and the files found walking up from the project folder. Each
file adds its own entries and replaces nothing. A parent folder's file reaches
every project below it, so it counts as user scope. A spec in two files of one
scope is one entry, the later file's, and edits go to that file. New user
entries are written to `OPENCODE_CONFIG` when it is set, else to the primary
global file. User plugin
files stay in the global `plugins/` folder: OpenCode scans plugin folders only
in config directories, never next to the `OPENCODE_CONFIG` file. The VS Code
bridge (`opencodeConfig.ts`) keeps the same rules.

Plugin lists omit project configs already represented by a user config,
retaining user scope when the selected project is the global config folder.
Global/custom aliases keep custom precedence and resolve relative targets from
that config path. Distinct declaration IDs
retain their separate entries and options. Local entries include `resolvedPath`,
resolved from their declaring config; discovered records include canonical
`resolvedPath` alongside the original `absolutePath`. Runtime status matches
`absolutePath`, preserving symlink aliases reported by OpenCode. The shared UI
compares `resolvedPath` to hide redundant package
cards. Editable local file cards remain visible even when declared in config.
This metadata does not change registry validation or mutation targets.

A configured plugin spec is classified by `parsedKindForSpec`
(`plugin-spec.js`): an OpenCode 2 control entry is `control`, a filesystem path
is `path`, a Git package spec is `git`, anything else is `npm`. A control entry
switches plugins OpenCode already knows: `-name` disables the plugin with that
id (`-*` and `-prefix.*` disable a group), and `*`, `prefix.*` and
`opencode.<name>` enable them again. It names no package, so the registry route
skips it, the card shows no load status, and it takes no options: OpenCode reads
`-name` as a control entry only as a bare string, and `{package: "-name"}` as a
package to install. The Git forms are the ones OpenCode 2 documents — the
hosted shortcuts (`github:`, `gitlab:`, `bitbucket:`, `gist:`), the `git+`
transports (`git+https://`, `git+ssh://`, `git+file://`) and bare `git://`,
each with an optional `#ref` and npm `::path:` subdirectory. A Git spec must
not reach the npm registry: the registry answers 405 to a name containing a
colon, which the UI reads as an unreachable registry, and a Git spec has no npm
version to check for updates. The registry route returns `git-ok` for such a
spec without querying npm; OpenCode resolves it itself.

The global config directory is what OpenCode 2 uses: `OPENCODE_CONFIG_DIR`
when set, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. Config
files are `opencode.json(c)` only: OpenCode 2 no longer discovers the v1-era
`config.json`, so OpenChamber neither reads nor writes it. In a project both
`<project>/opencode.json(c)` and `<project>/.opencode/opencode.json(c)` are
discovered by OpenCode, `.opencode/` winning; OpenChamber reads and writes the
highest-priority existing one (`.opencode/opencode.json` for a new file), so
an entry that lives only in a lower file is visible through the resolved
catalog but not editable here.

### Remote MCP OAuth

OpenCode's MCP client listens on `127.0.0.1` and, without configuration, registers
a loopback redirect. That is correct when the browser runs on the OpenCode
machine, and wrong when OpenChamber is opened from another one: the provider
sends the browser to the viewer's own `127.0.0.1`, and nothing reaches the
listener. A browser on loopback or with a direct https connection to
OpenChamber, with an OpenCode on the same machine as OpenChamber, finishes on
its own. Everywhere else the
user pastes the address the browser landed on into the waiting sign-in, which
OpenCode accepts since 2.2.6 (an attempt marked `paste`).

The work happens at the start of a sign-in (`mcp-oauth.js`, wired in
`proxy.js`), so an existing entry needs no edit and an entry nobody signs in to
is never changed. `POST /api/integration/mcp_*/connect/oauth` reads the server's
name from OpenCode's integration and then takes one of these paths:

| Situation | What happens |
| --- | --- |
| `oauth: false`, a local server, or a server with no config entry here | Forwarded untouched. |
| `redirect_uri` or `callback_port` written by a person | Forwarded untouched, whatever the origin and whatever OpenCode runs. It is that person's route. |
| OpenCode on another machine, nothing configured or a generated redirect | Started on OpenCode's own redirect, unbound and with the config unchanged, for the user to paste. |
| Relay client, nothing configured | Started on OpenCode's own redirect, unbound, for the user to paste. |
| Either of the two above, OpenCode without `paste` | The attempt is cancelled and the start answers 400 naming the problem, before consent. |
| Browser on loopback, nothing generated | Forwarded untouched, so CIMD and the ephemeral listener stay. This includes an SSH-forwarded address. |
| Browser on another machine over plain http, nothing generated | Started on OpenCode's own redirect, unbound and with the config unchanged, for the user to paste. OpenCode without `paste` gets the generated redirect of the next row instead, which works with a provider that accepts http. |
| Browser on another machine over https | `oauth.redirect_uri` becomes `<origin>/api/mcp/oauth/<name>/callback` and `oauth.callback_port` a free loopback port. The attempt is then bound. |
| Generated redirect already in place, any browser | The attempt is bound, so a loopback or relay browser follows the address generated last. |

Same-machine is decided from the address OpenChamber connects to: loopback or
one of this machine's interface addresses. A hostname that resolves here counts
as another machine, because the mistake then is a clear error and the other way
round is a callback sent to the wrong listener.

A plain-http origin on another machine gets no generated redirect. The MCP
authorization spec allows http redirects only on loopback, and Linear rejects
`http://192.168.x.x/...` at client registration, before consent. OpenCode's
own redirect is loopback, which those providers accept, so the browser lands
on a page that does not open and the user pastes its address. A redirect
generated earlier for that entry stays bound, as for the relay.

The relay is detected by `x-openchamber-relay-connection`, which the dispatcher
sets on every request it forwards. Its requests arrive with a loopback `host`,
so the origin alone would read as a local browser. The relay cannot give the
provider an address that reaches a NAT-hidden server, so a relay sign-in ends
with a paste.

### Why a pasted address and not a refusal where the redirect cannot return

Refusing before consent was the only honest answer while OpenCode could take
nothing but its listener's redirect: a started sign-in would wait for a
callback that never comes. Since 2.2.6 OpenCode validates a pasted redirect
address against the attempt's state, so these starts go through and the
waiting sign-in shows a paste field. The start checks `paste` on the attempt
OpenCode returns, which keeps the refusal for an older OpenCode without a
version probe. The automatic routes stay where they work, because they ask
the user for nothing. The callback route's error page tells the user to paste
its address, since a generated redirect that outlived its OpenCode lands
there.

**Ownership.** `mcp-oauth-assignments.json` in the data directory records each
generated redirect by port. Only an entry whose `redirect_uri` and
`callback_port` match a record is ours to move; path equality proves nothing,
since a reverse proxy can use the same path. The record is written before the
config, so a failed config write leaves a reserved port and never a generated
entry that reads as a person's. An unreadable file fails the sign-in. Records of
deleted servers stay and only reserve their ports.

**Ports.** Preparation runs one at a time in this process, and a new port
excludes every record in the store, in any project, the ports of the entries
visible from this folder, and those of live attempts. A generated port that a
listener or another entry holds at the next sign-in is replaced, which is the
recovery from a collision; a person's port is never replaced. Two OpenChamber
servers over one data directory are not coordinated beyond that bind check.

**A save during preparation.** Preparation rests on the entry the plan read. A
save that lands while a sign-in waits in the queue or allocates a port sends it
back to planning, so a custom redirect saved at that moment stays and the
sign-in goes to the proxy. After 3 rounds the start answers 503. The last check
and both writes run with no await between them.

**The directory.** The route reads the folder by OpenCode's rule: the
`location[directory]` query, then the `x-opencode-directory` header decoded once.
The SDK sends that header encoded with no marker, so it is decoded before
`resolveProjectDirectory` and encoded exactly once for upstream. A named folder
that does not resolve is refused, because global config would answer for it.

**Picking up the write.** OpenCode applies config through its file watcher. The
authorization URL OpenCode returns names the redirect it really uses, so an
attempt on another redirect is cancelled and started again for up to 8 seconds,
then the start answers 503. Each stale start can register a client with the
provider, so the wait between starts doubles.

**The callback.** `GET /api/mcp/oauth/:name/callback` is open without a session.
The state value in OpenCode's authorization URL binds an in-memory attempt to its
server, port, path, and expiry. Only a live state for that server reaches the
loopback listener, once. A missing, wrong, expired, cancelled or replayed state
gets a 400 with no loopback request, so an outside caller cannot fail the
legitimate attempt through OpenCode's own state check. The route reads neither
the current project nor config, so a client that changes project during consent
does not affect it. It forwards only the query keys an OAuth redirect carries,
and it does not follow a redirect from the listener. A restart of OpenChamber
ends the bound attempts, and their callbacks are refused.

A second start for the same server cancels the first attempt, because a fixed
port holds one listener.

**Costs of a generated redirect.**

- Setting `oauth.redirect_uri` turns off OpenCode's Client ID Metadata Document
  path. The provider must support dynamic client registration or have this URI
  pre-registered. This lasts after returning to localhost, because the entry
  keeps the generated redirect.
- OpenCode reuses a client registered by an earlier login, and that client's
  registered redirect is the old one. A provider that compares redirects exactly
  rejects the first sign-in after a move until the saved connection is removed.
- A UI save rebuilds the `oauth` block from what the page loaded, so a page left
  open can drop the generated fields. The next sign-in writes them again.

### v1 read fallback policy

Readers accept the v2 spelling first and fall back to the v1 spelling, because
v2 itself still decodes the legacy keys and users will have mixed files for a
while. When both exist for the same name, v2 wins — the precedence OpenCode's
normalizer applies.

| Entity | v2 | v1 still read |
|---|---|---|
| Agents | `agents` | `agent` |
| Commands | `commands` | `command` |
| Providers | `providers` | `provider` |
| MCP servers | `mcp.servers` | `mcp.<name>` (each file normalized on its own, then OpenCode's order: folder files from `getFolderConfigPaths` > custom > user; a raw merge would let a user-file `mcp.servers.<name>` shadow a project-file `mcp.<name>` override) |
| Plugins | `plugins` | `plugin` (including `[spec, options]` tuples) |
| Permissions | `permissions` rule array | `permission` map, `tools` map |

Writers emit v2 only. **Files are never moved.** Updating an entity that lives
in a v1 file rewrites it at its own path in v2 shape, and a v1 JSON entry moves
to the v2 section key inside the same file — unrelated v1 siblings are left
alone. Every mutation response reports the `path` that changed.

Two consequences worth knowing:

- An agent markdown file may not mix native and legacy frontmatter keys. One
  legacy key routes the whole file through OpenCode's v1 decoder
  (`config/plugin/agent.ts`), which would silently drop a `permissions` array.
  `fromAgentEntity` therefore emits native keys only.
- Migrating a v1 provider entry drops the fields v2 accepts but ignores
  (model `reasoning`, `attachment`, non-`deprecated` `status`, and unknown
  custom keys). That is the documented native conversion, not data loss through
  a bug. v1 model `interleaved` becomes `compatibility.reasoningField` the way
  OpenCode's own migration does; the v2-only provider `canonical` and model
  `compatibility` fields pass through every edit untouched.
- A v1 agent `color` may be a theme name (`primary`); v2 decodes only
  `#rrggbb` and OpenCode's migration maps anything else to `#aaaaaa`.
  `toAgentEntity` applies the same mapping so a rewritten file stays decodable.

### Plugin specs written by the plugins page

A plugin entry is written only when OpenCode 2 can load its spec
(`loadable-plugin-spec.js`, used by `plugins.js` and the VS Code bridge's
`opencodeConfig.ts`). The accepted forms follow OpenCode's own install check
(`Npm.isInstallablePackage` in `packages/util/src/npm.ts`): an npm name with
an optional version, tag or range, a Git spec (`github:owner/repo`,
`git+https://…`, `git+ssh://…#ref`, `git@host:owner/repo.git`, `owner/repo`),
a local path, or a control entry. Anything else is refused with `UNLOADABLE_SPEC`, which the route
answers as 400 with `code`, and the add dialog shows under the field. An
existing entry keeps its spec when only its options change, so a config that
already holds an unloadable spec stays editable.

#### Switching a plugin off

The switch is OpenChamber's, not OpenCode's: it keeps its state in
`<data-dir>/plugin-switches.json` and never writes a new switch into the user's
config. The managed OpenCode OpenChamber starts reads the denials from its own
config layer, so a plain `opencode` process, the TUI or an external server is
unaffected.

The resource is what OpenCode's plugin loader checks: for a package or Git entry
the spec up to its last `@` (`leakshield`, `@acme/plugin`,
`git+ssh://git@github.com/acme/plugin.git#plugin`), and the absolute path for a
local plugin file or package directory. The managed layer carries:

```jsonc
{ "policies": [{ "action": "integration.use", "resource": "plugin:leakshield", "effect": "deny" }] }
```

OpenCode drops a denied plugin however it was configured, so the entry and its
options stay where the user put them while the plugin does not load in
OpenChamber. The switch is OpenChamber-wide: the store keys only by resource, so
switching off a project-scope entry denies that plugin in every project the
managed OpenCode serves, and the page says so. A `file://` spec is matched by OpenCode as the path it
names, so the deny carries that path; any other `file:` spelling names nothing
OpenCode loads and gets no switch. Statements require OpenCode 2.0.29 or newer,
where `policies` is a top-level key.

The switch reads and writes the store, not a config file, so a rule the user
wrote is never removed; when one already denies the entry the page shows the
switch as blocked. A runtime OpenChamber did not start (`isExternalOpenCode`,
`OPENCODE_SKIP_START`) has no managed layer to apply the switch, so the plugin
routes report `unavailable` and refuse a change with `SWITCH_UNAVAILABLE`. When
the user owns `OPENCODE_CONFIG`, the managed runtime can only merge the policies
into `OPENCODE_CONFIG_CONTENT`, which the child reads at launch; the route answers
`requiresManualRestart`, and so does a rewrite that fails after the store write,
because the store is the durable state.

An unreadable store reports every switch `unreadable`. Every whole read of the
store is copied to `plugin-switches.json.last-good` beside it, and `denials()`
falls back to that copy, with a warning naming the store's path. A rewrite and a
fresh launch, after a restart too, keep the plugins as they last were, and the
page explains the switches stay put until the file is fixed or deleted.

### Why a broken store keeps the applied denials and does not stop the launch

Stopping OpenCode over one OpenChamber file took the whole app down for a plugin
setting. An empty list would load every plugin the user switched off. The managed
config file lives in a folder of the running server and goes with it, so the copy
sits beside the store, in the data folder. Without a copy there is no earlier
state, and the launch starts without denials.

OpenCode decides by the earliest-loaded config with a matching statement, so a
`plugin.use` allow that loads ahead of the denial beats it. The managed file loads
right after the global config files, and `OPENCODE_CONFIG_CONTENT` after every
file. `isPluginDenialOverridden` applies that order to the files OpenChamber can
read: the row reports `overridden`, and switching it off is refused with
`SWITCH_OVERRIDDEN` and writes nothing. Turning a stored switch back on stays
allowed. System and Console policies are outside those files; the page catches
them through `/api/config` (`packages/ui/src/components/sections/DOCUMENTATION.md`).

The switch is disabled until the policy read succeeds, and stays disabled when
the read fails: from the client, a denied plugin and an enabled one look the
same. Listing reads every config file OpenCode reads (both global files,
`OPENCODE_CONFIG`, and the folder configs above the project) and never creates
`.opencode`, so opening Settings in a project without a config, or in a
read-only checkout, still lists every plugin.

The VS Code extension applies the same rule from its own store and managed layer
in extension storage, through the same `plugin-switches.js` helpers; an external
OpenCode server (`openchamber.apiUrl`) reports every switch as unavailable.

#### Why rewrite a plain `https://` repository address and not refuse it

npm reads `https://github.com/owner/repo.git` as a Git repository, but
OpenCode 2.0.32 resolves it as a folder named after the URL and fails on every
start (measured: "Cannot find module '<cwd>/https:/github.com/…/server'").
The same repository as `git+https://…` installs and loads. The rewrite only
adds `git+`, and only for an address that names a repository without doubt: a
repository on GitHub, GitLab or Bitbucket, or any address ending in `.git`. A
page inside a repository (`/tree/main`) is refused, since the branch in its
path would be lost.

### Canonical entity shapes

One shape per entity, shared by the web routes and the VS Code bridge. The
conversions live in `config-v2.js`; `packages/vscode/src/opencode-config-v2.ts`
re-exports that module so both runtimes write identical files.

```jsonc
// PermissionRule — ordered array, last match wins.
// Actions: shell, subagent, edit, read, grep, glob, patch, webfetch, websearch,
// skill, question, external_directory, provider.use, "*"
{ "action": "shell", "resource": "git push *", "effect": "ask" }  // effect: allow | deny | ask

// AgentEntity
{
  "system": "Review for correctness.",   // markdown body for .md agents
  "description": "Reviewer",
  "model": "anthropic/claude-sonnet-4-5#high",
  "mode": "primary",                     // primary | subagent | all
  "hidden": false,
  "color": "#aabbcc",
  "steps": 12,
  "disabled": false,
  "request": { "headers": {}, "body": { "temperature": 0.4, "top_p": 0.9 } },
  "permissions": [ /* PermissionRule */ ]
}

// CommandEntity
{
  "template": "Review the current changes.",  // markdown body for .md commands
  "description": "Review",
  "agent": "reviewer",
  "model": "anthropic/claude-sonnet-4-5#high",
  "subagent": true
}

// McpEntity — `type` is required; v2 drops a v1 entry that only had `enabled`
{ "type": "local", "command": ["npx", "@playwright/mcp"], "cwd": "…",
  "environment": {}, "disabled": false, "codemode": true,
  "timeout": { "startup": 0, "catalog": 30000, "execution": 30000 } }
{ "type": "remote", "url": "https://mcp.example.com", "headers": {},
  "oauth": { "client_id": "…", "client_secret": "…", "scope": "…",
             "callback_port": 4242, "redirect_uri": "…" },
  "disabled": false, "timeout": { "catalog": 30000, "execution": 30000 } }

// ProviderEntity
{
  "canonical": "openai",                 // v2-only: built-in provider this entry inherits from
  "name": "Campus LLM",
  "package": "aisdk:@ai-sdk/openai-compatible",
  "env": ["CAMPUS_KEY"],
  "settings": { "baseURL": "https://llm.example.edu/v1" },
  "headers": {}, "body": {},
  "models": {
    "fast-model": {
      "modelID": "fast-model", "name": "Fast", "family": "…", "package": "aisdk:…",
      "compatibility": { "reasoningField": "reasoning_content", "requireReasoning": true, "maxTokensField": "max_tokens" },
      "settings": {}, "headers": {}, "body": {},
      "capabilities": { "tools": true, "input": ["text","image"], "output": ["text"] },
      "variants": [{ "id": "high", "settings": { "reasoningEffort": "high" } }],
      "cost": { "input": 1, "output": 2, "cache": { "read": 0.1, "write": 0.2 } },
      "limit": { "context": 200000, "output": 32000 },
      "disabled": false
    }
  }
}

// PluginEntity — serialized as a bare string when there are no options
{ "package": "./plugin/local.ts", "options": { "enabled": true } }
```

`model` is always the joined string `providerID/modelID#variant`. Split it with
`parseModelSelection(model)` → `{ providerID, modelID, variant? }` and join it
back with `formatModelSelection(selection)`. Both are exported from
`config-v2.js`.

### Request and response JSON per route

`GET /api/config/agents/:name` — metadata about where the agent is defined.
```jsonc
{
  "name": "reviewer",
  "scope": "project",              // project | user | null
  "isBuiltIn": false,
  "sources": {
    "md":   { "exists": true, "path": "…/.opencode/agent/reviewer.md", "scope": "project",
              "legacy": true,      // file uses v1-only frontmatter
              "fields": ["description", "model", "permissions"] },
    "json": { "exists": false, "path": "…/opencode.json", "scope": null,
              "sectionKey": null,  // "agents" or "agent" when the entry exists
              "legacy": false, "fields": [] },
    "projectMd": { "exists": true,  "path": "…" },
    "userMd":    { "exists": false, "path": "…" }
  }
}
```

`GET /api/config/agents/:name/config` — the canonical entity.
```jsonc
{
  "source": "md",                  // md | json | none
  "scope": "project",
  "path": "…/.opencode/agent/reviewer.md",
  "legacy": true,
  "config": { /* AgentEntity */ }
}
```

`GET /api/config/agents/:name/permissions` — what applies to this agent.
```jsonc
{
  "global":    [ /* PermissionRule, from config `tools` + `permission` + `permissions` */ ],
  "agent":     [ /* PermissionRule, the agent's own rules */ ],
  "effective": [ { "action": "edit", "resource": "*", "effect": "allow", "source": "global" },
                 { "action": "edit", "resource": "*", "effect": "deny",  "source": "agent" } ],
  "source": "md",
  "path": "…"
}
```
`effective` is in evaluation order: global rules first, agent rules last. Last
match wins, so a later rule overrides an earlier one.

`POST /api/config/agents/:name` — body is an `AgentEntity` plus
`scope: "user" | "project"`. Answers
`{ success: true, message, scope, path }`.

`PATCH /api/config/agents/:name` — body is a partial `AgentEntity`. `null`
removes a field, an omitted field is left alone. `permission` (a v1 map) and
`prompt` (the v1 name for `system`) are still accepted and translated. Answers
`{ success: true, message, source, scope, path }`.

`DELETE /api/config/agents/:name` — optional body `{ scope }`. Answers
`{ success: true, message }`.

`GET /api/config/commands/:name` — same `sources` envelope as agents.
`GET /api/config/commands/:name/config` — `{ source, scope, path, legacy, config }`
with a `CommandEntity`.
`GET /api/config/command-configs?name=a&name=b` — `{ commands: [{ name, entry }] }`,
each `entry` what the route above answers for that name. The client lists a
folder's commands with it in one request: read one by one they cost a round
trip each, which over the relay was a second for a dozen. Names pass the same
path check as `:name`; one unsafe name refuses the request, and an entry that
cannot be read is left out.
`POST` / `PATCH` / `DELETE /api/config/commands/:name` mirror the agent routes;
`subtask` is accepted as the v1 name for `subagent`.

`GET /api/config/mcp` — array of `McpEntity` extended with
`{ name, scope, sectionKey, legacy }`. Servers come from the global files,
`OPENCODE_CONFIG`, and every folder file OpenCode reads for the project,
parent folders included. `scope` is `project` only for the project folder's
own files; a parent folder's server reads as `user`. `PATCH` and `DELETE`
write the file whose definition OpenCode uses, a parent folder's file
included; a broken folder file is skipped, a broken global or custom file
fails the request.
`GET /api/config/mcp/:name` — one such entry, or 404.
`POST` / `PATCH` / `DELETE /api/config/mcp/:name` — body is an `McpEntity`
(plus `scope` on create). Answers `{ success: true, message, path }`.

`GET /api/mcp/oauth/:name/callback` — the provider's redirect target, open
without a UI session. A state value bound to a live attempt forwards `code`,
`state`, `error`, `error_description`, `error_uri` and `iss` to that attempt's
loopback listener and relays its status and body; anything else answers 400
without a loopback request. It answers 502 when the listener is gone. See
"Remote MCP OAuth".

`PUT /api/provider` — body accepts either spelling: v2 `{ package, settings,
headers }` or v1 `{ npm, options }`. The stored entry is always a
`ProviderEntity` under `providers`. Answers `{ providerId, path, config }`.
`GET /api/provider/:providerId/source` reports which layers define it.

## Public exports (config-entity-routes.js)
- `registerConfigEntityRoutes(app, dependencies)`: registers configuration entity routes:
  - Agents: `/api/config/agents/:name`, `/api/config/agents/:name/config`, `/api/config/agents/:name/permissions`
  - Commands: `/api/config/commands/:name` and `/api/config/commands/:name/config`
  - MCP servers: `/api/config/mcp` and `/api/config/mcp/:name`
  - Snippets: `/api/config/snippets`, `/api/config/snippets/:name`, and `/api/config/snippets/expand`
- Snippet writes keep every trigger unique. A new snippet, or a rename, under a name or alias another snippet already answers to fails with 409 and writes nothing, so a second file never shadows the first. `PATCH /api/config/snippets/:name` renames with `name` and moves between the global and project folder with `scope`; the file is renamed in place (copied and removed across volumes), and a case-only rename is a rename of the same file. `POST /api/config/snippets/expand` expands a prompt from `text`, or with `content` previews an unsaved snippet body exactly as `#name` would send it once saved. The VS Code extension host (`packages/vscode/src/opencodeConfig.ts`) carries the same rules, and its webview answers a taken name with 409 too.
- Agent/command/MCP write routes persist config to disk and return plain success. OpenCode 2 watches those files and rebuilds the affected entity itself, so there is nothing left to apply.

## Public exports (mcp-oauth.js)
- `createMcpOAuthSignIn(dependencies)`: the sign-in state for one server process. `registerCallbackRoute(app)` registers the public callback, and `registerStartRoutes(app, { readBody })` the start and cancel interception in front of the generic proxy.
- `isSameMachineUrl(url, addresses?)`: whether an OpenCode address is this machine.

## Public exports (config-mutation-response.js)
- `buildAppliedResponse(message, details?)`: success payload for a config mutation that is already live (`{ success: true, message }`, no restart flags). `details` carries the file the write landed in (`{ path, scope, source }`) so the caller can name the config file that changed, including a v1 file rewritten in place in v2 shape.
- `buildExternalManualRestartResponse(message)`: success payload when OpenCode is an external process and the operator must restart it manually (`requiresManualRestart: true`).

## Public exports (auth-state-runtime.js)
- `createOpenCodeAuthStateRuntime(dependencies)`: creates runtime for managed OpenCode auth password state and request headers.
- Returned API:
  - `getOpenCodeAuthHeaders()`
  - `isOpenCodeConnectionSecure()`
  - `ensureLocalOpenCodeServerPassword(options?)`

## Public exports (opencode-resolution-runtime.js)
- `createOpenCodeResolutionRuntime(dependencies)`: creates runtime for OpenCode binary/source snapshot resolution.
- Returned API:
  - `getOpenCodeResolutionSnapshot(settings)`: returns configured/resolved OpenCode binary details plus effective managed-launch fields (`launchBinary`, `launchArgs`, `launchWrapperType`) when applicable.

## Public exports (skills.ts)
- `getSkillSources(skillName, workingDirectory, discoveredSkill?, options?)`: returns the skill's Markdown metadata and instructions, source paths and scopes, and supporting files. Supporting files are included by default. `GET /api/config/skills` calls it once per skill with `{ includeSupportingFiles: false }`, which omits `md.supportingFiles` and skips walking supporting files.

## Public exports (skill-routes.ts)
- `registerSkillRoutes(app, dependencies)`: registers skills-related routes:
  - Skills config CRUD and metadata under `/api/config/skills*`
  - `DELETE /api/config/skills/:name` removes every copy of the name, in the project and the user's skill folders. With `scope` (`user`|`project`) and `source` (`opencode`|`claude`|`agents`) in the query it removes only the copy there and fails when that copy is missing; the integrations catalog uninstalls this way so it never removes a same-named skill the user keeps elsewhere
  - Skill rename via `PATCH /api/config/skills/:name` with `{ renameTo }` (directory rename preserves `SKILL.md` body and supporting files; restricted to managed skill roots under `.opencode/skills|skill`, `.claude/skills`, and `.agents/skills`)
  - Skill list responses include authoritative `renamable` derived from the same managed-root policy used by rename
  - An OpenCode built-in skill (path `/builtin/<id>.md`, or `skill://<id>/SKILL.md` from 2.2.7) has no file: it is listed with the path `<built-in>`, and its detail returns the text OpenCode sent as read-only instructions. The VS Code bridge (`bridge-settings-runtime.ts`) applies the same rule
  - `GET /api/config/skills` leaves `sources.md.supportingFiles` out: listing every file of every skill cost seconds when a skill bundles a `.venv` or `node_modules`, and no list consumer reads it. `GET /api/config/skills/:name` still returns it
  - Recursive skill walks, markdown reads, and per-skill source probes use `fs.promises`. The list enriches one skill at a time so filesystem waits yield to other requests. Discovery still uses synchronous config and root checks.
  - The list shares discovery's parsed markdown by exact file path within the request. OpenCode's selected path wins even when local discovery picks another copy with the same name; a path absent from the parse map is read normally. Each request gets a new map, and source lookup still checks whether the selected file exists.
  - Create, edit and rename run one at a time per process, so an existence check cannot go stale before its own write; create also writes `SKILL.md` with `wx` and reports an existing file as "already exists" instead of overwriting it
  - `disableModelInvocation` (detail `sources.md`, create/update body) is "run only when called": it writes both `disable-model-invocation: true` and `metadata.opencode/autoinvoke: false` so every supported OpenCode 2.x and Claude Code honour it, reads back the way OpenCode resolves the pair (`opencode/autoinvoke` wins), and clearing it removes both keys while keeping other `metadata`. The VS Code runtime mirrors this in `opencodeConfig.ts`
  - `PUT /api/config/skill-switch` with `{ id, enabled, scope }` turns a skill off or back on for agents through `skill-switch.js`. Off writes one exact `skill.use` deny for `<id>` into the top-level `policies` of the skill's own scope (`getJsonWriteTarget`, so `OPENCODE_CONFIG` when set), unless that file's last exact statement for the id is already a deny: OpenCode applies the last matching statement, so a deny followed by an exact allow gets a new deny after it; on removes the exact deny for the id, as `skill.use` `<id>` or the legacy `integration.use` `skill:<id>` an older OpenChamber wrote, in `policies` and the deprecated `experimental.policies`, from every config file OpenCode reads for the directory, skipping files it cannot parse. Wildcards, allows and other statements are never touched. The answer lists the files it changed. The pure edit is `writeSkillDisabled` in `config-v2.js`, shared with the VS Code bridge (`api:config/skill-switch`). OpenCode watches these files, so nothing restarts
  - Skills catalog listing/source pagination, scan, and install routes
  - Supporting skill file read/write/delete routes
  - Directory resolution prefers an explicit request directory, then soft-falls
    back to the active project / `lastDirectory` so repository-local
    `.agents/skills` and `.opencode/skills` remain discoverable when the client
    omits `directory`. Requests without any project still list user-scoped skills.

Catalog cache reads establish the object container. The route still checks
metadata fields individually and passes cached skill fields through as read.
For supporting-file routes Express can supply a wildcard as an array. It is
converted to the same string the URL decoder received in JavaScript.

### Why parsed markdown is shared within a request

Discovery already reads each skill's frontmatter and body. Source lookup uses that same read so listing does not open and parse the file again. The map holds a request's snapshot, so an edit during a list appears on the next request. Keeping entries across requests would need invalidation for external file edits.

Skill detail keeps YAML `name` and `description` as read. Discovery still
requires a string name. Writes preserve YAML values and let the Markdown
writer interpolate the instruction body. Supporting file paths require
strings; file data can also be a Node array-buffer view.

## Public exports (proxy.js)
- `registerOpenCodeProxy(app, dependencies)`: registers OpenCode proxy routes and middleware.
- Owns:
  - SSE forwarders: `GET /api/global/event`, `GET /api/event`
    - Downstream heartbeats keep clients and intermediaries alive, while a separate upstream-only stall watchdog closes the downstream response when OpenCode stops producing bytes so clients reconnect instead of trusting synthetic heartbeats indefinitely. Each watchdog reset uses the current load-aware timeout, matching the shared event transport.
  - Session message forwarder: `POST /api/session/:sessionId/message`
  - Session list and detail: `GET /api/session`, `GET /api/session/:sessionID`
    - Both are sanitized to an allowlist of `SessionInfo` fields, then get the entries of `lib/openchamber-sessions/archive-store.js` folded in (archive state OpenChamber kept before OpenCode held it, until the migration pushes it, see `session-archive.js`), plus any `metadata` entry `lib/openchamber-sessions/session-metadata-store.js` has not migrated from the legacy file yet, plus the unread baseline (`lib/openchamber-sessions/unread-baseline.js`): a turn that ended before it is served with `time.viewed` up to its `time.idle`, so sessions that finished before OpenChamber read OpenCode's unread state do not all show as unread. An unknown answer from any of them leaves the upstream record untouched rather than reporting a session as un-archived, dropping its metadata, or marking turns seen.
  - Shelled message pages: `GET /api/session/:sessionID/message` with `x-openchamber-part-shells: v1[,<tool>…]` returns the page with finished tool results replaced by an `openchamberContentShell` metadata marker and with fields no client reads dropped (`message-shells.js`); a result that was an OpenChamber tool envelope, from the tool itself or from an `execute` script, keeps `{ ok, action }` in the marker for the collapsed row. A successful `workflow.run` or `image.generate` envelope stays whole: the chat draws the run's card and the images from that result, and a shelled one left only the tool row after a reload. Without the header the request reaches OpenCode untouched. `GET /api/session/:sessionID/message/:messageID` is never shelled, so clients complete a call from it. `/health` and `/api/version` list `api.message-part-shells.v1` so clients send the header only to servers that honour it.
  - Upstream bound for the session routes: `GET /api/session`, `GET /api/session/:sessionID` and the shelled `GET /api/session/:sessionID/message` read OpenCode with the generic proxy's deadline (`SESSION_UPSTREAM_TIMEOUT_MS` overrides it in tests) and cancel that read when the client hangs up. Cancelling on hang-up is what stops abandoned reads from piling up when the UI retries; a budget shorter than the UI's own 30s wait would turn a slow but working session open into a retry loop of 504s. The budget starts before the path canonicalization, so a client that leaves during that wait cancels the read too. A read that ran out of time answers `504 OpenCode upstream timed out`, the same answer the generic proxy gives; a client that hung up gets nothing, because there is nobody left to answer. These routes read OpenCode themselves instead of reaching the generic proxy, so they apply its deadline explicitly.
  - Upstream paths are the request paths. OpenCode 2.x serves everything under `/api/*` itself, so the mount prefix Express strips is put back instead of being rewritten away.
  - There is no interactive OAuth forwarder any more: v2 connects providers through `/api/integration/*`, whose OAuth steps return immediately and are polled, so no route needs a longer deadline than the ordinary one.
  - Generic `/api/*` forwarding with hop-by-hop header filtering
  - Session list forwarding on every platform, preserving V2 query filters and pagination cursors. Global reads use OpenCode's cross-directory list rather than merging per-project pages on Windows.
  - OpenCode readiness gate for proxied `/api` requests
  - Worktree checkout gate before directory-scoped upstream reads and writes
  - Folder trust gate (`../opencode-trust`): a request for a folder whose OpenCode configuration runs code answers 403 `opencode_trust_required` until the user trusts it, and `GET`/`POST /api/opencode/trust` serve the prompt. Registered ahead of the readiness hold, since the answer needs no running OpenCode. A session move names its destination in the body, which reaches the proxy unread; the gate parses that body (`express.json`, 64 KB) and `replayParsedBody` sends it upstream.

Git bootstrap must reach `git-ready` before OpenCode can cache a new worktree's
project identity or config. Setup scripts may still be running; the optional UI
setup wait remains separate. A timed-out checkout returns 503 without
forwarding. A failed checkout returns 503 to every request that would start
the folder's OpenCode location; the reads OpenCode answers without one
(`isGlobalRead` in `../opencode-trust`, which the trust gate also uses: the
session list, session and message reads, events) pass, so the worktree's
sessions stay listed while the user repairs it. Mutations stay closed:
moving a session starts both its source and destination locations. The gate
checks the destination from the body (`readMoveDestination` in
`../opencode-trust`) and reads the session's current folder fresh, so moves
into or out of a failed checkout remain closed. A repair that completes the
checkout (`onCheckoutHydrated`) evicts the folder's locations before the record
turns ready, so OpenCode opens the repaired folder afresh. The shared draft
creator keeps the project directory selected until creation returns, because
preview paths have no bootstrap state. A directory with no bootstrap state was
never populated by this server and passes at once. A folder that no longer
exists never holds the gate either: a cached failure answers only while one
`lstat` still finds the folder. The gate
reads memory (`getWorktreeBootstrapGateStatus` in `../git/service.js`): the
durable bootstrap store takes a cross-process file lock per read, which must not
sit on every proxied request. The first request for a folder in each server
process loads that folder's saved record once, so a checkout that failed before
a restart is refused from the first request; concurrent first requests share
the one read. A store that cannot be read leaves the folder to memory, since
failing closed there would close every folder.

This server gate covers web, Electron, hosted mobile, and Capacitor connections.
The VS Code extension owns its separate Git and proxy implementation.

### Why directory normalization preserves unsafe header values

Marked directory headers decode before worktree and folder-trust checks only when Node's `http.validateHeaderValue` accepts the result. Values Node cannot carry stay encoded with their `uri` marker for OpenCode, while the guards read the decoded folder separately. Malformed escapes keep their raw value and lose the marker, matching the existing fallback and allowing trust checks for literal-percent folder names. The generic proxy must not decode again or remove a retained marker.

### Why a failed checkout stays closed to OpenCode

Forwarding every request for a failed checkout was weighed and rejected: the
first location-scoped request would let OpenCode cache the half-populated
folder's project identity and config, and sessions created after a repair
would keep them. Keeping only location-starting requests out leaves the
recovery path (session list, binding reads, Download again, archive) working
without that risk.

### Why the proxy drops browser fetch metadata and not adds origins to OpenCode's CORS list

Since 2.2.6 OpenCode answers 403 to an `/api` request whose `Sec-Fetch-Site`
is `cross-site` or `same-site` unless its `Origin` is on OpenCode's CORS list.
Packaged clients reach this server cross-site (`openchamber-ui://app`,
`capacitor://localhost`, `https://localhost`), so every proxied call failed.
OpenChamber vets its own clients before proxying, and to OpenCode the request
comes from this server, so both forwarding paths drop `sec-fetch-*`
(`proxy-headers.js`). Passing `--cors` for each packaged origin was weighed and
rejected: it fails for an external OpenCode OpenChamber does not launch.

### Why the proxy deadline is configurable

Slow gateways can exceed the default 240000 ms deadline. Operators can set
`OPENCHAMBER_PROXY_TIMEOUT_MS` to an integer from `0` to `2147483647`.
Invalid values warn at startup and keep the default. The upper bound prevents
Node socket timers from overflowing to 1 ms; integers also satisfy
`AbortSignal.timeout`. Zero disables the response deadline and proxy socket
timers, allowing unbounded waits while retaining client-disconnect cancellation.
The generic proxy watches response closure before upstream headers arrive and
destroys abandoned outgoing requests even after the incoming body is complete.
That listener is removed when the outgoing request closes.
Other client and upstream timeouts, SSE watchdogs, and readiness deadlines
remain unchanged. Web, Electron's server, hosted mobile, and Capacitor use this
setting; VS Code's separate extension bridge does not.

## Public exports (watcher.js)
- `createOpenCodeWatcherRuntime(dependencies)`: creates global event watcher runtime backed by the shared upstream SSE reader.
- Returned API:
  - `start()`
  - `stop()`
- Behavior:
  - Waits for OpenCode readiness before attaching the watcher.
  - In production wiring, subscribes to the shared global message-stream hub instead of opening its own `/api/event` connection.
  - Can still create its own `/api/event` reader when no shared hub is provided, which keeps module tests and isolated reuse simple.
  - Reuses event-stream parsing, `Last-Event-ID`, stall timeout, and reconnect behavior.
  - Translates each v2 wire event through `lib/event-stream/translate-v2.js` before handing it to notification/session side effects, so those consumers keep speaking the server's own event vocabulary.
  - Calls `onPayload(payload, { spaceId })`: `spaceId` is the isolated space an event came from, `null` for the host's own. A space's session exists only in the OpenCode inside that space, so a consumer that reads a session must read it there.
  - Calls the optional `onConnect()` on each connect of the stream, and once at start when the shared hub is already connected. `index.js` reads OpenCode's running list there and hands it to `adoptRunningSessions`. A failure is logged and does not touch the stream.
  - Calls the optional `onDisconnect()` on every stream loss (a disconnect or a stream error), so a consumer that must not act on a stale picture, such as chat-directory cleanup, can stop until the next connect.
  - Calls the optional `onWirePayload(payload, { spaceId })` with each untranslated wire payload before translation, for consumers that need events the translation drops.

## Storage and configuration
- Provider auth: read from the running OpenCode over `GET /api/credential` (2.0.20+); OpenCode 2.x owns credentials.
- Session archive state: on OpenCode's record (`PATCH /api/session/{id}` with `archived`) through `lib/openchamber-sessions/session-archive.js`. Since 2.2 that PATCH writes the record without building the session's location, so it works for a session whose directory is gone and starts no MCP servers. `sessions-archive.json` under the OpenChamber data dir only drains: it holds entries written before 2.1, and for sessions of deleted directories before 2.2, until the migration after OpenCode starts pushes them; archiving or restoring a session drops its entry.
- Unread baseline: `sessions-unread.json` (`{ since }`) under the OpenChamber data dir, created once on the first start that reads it and never replaced; an unreadable file is left alone and the proxy serves records as they are. The VS Code extension reads and creates the same file.
- Turn length: `lib/openchamber-sessions/turn-duration.js` watches the translated event stream and, when a top-level session's turn ends, writes `openchamber.turn = { endedAt, durationMs }` into its metadata, both in OpenCode's event time. Only a turn seen from its first busy event is recorded; starts are in memory and a stream reconnect forgets them, since it may have hidden an end. The UI shows the length while the session is unread.
- Session metadata (goal progress, the assist recap, the obligatory-context cursor, pinned notes) lives on the OpenCode session record, written with `PATCH /api/session/{id}`. OpenCode 2.0.15 added metadata writes through this API; `compatibility.js` enforces a minimum of 2.2.4. OpenCode replaces the whole object, so `sessionMetadataStore.setSessionMetadata` reads the record, applies the JSON Merge Patch and writes the result, one write per session at a time; a record that cannot be read stops the write. Since 2.2 the write also works for a session whose folder is gone. Every reader and writer (routes, goal loop, session assist, session knowledge, obligatory context, notifications) goes through `sessionMetadataStore.get` / `setSessionMetadata`. Older OpenChamber versions kept this state in `sessions-metadata.json` under the data dir. Its entries are the newest metadata their sessions have: the proxy lays them over OpenCode's records, a session's next write pushes its entry, and a sweep after OpenCode starts pushes the rest (a session OpenCode no longer knows is dropped, any other failure waits for the next write or start). The emptied file is renamed to `sessions-metadata.json.migrated`. Archive changes run one at a time per session, so the migration sweep cannot overwrite a user's newer archive or unarchive.
- User config: `<config dir>/opencode.json(c)` where the config dir is `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. The v1 `config.json` is not read.
- Project config: `<workingDirectory>/.opencode/opencode.json(c)` first, else `<workingDirectory>/opencode.json(c)`.
- Custom config: `OPENCODE_CONFIG` env var path.
- Origins (`../security/request-security.js`): CORS with credentials and socket upgrades trust the request's own host, `publicOrigin`, and the packaged clients (`openchamber-ui://app`, `capacitor://localhost`, `https://localhost`). Any other loopback port is trusted only on a development server (`OPENCHAMBER_ELECTRON_DEV=1` or `OPENCHAMBER_ALLOW_DEV_ORIGINS=1`, which the dev scripts set). Without a UI password a socket that names an `Origin` must still come from one of these (`isPasswordlessSocketOriginAllowed`): nothing else would stop a website open in the user's browser from reaching the terminal on the loopback port. Clients that send no `Origin` are not pages and pass.
- Rate limit config: `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS`, `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` env vars. Login and tunnel-connect limits key on the client that `../security/client-address.ts` resolves: `X-Forwarded-For` counts only through loopback peers and addresses in `OPENCHAMBER_TRUSTED_PROXIES` (comma-separated addresses or CIDR ranges); relay-dispatched sign-ins share one bucket. They do not use `req.ip`: `server/runtime.ts` sets `trust proxy` to loopback, link-local and private ranges, which would let a LAN peer open a fresh bucket per attempt.

## Notes for contributors
- This module serves as foundation for OpenCode-related server utilities.
- Route ownership moved to module-level `routes.js`; `index.js` wires dependencies only.
- All file writes include automatic backup before modification.
- Config merging follows priority: custom > project > user.
- UI auth uses scrypt for password hashing with constant-time comparison.
- Tunnel auth treats `host.docker.internal` as local-only when the socket remote IP is private/loopback.

The behavior `GET /api/behavior/agents-md` response includes `path`, the effective
server-side filename, whether or not the file exists. Settings displays this
path without deriving a directory from the browser environment. A `PUT` may send
`expectedContent` (the content the editor loaded, `null` for no file); when the
file on disk no longer matches, the write is refused with `409` and code
`AGENTS_MD_CONFLICT` instead of overwriting an edit made elsewhere.

## Managed OpenCode config layer (managed-config-file.js)

OpenChamber injects its own OpenCode plugins through a file it owns rather than
through the process environment, because an environment variable cannot change
under a running child.

- Contract: the managed child gets `OPENCODE_CONFIG=<data-dir>/run/instances/<server-pid>/opencode.managed.json`.
  Each server writes the file and the agent-tool plugin in its own folder
  (`instance-dir.js`): several servers can share one data dir, and with shared
  paths each overwrote the other's files, so an agent saw tools from one server
  while its calls went to another (#4470). On start a server removes the
  folders of servers whose pid is gone; a live server's folder is never touched.
  The pid check assumes every server on the data dir runs in one PID
  namespace: two containers sharing a data dir through a bind mount see each
  other's pids as gone, so a starting server can remove a live peer's folder,
  and that peer's OpenCode loses its managed tools until the next settings
  write or restart.
  The old shared `<data-dir>/agent-tool/` and `<data-dir>/opencode.managed.json`
  stay on disk on purpose: an older OpenChamber running on the same data dir
  still reads and writes them, so deleting them as stale breaks that server's
  agent tools.
  The file's `plugins` list is `-opencode.browser` first, then the absolute
  directory of every OpenChamber plugin currently switched on, then the plugin
  folders of active extensions (`contributes.opencodePlugin`, listed by
  `guests/agent-context.js` `pluginDirectories`): OpenCode loads in list
  order, so an extension never shadows a managed tool. OpenCode's
  built-in browser tools need OpenCode's own desktop app to attach a browser;
  OpenChamber does not, so they would always fail with `browser.disconnected`
  and steer agents away from `openchamber_web`. A project config listing
  `opencode.browser` re-enables it. While `openchamber_image` is on,
  `-opencode.tool.image-generate` follows it: OpenCode's own opt-in image tool
  would give the agent a second image tool on a model the user did not pick
  in Settings. While `openchamber_schedule` is on, `-opencode.tool.automation`
  follows it the same way: OpenCode's opt-in automations (2.3.1) would be a
  second scheduler that OpenChamber's Scheduled tasks do not show. The fallback path merges the same entries. Its layer sits above the user's
  global `opencode.json` and below their project config.
- `OPENCODE_CONFIG_CONTENT` is passed through untouched, so whatever the user
  put there still applies.
- `OPENCHAMBER_AGENT_TOOL_URL` and a fresh `OPENCHAMBER_AGENT_TOOL_TOKEN` are
  always in the child environment, including while every managed tool is off —
  a tool switched on later then reaches a process that can already call back.
- `persistSettings` rewrites the file (temp + rename) whenever
  `agentControlToolEnabled`, `agentScheduleToolEnabled`, `agentWebToolEnabled`, `agentMemoryToolEnabled`,
  `agentKnowledgeToolEnabled`, `agentNotifyToolEnabled`, `agentRenderToolEnabled`, `agentSecretToolEnabled`, `agentUsageToolEnabled`, `agentTerminalToolEnabled`, `agentActionsToolEnabled` or `agentWorkflowToolEnabled` changes, and the guest change listener rewrites it after an extension is installed, approved, paused, resumed, updated or removed. Plugin directories are written before the
  file names them, and a disabled plugin is removed from the list. OpenCode
  reloads within a couple of seconds; no restart is involved. Writes run one at
  a time: the catalog is read before the file is written, so two refreshes
  could land in read order and bring back the folder of an extension that
  was just paused; a refresh requested during a write runs the whole
  read-then-write once more instead, so the file always ends with the newest
  catalog (`refreshManagedConfigFile` and `buildManagedChildEnv` share that
  runner). A policy change while the app runs also rewrites it
  (`watchEnterprisePolicy` in `../enterprise-mode.js`, started by `index.js`):
  without that, a folder the policy now refuses would stay loaded until the
  next catalog event. A folder listed here and in the user's global config at
  once is loaded once by OpenCode 2.2.5 (checked live), so nothing is filtered.
- Fallback: when the user's own environment already sets `OPENCODE_CONFIG`,
  OpenChamber does not take it over. It merges its plugin directories, the
  extensions' plugin folders among them, into `OPENCODE_CONFIG_CONTENT`
  instead, and those installs keep the old behavior: a managed-tool toggle or
  an extension change needs an OpenCode restart to take effect. The extension
  card then says so and offers "Add to global config" (`guests/DOCUMENTATION.md`),
  which writes the folder into the user's global `opencode.json(c)` through
  `plugins.js` `addGlobalPluginEntry`; OpenCode watches that file, so the
  plugin loads without a restart, in every OpenCode on the machine.
- An external OpenCode (connected by URL, not spawned) reads neither the file
  nor the content; `refreshManagedConfigFile` still writes the file, which is
  harmless. The card's delivery state (`guests/opencode-plugin.js`) tells the
  user, and the same button is the way in.

### Why the shared service is replaced when it is older than the installed CLI

With the shared service setting on, `shared-service.ts` reads the version of
the OpenCode CLI on disk and passes `Service.ensure` a predicate that accepts
a running service of that version or newer. `opencode update` swaps the binary
but leaves the running `serve --service` on the old version, so reusing any
service it finds kept OpenChamber on the old OpenCode until the user stopped
the daemon by hand, while the About page and the update toast asked for a
restart that did nothing. OpenCode's own TUI and desktop replace the service on
a version mismatch the same way, and the replacement hands persistent terminals
and open turns to the new process. A newer service is kept so OpenChamber never
downgrades what other clients run. Only release versions are compared: preview
builds such as `0.0.0-next-10` do not order as semver and a preview CLI keeps
its own registration file, so a preview on either side is reused as is. The
version probe and the service command both go through the managed launch
resolver, so a Windows `opencode.cmd` shim becomes the native executable: the
client spawns the service without a shell, and a service stopped for
replacement could not be started again from a shim. When
the CLI version cannot be read, in enterprise mode, or when a failed switch to
the managed server rolls back to the shared one, OpenChamber reuses whatever
service is registered and never restarts it.

The same replacement makes the update toast work in shared mode. The upgrade
capability reports `supported` while OpenChamber is connected through the
shared service and outside enterprise mode, `/api/opencode/upgrade` runs
`opencode upgrade` with the CLI that launches the service, and the toast's
Reload goes through `restartOpenCode`, whose reconnect replaces the now older
service. A config reload that replaced the service answers `requiresReload`, so
the UI refreshes; one that reused it still asks the user to restart the
connected server, because the running service has not reread its config. The
CLI upgrade skips the Windows stop-and-start step: OpenChamber cannot stop a
service it shares, and OpenCode's own upgrade keeps `serve --service` alive
while it replaces the executable.

### External local OpenCode plugin bridge (`external-plugin-bridge.ts`)

When OpenChamber connects to an externally started local OpenCode server (such
as `opencode serve --service` or an enterprise-managed local daemon), OpenChamber
does not spawn OpenCode and cannot pass `OPENCODE_CONFIG` or callback env vars.

- **Ownership:** `external-plugin-bridge.ts` materializes one stable plugin
  folder at `<dataDir>/plugins/openchamber/` combining OpenChamber's agent tools,
  limit-failover `retry` hook, `prompt`/compaction hooks, and `session-title`
  transforms, plus an atomic `<dataDir>/runtime-bridge.json` file (mode `0600`)
  holding `{ version, pid, url, token, failoverEnabled, tools }`.
- **Invariants:**
  - The external plugin stays completely dormant (`ctx.tool.transform`,
    `ctx.agent.transform`, and hooks are no-ops) whenever
    `OPENCHAMBER_AGENT_TOOL_URL` is set in the OpenCode process env (managed
    child), when `runtime-bridge.json` is absent, or when the recorded `pid` is
    not alive.
  - While active, `ctx.tool.transform` registers enabled OpenChamber tools and
    removes replaced built-in OpenCode tools (`browser.*`,
    `experimental_image_generate`, `automation_*`, `opencode_worktree_create`,
    `opencode_models`) dynamically without writing `-opencode.*` entries into
    the user's global `opencode.json`.
  - Watching `<dataDir>` for `runtime-bridge.json` changes and checking `pid`
    liveness triggers `ctx.tool.reload()` and `ctx.agent.reload()` when
    OpenChamber starts, updates tool settings, or exits, so built-in OpenCode
    tools and native session titles return when OpenChamber closes.
  - OpenChamber never silently edits the user's global `opencode.json`:
    `GET/POST/DELETE /api/config/external-opencode-plugin(/global-config)` and
    `ExternalOpenCodePluginBanner` in Settings let the user explicitly add or
    remove the plugin path or copy it for enterprise-managed configs.
- **Why one bridge file + dynamic `tools.remove` instead of per-message metadata
  isolation:** Filtering per turn via message metadata breaks Code Mode catalog
  hiding and requires tagging every background prompt sender. Treating the
  external local OpenCode as shared while OpenChamber is running and restoring
  native behavior as soon as OpenChamber exits keeps the contract simple and
  reliable.

### Session title prompt

OpenCode names a new session with its hidden `title` agent. Its built-in prompt
keeps file names and issue numbers and tends to restate the request, so the
first title often reads like a summary of the prompt and gets cut off in the
sidebar. `session-title-plugin.ts` replaces that agent's `system` prompt with
the folder-label style the UI's own regeneration uses
(`packages/ui/src/lib/sessionTitle.ts`). The two prompts change together
unless a decision below says why one differs.

- The plugin is listed on every managed launch, with no setting. External
  OpenCode and the VS Code extension's own OpenCode get no managed plugins, so
  they keep OpenCode's prompt.
- An `agents.title.system` the user set, in global or project config or an
  agent file, still wins. OpenCode activates configured plugins after its
  built-in agents and before its config agents, so the config writes the
  prompt after this plugin.
- For an `opencode/*-free` title model, the hook restores OpenCode's original
  system prompt and adds OpenChamber's style as a user text part. With OpenCode
  2.2.7, the anonymous free model tested generated no title with a replacement
  system prompt, but did with the original prompt and the same style in the
  input. This applies only when the request still carries OpenChamber's prompt;
  a user-configured prompt stays untouched.
- OpenCode titles from the first user message's text only. Context the user
  attached (a file comment, a browser annotation, PR checks) is admitted as
  synthetic messages right before that message (`sendMessage` in
  `packages/ui/src/lib/opencode/client.ts`), so a session started with context
  and no words was titled "Empty message". The plugin's `title` hook reads the
  session context, and when the first user message is shorter than 20
  characters it adds the synthetic messages admitted before it, at most 2000
  characters, as a second text part of the title request's user message. A
  first message that already names the topic gets the request unchanged. A
  failed context read leaves the request as OpenCode built it.

#### Why an agent transform and not the `session.title` hook for the prompt

The hook runs after config is applied, so an unconditional replacement would
overwrite a user's own `agents.title.system`. The agent transform leaves that
choice on top. The free-model exception compares the request with the exact
OpenChamber prompt before moving the style to the input; other requests retain
the transform's system prompt.

#### Why the attached context goes to the title model and not into `result`

The hook could set `result` and skip the model, for example by naming the
session after the comment's file. The model names the topic in the user's
language and the folder-label style the prompt sets; a title built from the
context's first line would read like a path or a quote. The context joins the
same user message as a text part, because some providers reject two user
messages in a row. The part only says the context came with the first message
and gives no naming instruction: OpenCode's regeneration of a titled session
sends the original request with the recent conversation, and an instruction to
name the session after the context pulled that title back to the old topic.

#### Why the prompt pins the title language and carries a non-English example

The title runs on a small model, which follows the example language more
reliably than an abstract instruction. The examples were mostly English with
one Ukrainian, and a Chinese first message still produced English titles (drift
varied per request on the same input). The prompt now states that only the
user's message decides the language and adds a Chinese example, the same
pinning idiom `packages/ui/src/lib/smallModel.ts` uses for its notes.

#### Why the language rule says when a path's words count

A first message of one English word and a path, such as
`Read ~/.config/openchamber/projects/<id>/plans/<plan>.md`, often got a Chinese
title on GitHub Copilot's `gpt-6-luna`, taken from the Chinese example about a
project's plans (#7225). The prompt now tells the model that the words inside
a path or file name count only when the message has no other words, with three
examples: an English word before a path, a Chinese word before a path, and a
path alone. This is an instruction, not a guarantee: it asks the model to take
the language of the words around a path, and the language of the path's words
when the message is only a path.

The rule was measured on `gpt-6-luna` through a managed OpenCode 2.3.1, with
English, Chinese and Ukrainian words before plan paths, paths alone, and plain
sentences (#7227). There, an English example of a command and a path also
fixed the English messages, but it pulled a Ukrainian word before an English
path toward English about one time in ten. A rule without the path-alone
example fixed them too, but a message that was only an English path then got
a Chinese title about one time in fifteen; that is why the path-alone example
stays. The `opencode/*-free` title models, where the plugin moves the prompt
into the user turn, were not measured. The Chinese example stays, because
without it a Chinese first message got English titles (#5654).

The Rename with AI prompt (`packages/ui/src/lib/sessionTitle.ts`) keeps its
own rule, because it names the session from finished turns rather than from
the first message alone. With a `Read <path>` turn and an English reply it gave
English titles in 40 of 40 runs on `gpt-6-luna` and `gemini-3.8-flash`, a
Chinese current title included.

#### Why the prompt is short and every example fits four words

The title runs on a small model that imitates the example shape more than a
rule buried in a long prompt. A five-word Ukrainian example modelled the wrong
length, and "Статус бага режиму плану OpenChamber" came back at five words
even though the prompt said two to four. Its fifth word was the name of the
project the session worked in, which the session list already shows, so the
prompt tells the model to leave that name out. The prompt is now a short rule
list, every example output fits the limit, one example drops the project name
from a long question, and the last line aims at two or three words. The
title model usually runs without reasoning and writes the title in one pass, so
the prompt never asks it to count or trim what it wrote.

The small model still sometimes returns five words on a long first message; the
word limit is a prompt instruction, not a code cap. Only a post-processing cap
or a stronger title model would make it exact, and both are product decisions.

The embedded server controller exposes `getManagedOpenCodePreflight()` for
desktop bootstrap. It shares the lifecycle's current CLI validation promise,
including while validation is in flight. It returns false before validation
starts, after failure, during shutdown, or for external OpenCode. Restart clears
the previous result, and readers discard results from a replaced preflight.
This checks CLI compatibility, not server health; the normal startup flow still
owns connection readiness. Explicit user compatibility checks remain fresh.
