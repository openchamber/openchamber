# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Invariants

### Webview delivery and editor context

- Extension activation starts OpenCode asynchronously. Waiting for startup delays webview resolution and leaves the panel blank. Sidebar focus commands register after their view provider, and startup reveal waits until activation finishes so it does not take focus during startup.
- Connection status and focus payloads are idempotent. Hosts resend cached connected state at staggered delays because a message posted before the webview bridge runs can be lost permanently. Retries read the current target and stop when the original panel is replaced.
- Inline-comment delivery waits for an inbound webview message, which proves its script runs. Pending comments form a list so a second submission during startup cannot discard the first.
- Draft absence disposes an editor thread only after its owning composer has reported holding that draft at least once. An earlier snapshot can describe the composer before delivery lands. Unknown thread ids never give the host ownership of in-app viewer comments.
- Removing a comment clears pending holds before notifying every chat webview. A draft can belong to an inactive panel or still await delivery; clearing only the visible thread allows a delayed chip to reappear. Removal does not reveal or focus a chat.
- The comment-controller id matches the literal menu condition in `package.json`, which cannot import the TypeScript constant.
- Both inline-comment entry points require a workspace-relative target. A document outside the workspace would attach a path the composer cannot resolve. A lost thread range cannot anchor a submission, and an empty reply cancels the thread.
- Diff identity is captured before the first await because opening a Git document can change tab focus. Selected text comes from the chosen pane, while the attachment names the real file from a `git:` document's query. A selection ending at the next line's start excludes that line because only its preceding newline is highlighted.
- Editor comment bodies remain plain text because Markdown consumes underscores and asterisks that are literal code-related prose.
- Context attachment paths use the same workspace-relative spelling as active-editor broadcasts so attachment deduplication recognizes the pin-selection suggestion.
- Right-click actions prefer the focused session panel, then the most recently focused one. Callers verify that its id still identifies a live panel.
- A single resolved Shiki theme supplies both variants when the opposite theme cannot be found, preserving the active editor's highlighting. Active-theme lookup wins for the current variant; preferred themes supply the opposite variant. Theme resolution also listens for configuration changes because `workbench.colorTheme` can update after the active-theme event.
- The logo between the `brand:flat-logo` markers in `webviewHtml.ts` belongs to `scripts/brand/generate.mjs` and shares its drawing with `OpenChamberLogo.tsx`.

### Why the splash uses discrete updates and not a smooth animation

The loading logo advances its lit roof tier once per second because a smooth CSS animation repaints the logo on every frame. Reduced-motion mode leaves the logo static.

### Why the splash shows errors and not connection progress text

The animated logo already indicates startup activity, so normal connection states leave the status text empty. Errors populate that text so a startup failure remains visible.

### Bridge reads and configuration

- Config tests import `opencodeConfigTestHome` before `opencodeConfig` or `opencodeConfigPaths`. Config paths freeze at module load, so later isolation leaves reads and writes pointed at the user's real OpenCode config directory.
- Proxy coalescing shares only overlapping, identical, allowlisted GET requests. Bootstrap and configuration stores issue duplicate reads that otherwise delay session creation on the single OpenCode process. Each caller receives its own payload copy, and settled requests leave the coalescer immediately.
- A coalescing key includes every forwarded header with canonicalized header names, because directory and authentication scope travel in headers. A caller's abort cannot cancel a shared read and strand other callers.
- A failed authoritative OpenCode skill list marks the filesystem supplement partial. Caching the supplement as a complete answer hides skills. Built-ins normalize both legacy `location` and current `path` records, including `/builtin/` and `skill://` paths, and retain OpenCode's id because policy ids can differ from display names.
- File searches with a query continue to the tree or inspection ceiling so shallow weak matches cannot exhaust the budget before exact deeper matches are visited.
- Model overrides split `provider/model` at the first slash because model ids can contain more slashes. Wrong-typed bridge model fields count as absent, and a cold or unreachable catalog cannot invalidate a saved variant.
- Utility generation retries only a pre-dispatch catalog rejection, which costs no tokens. Plugin model activation can outlast readiness, so the bounded retry schedule spans about 31 seconds; other generation errors do not retry. Missing or still-loading title agents supply no configured model.
- A present Magic Prompt override wins even when its value is empty. Only an absent key selects built-in text.
- Config-file mutations report success without a managed restart because OpenCode watches those files. Binary, port and external-server changes still use the reload flow. A command prefers the webview's full reload flow and falls back to a manager restart when no webview can drive it.
- Agent markdown writes contain only native v2 keys because one legacy key sends the whole file through the v1 decoder and loses native permission arrays. Legacy field deletion reaches its v2 location, and partial updates copy request overlays so clearing a field cannot mutate the caller's entity.
- Agent and command `{file:...}` references keep their reference and edit the referenced file. Markdown parsing accepts a closing frontmatter fence at end of file because an empty system prompt has no following body.
- Plugin layers concatenate declarations in OpenCode load order, with legacy entries before native entries within a file. Later duplicate declarations are the editable entry; unparseable entries survive writes. Control denials stay bare strings because an object-shaped denial becomes a package installation request.
- `OPENCODE_CONFIG` adds a file layer without relocating the global config directory or creating a neighbouring plugin discovery directory. A folder file that aliases this layer remains one user-scope declaration. Switch conflict checks use the earliest-loaded matching policy, including the managed layer's position.
- Skill scans skip hidden directories and `node_modules`, stop descending when a directory owns `SKILL.md`, and follow directory links only at the scanned root to prevent loops. Linked skill files count only when their targets resolve; an unreadable link does not fail unrelated skills.
- Skill invocation writes both `disable-model-invocation` and `metadata.opencode/autoinvoke` for supported OpenCode versions; the OpenCode-specific field wins. Enabling removes exact denials from every readable layer, while an unreadable layer remains untouched.
- Snippet names and aliases share one namespace. Scope moves preserve file bytes across volumes; a case-only rename can target its own file on a case-insensitive disk, while another snippet's file is never overwritten.
- Structural JSONC array removals run from the highest index down so later removals retain their indices. Appending a line-separated element preserves earlier text because the parser's generic insertion reformats its target line. Write-boundary JSON normalization makes absent keys match serialized removals.
- Settings migration takes disk values over legacy `globalState` values and copies missing legacy keys to disk on the first process read. Saves also mirror into `globalState` for older extensions. Registry-secret values are write-only to webviews, and derived runtime fields are recomputed instead of persisted.
- Per-surface preference writes preserve the base and every other surface's value. A key absent from the writer's resolved view can still belong to another surface, so absence alone cannot clear it. A newly surface-owned key can have no base value.

### Worktree and Git ownership

- Repository probes use English Git diagnostics to distinguish a missing repository from an execution failure. Bare repositories still own linked worktrees, but their bare list entry is never a session checkout. A separate Git directory has no inferred primary checkout.
- Raw status deliberately lists individual untracked files with `-uall`; this runtime does not use the web server's collapsed-directory bound. The Git API accepts the shared status-options shape without computing heavyweight diff statistics.
- Status-path classification distinguishes missing files, nested repositories and submodules from an empty successful diff. Exact index entries alone count because a directory pathspec also matches children; a nested repository needs its own `.git` or `rev-parse` answers for its parent.
- Patch reconstruction restores the common indentation OpenCode strips from stored edit diffs, using the current file to recover a consistent prefix. Unaligned patches retain the stored old lines, and a deleted file compares its old content with an empty right side.
- Creation propagates worktree-root config failures so it cannot choose a directory the user did not select. Read-only and removal paths can tolerate the failure and use the managed root. A configured root can contain unrelated projects, so orphan deletion there requires this repository's prior Git registration.
- Worktree create commands own checkout population and hooks, can resolve to a symlink-backed path, and finish before the request returns that actual path. Their admin-folder marker survives a failed command so a locked checkout stays removable; both runtimes interpret the marker and extra force flag identically.
- Teardown runs while the checkout and its OpenCode instance still exist. Failure preserves both; missing or failed-bootstrap checkouts have nothing to stop. Contributor-fork checkouts never execute teardown, and an unreadable server classification keeps the worktree untouched.
- Branch-conflict classification reads refs before creation because a failed attempt can leave its own new branch behind. Rollback deletes only a branch made by that attempt and held by no checkout. A freshly fetched upstream supplies the start only when it still contains all local commits; unpublished commits and force-push divergence preserve the local ref, which is never moved.
- Fetch failure leaves upstream tracking unset so branch config cannot refer to a ref that was never fetched. Project start-command lookup uses the requesting directory to avoid starting another OpenCode location.
- Worktree disposal reads the current API URL and credentials on every call because managed restarts move the connection. Removal matching resolves the nearest existing parent so missing paths and symlink spellings still match. Busy-folder retry applies only to Windows, where another process can temporarily hold the directory open.
- Background Git and setup commands receive EOF on stdin because no user can answer their prompts. Payload-derived remote values stay positional after `--` so a leading hyphen cannot become a Git option.
- OpenCode owns sandbox registration when a location boots. The extension never writes OpenCode storage JSON to register a worktree. Run snapshots use private refs so Git keeps them reachable without displaying them as branches or tags.
- Batch staging retries unmatched paths individually because queued optimistic mutations can already have staged a deleted file, and one unmatched path would fail the whole batch. Stash apply first restores the index split and falls back to plain apply when that split cannot be reinstated.
- Stash file counts use `stash show --include-untracked --name-only`, matching the server. The flag includes the third parent's untracked files without another Git process per stash.
- Log base resolution prefers a local ref and falls back to `origin/<ref>` only when the local ref is missing. A newly initialized branch without commits has empty history. Remote URL parsing accepts CRLF and ignores suffix decorations after the URL-kind marker, preserves the first URL, and uses Git's name-as-URL fallback when no fetch URL exists.
- Branch listing returns `defaultBranches` like the web server: each remote's default as its local `refs/remotes/<remote>/HEAD` records it, without contacting the remote or guessing one for a remote with no known HEAD. The raw `git branch` path (no Git extension) names remote branches `remotes/<remote>/<branch>` like the extension path and leaves out a remote's HEAD symref, so the shared UI can split local from remote and lift the defaults in the New Worktree base picker.

### Process, session and quota state

- API forwarding waits for connected readiness because a URL exists before startup health checks finish and can point at a stale port during restart. Permanent startup errors fail promptly; the bounded wait returns unavailable when startup remains stuck.
- Windows command shims run directly through `cmd.exe` with a separate shim-path argument and `shell: false`; shell command construction breaks paths containing spaces. CLI path normalization removes one wrapping quote pair, and POSIX discovery avoids interactive login shells.
- Managed servers start in a neutral working directory and receive workspace context explicitly through API parameters. Provider environment reads use the child's captured launch environment, while user `OPENCODE_CONFIG` ownership is captured before the managed layer rewrites the child environment.
- Managed authentication uses username `opencode` and prefers `OPENCODE_PASSWORD` over its legacy name. Background-service credentials are sent only to the matching service origin, with equivalent loopback hosts accepted. The output channel is shared across restarts; Output-panel logging persists diagnostics that extension-host console output does not retain.
- Shared process-registry, provider-alias, injected-environment and config-shape modules remain thin re-exports of the server implementation. Cross-runtime orphan cleanup depends on a byte-compatible registry and matching ownership checks. POSIX child groups exclude the extension host's group, and Windows enumerates descendants before losing their parent.
- Session-state file reads distinguish missing data from I/O failure. Unparseable bytes move aside before a future write, and an unreadable unread-baseline file stays untouched because recreating it would mark earlier turns seen. Legacy archive entries use null for explicit restore and absence for preserving upstream state.
- Session activity derives from live execution events and the authoritative active-session endpoint. Reconciliation clears sessions missing from that endpoint; normal turns can emit no status or idle event. New execution events reset the turn start on the host clock, avoiding remote clock skew, and completion passes through cooldown. The first frame proves stream connection, and a healthy stream clears reconnect backoff.
- Project setup writers take the personal-file chain before the shared-checkout chain, while single-key writers take only the shared chain. Canonical checkout paths unify symlink aliases, preventing inverted lock order and concurrent writes to one file. Single-key updates refuse invalid setup files; setup repair preserves unrelated keys in a valid version-1 document. Unknown `__proto__` keys remain own properties.
- Shared setup trust covers executable commands in canonical order; absent teardown contributes nothing so existing answers still match. Personal-only tool choices stay out of team config because teammates may not have the tool. Shared setup merges and sanitization follow the server's project contract.
- Quota credentials chmod only a directory created by that write so existing ACLs survive. Obsolete Ollama cookies are deleted without reading them, and non-missing cleanup failures appear in the Output panel. Credential discovery failure remains an error, preserving the distinction from no configured providers.
- Quota reads leave rotating xAI and Claude refresh tokens to OpenCode, because refreshing without updating its credential store invalidates the token it still holds. Fixed-origin bearer requests refuse redirects, and Copilot Enterprise credentials require a valid bare origin before requesting its quota endpoint.
- OpenCode Go prefers a renewable Console sign-in and falls back to an API key. Console sign-ins require a Console credential with a `wrk_` or legacy `org_` workspace id; an OAuth token and a service key are not interchangeable. The Console meters preserve fractions that the legacy usage API floors. A failed supplementary billing read drops the credits row without fabricating zero or failing the meters; one dollar is 100,000,000 micro-cents.
- Go quota parsing isolates malformed meters, rejects unusable limits and resets, and treats `access: null` as no subscription. A Console key's 403 means no Go subscription; only `api_key_expired` identifies an expired key. When a connected Console account also fails, its failure supplies the actionable error.
- Codex CLI fallback usage identifies the CLI account by email because OpenCode's token-sharing credential cannot establish whose quota the CLI returns. An access-enforcement 401 on that token is distinct from expiry; without a CLI sign-in the user needs the ChatGPT usage page. Claude tokens with no expiry remain unknown, expired tokens are checked before a 429 cooldown, and `Retry-After: 0` ends that cooldown.
- Kimi ratio-based `usages` takes precedence over duplicated counted limits, omits the code-only share of the monthly total, and skips non-finite ratios. Legacy blocks can supply used or remaining counts. A pay-as-you-go Moonshot key reads balance because the Kimi Code usage endpoint refuses it.
- OpenRouter quota uses the configured gateway base that receives chat credentials. Native and legacy config sections are read independently so a native entry without an address cannot hide a legacy address; a config failure still permits the default-endpoint lookup. Monthly spending from `usage_monthly` and `byok_usage_monthly` stays beside any cap as `monthly_total`, `monthly_credits`, and `monthly_byok`; the raw amounts are summed before display rounding, unreadable counters including blank strings stay unknown, and only exact-zero categories are omitted. A set cap whose `limit_remaining` is unreadable stays as a cap window with an unknown spent amount.
- Z.ai and BigModel business errors can arrive in HTTP 200 envelopes. Credit limits use total `usage` and consumed `currentValue`; token-only limits can supply just a percentage. Gift reset metadata never fails quota refresh, interprets timestamps as UTC+8, and selects the nearest unexpired claimable reset. Activation sends the listed grant kind with `GLOBAL` as the missing-kind fallback.
- Quota windows preserve provider-specific limits: a null current daily quota means no cap, kWh annual subscriptions still reset monthly without an invented duration, allowance ceilings include the remaining credit wallet, and Cline calendar months carry no fixed duration. Fixed 30-day and 365-day approximations belong only to display labels. A blank DeepInfra balance remains missing data.

## Runtime modules

Session admission uses the shared UI's OpenCode fingerprint trust dialog before
adding an unknown destination through `api:workspace:addFolder`. The extension
host rechecks its current fingerprint before changing workspace folders, so a
changed configuration cannot be added on a stale answer. Empty configurations
and trusted fingerprints add without a prompt. Only a deliberate session open
adds a folder; a session moving to another folder and the session list never
change the workspace on their own. Declining leaves the workspace
unchanged; raw global session records remain available for cleanup.

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers.

- `bridge-git-special-runtime.ts`
  - Hosts the SCM commit-message generator (`generateBridgeCommitMessage`), which the Source Control title-bar command runs directly on the extension host. No bridge handler remains: commit-message, pr-description and conflict-details were dead webview surface.
  - Generation runs through OpenCode's `POST /api/experimental/generate/text`, which answers with the finished text. There is no throwaway session to create, poll and delete any more.
  - Generation model choice lives in `bridge-git-generation-model.ts`: request model first, then the user's small-model override (`smallModelUseDefault === false` plus `smallModelOverride` as `provider/model` and `smallModelVariant` as its thinking level), then the model and variant OpenCode's `title` agent is configured with (`agents.title.model`, read through `GET /api/agent/title`, the same step the server-side small-model resolver honors). The first one named decides: when it is unusable, generation refuses with its name, and a failed read of the title agent fails the generation, so a diff never goes to a model the user did not choose. The zen fallback is only for a user who named none; the catalog rule for every step is the one below. A saved variant is dropped only when the catalog knows the model and does not list it; an unlisted model keeps the chosen variant. The old `gitProviderId`/`gitModelId` pair is no longer read.
  - A catalog rejects a model only when it lists that model as disabled, or as one of zen's free models without a login (`settings.apiKey` is OpenCode's `"public"` placeholder; the generate route refuses them), which is the rule the server-side resolver applies: a config can outlive the login behind it, but a model the catalog does not list at all — a plugin provider still loading, or a cold location that answered before its providers did — is kept. Gating on "listed" dropped the user's configured small model on a cold start, sent generation to the zen default they cannot use, and the `Model unavailable` retry loop then retried that wrong model until it gave up.
  - Catalog reads, the title-agent read, and generation all name the flow's directory through the `x-opencode-directory` header, and the model catalog cache is keyed by that directory. OpenCode resolves models per location, so an unscoped read would answer for OpenCode's own working directory and reject models that work in the repository.
  - Commit message prompt templates stay aligned with `git.commit.generate.*` in `packages/ui/src/lib/magicPrompts.ts`; the caller hands the generator the overrides (`readPromptOverrides` in `scmCommitMessage.ts`).

- `bridge-small-model-runtime.ts`
  - Answers `GET /api/small-model`, which the web server serves elsewhere and OpenCode does not know. The webview routes the path to `api:small-model:get` before the generic proxy.
  - Returns `authenticatedProviders` only, computed like the server's `listAuthenticatedProviders`: every provider with an enabled model other than zen's free models without a login (`settings.apiKey` is OpenCode's `"public"` placeholder), OpenCode's provider order first. The Small Model and walkthrough pickers list models from it. `available` and `model` are not computed here, so the small-model availability store stays "unknown" in VS Code.
  - Both reads name the request's directory through `x-opencode-directory` after checking folder trust (`opencodeTrust.ts`). An untrusted directory returns a structured 403 `opencode_trust_required` bridge error with `directory`, forwarded by the webview as HTTP 403 so passive pickers stay quiet without contacting OpenCode. Any other failed read answers an error; the picker then keeps its previous list.

- `git-commit-message.ts`
  - Pure parse/format/file-selection helpers for commit generation (no `vscode` import).
  - A path with a meaningful index status uses only the staged (`--cached`) diff. Extra working-tree hunks stay out of the prompt.

- `scmCommitMessage.ts`
  - Source Control title-bar command. Resolves the git repo, prefers staged files then unstaged/untracked, writes the result into `Repository.inputBox` only if that box still matches the value captured when generation started. Light theme reuses `icon.svg`. Dark theme uses `icon-scm-titlebar.svg` (`#C5C5C5`) because that slot does not theme `currentColor` and `icon-titlebar.svg` is mint. A blank icon over SSH/DevPod is [vscode-remote-release#11686](https://github.com/microsoft/vscode-remote-release/issues/11686), not a missing asset.
  - Magic Prompts come from the project that owns the picked repository, not the project selected in the webview, so each root of a multi-root window uses its own file.

- `magic-prompts.ts`
  - Host side of `/api/magic-prompts` (no `vscode` import). It runs the server's `runtime.js` and `service.js` (`packages/web/server/lib/magic-prompts/DOCUMENTATION.md` is the contract) and adds what differs here: the bridge payload, the project list and owner resolution.
  - Registered projects are the window's workspace folders with the ids the UI gives them; `settings.projects` is ignored. The global file is always `~/.config/openchamber/magic-prompts.json`; `OPENCHAMBER_DATA_DIR` does not move it.
  - Owner resolution maps a linked worktree onto its primary checkout through `git worktree list --porcelain`. Only git's "not a git repository" means no repository; any other git failure fails the read, so a worktree never silently gets the global prompts.

- `bridge-git-process-runtime.ts`
  - Git process execution and environment setup (`execGit`), including SSH agent socket resolution. Both bridge helpers and `gitService.ts` use this executor; the latter passes the Git binary selected by VS Code's Git extension.
  - Reads both output streams and gives commands EOF on stdin, after optional `input` bytes. A signal exit is a failure, never exit code zero. File ignore checks pass their deadline to this executor so timeout terminates the child tree rather than abandoning a live command behind `Promise.race`. Other Git commands have no new time limit.
  - Tracks outstanding commands through completion and timeout cleanup. Extension deactivation awaits `stopGitProcesses`, which terminates active work and rejects later launches. Operations delegated to VS Code's built-in Git API remain owned by that extension.

- `owned-process.ts`
  - Owns background child termination shared by Git and managed OpenCode. POSIX children have a separate process group, which receives SIGKILL after the grace period or root exit so a SIGTERM-resistant descendant cannot survive. Windows enumerates and terminates the tree before losing its root, using an asynchronous hidden `taskkill` invocation. Completion waits for stdio closure; failed termination remains an error.
  - Windows has no SIGTERM, and `taskkill /F` ends OpenCode before it records how its running turns ended: a chat waiting on a question reopened stuck (#5129). The managed OpenCode therefore runs as `serve --stdio` on Windows with a piped stdin. `stopWindowsProcessTree` closes that stdin first; OpenCode reads the EOF as the end of its lease, ends running turns as cancelled and stops its MCP servers. The tree kill runs only if OpenCode is still alive after 3 seconds. VS Code gives `deactivate` 5 seconds before the extension host exits, so the fallback fits inside it; if the host exits earlier, its end of the pipe closes and OpenCode still gets the EOF. The web server stops its OpenCode the same way (`packages/web/server/lib/opencode/managed-process-stop.js`); this copy awaits the asynchronous `taskkill` so its failure stays an error. Git commands and macOS/Linux keep the order above. Readiness accepts the `{"url":"..."}` line `--stdio` prints next to `server listening on`. Checked on Windows 11 with portable VS Code 1.142 and OpenCode 2.0.32, launched both as `opencode.exe` and through the npm `opencode.cmd` shim: closing the window with a question waiting ended the turn, and no OpenCode or MCP process survived, including an MCP server's own child.

- `managed-opencode-process.ts` and `opencode.ts`
  - The process handle and shared registry entry exist from spawn, before readiness. Startup timeout, malformed output, and cancellation terminate the child before the attempt settles. Registry removal follows confirmed termination. Startup diagnostics retain a bounded output tail; ready processes keep draining both streams.
  - Manager operations run in order. Stop cancels in-flight readiness/health probes and invalidates older queued starts/restarts. A later explicit start can run after stop. Startup passes an explicit cwd to the child without changing the extension host's cwd.
  - Shutdown targets owned processes rather than whichever process happens to listen on a remembered port. External OpenCode receives no spawn or termination request.
  - `bridge-git-process-runtime.test.ts` and `managed-opencode-process.test.ts` use real subprocesses for repeated deadlines, signal exits, stdin EOF, large stderr, deactivation, startup failure, and resistant descendants. The manager was also exercised in an isolated macOS VS Code 1.137.0 extension host with a controlled server fixture. Before the fix, two restarts left two orphaned tool processes beside the active server and its tool. After the fix, only the active pair remained, and stop removed it. The complete fixed scenario created eight processes across startup, restarts, and cancellation, with none surviving. Native Windows process-tree behavior remains unverified on the macOS test host.

- `opencodeCliDiscovery.ts`
  - Finds a usable standalone CLI on PATH before trying known install locations, on Windows and Unix. The resolver in `opencode.ts` still gives the administrator's pin, VS Code and shared settings, and environment overrides priority over discovery.
  - Skips and rejects the OpenCode Desktop app. On Windows that is a `.exe` with `resources\app.asar` beside it, whatever its install folder is called. The server has the same check, and the reason is in `../../web/server/lib/opencode/DOCUMENTATION.md` (*Why the Windows Desktop app is recognized by its files and not its install folder*).

- `gitService.ts`
  - Owns VS Code Git and worktree operations.
  - Reads `worktree.directory` through the web server's `config-files.js` reader on the canonical checkout. Both runtimes merge ancestor files and checkout-local configs in OpenCode order, with project files overriding `OPENCODE_CONFIG`; malformed or unreadable configs fail creation before choosing a folder.
  - Preview and creation follow the [worktree path identity rule](../../web/server/lib/git/DOCUMENTATION.md#why-preview-and-creation-resolve-the-parent-after-creating-it), returning canonical paths. Workspace admission stays unchanged.
  - `api:git/diff` and `api:git/file-diff` classify the status path first through `gitPathDiff.ts`, matching the web server's diff routes. The host answers `{ kind: 'diff' | 'file-diff', ..., submodule }` or `{ kind: 'unavailable', reason: 'path_not_found' | 'nested_repository', message }`. Their bridge handlers were dead surface (DiffView is not mounted in VS Code) and are gone; `getGitDiff` remains on the host only for the SCM commit-message generator, and the gitPathDiff contract is covered by `gitPathDiff.test.ts`.
  - `api:git/status` rows carry a rename's or copy's source as `previousPath`, as the web server's status does: from the Git API change's `originalUri`, or from the source entry `git status -z` lists after the destination in the raw fallback. The Changes view that reads it is not mounted here; the field keeps the status contract the same on every runtime.
  - Fetches the current tracked source branch once before worktree creation. Fetch failure falls back to the local branch and reports it to the shared UI.
  - A new worktree first runs the project's start command, read from the running OpenCode through the web server's `lib/opencode/project-start-command.js` (wired in `extension.ts`), then the start command the request names.
  - Fast worktree creation reports bootstrap phases explicitly: `directory-created`, then `git-ready` after Git population/upstream work, and `setup-ready` after setup commands. Existing worktrees without tracked bootstrap state fall back to `ready`/`setup-ready`; shared webview consumers also accept legacy responses without `phase`.
  - A failed bootstrap keeps Git's message in `error`, except a branch name that clashes with an existing branch: like the web server, it is read from refs and recorded as `errorCode: 'BRANCH_NAME_CONFLICT'` with the server's fixed sentence, which the shared UI shows in the selected language.
  - Worktree removal keeps the local branch when another checkout holds it or a remote's `refs/remotes/<remote>/HEAD` names it, and `deleteRemoteBranch` refuses the branch the remote's own `ls-remote --symref` HEAD names, as the web server does (packages/web/server/lib/git/DOCUMENTATION.md, `removeWorktree` and *Why the remote is asked and not `refs/remotes/<remote>/HEAD`*).
  - Worktree removal waits for an active create/bootstrap task for the same directory so background Git and setup work cannot race deletion or restore stale bootstrap state. It then releases the removed worktree's OpenCode instance through the bridge-injected `disposeInstance` hook, after git confirms the linked worktree and before `git worktree remove`, while the path still resolves. The hook evicts the worktree root and every running OpenCode location inside it (`debug.location.list`), such as `<worktree>/ai` for a project opened on a folder of its repository; when the list cannot be read it still evicts the root. Disposal is best-effort: failures (including an unavailable managed runtime or a timed-out request) are logged as a warning and never fail the removal. The primary workspace and the orphan fallback are never disposed. From the release until the removal settles, `api:proxy` and `api:session:message` hold every request naming a folder inside the worktree (`waitForWorktreeRemoval`, at most 60 seconds), and a busy failure releases the instance again before the next attempt, as the web server does: a request that reaches OpenCode then would start the folder again with its MCP servers, which keep Windows from deleting it (packages/web/server/lib/git/DOCUMENTATION.md, *Worktree removal and the folder's OpenCode location*).
  - Worktree population enables Git `core.longpaths` (local repo config plus `-c core.longpaths=true` on `git reset --hard`) so deeply nested checkouts under the managed data-dir worktree root do not fail on Windows MAX_PATH with "Filename too long".

- `bridge-fs-runtime.ts`
  - Bridge handlers for filesystem-related message routes.
  - Uses shared FS helpers via injected dependencies.

- `bridge-fs-helpers-runtime.ts`
  - Search ignore checks use `git check-ignore --stdin -z` to match original Unicode, whitespace and newline-containing names. Quoted line output would miss those ignored entries.
  - Filesystem/path/search helper functions:
    - path normalization and resolution
    - directory listing
    - file search
    - file read path safety checks
    - active-directory selection across multi-root workspaces
    - dropped-file parsing and attachment reading
    - models metadata fetch helper
   - File search walks the tree until it is exhausted or 10,000 files are inspected (`FILE_SEARCH_MAX_VISITED_FILES`), mirroring the web server's `search.js`; an empty query still stops at the result limit. The module imports `vscode`, which the isolated runner cannot resolve, so `bridge-fs-helpers-runtime.test.ts` pins the ceiling and the two runtimes' agreement on the source text.
   - Non-default hidden/gitignore flags request a workspace supplement directly
     from the filesystem, including generated directories such as `build`.
     This walk excludes only `.git` and `node_modules`, has no inspected-file
     ceiling, and fails after its 30-second deadline rather than returning a
     partial answer. The shared store retains OpenCode's indexed hits first.
     A webview that moved on stops the walk with `api:fs:search:abort`.
  - Read paths are authorized in the requested workspace path space before symlink resolution, matching the web runtime; directly requested outside-workspace paths remain denied.
  - Workspace containment normalizes Windows drive-letter case: VS Code supplies lowercase drives while OpenCode supplies uppercase drives. The remaining path casing and directory-separator boundary stay significant.

The sidebar installs a script-free CSP bootstrap document before changing webview options, so VS Code does not diagnose the transient blank document as an extension webview without CSP. The final webview CSP permits `blob:` only for `worker-src` so shared UI parsers can run bounded local decompression off the main thread. Blob scripts remain disallowed by `script-src`.

The webview build emits each worker as one self-contained file. VS Code webviews cannot load workers directly from extension resource URLs or load module imports from inside a worker. The shared Shiki client therefore fetches the built worker, starts it from a `blob:` URL, and relies on the worker CSP allowance above.

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.
  - `/api/fs/directory-stat` and `/api/fs/directory-stats` return 501 locally. Directory-availability probes remain unknown in VS Code rather than falling through to OpenCode.
  - Workspace-contained Markdown gallery images use these local filesystem
    routes without calling the server grant route. Grant requests for OpenCode
    temporary-directory images return an explicit unsupported response instead
    of being forwarded to OpenCode.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - `api:session:message` adds `x-openchamber-error: opencode-unreachable` to its 503 when the prompt never reached OpenCode: OpenCode was not up, or the forward failed with `ECONNREFUSED`, `ENOTFOUND` or `EAI_AGAIN` before a connection opened. The UI resends a prompt only on that header (`packages/ui/src/lib/opencode/DOCUMENTATION.md`, *Transport and authoritative state*); a timeout or any other failure leaves the outcome unknown.
  - The webview forwards the request path unchanged (`/api/<x>` → `/api/<x>`): OpenCode 2.x serves its own routes under `/api`, so nothing strips the prefix.
  - SSE routes are intentionally excluded from the generic proxy and use `sseProxy.ts`, whose upstream-only stall watchdog closes a quiet OpenCode stream so the webview can reconnect instead of trusting an open but silent response.
  - The webview allocates each SSE stream ID and installs its listener before requesting the upstream stream, so immediate OpenCode replay events cannot race the bridge start response.
  - OpenCode 2.x has one global stream, `GET /api/event`. Every frame names its own `location.directory`, so the proxy no longer scopes the request to a directory.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - The skill list (`skills-list-response.ts`) answers the web route's shape, `externalSkills` included. Those switches come from the managed OpenCode's launch environment (`getManagedLaunchEnvironment()`), so Settings hides `.claude` skills exactly when OpenCode skips them; with an external server the list carries no switches and nothing is hidden.
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).
  - Plugin lists carry `policyResource` and `switchState`, and `PUT /api/config/plugins/{entry,file}/:id/enabled` writes the extension's switch store and refreshes the managed OpenCode config layer. See *Plugin switches* below.
   - Plugin lists omit project configs already represented at user scope; global/custom aliases retain custom precedence for relative targets. Local declarations expose `resolvedPath`. File-only discovery records keep the original `absolutePath` for runtime status and a canonical `resolvedPath` for display deduplication, so symlink aliases still match OpenCode's reports. The shared grid hides only redundant package cards, so VS Code's editable file cards remain visible even when declared in config. Discovery capabilities and mutation rules are unchanged.
  - OpenCode JSONC reads in `opencodeConfig.ts` fail closed on a partial or non-object `jsonc-parser` tree (`INVALID_JSONC`) so mutations cannot rewrite a `$schema`-only stub over an existing config. Comment-only files read as empty, while other content that yields no JSON value (YAML, plain text) fails closed. A broken layer is omitted from the merge and recorded on `layerErrors`; valid sibling layers still load, including plugin list/read via `getPluginConfigSources`. Writes still refuse to overwrite the broken file.
  - `writeConfig` and the agent/command markdown writer replace their file atomically through `writeFileAtomic` from `packages/web/server/lib/opencode/atomic-write.js`, the same function the web server uses, so OpenCode's watcher never reads a partial file.
  - Config writes through `writeConfig` are structural: the parsed file is diffed against the desired config and each change is applied with `jsonc-parser` edits. Property and array element removal locates the separator comma with the scanner so surrounding comments survive and no stray comma is left behind. Comments, formatting, and line endings outside the changed values are preserved. Equal-length arrays are diffed by index, including objects and nested arrays, unless a retained value moves between changed positions; an array that only grew at its end or only lost elements is edited per element, and other resized arrays are replaced whole. This follows the server writer's position rule in `packages/web/server/lib/opencode/DOCUMENTATION.md`. Comment-only files keep their comments with the serialized config appended below. The edited text must re-parse to exactly the intended config or the write falls back to a normalized rewrite.

- `bridge-project-setup-runtime.ts`
  - Extension-host side of `GET/PUT /api/projects/:projectId/config` (the webview handles the route locally and bridges `api:project-setup:get` / `api:project-setup:update`). Reads and writes the client-owned keys of `~/.config/openchamber/projects/<projectId>.json` (worktree setup commands, project actions, draft starters) with the rules in `project-setup.ts`, a mirror of the server's `packages/web/server/lib/projects/project-setup.js`; keep the two in sync. The file name follows the server's bounded rule (`projectConfigFileStemOf`, mirrored from `packages/web/server/lib/projects/project-id.js`): an id over 200 characters is stored as `path_sha256_<digest>.json` so a deeply nested checkout does not exceed the file name limit. A file an older build wrote under the long name is still read when the bounded one is missing and is removed once a write has moved its content. Writes to one file are chained; server-owned and unknown keys survive. The read also merges the team's optional `<workspace>/.openchamber/project.json` (checkout path decoded from the `path_<base64url>` id) by the same rules as the server, so the webview sees one view with `shared` / `personal` blocks. The shared UI (`openchamberConfig.ts`) no longer composes that path or reads it through the fs bridge.
  - The store also follows the server's two-writer rules for that shared file (`packages/web/server/lib/projects/DOCUMENTATION.md`, *Writing the shared file*); `updateSharedEntry` is the Magic Prompts writer. Its write chain covers this extension host only.
- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers.
  - Writes are gated by the generated registry snapshot (`settings-registry.json`, via `settings-registry-gate.ts`): keys the registry does not list, or marks `computed`, `local`, or `owner: desktop-shell`, never reach the shared settings files. Regenerate the snapshot with `bun run settings-registry:generate` when the UI registry changes.
  - Shared settings live in two files under `~/.config/openchamber/`, split by `settings-files.ts` (a pure mirror of the server's `settings-files.js`; both write the same bytes): `settings.json` holds instance facts and legacy keys, `preferences.json` (`{ version: 1, fields: { key: { value, updatedAt } } }`) holds every registry `profile` key. `updatedAt` is stamped by the extension host only when a value actually changes. Reads return the merged view (preferences win). A missing `preferences.json` is seeded once from the profile keys still in `settings.json`; every write keeps a copy of the profile's base values in `settings.json` too, so a build from before the split (which reads only that file) still finds the user's preferences; it is ignored by current builds.
  - An existing but unparseable `preferences.json` is a failure, not an empty profile: it is never seeded over or rewritten, one warning is logged per process, reads return `settings.json` only, and writes drop the profile part until a later read succeeds.
  - `settings.json` is read the same strict way: only a missing file is empty. While it exists but cannot be read or parsed (a lock held by another app on Windows, a torn file), reads show the copy saved in `globalState`, the start-up migration and preference seeding wait, and saves reject without writing either file. Reading it as empty let the start-up migration write the `globalState` copy over projects the desktop app had added since.
  - A save marks the start-up migration done before it reads. The save already writes every `globalState` key; a migration first run inside the save, after the file became readable again, wrote in parallel and could land last without the saved change.
  - Session cost amounts are checked before the write (`settings-session-cost.ts`, the rule the server applies in `settings-session-limits.ts`): a change that would leave the warning amount at or above the critical one, merged with the stored pair or the default for a side never saved, is dropped and the last valid pair stays. A write may carry only one side, so the check runs against what is stored, not against the request alone.
  - Both files are written atomically (tmp file + rename). Write failures throw, so `persistSettings` rejects and the webview sees the save fail instead of a silent success.
  - The extension host is always the `vscode` surface kind: per-surface profile keys it changes land under `surfaces.vscode` in `preferences.json` and reads resolve `vscode` first, base otherwise (mirrors the server's header-driven behaviour).

- `bridge-system-runtime.ts`
  - Cursor Enterprise quota shares `providers/cursor-summary.js` with the web server for individual dollar allowances when the older APIs expose no billing-cycle meter. Cookie handling, personal scope and cents conversion follow the quota module's "Cursor individual dollar allowance fallback" contract.
  - System/editor/provider/quota/notification/update-check message handlers.
  - `openchamber.internal.openSession` reveals the sidebar chat and opens a session there; the Settings editor, which has no chat, uses it for a toast's Open session action.
  - `api:notifications:show` hands the webview's notification to `openchamber.internal.showNotification` in `extension.ts`, which shows it through `sessionNotifications.ts` and answers `{ shown }`. Chromium never displays a `new Notification()` from a webview frame, so the extension host is the only place a VS Code notification can come from.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`, and `/api/sessions/status`, where busy phases become the host status seed the shared UI reads for unopened directories). A busy entry also carries how long its turn has been running, measured by the extension host, so a webview that attaches later counts the sidebar timer from the turn's start instead of from the moment it opened.
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).
  - Enterprise mode: the extension runs no OpenChamber server, so it reads the same machine policy through the bundled `packages/web/server/lib/enterprise-mode.js` (policy file, or `OPENCHAMBER_ENTERPRISE_MODE` in the editor's environment). `api:openchamber:enterprise-policy` answers the webview's `/api/openchamber/enterprise-policy`; with the mode on, `api:provider:upsert` is refused, the update check never reports usage, and `bridge-proxy-runtime.ts` answers the provider-connect OpenCode routes (`isProviderConnectRequest`) with 403 `enterprise_mode` instead of forwarding them; MCP server sign-in passes, as on the web server. Jev, relay, tunnels, push and cloud speech do not exist here. A policy file `opencodeBinary` pin (with or without the mode) wins over `openchamber.opencodeBinary`, the shared settings and the environment in `opencode.ts`, never falls back when unusable, and turns off install-v2 and CLI upgrade (`opencode-upgrade-runtime.ts`, `reason: 'policy'`).
  - Stored credentials: `bridge-proxy-runtime.ts` answers `GET /api/credential` (`isCredentialListRequest`, any spelling OpenCode routes the same way) with 403 `credential_list_refused` in and out of enterprise mode. It returns every key with its secret; the extension host reads it for itself through `opencodeAuth.ts`, and the webview never gets it. Both this check and the provider-connect one run on the path as OpenCode receives it: the webview path is resolved as a URL first (so `/http:api/credential` counts as `/api/credential`), and a path that would resolve to another origin gets 400.
  - Git initialization: `POST /api/vcs/init` in the home directory, at a disk root, or without a directory gets the same 400 `InvalidRequestError` the web server answers (`vcsInitRefusal` from `web/server/lib/git/repository-root.js`), checked on the resolved path before anything reaches OpenCode.
  - Folder trust: `api:proxy`, `api:session:message`, and every direct extension-host OpenCode caller enforce folder trust before sending a directory-scoped request to OpenCode, and `api:proxy` serves `/api/opencode/trust` itself (`web/server/lib/opencode-trust`). The answers file is `~/.config/openchamber/opencode-trust.json`, shared with the desktop app, so a folder trusted in one is trusted in the other. One instance and its shared refusal helpers live in `opencodeTrust.ts`; the global event watcher (`sessionActivityWatcher.ts`) tells it when OpenCode closes a folder, so a trusted folder is read again only on its next opening. Direct extension-host callers cover the small-model catalog (`bridge-small-model-runtime.ts`, answering 403 `opencode_trust_required` with `directory`), SCM commit-message generation (`bridge-git-special-runtime.ts` and `scmCommitMessage.ts`, surfacing a trust refusal as a localized warning before waiting for OpenCode; an unreachable folder takes the ordinary error path), skills API discovery (`bridge-settings-runtime.ts`, returning `null` so filesystem discovery stays marked partial), project start-command lookup (`extension.ts` wrapping `openCodeProjectStartCommandSource`), credential and quota usage reads (`opencodeAuth.ts`, returning `{}` from `listEnvironmentKeys` and `null` from `readUsageLimits` on refusal so stored credentials still load), and `openchamber.showOpenCodeStatus` (`opencodeStatusProbes.ts`). Its location probes (config, providers, agents, commands, location) name the workspace through `x-opencode-directory`, the way OpenCode 2.x reads a location (it ignores `?directory=` there and falls back to its own working directory), and the trust check reads the same headers; a refused probe and every location probe without a workspace folder are skipped, while global probes, including the session list filtered by `?directory=`, still run.
  - Owns managed OpenCode upgrade status handlers and capability reporting.
  - Bridge command and external URL gates (`bridge-vscode-policy.ts`): `vscode:command` accepts only `openchamber.showSettings`, `openchamber.closeSettings`, `openchamber.setActiveSession`, `openchamber.openSessionInEditor`, and `openchamber.internal.openSession` with Zod-validated argument tuples (`ALLOWED_VSCODE_COMMANDS` is the discriminator set of that same schema, and truncating session titles to 4096 characters), and refuses unlisted commands or malformed arguments before calling `vscode.commands.executeCommand`. Panel-only commands `openchamber.settingsReady` and `openchamber.updateSessionEditorTitle` are handled only on their owning panel kind in `SessionEditorPanelProvider.ts` (ignoring disposed panels) and are refused by the system allowlist in every other view. `vscode:openExternalUrl` opens `http:` and `https:` directly, asks in a VS Code modal (scheme and full URL, Open / Cancel) before opening a link to another installed app, and refuses everything else, including `mailto:`, `file:`, `command:`, `vscode:`, `vscode-insiders:`, `vscode-*` and the editor's own `vscode.env.uriScheme`; `vscode.Uri.parse(url, true)` must keep the decided scheme. `vscode.env.openExternal(uri)` hands the app `encodeURI(uri.toString(true))`, which decodes escaped delimiters such as `%26`, so the modal shows that string: the user approves the URL that opens. The webview waits on that request without a deadline, since the modal has none.
  - Provider handlers cover source lookup, removal (`DELETE /api/provider/:id/auth?scope=all` → `api:provider:remove`: the entry leaves every config layer, both global files included, then managed OpenCode restarts as after an upsert; other scopes answer 400, enterprise mode refuses), and custom provider upsert (`PUT /api/provider`; create/update OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages config with explicit `scope` for user/project/custom layers; requires `env` or stored auth; secrets via OpenCode auth API). As on the web server, the `user` scope of source lookup, upsert and removal is the global file that holds the provider: `opencode.jsonc` beside `opencode.json` when the entry lives there. Updates preserve existing provider, option, and retained-model fields that the form does not manage while honoring explicit model, header, and env removal. Entries under the legacy `provider` key move to `providers` when edited. Validation and the merge are the web server's own `validateCustomProviderConfig` and `mergeCustomProviderConfig` from `packages/web/server/lib/opencode/providers.js`, so a model's limits, capabilities and reasoning levels land in the file exactly as on the web server. Do not copy them back here: a copy falls behind the form without any test noticing.
  - `api:provider:discover-models` runs the shared server discovery module in the extension host, so the webview never sends provider credentials or custom headers through the generic OpenCode proxy. In edit mode the host reads the provider's OpenCode-stored key when the form leaves it blank; a replacement key typed into the form wins. Enterprise mode refuses discovery before any network request.
  - Quota handlers keep managed exe.dev, Cursor, and ZenMux credentials in the extension data directory with the same private-file contract as the web runtime. exe.dev uses one command-scoped usage token for the aggregate billing shared by every `exe-*` model provider. ZenMux usage uses an optional Platform API key (`platformApiKey`) and does not read the OpenCode chat key. If that Platform API key is missing, ZenMux quota is not configured and the balance endpoint is not called. Kilo Code usage reads the OpenCode `auth.json` entry and also sends `x-kilocode-organizationid` when an organization id is on that entry or in `provider.kilo.options`. Keep those fetchers in sync with `packages/web/server/lib/quota/providers/zenmux.js` and `kilo.js`.
  - `quotaProviders.ts` owns the Ollama Cloud `/api/balance` request and parser used by quota refresh. It authenticates with the `ollama-cloud` API key from OpenCode's credential store, so there is no cookie to paste and the tracker follows the active account. It rejects 401/403 as auth failures, other HTTP errors as such, an unreadable body as transport, and a body carrying no usable credit pool as an unusable shape, with a 15-second request timeout. Current plans carry a monthly pool of credits, not the session/weekly limits of older plans: `included.allowance_usd` is the month's total and `included.balance_usd` what remains, so the used percent is `(allowance_usd - balance_usd) / allowance_usd`, accepted as numbers or numeric strings and clamped to 100, with the reset at `included.period.until`. An allowance that is absent, non-numeric, or not positive yields no window rather than a guessed percentage. `purchased.balance_usd` is surfaced as a `purchased_credits` money row only while positive. `included` has two documented shapes: a credits plan reports `allowance_usd`/`balance_usd` (the `monthly` window) and a legacy plan reports `session`/`weekly`, each a `remaining_percent` with a `resets_at`; whichever the account serves is rendered, at `(allowance - balance) / allowance` and `100 - remaining_percent` respectively. The account's plan tier (`free`, `pro`, `max`) is read best-effort from `POST /api/me` and surfaced as `planLabel`; a failure there drops the label rather than the usage reading. That parse is a deliberate second copy of `packages/web/server/lib/quota/providers/ollama-cloud.js`, so the two runtimes must agree on every one of those rules; the shared cases are pinned in both suites. The obsolete cookie file and per-account directory are removed on the first refresh.
  - There is no Google or Antigravity quota, for the reason in `packages/web/server/lib/quota/DOCUMENTATION.md` (*Why there is no Google or Antigravity quota*).
  - OpenCode Zen quota refresh uses the shared `packages/web/server/lib/quota/providers/opencode-zen.js` reader for Console requests, parsing and window construction. Its contract is in `packages/web/server/lib/quota/DOCUMENTATION.md`, section "OpenCode Zen credential and quota semantics". Each service-account budget stays in its own named window; the request counters and model rows cover only the `opencode` provider, so a workspace that also serves OpenCode Go does not put Go usage on the Zen card, and model reads include every page of each range. Windows carry structured `value` data for shared UI localization without another Console request. The extension owns credential discovery and result envelopes. OpenCode Go meters remain on the separate `opencode-go` provider.
  - Codex quota refresh mirrors `packages/web/server/lib/quota/providers/codex.js` by hand and shares its reader of the Codex CLI's sign-in, `providers/codex-cli.js` (`$CODEX_HOME/auth.json`, read-only), for the "Sign in with ChatGPT" case; the contract is in the same `DOCUMENTATION.md`, section "Codex credit balance semantics".

### Why Kimi deadlines use an AbortController

Kimi quota requests combine the 25-second refresh deadline and a 5-second request deadline through an `AbortController`. VS Code 1.85 runs Node 18.15, which lacks `AbortSignal.any`; both deadlines must still abort response body reads. Listeners detach when either deadline expires.

### Why app links ask in VS Code instead of being allowlisted

Links to other installed apps (`zed://`, `figma://`, `slack://`) have to keep working, and no fixed list of apps can cover them. A webview script can post `vscode:openExternalUrl` without passing through the chat's own confirmation, so the confirmation lives on the host: a modal the webview cannot answer. Which schemes count as app links comes from `ui/src/lib/appLinkSchemes.ts`, the same rule the chat uses; inside VS Code that rule also drops the editor's own schemes, so the chat never offers a link the host then refuses, and it skips its own dialog there so the user is asked once. `mailto:` and other browser-handled links never go through this bridge: the webview opens them itself.

- OpenCode compatibility recovery
  - `api:opencode/compatibility` is available even when managed startup rejects v1 or a 2.x older than the supported minimum. The UI checks it before configuration and session bootstrap.
  - `api:opencode/install-v2` accepts the same managed CLI versions for which compatibility offers installation. It runs the shared `v2-install.js` installer on macOS, Linux and Windows through the manager queue. Concurrent webviews share the operation. The extension selects the verified binary in the effective VS Code configuration scope, restarts, and requires a connected, supported v2 status before reporting success. Stop invalidates pending restart work.
  - The webview bridge waits without its default 30-second timeout. External URLs use manual installation. Filesystem rollback, standard installation location and cross-process locking follow the web runtime's CLI migration contract.

- `opencode-upgrade-runtime.ts`
  - Owns managed-versus-external capability decisions and latest-version checks.
  - Managed runtimes run the resolved CLI with `upgrade` through the manager's operation queue and the shared `packages/web/server/lib/opencode/cli-upgrade.js` executor. The queued action resolves the CLI with the same fallback as capability reporting; it does not require a live server process just to update the binary. OpenCode chooses its installer. On Windows a running managed server stops for the install and starts again afterwards, because a running `opencode.exe` cannot be replaced (see `packages/web/server/lib/opencode/DOCUMENTATION.md`). Concurrent webviews share one installation; failures allow another attempt. The existing Reload action restarts the server afterwards. The bridge waits for command completion without its default 30-second timeout. External connections and missing CLIs reject upgrades before spawning. Version checks remain available for external connections.

- Plugin metadata and OpenCode version checks use `packages/web/server/lib/npm/npm-registry-config.js`, the same resolver as the web server. It reads inherited registry settings and the user's `.npmrc`, supports scoped registries, and sends credentials only in HTTP headers.

- `sessionNotifications.ts`
  - Shows OpenChamber notifications (finished turn, error, question, the Settings test) as `vscode.window.showInformationMessage`. The webview keeps deciding which events notify and their text from the shared notification settings.
  - With "Notify while app is focused" off (`requireHidden`), a notification is skipped only while VS Code is focused and an OpenChamber chat, the sidebar or a session tab, is on screen. A hidden or collapsed chat counts as out of view. Any visible chat is enough, whichever session it shows; `packages/ui/src/lib/surfaceAttention.ts` decides unread per chat instead, so a session finishing behind another visible chat is marked unread without a notification.
  - A session notification carries "Open Session", which reveals the sidebar and selects that session (`openSession` webview command). Every open webview asks for the same session event, so repeats of one session message within 10 seconds show once; a notification without a session, the Settings test, is never deduplicated.
  - Kept free of the `vscode` import so it is unit tested directly.

- `bridge-permission-auto-accept-runtime.ts`
  - Owns the persisted VS Code permission auto-accept policy and its GET/PUT bridge contract.
  - Serializes reads and read-modify-write updates, persists a monotonic policy revision, and broadcasts the exact committed snapshot to every active OpenChamber webview. Permission replies remain foreground UI-owned because VS Code does not run the OpenChamber server runtime.

## Git in the webview

VS Code manages Git hosting providers and Git credentials itself, so the extension host exposes only the standard Git operations in `gitService.ts` and `bridge-git-runtime.ts`. Remote-branch deletion runs as a plain `git push --delete` with whatever credentials the user's Git setup provides; commit, history, merge, rebase and network write operations have no bridge handler (their surfaces are not mounted in VS Code). That is a product decision, not missing wiring: the extension gets no git write actions, because VS Code's own Source Control already does them. Mounting the Git view's commit, push, history, merge or rebase surfaces here, or restoring their bridge handlers, needs the maintainer's call first. The extension host stores no source-control bindings, provider accounts, transport credentials or author profiles.

The shared UI reads a repository context and binding before every Git network operation and drives push, pull, fetch, sync and remote-branch deletion through the `planNetworkOperation` / `executeNetworkOperation` lifecycle. `webview/api/git-remotes.ts` and `webview/api/source-control.ts` satisfy that contract without a store: they project the repository's remotes, read through `api:git/remotes` and redacted of userinfo, as a `bound` binding whose every remote is a ready System-transport grant. `providers()` answers an empty list, an authoritative answer rather than a failure, so the shared provider registry holds no provider and every provider operation stays unsupported. That includes Git hosts added by extensions whose service provides `source-control` (`ext-<guestId>`): VS Code leaves them out on purpose, since the guest catalog is unsupported here and there is no OpenChamber server to run their service. `createVSCodeAPIs` leaves out `RuntimeAPIs.trackers`, so tracker cards, pickers and board tabs do not appear. The only network-operation kind a mounted VS Code surface can plan is remote-branch deletion (the worktree delete flow); `webview/api/git.ts` keeps planned operations in webview memory and maps `executeNetworkOperation` onto `api:git/remote-branches`, a bridge failure becoming a `failed` snapshot with `TRANSPORT_FAILED` and the Git error text. Push, pull, fetch and sync plans need the Git view's binding strip, which is not mounted, so their `api:git/push` / `api:git/pull` / `api:git/fetch` bridge handlers are gone. Plans never reach the extension host, cancellation only affects a plan that has not started, and operation snapshots do not survive a webview reload.

Provider authentication, capabilities, issues, change requests, contributor destinations (`{ kind: 'ordinary' }`), clone, checkout hydration, worktrees created from a change request or with `ensureRemoteUrl`, and transport or auxiliary binding configuration are unsupported in the webview adapters and never reach the OpenCode proxy. The shared Git view therefore hides the repository binding strip in VS Code, and the Git settings page hides provider and managed SSH sections. Author profiles live in webview memory for the lifetime of the view and are not persisted; the git settings page that would apply one is VS Code-gated and never mounts.
- `InlineCommentThreads.ts`
  - Owns the `openchamber.inlineComments` comment controller: the gutter `+` range, the thread opened by `openchamber.addLineComment`, and every thread a submitted comment leaves anchored in the editor until the message goes out.
  - A `+` clicked in the gutter is not the thread described above: the workbench creates that template thread itself (`commentService.createCommentThreadTemplate`), renders its own header ("Start discussion"), its delete action and its input, and calls the extension back only on submit, through the `comments/commentThread/context` menu. The comment API has no event for such a thread and no way to style it, so the only control over it is whether a commenting range is offered at all. `editor` placement keeps that native affordance; `chat` placement withdraws it, since the text belongs in the composer.
  - A thread never owns a draft. It mints the draft id, hands the payload to a chat webview with the same routing as Add to Context (the active session panel when one exists, else the sidebar, revealed if needed), and follows the webview's whole-draft-list `inlineComments:sync` snapshots: present means show, absent after having been seen means dispose. A thread whose text is written in the composer is the exception to the first half: an empty body keeps the draft, so the thread leaves the screen and its anchor waits for the next text instead of ending the comment, and only an absent draft disposes it. A snapshot is tagged with the surface that produced it (a panel id or `sidebar`) and only decides that surface's own threads, because every webview runs its own draft store.
  - A comment the composer never confirms holding within 30 s is retracted from every surface's pending hold, its thread disposed, and the user told, so a thread cannot promise a send that will never happen. The thread's "not sent yet" label stays until the message carrying the comment is sent and the draft leaves the store, which disposes the thread.
  - `lineCommentCommand.ts` registers `openchamber.addLineComment` for the editor context menu, the line-number menu and the keybinding. The line-number menu passes `{ uri, lineNumber }` (1-based) while the other entries pass only the resource or nothing, so the clicked line is read from the argument and the comment quotes that line's own text; without a usable line the command warns and falls back to the editor selection. The chosen range then goes to `composeInChat` or `openThread` by the setting.
  - `inlineCommentSelection.ts` holds the pure pieces (line ranges, the diff-side and real-path resolution for `git:` documents, the pending hold, removal broadcast, thread fate) without the `vscode` import so they are unit-tested directly.
  - Webview side: `webview/inlineCommentTarget.ts` decides where a delivered comment is filed. A session panel stamps its session on every comment it delivers and the webview waits until it shows that session; the sidebar files on its current session or open draft. Filing on the first snapshot with a directory put the draft under `draft` while a fresh panel was still loading its session list, a key that composer never reads. `webview/inlineCommentRemovals.ts` remembers removals that arrive before a delayed delivery lands, so a comment dropped while its panel was still booting does not appear as a chip later. The extension is not activated on startup for this; the right-click command activates it, and the gutter `+` appears from then on.
  - `openchamber.lineCommentPlacement` decides where the text is written. `editor` (the default) opens the thread above. `chat` files an empty draft and opens its row in the composer; no thread is created until a snapshot shows the draft with text, because the composer reads an empty body as removed. The thread is created from that snapshot, keeps the diff identity captured before the chat reveal, and is given up on after the same 30 s deadline if no snapshot ever shows the draft. A thread already on screen follows the field: emptying the field takes the thread away and parks its anchor (current lines, diff identity, surface), and the next text re-creates the thread there. `editor` keeps the native gutter `+` (which runs the workbench's own template thread, see above); `chat` withdraws that range, so the editor menu, the line-number menu and the keybinding are the entries that reach the composer. The line-number menu passes the clicked line and the comment quotes that line's text, so the entry anchors there instead of at the caret. Until the thread exists the extension follows the document's changes and moves the pending anchor with them; an edit that rewrites the anchored lines themselves moves the comment to the start of the rewrite. The pending anchor is an inclusive line interval, not a `Range`, because a range ending at column zero of its last line reads back one line short; the edits of one change event all name lines of the document before it, so they apply bottom-up. The sidebar may be showing its session list when the command runs, with neither a session nor a new-session draft to file into, and the chat comes forward only once a draft is stored; so a composer comment without a target session opens a new-session draft itself, the same way the New Session command does, and files into it. A session panel's comment stays pinned to its own session. The draft arrives marked `composing`, which opens its field, and `VSCodeLayout` brings the chat forward when the draft arrives (also out of a run overview).

### Why a code comment can be written in the chat composer

A comment is context for the next message, and on a narrow surface the chat composer is where the user can see what is attached and edit it with the field they already know. Writing it in the VS Code thread means a second, poorer input box: the thread takes only text, while the composer's comment field handles image paste and `#snippets` already. The editor still owns the anchor, so the setting changes where the note is typed, never what it is attached to. `editor` stays the default because reading the comment on the code is the more direct path when the editor is wide enough.

### Why an emptied composer field parks the thread instead of ending the comment

The draft is the comment and the field holds its text, so an empty field means a comment with nothing written yet, not a cancelled one. The composer discards an empty body only when the user cancels the field, which is also the moment the draft leaves the store. Ending the thread instead hides the anchor while the draft still exists, and a later snapshot with text then has nothing to attach the thread to, which is how a comment could disappear from the editor for good.

The rejected alternative is keeping the thread with no comments. VS Code renders that as an empty header box on the line, and its own comment UI treats an empty body as a removed comment, so the anchor looks like a broken comment rather than a comment being written.

The parked anchor outlives a chat webview that is closed while its field is empty. Dropping it with the surface would be wrong: the draft store is persisted and a reopened session tab brings the draft back, but the lines it was attached to live only in the extension.

## Shared webview message ordering

### Chats in empty windows

With no workspace folder, sidebar and editor drafts use the shared managed Chats
creation flow. The filesystem home bridge names the host's
`~/.config/openchamber/chats` root and its canonical path when it exists.
Reading home does not create directories. Empty-window directory bootstrap
creates the shared root before publishing it as ready for OpenCode reads; a
failed root allocation leaves bootstrap retryable. The draft owner allocates
a separate directory per Chat, and a failed draft allocation blocks only that draft.
The workspace folder list stays empty; the Chats root is never a workspace project.
Editor tabs resolve the requested session through the global index before selecting
its directory. The sidebar's archived toggle exposes a Chats archive bucket with
top-level sessions; restoring one uses the shared subtree restore action.

The filesystem bridge runs on the extension host. An external OpenCode on another
host does not receive these directories, so projectless Chats require OpenCode
to share the extension host's filesystem. No remote directory transport is provided.

### Why Chats is limited to empty windows

The approved no-folder flow needs a session directory without asking the user to
open a project. Windows with workspace folders keep their project-only behavior.
Shared draft and visibility rules read the host's workspace list, so a previous
session's directory cannot select the wrong mode.

The editor-panel host owns a singleton Settings tab separately from its session panels. `openchamber.showSettings` reveals that tab, including when the sidebar has never resolved or no folder is open. Settings receives theme, connection, settings-save and permission-policy broadcasts through the same panel bridge, but is excluded from chat attention, attachment routing and active-editor selection broadcasts. Closing or reloading its webview aborts only its own SSE streams.

A settings-save broadcast invalidates the recipient's cached server document before its existing settings synchronization runs. Reusing the short-lived GET cache hid a peer's save from an already-open tab. Synchronization keeps its normal mutation reconciliation and preserves the webview's editor-derived theme. Pending bridge replies post only while their original panel owner remains current; disposal cleanup uses the webview reference captured while the panel was alive, because VS Code's panel getter throws after disposal.

### Why the Settings command accepts null without relaxing navigation validation

VS Code can pass `null` as the view-title action context, so the command treats it like an omitted argument. Other supplied values still pass through the navigation schema: silently discarding malformed navigation would open the wrong settings page and hide a caller error.

### Why Settings uses a separate panel and not the sidebar view

Settings needs the editor area's width while the sidebar keeps its current chat or session list. Sharing the existing panel host preserves its bridge and lifecycle behavior without copying another provider. The Settings root loads configuration pages on demand and does not mount the session layout, global session poller or background queue/cleanup effects.

Navigation waits for `openchamber.settingsReady`, sent by the mounted Settings root and handled only by its originating panel. A closed panel's readiness cannot release navigation in its replacement. `webview:ready` proves only that the bridge runs, before React owns navigation. The host keeps the newest pending target through that interval and consumes it once, so a reload does not replay an old page selection. `openchamber.closeSettings` disposes the specific Settings panel rather than whichever editor currently has focus. The parsed navigation contract lives in `packages/ui/src/lib/settings/vscodeNavigation.ts`.

The default Ctrl+, / Cmd+, Settings shortcut belongs to VS Code while an OpenChamber webview has focus. Native keybindings reveal Settings from chat webviews and close it from the Settings webview; the shared shortcut handler yields that default key. VS Code forwards webview key events to its workbench even after the renderer handles them, so browser-only handling opened both Settings pages. `settingsShortcutFocus.ts` owns the keyboard target, distinct from chat attention: parsed document focus reports claim the sender's host-stamped kind, a late blur releases only that sender, and hiding, reloading or disposing a webview clears its claim. VS Code's ordinary `editorFocus`/`focusedView` keys do not identify focus inside its webview overlays. Custom OpenChamber shortcut overrides retain their shared handler, and other VS Code views retain the editor's own Settings binding.

The bridge sends `webview:ready` once per document, before its first outbound
message. Sidebar and session-editor hosts abort that panel's old
SSE streams before accepting new requests and resend the current connection
state. A VS Code webview reload or cross-window move replaces the document
without disposing its panel; relying only on panel disposal leaked one upstream
stream per reload, including its ongoing idle heartbeat traffic.

Each host also sends `viewerStateChanged` with `{ windowFocused, surfaceVisible }`: on resolve and on `webview:ready`, when the VS Code window gains or loses focus, and when that view or panel is shown or hidden. The webview parses it at the bridge and hands it to `packages/ui/src/lib/surfaceAttention.ts`, which decides whether a finished turn in the selected session counts as seen. The webview document's own `hasFocus()` is not used for this, because focus in the code editor would otherwise mark a visible chat as unread.

Message and part ordering is owned by [`packages/ui/src/sync/DOCUMENTATION.md`](../../ui/src/sync/DOCUMENTATION.md#session-message-loading). The VS Code webview consumes that shared sync implementation; bridge and proxy runtimes pass OpenCode records through without adding runtime-specific ordering.

The OpenChamber control stream (`/api/openchamber/events`) requires the
OpenChamber server, which the extension does not run. `subscribeOpenchamberEvents`
therefore returns a no-op subscription in VS Code before resolving URLs or
opening a connection. Session sync still uses the OpenCode SSE bridge and
global session polling. Sending the control stream to the webview origin caused
repeated `403` responses and URL-token requests to `/auth/url-token`.

Shared lazy imports retry a failed chunk load, but skip browser-navigation
recovery in VS Code. `window.location.reload()` is unsupported inside webviews;
the original import error must reach the UI error boundary instead.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.

## VS Code surface reachability map

Verified 2026-08-28 against `8f5eb231b`.

Two webview hosts, both rendering `renderVSCodeApp` → `VSCodeApp`
(`packages/ui/src/apps/VSCodeApp.tsx`):

- `ChatViewProvider.ts` — sidebar view, `viewMode: 'sidebar'`.
- `SessionEditorPanelProvider.ts` — editor tabs, `viewMode: 'editor'`. Session tabs use `panelType: 'chat'`. The singleton Settings tab uses `panelType: 'settings'`. A tab opened by `openchamber.openAgentManager` (titled "Run on Several Models"; the id predates multi-run and stays for existing keybindings) carries `initialComposer: 'parallel'`, so its new-session draft starts in parallel mode.

The old Agent Manager panel (its own provider, `AgentManagerView` and group store) is gone. It listed worktree sessions it never bootstrapped into sync, so its chats missed live events; runs now use the shared sidebar rows, run overview and composer.

`VSCodeLayout` has two views: `sessions` and `chat`
(`packages/ui/src/components/layout/VSCodeLayout.tsx:76`). There is no
`MainLayout`, no `ContextPanel`, and no `ContextPanelRail` in this runtime, so
every surface reached only through those is unreachable.

### Surfaces

| Surface | Status | Mount chain / cut-off |
|---|---|---|
| Chat timeline | MOUNTED | `VSCodeLayout` → `ChatView` → `ChatContainer` → `MessageList` |
| Composer | MOUNTED | `ChatContainer` → `ChatInput` (model/agent controls, autocomplete, attachments, dictation, issue/PR pickers, `ReviewFlowDialog`, `PendingChangesBar`) |
| Work status panel | MOUNTED | Inline beside the chat in `VSCodeChatArea` where it fits, otherwise the overlay; `VSCodeHeader` carries the toggle |
| Permission / form cards | MOUNTED | `ChatContainer` → `PermissionCard`, `FormCard` |
| Timeline dialog | MOUNTED | `ChatContainer` → `TimelineDialog` |
| Tool output / inline diff preview | MOUNTED | `MessageList` → `ToolPart`, `ToolOutputDialog` (`DiffViewToggle`, not `DiffView`) |
| Sessions sidebar | MOUNTED | `VSCodeLayout` → `SessionSidebar` with `mobileVariant hideDirectoryControls` |
| Session dialogs | MOUNTED | `VSCodeLayout` → `SessionDialogs` |
| Session switcher | MOUNTED | `VSCodeHeader` → `SessionSwitcherDropdown` |
| MCP servers | MOUNTED | Work status panel's MCP section; the separate header dropdown is gone |
| Context usage | MOUNTED | `VSCodeHeader` `showContextUsage` → `ContextUsageDisplay` |
| Rate limits | MOUNTED | Work status panel's Usage section; the separate header dropdown is gone |
| Multi-run | MOUNTED | `SessionSidebar` run rows; `RunOverview` over the chat in every layout (sidebar, expanded, editor tab); composer parallel mode from the model picker and the `openchamber.openAgentManager` tab |
| Settings | PARTIAL | Settings editor tab → `VSCodeApp` → on-demand `SettingsView`. Page availability remains defined by `metadata.ts`; moving the host does not enable unsupported pages. |
| Usage / quota page | MOUNTED | `SettingsView` → `UsagePage` (slug `usage`, no VS Code gate) |
| Notifications settings | MOUNTED | `SettingsView` → slug `notifications` (no VS Code gate) |
| MCP settings | MOUNTED | `SettingsView` → `McpSidebar` / `McpPage` |
| Agents / commands / skills / plugins / providers / projects settings | MOUNTED | `SettingsView` page registry |
| Worktrees | PARTIAL | Create/remove reachable via `SessionSidebar` → `NewWorktreeDialog` and `sessionWorktreeMenu`. `WorktreesView` is `MainLayout`-only |
| Git | PARTIAL | Read-only status and branches via `useGitStore` in `SessionSidebar`, `ChatInput`, `WorkStatusPrimaryGroup`. Stage, commit, push, history, merge and rebase live in `GitView` + `views/git/*`, cut off with `ContextPanel`; the bridge has no handlers for them and the shared Git API rejects them as unsupported |
| Voice / dictation | PARTIAL | `ComposerDictation` renders in `ChatInput`; the `voice` settings page is VS Code-gated |
| Command palette | NOT MOUNTED | `CommandPalette` renders only in `MainLayout`; `useKeyboardShortcuts` gates `open_command_palette` off in the VS Code runtime, so Cmd/Ctrl+P stays with VS Code's own Quick Open |
| ContextPanel / project context (notes, todos, plans tabs) | NOT MOUNTED | `ContextPanel`, `ContextPanelRail`, `RightSidebarTabs` imported only by `MainLayout` and `MobileWorkspaceDrawer` |
| Terminal | NOT MOUNTED | `TerminalView` imported only by `ContextPanel` and `MobileWorkspaceDrawer`. `webview/api/index.ts` ships `createStubTerminalAPI()` whose every method throws unsupported; `useKeyboardShortcuts` gates `toggle_terminal` off in the VS Code runtime, leaving Cmd/Ctrl+J to VS Code, which toggles its bottom panel on whichever tab was last open |
| Files view | NOT MOUNTED | lazy `FilesView` in `ContextPanel`; `SidebarFilesTree` is `MainLayout`-only |
| Diff view | NOT MOUNTED | lazy `DiffView` in `ContextPanel` |
| Git view | NOT MOUNTED | lazy `GitView` in `ContextPanel` |
| Plan view | NOT MOUNTED | lazy `PlanView` in `ContextPanel`, `ProjectNotesTodoPanel`, `MobileApp` |
| Pull request view | NOT MOUNTED | `PullRequestView` imported only by `ContextPanel` |
| Browser panel | NOT MOUNTED | `BrowserPane` imported only by `ContextPanel`; `RuntimeAPIs` has no browser member in `webview/api/index.ts` |
| Walkthrough | NOT MOUNTED | `WalkthroughView` imported only by `ContextPanel` |
| Archive view | NOT MOUNTED | `ArchiveView` imported only by `MainLayout` |
| Scheduled tasks | NOT MOUNTED | `ScheduledTasksDialog` imported only by `MainLayout` |
| Memory debug panel | NOT MOUNTED | `MemoryDebugPanel` imported only by `App.tsx` (web/desktop root) |
| Mini chat | NOT MOUNTED | `MiniChatLayout` imported only by `ElectronMiniChatApp` |

### Dead bridge surface

No mounted VS Code surface reaches these: `api:git/*` commit, history, merge,
rebase, network-write, diff and identity write handlers were removed with
their surfaces, as were the filesystem write handlers (`api:fs:write`,
`api:fs:rename`, `api:fs:delete`) that served `FilesView`, `SidebarFilesTree`
and `PlanView`, which never mount here.

Reachable filesystem routes: `api:fs:read` (attachments), `api:fs:search`
(`useFileSearchStore` behind composer file mentions), `api:fs:list`,
`api:fs:stat`, `api:fs:home` and `api:fs:mkdir` (empty-window Chats root
bootstrap through `/api/fs/mkdir` in the webview), and `api:fs:reveal` (the
session sidebar's export "Reveal" action).

Maintenance: reviews, changelog entries, and parity claims consult this map;
whoever mounts or unmounts a surface updates it in the same change.

## Network connections

Extension activation applies `networkDefaults.ts` before registering handlers.
It gives Node connection attempts 5 seconds, matching the web runtime, so quota
requests to distant providers can connect. This is an extension-host process
default, including other Node connections in that host. Address-family selection
stays unchanged; runtimes without the setter retain their existing behavior.

## OpenCode version requirement

The extension requires OpenCode 2.x. `opencode.ts` runs `opencode --version` before
spawning a managed server and refuses to start on anything else
(`opencodeVersion.ts` parses the CLI's `opencode v2.0.2` line). A 1.x binary would
start and serve a different API, leaving the user with a webview that loads and
then fails every request, so the failure is reported up front instead.

Readiness comes from the `server listening on <url>` line on stdout, confirmed
by `GET /api/info` (OpenCode 2.0.8 removed `/api/health`). A 200 is the whole
readiness answer; the payload carries `{ version, pid, urls, paths }` and no
`healthy` field.

## Machine-specific settings

`openchamber.apiUrl` and `openchamber.opencodeBinary` describe one machine. In a
remote window a value set only in the local User settings never applies: both
settings are read through `readMachineSetting` (`machine-settings.ts`), and a value
for the server comes from the Remote or Workspace settings.

### Why `machine-overridable` and not `machine` or `window`

`window` hands the client's path to the server. `machine` drops the project folder
override that `window` allowed. `machine-overridable` keeps that override, stops
Settings Sync from copying the value, and sends a Global write in a remote window
to the Remote settings.

### Why a read helper on top of the scope

The scope alone leaves a gap. While a remote window starts, VS Code reports the
local User value until it applies the scope about 2 seconds later, and an open
OpenChamber panel activates the extension inside that gap. Waiting for a later
configuration event has no signal to wait for: the event that drops the value
reports `affectsConfiguration` as false. `inspect` names the level the value came
from, so the helper can decide on the first read. `globalLocalValue` is outside the
public types; 1.98 has it and 1.95 does not. A build without it falls through to
`get` and keeps the gap.

## Global OpenCode paths

`opencodeConfigPaths.ts` owns the global config directory for config CRUD,
skill discovery/install, global AGENTS.md, and quota config-file lookup. It
resolves `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
`~/.config/opencode` at extension startup (the same rule OpenCode 2 applies);
only `opencode.json(c)` is a config file, the v1 `config.json` is not read. Project paths, the explicit
`OPENCODE_CONFIG` file layer, and the auth data directory stay separate.
When both global files exist, every config entry lookup reads
`opencode.jsonc` after `opencode.json`, so on a name clash the `.jsonc` entry
wins. This covers MCP servers, agents, and commands: editing or deleting an
entry updates the file that defines it, and without `OPENCODE_CONFIG` a new
user-scoped entry goes into the primary config file.
MCP servers also come from every `opencode.json(c)` and
`.opencode/opencode.json(c)` OpenCode 2 finds walking up from the project
folder to the filesystem root, in OpenCode's order (see the web server's
`getFolderConfigPaths`); those folder files rank above `OPENCODE_CONFIG`, and
a server from a parent folder is edited and deleted in that parent file.
An invalid secondary file cannot answer an empty MCP list or a missing-server
lookup as success; those reads report the parse error instead. An agent or
command lookup that reaches the global files reports the same error.
No files are migrated. The behavior GET bridge response includes the effective
`path` for both existing and missing AGENTS.md files; shared Settings uses it
in the warning.

### Plugin switches

The Plugins page's on/off switches exist in VS Code too. The extension keeps
its state in `<extension global storage>/plugin-switches.json`, separate from
the web server's data-dir store, so each OpenChamber runtime applies only its
own switches to the OpenCode it starts. The rule that maps a spec to the
`plugin:` resource OpenCode matches, and the check for an allow that beats the
denial, are the web server's `plugin-switches.js`, so both surfaces decide alike.
`plugin-switches.ts` holds what is the extension's own: its store location and
its managed layer.

The bridge exposes `PUT /api/config/plugins/entry/:id/enabled` and
`/file/:id/enabled`, and the list payload carries `policyResource` and
`switchState` so the shared UI can render the same switch. Before spawning the
managed `opencode serve`, `opencode.ts` writes `opencode.managed.json` in the
extension storage and passes it as `OPENCODE_CONFIG` in the child's environment
only; the user's own config and `process.env.OPENCODE_CONFIG` are untouched.
When the user already owns `OPENCODE_CONFIG`, the denials merge into
`OPENCODE_CONFIG_CONTENT` and the route reports `requiresManualRestart`, since
the running child only reads that value at launch. A rewrite that fails after the
store write also answers saved with `requiresManualRestart`. An unreadable store
leaves the managed file as it was and fails a fresh launch, because starting
without the denials would load the plugins the user switched off. A rule that
beats the denial reports `overridden` and refuses the change with
`SWITCH_OVERRIDDEN`. An external OpenCode server (`openchamber.apiUrl`) owns
neither the process nor its config layer, so every row reports the switch as
unavailable and a change is refused with `SWITCH_UNAVAILABLE`.

## OpenCode 2 config shapes

`opencodeConfig.ts` is the extension-host mirror of the web server's
`packages/web/server/lib/opencode/*` entity modules. Both must write identical
files, so all the shape logic lives in one place: `opencode-config-v2.ts` is a
thin re-export of `packages/web/server/lib/opencode/config-v2.js`, bundled in by
esbuild the same way `provider-env-aliases.ts` is. Do not reimplement a
conversion here — add it to the web module and it lands in both runtimes.

Ownership and the v1 fallback policy are documented once, in
`packages/web/server/lib/opencode/DOCUMENTATION.md` under "Entity routes
(v2 shapes)". The short version:

- Reads accept the v2 keys (`agents`, `commands`, `providers`, `mcp.servers`,
  `plugins`, `permissions`) and fall back to the v1 keys OpenCode 2 still
  decodes (`agent`, `command`, `provider`, `mcp.<name>`, `plugin`,
  `permission`/`tools`). v2 wins when both exist.
- Writes emit v2 only, into the v2 directory (`.opencode/agents/`,
  `.opencode/commands/`, `.opencode/skills/<id>/`, `.opencode/plugins/`).
- Files are never moved. Updating an entity that lives in a v1 file rewrites it
  at its own path in v2 shape, and a v1 JSON entry moves to the v2 section key
  inside the same file. Every mutation returns the `path` it wrote.

Bridge surface (`bridge-config-runtime.ts`), matching the web routes:

- `api:config/agents` — `GET` answers the `sources` envelope; `GET` with
  `resource: "config"` answers `{ source, scope, path, legacy, config }` and
  with `resource: "permissions"` answers `{ global, agent, effective, source,
  path }`. `POST`/`PATCH` take an `AgentEntity` body (a v1 `permission` map and
  the v1 `prompt` alias are still accepted) and report the written `path`.
- `api:config/disabled-agents` — `GET` answers `{ agents }`, the agents whose own
  config says `disabled: true`. OpenCode drops them from its agent list, so
  Settings reads them here to offer Enable. Mirrors `/api/config/disabled-agents`.
- `api:config/commands` — same, with `resource: "config"` and a `CommandEntity`;
  `subtask` is accepted as the v1 name for `subagent`.
- `api:config/mcp` — `McpEntity` bodies; entries carry `sectionKey` and
  `legacy`.
- `api:config/websearch` — `PUT /api/config/websearch`; `{ selection }` is
  `false`, `null` (remove the key), `"random"` or a provider id, written with
  the shared `writeWebSearchSelection` to `OPENCODE_CONFIG` or the user config.
  `{ method: "GET", directory }` returns `{ projectPath }` from the shared
  `findWebSearchProjectOverride`: the project config that overrides that write.
- `api:config/warming` — `PUT /api/config/warming`; `{ enabled }` turns session
  warming on (`true`, keeping a hand-tuned object) or off (removes the key),
  written with the shared `writeWarmingEnabled` to the same file.
- `api:config/compaction` — `PUT /api/config/compaction`; `{ auto, buffer,
  keepTokens, background }` (each optional) parsed by the shared
  `compactionUpdateSchema` and written with `writeCompactionSettings` to the
  same file.
- `api:config/skill-switch` — `PUT /api/config/skill-switch`; `{ id, enabled,
  scope, directory }` turns a skill off or on with the shared
  `writeSkillDisabled`, in the same files the web route edits
  (`setSkillEnabled` in `opencodeConfig.ts` mirrors `skill-switch.js`).
- `api:config/skills:catalog` — `GET /api/config/skills/catalog`; answers
  `{ ok, sources, itemsBySource: {} }` without scanning anything, like the web
  route. The shared UI asks for it on every Skills catalog open and on every
  OpenCode `skill` or `config` catalog event, catalog page open or not.
- `api:config/skills:catalog/source` — `GET /api/config/skills/catalog/source`;
  `{ sourceId, refresh }` scans that one source (`skillsCatalog.ts`) and answers
  `{ ok, items }` or `{ ok: false, error }`. Results stay cached for 30 minutes,
  and requests for a source whose scan is still running wait for that scan,
  `refresh` included.

### Why the catalog list does not scan the sources
Until #5446 `api:config/skills:catalog` scanned every source one after another
in the same request, skipping the cache when asked to refresh. A scan of a large
source outlasted the webview's 30 second bridge timeout, so the page showed
"timed out" and the next open or catalog event started more scans beside the
ones still running. Per-source requests are what the web server already
offers, so the shared UI needs no VS Code branch.

## Session archive and metadata

OpenCode holds archive state since 2.1, and `openchamberSessionState.ts` sends
every archive and restore there first (`PATCH /api/session/{id}` with
`archived`), so VS Code, the desktop app and the TUI share one archive.
Since 2.2 that also works for a session whose directory was deleted. The
`sessions-archive.json` the OpenChamber server keeps, in the shared OpenChamber config directory
(`~/.config/openchamber`, `%APPDATA%\openchamber` on Windows), which is also
the web server's default data directory, still holds entries an older version
wrote. They win over OpenCode's record, so archiving or restoring a session
drops its entry, and the web server pushes the rest. Nothing is cached between calls
because two processes can write the file; every write re-reads first and
replaces the file atomically.

The unread baseline (`sessions-unread.json`, `{ since }`) is shared the same
way: whichever of the server and the extension reads it first creates it, and
both serve turns that ended before it as seen (`time.viewed` up to
`time.idle`). Once read, it is cached, because nothing rewrites it.

Session metadata lives on the OpenCode record (`PATCH /api/session/{id}`,
OpenCode 2.0.15+). OpenCode replaces the whole object, so a write reads the
record, applies the JSON Merge Patch (RFC 7386) and writes the result, and
features sharing the `openchamber` namespace do not erase each other. An entry
an older version left in `sessions-metadata.json` is laid over the record on
reads and pushed to OpenCode on that session's next write, then dropped from
the file; the web server sweeps the rest.
The extension serializes metadata writes per session. A conditional write
compares the expected metadata within that queue and returns the current value
on conflict. This queue does not serialize writes from another process.

The webview answers `POST /api/openchamber/sessions/archive|unarchive` and
`GET|POST /api/openchamber/sessions/:id/metadata` through the
`api:sessions/*` bridge cases in `bridge-system-runtime.ts`, and
`bridge-proxy-runtime.ts` folds `time.archived` and not-yet-migrated metadata
onto every proxied `GET /api/session` and `GET /api/session/:id` response, the
same overlay the web proxy applies.

## Extension localization

Two bundles carry extension-host text: `package.nls*.json` for the manifest
`%token%` strings and `l10n/bundle.l10n*.json` for the `t(...)` call sites.
Every locale file must cover the full English key set with the same `{0}`
placeholders — VS Code silently falls back to English per missing key, so a
half-translated locale looks like a shipped feature. `localizationBundles.test.ts`
enforces that, and it is the check to run whenever a feature adds a new string.

The pre-bundle loading splash in `webviewHtml.ts` is separate: its strings are
inlined in the generated HTML because the splash renders before the webview
bundle loads. It picks them from OpenChamber's own saved locale
(`openchamber.i18n.v1` in webview localStorage) and, before the user has
chosen one, from VS Code's display language, which the HTML exposes as
`window.__OPENCHAMBER_HOST_LANGUAGE__`. The UI bundle reads the same value as
its default locale (`detectInitialLocale`), so a fresh install in a supported
language starts in that language on both the splash and the app. Both are only
the first paint: the interface language is a `profile` setting (`locale`), so
once the settings load, a language the person picked in any OpenChamber client
replaces it. VS Code's display language stays in effect only while no client
has saved one.
