# VS Code test mutation audit

Counts are test/it blocks, assigned to their original files. A table-driven block can run several named cases. The audit starts with 67 files and finishes with 65. Red means the named block failed. Failures in other blocks do not count.

The search-ceiling rewrite moved from bridge-fs-helpers-runtime.test.ts into bridge-fs-search.test.js. The 2 CSP rewrites moved from webviewHtml.test.ts into SessionEditorPanelProvider.newSession.test.js. Both now reuse existing VS Code stubs; the 2 source-only files are removed.

Product files were restored with git checkout immediately after each mutation. The audit changes only tests and this evidence file. No behavior net, dev server, or browser was used.

The audit base is `39df119d49fe5cd7a6df9eac7df04d18d8c338d8`, the starting HEAD and the original `origin/bohdan/dev`. During the final checks, another fetch advanced that shared remote-tracking ref to `4c7fb7f741fc5fa4a74302fbba1828ba1c8ad27e`. The product code stays at the audited starting version. No shared ref was reset and no upstream product changes were adopted.

## Validation

- Bun 1.4.4, the repository's pinned runtime, ran every remaining file separately with `bun test ./packages/vscode/src/<file>` from the repository root. All 65 files passed 3 consecutive runs each, for 195 passing file runs.
- `sseProxy.test.ts` passed 20 consecutive individual-file runs with the node:test fake clock. Removing the per-chunk reset or skipping the stream pipe then made the rewritten checks fail.
- `git diff --stat origin/bohdan/dev -- . ':!*.test.*' ':!**/__tests__/**' ':!**/test-support/**'` printed nothing before the external fetch. After that fetch it shows 115 upstream file differences. The same comparison against the pinned audit base prints nothing.
- `bunx oxlint -c oxlint.config.ts packages/vscode/src` printed nothing and exited successfully.
- `bun run check:changed -- --base 39df119d49fe5cd7a6df9eac7df04d18d8c338d8` passed type-checking, lint, dead-code checks, the findings ratchet, and file-size checks. Existing UI lint warnings remain unchanged.
- One initial baseline run hit ENOSPC. Test temporary directories were moved to session-owned tmpfs storage; all final runs passed there.

| File under packages/vscode/src | Before | Kept | Rewritten | Deleted |
|---|---:|---:|---:|---:|
| `` SessionEditorPanelProvider.newSession.test.js `` | 13 | 13 | 0 | 0 |
| `` activePanelRouting.test.ts `` | 6 | 6 | 0 | 0 |
| `` antigravityQuota.test.ts `` | 1 | 1 | 0 | 0 |
| `` bridge-config-runtime.test.js `` | 17 | 17 | 0 | 0 |
| `` bridge-fs-helpers-runtime.test.ts `` | 1 | 0 | 1 | 0 |
| `` bridge-fs-runtime.test.js `` | 3 | 3 | 0 | 0 |
| `` bridge-fs-search.test.js `` | 3 | 3 | 0 | 0 |
| `` bridge-git-generation-model.test.ts `` | 14 | 14 | 0 | 0 |
| `` bridge-git-process-runtime.test.ts `` | 5 | 5 | 0 | 0 |
| `` bridge-git-runtime.test.js `` | 14 | 14 | 0 | 0 |
| `` bridge-git-special-runtime.test.js `` | 14 | 14 | 0 | 0 |
| `` bridge-localfs-proxy-runtime.test.js `` | 6 | 6 | 0 | 0 |
| `` bridge-permission-auto-accept-runtime.test.ts `` | 3 | 3 | 0 | 0 |
| `` bridge-proxy-runtime.test.js `` | 4 | 4 | 0 | 0 |
| `` bridge-proxy-runtime.test.ts `` | 10 | 9 | 0 | 1 |
| `` bridge-settings-runtime.test.js `` | 3 | 3 | 0 | 0 |
| `` bridge-small-model-runtime.test.ts `` | 7 | 7 | 0 | 0 |
| `` bridge-system-runtime.test.js `` | 16 | 16 | 0 | 0 |
| `` exeDevQuota.test.ts `` | 2 | 2 | 0 | 0 |
| `` git-commit-message.test.ts `` | 3 | 3 | 0 | 0 |
| `` gitPathDiff.test.ts `` | 4 | 4 | 0 | 0 |
| `` gitRemoteListing.test.ts `` | 5 | 5 | 0 | 0 |
| `` gitService.bare-repository.test.js `` | 3 | 3 | 0 | 0 |
| `` gitService.remote-argument-hardening.test.js `` | 8 | 8 | 0 | 0 |
| `` gitService.repository-prefix.test.js `` | 2 | 2 | 0 | 0 |
| `` gitService.status-rename.test.js `` | 2 | 2 | 0 | 0 |
| `` gitService.worktree-bootstrap.test.js `` | 5 | 5 | 0 | 0 |
| `` gitService.worktree-config.test.js `` | 2 | 2 | 0 | 0 |
| `` gitService.worktree-fetch-fallback.test.js `` | 3 | 3 | 0 | 0 |
| `` gitService.worktree-remove.test.js `` | 13 | 13 | 0 | 0 |
| `` gitService.worktree-upstream-tracking.test.js `` | 2 | 2 | 0 | 0 |
| `` googleQuota.test.ts `` | 5 | 5 | 0 | 0 |
| `` inlineCommentSelection.test.ts `` | 40 | 40 | 0 | 0 |
| `` localizationBundles.test.ts `` | 2 | 2 | 0 | 0 |
| `` machine-settings.test.js `` | 5 | 5 | 0 | 0 |
| `` magic-prompts.test.ts `` | 3 | 3 | 0 | 0 |
| `` managed-opencode-process.test.ts `` | 1 | 1 | 0 | 0 |
| `` networkDefaults.test.ts `` | 2 | 2 | 0 | 0 |
| `` openchamberSessionState.test.ts `` | 13 | 13 | 0 | 0 |
| `` opencode-ready.test.ts `` | 5 | 5 | 0 | 0 |
| `` opencode-upgrade-runtime.test.ts `` | 7 | 7 | 0 | 0 |
| `` opencodeAuth.test.ts `` | 2 | 2 | 0 | 0 |
| `` opencodeCliDiscovery.test.ts `` | 2 | 2 | 0 | 0 |
| `` opencodeConfig-npm-registry.test.ts `` | 2 | 2 | 0 | 0 |
| `` opencodeConfig.config-parse.test.ts `` | 21 | 21 | 0 | 0 |
| `` opencodeConfig.entity-v2.test.ts `` | 15 | 15 | 0 | 0 |
| `` opencodeConfig.providers.test.ts `` | 19 | 19 | 0 | 0 |
| `` opencodeConfig.skills.test.js `` | 3 | 3 | 0 | 0 |
| `` opencodeConfigPaths.test.ts `` | 3 | 3 | 0 | 0 |
| `` opencodeServiceUrl.test.ts `` | 2 | 2 | 0 | 0 |
| `` opencodeVersion.test.ts `` | 3 | 3 | 0 | 0 |
| `` owned-process.test.ts `` | 4 | 4 | 0 | 0 |
| `` patchReconstruction.test.ts `` | 7 | 7 | 0 | 0 |
| `` pathUtils.test.ts `` | 3 | 3 | 0 | 0 |
| `` plugin-switches.test.ts `` | 9 | 9 | 0 | 0 |
| `` project-setup.test.ts `` | 17 | 17 | 0 | 0 |
| `` provider-env-aliases.parity.test.ts `` | 3 | 1 | 0 | 2 |
| `` quotaProviders.test.ts `` | 207 | 207 | 0 | 0 |
| `` sessionNotifications.test.ts `` | 5 | 5 | 0 | 0 |
| `` settings-files.test.ts `` | 19 | 19 | 0 | 0 |
| `` settings-registry-gate.test.ts `` | 8 | 8 | 0 | 0 |
| `` sseProxy.test.js `` | 2 | 2 | 0 | 0 |
| `` sseProxy.test.ts `` | 2 | 0 | 2 | 0 |
| `` viteConfig.test.ts `` | 1 | 0 | 1 | 0 |
| `` webviewHtml.test.ts `` | 2 | 0 | 2 | 0 |
| `` workingDirectoryChange.test.js `` | 3 | 3 | 0 | 0 |
| `` workspaceResolver.test.js `` | 6 | 6 | 0 | 0 |
| Total | 647 | 638 | 6 | 3 |

## Invariants no longer tested

- Preserving an already-set preferred Google key in the VS Code alias test.
- Returning an empty object for invalid alias input in the VS Code alias test.
- Excluding POST writes and non-allowlisted GETs from proxy coalescing in the removed combined test. That test never sent a POST.

## Still waits on real time

- `bridge-git-process-runtime.test.ts`:
  - `repeated read deadlines terminate the processes, not just the waiters`
  - `deactivation terminates outstanding Git work and rejects new launches`
- `bridge-proxy-runtime.test.ts`:
  - `aborts non-SSE api:proxy fetches by bridge request id`
  - `shares one upstream fetch across concurrent identical GET reads`
  - `keeps reads for different directories apart even when the URL is identical`
  - `keeps reads with different auth scopes apart`
- `gitService.remote-argument-hardening.test.js`:
  - `creates and reads a remote whose name looks like a git option during worktree creation`
  - `updates the URL of an existing option-like remote during worktree creation`
  - `creates a worktree from an option-like remote start ref`
- `gitService.worktree-bootstrap.test.js`:
  - `runs the project start command in a canonical new worktree`
  - `records a branch name nested under an existing branch as BRANCH_NAME_CONFLICT with the server sentence`
  - `creates through the project create command, adopts the checkout behind a symlink, and removes it while locked`
- `gitService.worktree-remove.test.js`:
  - `holds requests for the worktree folders from the release until the removal settles`
  - `releases the worktree instance again before retrying a busy removal`
- `gitService.worktree-upstream-tracking.test.js`:
  - `leaves branch tracking unset when the upstream ref cannot be fetched`
  - `sets branch tracking when the upstream ref can be fetched`
- `managed-opencode-process.test.ts`:
  - `managed <mode> reaps parent and SIGTERM-resistant descendant`, for timeout, malformed, abort, ready, and ready-stdio.
- `opencode-ready.test.ts`:
  - `does not hand out the URL until status is connected (pre-ready spawn window)`
  - `holds during a restart and resolves once reconnected`
  - `fails fast on error status instead of burning the timeout`
  - `falls back to whatever URL exists after the timeout`
- `owned-process.test.ts`:
  - `a child that honors the stdin lease exits on its own and is not killed`
  - `a child that ignores the lease is tree-killed once the grace runs out`
  - `without a lease the tree is killed at once`

These blocks were kept unchanged after red mutations. SSE watchdog tests now use the node:test fake-clock API in Bun and passed 20 consecutive individual-file runs.

## Per-block claims and mutation results

Mutation snippets show the exact edited expression or statement. Empty replacement text means the call was removed.

## SessionEditorPanelProvider.newSession.test.js

- Kept `` embeds the current workspace folder for automatic draft initialization `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` createOrShowNewSession ``. Red with `` this._openDraftPanel(t('New Session'), undefined, directory); `` -> `` ; ``.
- Kept `` opens the "Run on several models" tab with its draft in parallel mode `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` createOrShowParallelDraft ``. Red with `` this._openDraftPanel(t('Run on several models'), 'parallel', directory); `` -> `` ; ``.
- Kept `` embeds the selected directory for a new editor session `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` createOrShowNewSession ``. Red with `` this._openDraftPanel(t('New Session'), undefined, directory); `` -> `` ; ``.
- Kept `` opens a projectless draft when no workspace folder is open `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` createOrShowNewSession ``. Red with `` this._openDraftPanel(t('New Session'), undefined, directory); `` -> `` ; ``.
- Kept `` reveals one Settings tab, even without an open folder or resolved sidebar `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` showSettings ``. Red with `` existing `` -> `` !(existing) ``.
- Kept `` keeps the latest page target until the Settings root is ready `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` showSettings ``. Red with `` 'settings' `` -> `` '' ``.
- Kept `` keeps a quoted or HTML-like Settings directory as bootstrap data `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` showSettings ``. Red with `` existing `` -> `` !(existing) ``.
- Kept `` does not count Settings as an attended chat or send attachments there `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` showSettings ``. Red with `` existing `` -> `` !(existing) ``.
- Kept `` scopes the native shortcut to the focused sender and ignores a late peer blur `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` showSettings ``. Red with `` 'settings' `` -> `` '' ``.
- Kept `` broadcasts settings and connection changes to both editor surfaces `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` showSettings ``. Red with `` existing `` -> `` !(existing) ``.
- Kept `` closes only Settings and creates a fresh tab when reopened `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` showSettings ``. Red with `` existing `` -> `` !(existing) ``.
- Kept `` does not deliver an in-flight bridge reply to a closed Settings tab `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` showSettings ``. Red with `` existing `` -> `` !(existing) ``.
- Kept `` ignores a closed tab readiness message while its replacement is starting `` claims `` packages/vscode/src/SessionEditorPanelProvider.ts `` in `` showSettings ``. Red with `` 'settings' `` -> `` '' ``.

## activePanelRouting.test.ts

- Kept `` returns null when there are no panels and no recent panel `` claims `` packages/vscode/src/activePanelRouting.ts ``. Red with `` return active?.id ?? lastActivePanelId ?? null; `` -> `` return active?.id ?? lastActivePanelId ?? ''; ``.
- Kept `` falls back to the last active panel when none is currently focused `` claims `` packages/vscode/src/activePanelRouting.ts ``. Red with `` return active?.id ?? lastActivePanelId ?? null; `` -> `` return active?.id ?? null; ``.
- Kept `` prefers the currently focused panel over the last active one `` claims `` packages/vscode/src/activePanelRouting.ts ``. Red with `` return active?.id ?? lastActivePanelId ?? null; `` -> `` return lastActivePanelId ?? null; ``.
- Kept `` uses the focused panel even when there is no recorded last active panel `` claims `` packages/vscode/src/activePanelRouting.ts ``. Red with `` return active?.id ?? lastActivePanelId ?? null; `` -> `` return lastActivePanelId ?? null; ``.
- Kept `` returns the last active panel when no panel is focused `` claims `` packages/vscode/src/activePanelRouting.ts ``. Red with `` return active?.id ?? lastActivePanelId ?? null; `` -> `` return active?.id ?? null; ``.
- Kept `` returns null when nothing is focused and there is no recent panel `` claims `` packages/vscode/src/activePanelRouting.ts ``. Red with `` return active?.id ?? lastActivePanelId ?? null; `` -> `` return active?.id ?? lastActivePanelId ?? ''; ``.

## antigravityQuota.test.ts

- Kept `` identifies as the current Antigravity client and shows Gemini and Claude 5-hour and weekly limits `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchAntigravityQuota ``. Red with `` modelGroupWindows.push({       groupType,       windows,       bucket5h,       bucketWeekly,     }); `` -> `` ; ``.

## bridge-config-runtime.test.js

- Kept `` lists a config once and exposes paths for existing file discovery `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` entries: listPluginEntries(workingDirectory, listSwitchDirectory).map((entry) => ( `` -> `` entries: [].map((entry) => ( ``.
- Kept `` preserves runtime status through a symlinked config directory `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` files: listPluginDirFiles(workingDirectory, listSwitchDirectory).map((file) => ( `` -> `` files: [].map((file) => ( ``.
- Kept `` keeps custom relative targets when the global config is a symlink alias `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` entries: listPluginEntries(workingDirectory, listSwitchDirectory).map((entry) => ( `` -> `` entries: [].map((entry) => ( ``.
- Kept `` explicit config reload restarts OpenCode `` claims `` packages/vscode/src/bridge-config-runtime.ts `` in `` handleConfigBridgeMessage ``. Red with `` true `` -> `` false ``.
- Kept `` removes agent fields when update payload sends null `` claims `` packages/vscode/src/bridge-config-runtime.ts `` in `` handleConfigBridgeMessage ``. Red with `` !agentName `` -> `` !(!agentName) ``.
- Kept `` creates, lists, updates, and deletes project plugin entries `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` entries: listPluginEntries(workingDirectory, listSwitchDirectory).map((entry) => ( `` -> `` entries: [].map((entry) => ( ``.
- Kept `` creates and reads project plugin files `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` files: listPluginDirFiles(workingDirectory, listSwitchDirectory).map((file) => ( `` -> `` files: [].map((file) => ( ``.
- Kept `` updates and deletes user plugin entries from OPENCODE_CONFIG source `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` entries: listPluginEntries(workingDirectory, listSwitchDirectory).map((entry) => ( `` -> `` entries: [].map((entry) => ( ``.
- Kept `` lists the global config and plugins folder when OPENCODE_CONFIG names a missing file `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` entries: listPluginEntries(workingDirectory, listSwitchDirectory).map((entry) => ( `` -> `` entries: [].map((entry) => ( ``.
- Kept `` writes user plugin files to the global plugins folder when OPENCODE_CONFIG is set `` claims `` packages/vscode/src/bridge-config-runtime.ts `` in `` handleConfigBridgeMessage ``. Red with `` target === 'file' `` -> `` !(target === 'file') ``.
- Kept `` creates an MCP server under mcp.servers without restarting OpenCode `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` const created = createMcpConfig(mcpName, (body \|\| {}) as Record<string, unknown>, workingDirectory, scope); `` -> `` const created = {}; ``.
- Kept `` answers an unknown source with an error `` claims `` packages/vscode/src/skillsCatalog.ts ``. Red with `` return { ok: false, error: { kind: 'invalidSource', message: 'Unknown source' } }; `` -> `` return { ok: true, items: [] }; ``.
- Kept `` switches an entry off in its own store and reports it in the list `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` entries: listPluginEntries(workingDirectory, listSwitchDirectory).map((entry) => ( `` -> `` entries: [].map((entry) => ( ``.
- Kept `` keeps the saved switch and asks for a restart when the managed layer cannot be rewritten `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` entries: listPluginEntries(workingDirectory, listSwitchDirectory).map((entry) => ( `` -> `` entries: [].map((entry) => ( ``.
- Kept `` reports a plugin a config allow keeps loading and refuses to switch it off `` claims `` packages/vscode/src/bridge-config-runtime.ts ``. Red with `` entries: listPluginEntries(workingDirectory, listSwitchDirectory).map((entry) => ( `` -> `` entries: [].map((entry) => ( ``.
- Kept `` refuses a switch when the extension connects to an external OpenCode `` claims `` packages/vscode/src/bridge-config-runtime.ts `` in `` handleConfigBridgeMessage ``. Red with `` !switchAvailable \|\| !switchDirectory \|\| !manager `` -> `` !(!switchAvailable \|\| !switchDirectory \|\| !manager) ``.
- Kept `` hands the parsed request to the host and returns its status and body `` claims `` packages/vscode/src/bridge-config-runtime.ts `` in `` handleConfigBridgeMessage ``. Red with `` true `` -> `` false ``.

## bridge-fs-helpers-runtime.test.ts

- Rewritten `` `${label} query searches stop on inspected files, not the old candidate cap` `` claims `` packages/vscode/src/bridge-fs-helpers-runtime.ts ``. Red with `` const FILE_SEARCH_MAX_VISITED_FILES = 10_000; `` -> `` const FILE_SEARCH_MAX_VISITED_FILES = 200; ``. Rewrite moved to `` packages/vscode/src/bridge-fs-search.test.js ``.

## bridge-fs-runtime.test.js

- Kept `` returns an existing Chats root and its filesystem identity `` claims `` packages/vscode/src/bridge-fs-runtime.ts `` in `` handleFsBridgeMessage ``. Red with `` canonicalChatsRoot `` -> `` !(canonicalChatsRoot) ``.
- Kept `` reads home without creating a missing Chats root `` claims `` packages/vscode/src/bridge-fs-runtime.ts `` in `` handleFsBridgeMessage ``. Red with `` true `` -> `` false ``.
- Kept `` keeps home readable when only Chat allocation is blocked `` claims `` packages/vscode/src/bridge-fs-runtime.ts `` in `` handleFsBridgeMessage ``. Red with `` true `` -> `` false ``.

## bridge-fs-search.test.js

- Kept `` respects ignored Unicode and whitespace names when hidden files are included `` claims `` packages/vscode/src/bridge-fs-helpers-runtime.ts `` in `` searchDirectory ``. Red with `` directory `` -> `` !(directory) ``.
- Kept `` a stopped walk rejects and reads no more of the tree `` claims `` packages/vscode/src/bridge-fs-helpers-runtime.ts `` in `` searchDirectory ``. Red with `` includeHidden \|\| !respectGitignore `` -> `` !(includeHidden \|\| !respectGitignore) ``.
- Kept `` includes ignored build files and honors the hidden flag with real filesystem entries `` claims `` packages/vscode/src/bridge-fs-helpers-runtime.ts `` in `` searchDirectory ``. Red with `` directory `` -> `` !(directory) ``.

## bridge-git-generation-model.test.ts

- Kept `` request payload model wins when it is in the catalog `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` small-model override is honoured when present in the catalog `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` override model ids may contain slashes; only the first splits provider from model `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` the selected thinking variant travels with the small-model override `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` a variant the catalog lists for the model is kept `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` a variant the catalog knows the model does not list is dropped `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` a title-agent variant is carried and validated the same way `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` override is ignored when smallModelUseDefault is not false `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` override is ignored when it is not in the catalog or malformed `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` the removed gitProviderId/gitModelId pair is no longer read `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` zen fallback prefers the request zen model, then settings, then the default `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` a configured title-agent model wins over the zen fallback when it is in the catalog `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` the request model and the small-model override outrank the title-agent model `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.
- Kept `` a title-agent model missing from the catalog falls back to zen `` claims `` packages/vscode/src/bridge-git-generation-model.ts `` in `` chooseBridgeGitGenerationModel ``. Red with `` typeof payloadModel.providerId === 'string' `` -> `` !(typeof payloadModel.providerId === 'string') ``.

## bridge-git-process-runtime.test.ts

- Kept `` a Git process terminated by a signal is never reported as successful `` claims `` packages/vscode/src/bridge-git-process-runtime.ts ``. Red with `` exitCode: exit.code ?? 1 `` -> `` exitCode: exit.code ?? 0 ``.
- Kept `` repeated read deadlines terminate the processes, not just the waiters `` claims `` packages/vscode/src/bridge-git-process-runtime.ts ``. Red with `` if (timedOut) return { stdout, stderr: `Git command timed out after ${options.timeoutMs}ms`, exitCode: 1 }; `` -> `` if (timedOut) return { stdout, stderr: `Git command timed out after ${options.timeoutMs}ms`, exitCode: 0 }; ``.
- Kept `` drains verbose stderr and sends EOF to non-interactive command stdin `` claims `` packages/vscode/src/bridge-git-process-runtime.ts ``. Red with `` process.child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); }); `` -> `` process.child.stderr.on('data', () => {}); ``.
- Kept `` sends NUL-delimited Unicode input and closes stdin `` claims `` packages/vscode/src/bridge-git-process-runtime.ts ``. Red with `` { cwd, env, input: options.input } `` -> `` { cwd, env, input: undefined } ``.
- Kept `` deactivation terminates outstanding Git work and rejects new launches `` claims `` packages/vscode/src/bridge-git-process-runtime.ts ``. Red with `` if (shutdown) return { stdout: '', stderr: 'Git runtime is shutting down', exitCode: 1 }; `` -> `` if (shutdown) return { stdout: '', stderr: 'Git runtime is shutting down', exitCode: 0 }; ``.

## bridge-git-runtime.test.js

- Kept `` answers where the directory sits inside its checkout `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` true `` -> `` false ``.
- Kept `` rejects a request without a directory before reaching git `` claims `` packages/vscode/src/bridge-git-runtime.ts ``. Red with ``       if (dirError) return dirError;       const result = await gitService.resolveRepositoryPrefix(directory!); `` -> ``       const result = await gitService.resolveRepositoryPrefix(directory!); ``.
- Kept `` accepts legacy stage path payloads `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` !directory \|\| filePaths.length === 0 `` -> `` !(!directory \|\| filePaths.length === 0) ``.
- Kept `` accepts bulk stage paths payloads `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` !directory \|\| filePaths.length === 0 `` -> `` !(!directory \|\| filePaths.length === 0) ``.
- Kept `` accepts legacy unstage path payloads `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` !directory \|\| filePaths.length === 0 `` -> `` !(!directory \|\| filePaths.length === 0) ``.
- Kept `` accepts bulk unstage paths payloads `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` !directory \|\| filePaths.length === 0 `` -> `` !(!directory \|\| filePaths.length === 0) ``.
- Kept `` rejects invalid path payloads `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` !directory \|\| filePaths.length === 0 `` -> `` !(!directory \|\| filePaths.length === 0) ``.
- Kept `` preserves bootstrap phases in status responses `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` true `` -> `` false ``.
- Kept `` passes a branch name conflict and its sentence through the status response `` claims `` packages/vscode/src/bridge-git-runtime.ts ``. Red with `` const result = await gitService.getWorktreeBootstrapStatus(directory!); `` -> `` const result = { ...(await gitService.getWorktreeBootstrapStatus(directory!)), errorCode: undefined }; ``.
- Kept `` preserves the directory-created phase in fast create responses `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` true `` -> `` false ``.
- Kept `` disposes the removed worktree instance through the active runtime on DELETE `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` typeof removePayload?.body?.directory === 'string' `` -> `` !(typeof removePayload?.body?.directory === 'string') ``.
- Kept `` evicts every running location inside the removed worktree, such as a project folder `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` !worktreeDirectory `` -> `` !(!worktreeDirectory) ``.
- Kept `` still evicts the worktree root when the location list cannot be read, and reports the failure `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` !worktreeDirectory `` -> `` !(!worktreeDirectory) ``.
- Kept `` fails disposal when the managed runtime has no API URL `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` !worktreeDirectory `` -> `` !(!worktreeDirectory) ``.

## bridge-git-special-runtime.test.js

- Kept `` generates a commit message for the changed files through the OpenCode generate route `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` reads the prompts of the directory it commits in and uses an empty instructions override as written `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` uses the title agent model and its thinking variant when no request or override model is set `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` skips a title agent model OpenCode lists as disabled, like the server resolver `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` skips a saved free zen small model without a login, like the server resolver `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` keeps the configured small model when the catalog is not readable yet `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` carries the small-model thinking variant into generation `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` keeps the configured small model when the catalog comes back empty `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` keeps the configured small model when a partial catalog omits it `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` scopes the catalog, agent, and generate reads to the flow directory `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` reads the model catalog again when the flow directory changes `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` reports the failure when generation fails `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` retries with backoff until the model appears `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.
- Kept `` gives up once the backoff runs out and never retries other errors `` claims `` packages/vscode/src/bridge-git-special-runtime.ts `` in `` generateBridgeCommitMessage ``. Red with `` selectedFiles.length === 0 `` -> `` !(selectedFiles.length === 0) ``.

## bridge-localfs-proxy-runtime.test.js

- Kept `` rejects existing files outside the workspace, including a sibling with the same prefix `` claims `` packages/vscode/src/bridge-localfs-proxy-runtime.ts `` in `` tryHandleLocalFsProxy ``. Red with `` /^\/api\/openchamber\/sessions\/[^/]+\/markdown-image-grants$/.test(parsed.pathname) `` -> `` !(/^\/api\/openchamber\/sessions\/[^/]+\/markdown-image-grants$/.test(parsed.pathname)) ``.
- Kept `` does not forward server-owned Markdown image grant routes to OpenCode `` claims `` packages/vscode/src/bridge-localfs-proxy-runtime.ts `` in `` tryHandleLocalFsProxy ``. Red with `` /^\/api\/openchamber\/sessions\/[^/]+\/markdown-image-grants$/.test(parsed.pathname) `` -> `` !(/^\/api\/openchamber\/sessions\/[^/]+\/markdown-image-grants$/.test(parsed.pathname)) ``.
- Kept `` returns a quiet optional stat miss for missing files `` claims `` packages/vscode/src/bridge-localfs-proxy-runtime.ts `` in `` tryHandleLocalFsProxy ``. Red with `` 200 `` -> `` 201 ``.
- Kept `` keeps regular stat miss behavior without optional flag `` claims `` packages/vscode/src/bridge-localfs-proxy-runtime.ts `` in `` tryHandleLocalFsProxy ``. Red with `` /^\/api\/openchamber\/sessions\/[^/]+\/markdown-image-grants$/.test(parsed.pathname) `` -> `` !(/^\/api\/openchamber\/sessions\/[^/]+\/markdown-image-grants$/.test(parsed.pathname)) ``.
- Kept `` does not forward directory availability probes to OpenCode `` claims `` packages/vscode/src/bridge-localfs-proxy-runtime.ts `` in `` tryHandleLocalFsProxy ``. Red with `` parsed.pathname === '/api/fs/directory-stat' \|\| parsed.pathname === '/api/fs/directory-stats' `` -> `` !(parsed.pathname === '/api/fs/directory-stat' \|\| parsed.pathname === '/api/fs/directory-stats') ``.
- Kept `` reads from the active directory when it is the second workspace root `` claims `` packages/vscode/src/bridge-localfs-proxy-runtime.ts `` in `` tryHandleLocalFsProxy ``. Red with `` /^\/api\/openchamber\/sessions\/[^/]+\/markdown-image-grants$/.test(parsed.pathname) `` -> `` !(/^\/api\/openchamber\/sessions\/[^/]+\/markdown-image-grants$/.test(parsed.pathname)) ``.

## bridge-permission-auto-accept-runtime.test.ts

- Kept `` persists policy and broadcasts the authoritative snapshot `` claims `` packages/vscode/src/bridge-permission-auto-accept-runtime.ts `` in `` handlePermissionAutoAcceptBridgeMessage ``. Red with `` true `` -> `` false ``.
- Kept `` serializes concurrent writes without losing policy entries `` claims `` packages/vscode/src/bridge-permission-auto-accept-runtime.ts `` in `` handlePermissionAutoAcceptBridgeMessage ``. Red with `` message.type !== 'api:permission-auto-accept:get' && message.type !== 'api:permission-auto-accept:set' `` -> `` !(message.type !== 'api:permission-auto-accept:get' && message.type !== 'api:permission-auto-accept:set') ``.
- Kept `` rejects malformed policy writes `` claims `` packages/vscode/src/bridge-permission-auto-accept-runtime.ts `` in `` handlePermissionAutoAcceptBridgeMessage ``. Red with `` false `` -> `` true ``.

## bridge-proxy-runtime.test.js

- Kept `` does not buffer SSE endpoints through the generic API proxy `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` 400 `` -> `` 401 ``.
- Kept `` never hands the stored credential list to the webview `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` 'credential_list_refused' `` -> `` '' ``.
- Kept `` refuses a path that would resolve outside OpenCode `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` resolvedPath === null `` -> `` !(resolvedPath === null) ``.
- Kept `` in enterprise mode refuses connecting a provider but forwards an MCP server sign-in `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` resolvedPath === null `` -> `` !(resolvedPath === null) ``.

## bridge-proxy-runtime.test.ts

- Kept `` aborts non-SSE api:proxy fetches by bridge request id `` claims `` packages/vscode/src/bridge-proxy-runtime.ts ``. Red with ``       const coalesceKey =         normalizedMethod === 'GET' && COALESCE_READ_PATH.test(normalizedPath) `` -> ``       const coalesceKey = normalizedMethod === 'POST' ? buildReadCoalesceKey(targetUrl, requestHeaders) :         normalizedMethod === 'GET' && COALESCE_READ_PATH.test(normalizedPath) ``.
- Kept `` shares one upstream fetch across concurrent identical GET reads `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` requestPath.trim().startsWith('/') `` -> `` !(requestPath.trim().startsWith('/')) ``.
- Kept `` keeps reads for different directories apart even when the URL is identical `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` deps.openCodeTrust && requestUrl.pathname === OPENCODE_TRUST_ROUTE `` -> `` !(deps.openCodeTrust && requestUrl.pathname === OPENCODE_TRUST_ROUTE) ``.
- Kept `` keeps reads with different auth scopes apart `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` deps.openCodeTrust && requestUrl.pathname === OPENCODE_TRUST_ROUTE `` -> `` !(deps.openCodeTrust && requestUrl.pathname === OPENCODE_TRUST_ROUTE) ``.
- Deleted `` does not coalesce POST writes or non-allowlisted reads `` claims packages/vscode/src/bridge-proxy-runtime.ts. Both mutations left this test green: `` normalizedMethod === 'GET' && COALESCE_READ_PATH.test(normalizedPath) `` -> `` COALESCE_READ_PATH.test(normalizedPath) ``; ``       const coalesceKey =         normalizedMethod === 'GET' && COALESCE_READ_PATH.test(normalizedPath) `` -> ``       const coalesceKey = normalizedMethod === 'POST' ? buildReadCoalesceKey(targetUrl, requestHeaders) :         normalizedMethod === 'GET' && COALESCE_READ_PATH.test(normalizedPath) ``. Other blocks in the file may fail.
- Kept `` refuses to initialize Git in the home directory without reaching OpenCode `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` 400 `` -> `` 401 ``.
- Kept `` forwards Git initialization for a project directory `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` deps.openCodeTrust && requestUrl.pathname === OPENCODE_TRUST_ROUTE `` -> `` !(deps.openCodeTrust && requestUrl.pathname === OPENCODE_TRUST_ROUTE) ``.
- Kept `` holds a request for a folder of the worktree being removed until the removal settles `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` await holdForWorktreeRemoval(         directoriesAsOpenCodeReadsThem(resolvedPath, normalizeHeaderKeys(headers)),         deps.waitForWorktreeRemoval,       ); `` -> `` ; ``.
- Kept `` refuses an untrusted folder before OpenCode sees it and answers the trust route itself `` claims `` packages/vscode/src/bridge-proxy-runtime.ts `` in `` handleProxyBridgeMessage ``. Red with `` deps.openCodeTrust && requestUrl.pathname === OPENCODE_TRUST_ROUTE `` -> `` !(deps.openCodeTrust && requestUrl.pathname === OPENCODE_TRUST_ROUTE) ``.
- Kept `` checks the folder a session moves into `` claims `` packages/vscode/src/bridge-proxy-runtime.ts ``. Red with ``       const coalesceKey =         normalizedMethod === 'GET' && COALESCE_READ_PATH.test(normalizedPath) `` -> ``       const coalesceKey = normalizedMethod === 'POST' ? buildReadCoalesceKey(targetUrl, requestHeaders) :         normalizedMethod === 'GET' && COALESCE_READ_PATH.test(normalizedPath) ``.

## bridge-settings-runtime.test.js

- Kept `` reads the v2 `path` field, keeps the v1 `location` fallback, and drops unlocated items `` claims `` packages/vscode/src/bridge-settings-runtime.ts `` in `` fetchOpenCodeSkillsFromApi ``. Red with `` typeof item?.path === 'string' `` -> `` !(typeof item?.path === 'string') ``.
- Kept `` returns null when the API responds with an error or a non-list payload `` claims `` packages/vscode/src/bridge-settings-runtime.ts ``. Red with ``     if (!response.ok) {       return null; `` -> ``     if (!response.ok) {       return []; ``.
- Kept `` returns null when the context exposes no API url `` claims `` packages/vscode/src/bridge-settings-runtime.ts ``. Red with ``   if (!apiUrl) {     return null; `` -> ``   if (!apiUrl) {     return []; ``.

## bridge-small-model-runtime.test.ts

- Kept `` lists every provider with an enabled model, in OpenCode order `` claims `` packages/vscode/src/bridge-small-model-runtime.ts `` in `` listAuthenticatedProviders ``. Red with `` model.enabled === false \|\| isAnonymousZenModel(model) `` -> `` !(model.enabled === false \|\| isAnonymousZenModel(model)) ``.
- Kept `` leaves out zen without a login and lists it with a real credential `` claims `` packages/vscode/src/bridge-small-model-runtime.ts `` in `` listAuthenticatedProviders ``. Red with `` model.enabled === false \|\| isAnonymousZenModel(model) `` -> `` !(model.enabled === false \|\| isAnonymousZenModel(model)) ``.
- Kept `` reads the project directory with the OpenCode credentials `` claims `` packages/vscode/src/bridge-small-model-runtime.ts `` in `` readOpenCodeSmallModelCatalog ``. Red with `` directory `` -> `` !(directory) ``.
- Kept `` without a directory the reads carry no directory header `` claims `` packages/vscode/src/bridge-small-model-runtime.ts `` in `` readOpenCodeSmallModelCatalog ``. Red with `` directory `` -> `` !(directory) ``.
- Kept `` a failed read is an error, never an empty provider list `` claims `` packages/vscode/src/bridge-small-model-runtime.ts `` in `` handleSmallModelBridgeMessage ``. Red with `` false `` -> `` true ``.
- Kept `` without a running OpenCode the read fails `` claims `` packages/vscode/src/bridge-small-model-runtime.ts `` in `` readOpenCodeSmallModelCatalog ``. Red with `` !apiUrl `` -> `` !(!apiUrl) ``.
- Kept `` other message types are left to the next handler `` claims `` packages/vscode/src/bridge-small-model-runtime.ts `` in `` handleSmallModelBridgeMessage ``. Red with `` type !== 'api:small-model:get' `` -> `` !(type !== 'api:small-model:get') ``.

## bridge-system-runtime.test.js

- Kept `` uses vscode.open so VS Code can select the notebook editor `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), options); `` -> `` ; ``.
- Kept `` preserves line and column selection for regular files `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), options); `` -> `` ; ``.
- Kept `` refuses untrusted OpenCode configuration before changing workspace folders `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` !(await openCodeTrust.assess(uri.fsPath, { fresh: true })).trusted `` -> `` !(!(await openCodeTrust.assess(uri.fsPath, { fresh: true })).trusted) ``.
- Kept `` adds a folder to the workspace and returns the folder list `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` !(await openCodeTrust.assess(uri.fsPath, { fresh: true })).trusted `` -> `` !(!(await openCodeTrust.assess(uri.fsPath, { fresh: true })).trusted) ``.
- Kept `` does not duplicate an already-open workspace folder `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` !alreadyAdded `` -> `` !(!alreadyAdded) ``.
- Kept `` returns an error when VS Code rejects the folder add `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` 'Failed to add workspace folder' `` -> `` '' ``.
- Kept `` dedupes an already-open folder with a lowercase Windows drive letter `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` !alreadyAdded `` -> `` !(!alreadyAdded) ``.
- Kept `` rejects a missing path `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` 'Directory path is required' `` -> `` '' ``.
- Kept `` activates a gift reset through the quota provider `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` await activateQuotaGiftReset(providerId, { recordId, resetType, grantType }); `` -> `` ; ``.
- Kept `` passes the record grantType through unchanged `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` await activateQuotaGiftReset(providerId, { recordId, resetType, grantType }); `` -> `` ; ``.
- Kept `` keeps an omitted grantType omitted `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` await activateQuotaGiftReset(providerId, { recordId, resetType, grantType }); `` -> `` ; ``.
- Kept `` rejects a payload without a recordId `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` !providerId \|\| recordId === undefined \|\| !Number.isFinite(recordId) \|\| !resetType `` -> `` !(!providerId \|\| recordId === undefined \|\| !Number.isFinite(recordId) \|\| !resetType) ``.
- Kept `` returns the provider failure as a bridge error `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` await activateQuotaGiftReset(providerId, { recordId, resetType, grantType }); `` -> `` ; ``.
- Kept `` waits for the manager to finish installing and restarting `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` !ctx?.manager `` -> `` !(!ctx?.manager) ``.
- Kept `` does not claim success without a manager or after installation failure `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` !ctx?.manager `` -> `` !(!ctx?.manager) ``.
- Kept `` reports a failed write `` claims `` packages/vscode/src/bridge-system-runtime.ts `` in `` handleSystemBridgeMessage ``. Red with `` false `` -> `` true ``.

## exeDevQuota.test.ts

- Kept `` parses monthly credit usage `` claims `` packages/vscode/src/exeDevQuota.ts `` in `` parseExeDevUsage ``. Red with `` totalCost === null \|\| monthlyAllowance === null \|\| monthlyAllowance < 0 \|\| !Number.isFinite(resetAt) `` -> `` !(totalCost === null \|\| monthlyAllowance === null \|\| monthlyAllowance < 0 \|\| !Number.isFinite(resetAt)) ``.
- Kept `` executes only the billing usage command `` claims `` packages/vscode/src/exeDevQuota.ts `` in `` parseExeDevUsage ``. Red with `` totalCost === null \|\| monthlyAllowance === null \|\| monthlyAllowance < 0 \|\| !Number.isFinite(resetAt) `` -> `` !(totalCost === null \|\| monthlyAllowance === null \|\| monthlyAllowance < 0 \|\| !Number.isFinite(resetAt)) ``.

## git-commit-message.test.ts

- Kept `` uses staged paths when any exist, otherwise unstaged and untracked `` claims `` packages/vscode/src/git-commit-message.ts `` in `` commitPathUsesStagedDiff ``. Red with `` && `` -> `` \|\| ``.
- Kept `` formats a subject and optional highlight body for the SCM input `` claims `` packages/vscode/src/git-commit-message.ts `` in `` formatCommitMessageForScm ``. Red with `` highlights.length === 0 `` -> `` !(highlights.length === 0) ``.
- Kept `` parses structured commit JSON and rejects empty output `` claims `` packages/vscode/src/git-commit-message.ts `` in `` parseGeneratedCommitMessage ``. Red with `` start < 0 `` -> `` !(start < 0) ``.

## gitPathDiff.test.ts

- Kept `` a status path that no longer exists is unavailable, while a deleted tracked file still diffs `` claims `` packages/vscode/src/gitPathDiff.ts `` in `` resolveGitPathTarget ``. Red with `` 'file' `` -> `` '' ``.
- Kept `` a nested repository listed as a directory is unavailable `` claims `` packages/vscode/src/gitPathDiff.ts `` in `` resolveGitPathTarget ``. Red with `` 'nested_repository' `` -> `` '' ``.
- Kept `` a submodule with only untracked files reports them although its patch is empty `` claims `` packages/vscode/src/gitPathDiff.ts `` in `` resolveGitPathTarget ``. Red with `` 'submodule' `` -> `` '' ``.
- Kept `` a submodule in a merge conflict reports the conflict instead of an unchanged commit `` claims `` packages/vscode/src/gitPathDiff.ts `` in `` resolveGitPathTarget ``. Red with `` 'submodule' `` -> `` '' ``.

## gitRemoteListing.test.ts

- Kept `` parses fetch and push URLs per remote `` claims `` packages/vscode/src/gitRemoteListing.ts `` in `` parseGitRemoteListing ``. Red with `` kind === 'fetch' `` -> `` !(kind === 'fetch') ``.
- Kept `` reads CRLF output as Git for Windows may print it, URLs with spaces included `` claims `` packages/vscode/src/gitRemoteListing.ts `` in `` parseGitRemoteListing ``. Red with `` kind === 'fetch' `` -> `` !(kind === 'fetch') ``.
- Kept `` ignores decoration after the listing kind, recognized or not (#4479) `` claims `` packages/vscode/src/gitRemoteListing.ts `` in `` parseGitRemoteListing ``. Red with `` !match `` -> `` !(!match) ``.
- Kept `` reports URLs as `git remote get-url [--push]` does when lines are missing or repeated `` claims `` packages/vscode/src/gitRemoteListing.ts `` in `` parseGitRemoteListing ``. Red with `` kind === 'fetch' `` -> `` !(kind === 'fetch') ``.
- Kept `` reads a partial-clone remote as `git remote get-url` reports it `` claims `` packages/vscode/src/gitRemoteListing.ts `` in `` parseGitRemoteListing ``. Red with `` !match `` -> `` !(!match) ``.

## gitService.bare-repository.test.js

- Kept `` treats a bare repository as a git repository and lists its linked worktrees `` claims `` packages/vscode/src/gitService.ts `` in `` checkIsGitRepository ``. Red with `` !fs.existsSync(normalizePath(directory)) `` -> `` !(!fs.existsSync(normalizePath(directory))) ``.
- Kept `` keeps non-repository directories and plain checkouts answering as before `` claims `` packages/vscode/src/gitService.ts `` in `` checkIsGitRepository ``. Red with `` false `` -> `` true ``.
- Kept `` reports a repository Git refuses in Git's words instead of as no repository `` claims `` packages/vscode/src/gitService.ts `` in `` checkIsGitRepository ``. Red with `` false `` -> `` true ``.

## gitService.remote-argument-hardening.test.js

- Kept `` creates and reads a remote whose name looks like a git option during worktree creation `` claims `` packages/vscode/src/gitService.ts `` in `` prepareWorktreeCreateSource ``. Red with `` ensureRemoteName && ensureRemoteUrl `` -> `` !(ensureRemoteName && ensureRemoteUrl) ``.
- Kept `` updates the URL of an existing option-like remote during worktree creation `` claims `` packages/vscode/src/gitService.ts `` in `` prepareWorktreeCreateSource ``. Red with `` ensureRemoteName && ensureRemoteUrl `` -> `` !(ensureRemoteName && ensureRemoteUrl) ``.
- Kept `` validates a start ref and upstream on an option-like remote `` claims `` packages/vscode/src/gitService.ts `` in `` parseRemoteBranchRef ``. Red with `` trimmed.startsWith('refs/remotes/') `` -> `` !(trimmed.startsWith('refs/remotes/')) ``.
- Kept `` creates a worktree from an option-like remote start ref `` claims `` packages/vscode/src/gitService.ts `` in `` attachGitWorktreeToCandidate ``. Red with `` queueWorktreeBootstrap({     directory: candidate.directory,     projectDirectory: context.requestedDirectory,     primaryWorktree: context.primaryWorktree,     localBranch,     setUpstream: shouldSetUpstream,     upstreamRemote,     upstreamBranch,     ensureRemoteName,     ensureRemoteUrl,     startCommand: input?.startCommand,     populated: Boolean(createCommand),   }); `` -> `` ; ``.
- Kept `` does not interpret an option-like ensureRemoteUrl as a git option when validating `` claims `` packages/vscode/src/gitService.ts ``. Red with `` ['ls-remote', '--heads', '--', ensureRemoteUrl, `refs/heads/${parsedExistingRemote.branch}`] `` -> `` ['ls-remote', '--heads', ensureRemoteUrl, `refs/heads/${parsedExistingRemote.branch}`] ``.
- Kept `` removes a remote whose name looks like a git option `` claims `` packages/vscode/src/gitService.ts `` in `` removeRemote ``. Red with `` !remoteName `` -> `` !(!remoteName) ``.
- Kept `` deletes a branch on an option-like remote instead of reading it as an option `` claims `` packages/vscode/src/gitService.ts `` in `` deleteRemoteBranch ``. Red with `` head.exitCode !== 0 `` -> `` !(head.exitCode !== 0) ``.
- Kept `` refuses to delete the default branch of the remote `` claims `` packages/vscode/src/gitService.ts `` in `` deleteRemoteBranch ``. Red with `` head.exitCode !== 0 `` -> `` !(head.exitCode !== 0) ``.

## gitService.repository-prefix.test.js

- Kept `` reports where a directory sits inside its checkout, and nothing at the root `` claims `` packages/vscode/src/gitService.ts `` in `` resolveRepositoryPrefix ``. Red with `` !directoryPath `` -> `` !(!directoryPath) ``.
- Kept `` rejects instead of answering "at the root" outside a repository `` claims `` packages/vscode/src/gitService.ts `` in `` resolveRepositoryPrefix ``. Red with `` !result.success `` -> `` !(!result.success) ``.

## gitService.status-rename.test.js

- Kept `` in the raw-status fallback, including names Git would quote `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` true `` -> `` false ``.
- Kept `` through the VS Code Git API `` claims `` packages/vscode/src/bridge-git-runtime.ts `` in `` handleStandardGitBridgeMessage ``. Red with `` true `` -> `` false ``.

## gitService.worktree-bootstrap.test.js

- Kept `` treats missing bootstrap state as fully ready `` claims `` packages/vscode/src/gitService.ts `` in `` getWorktreeBootstrapStatus ``. Red with `` !key `` -> `` !(!key) ``.
- Kept `` runs the project start command in a canonical new worktree `` claims `` packages/vscode/src/gitService.ts `` in `` getWorktreeBootstrapStatus ``. Red with `` !key `` -> `` !(!key) ``.
- Kept `` records a branch name nested under an existing branch as BRANCH_NAME_CONFLICT with the server sentence `` claims `` packages/vscode/src/gitService.ts `` in `` getWorktreeBootstrapStatus ``. Red with `` !key `` -> `` !(!key) ``.
- Kept `` creates through the project create command, adopts the checkout behind a symlink, and removes it while locked `` claims `` packages/vscode/src/gitService.ts `` in `` getWorktreeBootstrapStatus ``. Red with `` !key `` -> `` !(!key) ``.
- Kept `` drops the branch it made when the create command fails `` claims `` packages/vscode/src/gitService.ts `` in `` attachGitWorktreeToCandidate ``. Red with `` error instanceof WorktreeCreateCommandError && error.branchMade && !(await findBranchInUse(context.primaryWorktree, localBranch)) `` -> `` !(error instanceof WorktreeCreateCommandError && error.branchMade && !(await findBranchInUse(context.primaryWorktree, localBranch))) ``.

## gitService.worktree-config.test.js

- Kept `` previews and creates in the inherited folder, including from a linked checkout `` claims `` packages/vscode/src/gitService.ts `` in `` primaryWorktreeRootFromGitDir ``. Red with `` gitDir.replace(/\\/g, '/').endsWith('/.git') `` -> `` !(gitDir.replace(/\\/g, '/').endsWith('/.git')) ``.
- Kept `` refuses creation when the inherited config is invalid `` claims `` packages/vscode/src/gitService.ts `` in `` resolveWorktreeProjectContext ``. Red with `` !tolerateWorktreeRootConfigError `` -> `` !(!tolerateWorktreeRootConfigError) ``.

## gitService.worktree-fetch-fallback.test.js

- Kept `` falls back to the tracked local branch when the source fetch fails `` claims `` packages/vscode/src/gitService.ts `` in `` prepareWorktreeCreateSource ``. Red with `` await fetchRemoteBranchRef(context.primaryWorktree, remoteStartRef.remote, remoteStartRef.branch); `` -> `` ; ``.
- Kept `` rejects creation when the remote start ref was never fetched and cannot be fetched `` claims `` packages/vscode/src/gitService.ts `` in `` prepareWorktreeCreateSource ``. Red with `` await fetchRemoteBranchRef(context.primaryWorktree, remoteStartRef.remote, remoteStartRef.branch); `` -> `` ; ``.
- Kept `` starts a local base with nothing unpublished from its freshly fetched upstream `` claims `` packages/vscode/src/gitService.ts `` in `` preparePublishedLocalBranchSource ``. Red with `` await fetchRemoteBranchRef(primaryWorktree, upstream.remote, upstream.branch); `` -> `` ; ``.

## gitService.worktree-remove.test.js

- Kept `` disposes the registered worktree instance before git removes the directory `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` runs the teardown command in the worktree first, and keeps the worktree when it fails `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` runs a teardown alone without removing anything, and reports a failure with its code `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` never runs a teardown in a contributor fork, and removes it `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` runs the teardown of a checkout the store does not list as a fork `` claims `` packages/vscode/src/gitService.ts `` in `` teardownWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` runs nothing and keeps the worktree when the store cannot be read `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` holds requests for the worktree folders from the release until the removal settles `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` releases the worktree instance again before retrying a busy removal `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` warns about a failed instance disposal and still removes the worktree `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` keeps a branch another checkout holds and still removes the worktree `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` keeps the branch a remote names as its default `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` never disposes the primary workspace `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.
- Kept `` does not dispose for a path that is not a registered linked worktree `` claims `` packages/vscode/src/gitService.ts `` in `` removeWorktree ``. Red with `` !targetDirectory `` -> `` !(!targetDirectory) ``.

## gitService.worktree-upstream-tracking.test.js

- Kept `` leaves branch tracking unset when the upstream ref cannot be fetched `` claims `` packages/vscode/src/gitService.ts `` in `` attachGitWorktreeToCandidate ``. Red with `` queueWorktreeBootstrap({     directory: candidate.directory,     projectDirectory: context.requestedDirectory,     primaryWorktree: context.primaryWorktree,     localBranch,     setUpstream: shouldSetUpstream,     upstreamRemote,     upstreamBranch,     ensureRemoteName,     ensureRemoteUrl,     startCommand: input?.startCommand,     populated: Boolean(createCommand),   }); `` -> `` ; ``.
- Kept `` sets branch tracking when the upstream ref can be fetched `` claims `` packages/vscode/src/gitService.ts `` in `` normalizeUpstreamTarget ``. Red with `` !remoteName \|\| !branchName `` -> `` !(!remoteName \|\| !branchName) ``.

## googleQuota.test.ts

- Kept `` `uses Gemini once for ${refresh.includes('\|') ? 'packed' : 'plain'} refresh tokens` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchGoogleQuota ``. Red with `` !source.refreshToken `` -> `` !(!source.refreshToken) ``.
- Kept `` `tries Antigravity after Gemini returns ${status} unauthorized_client` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchGoogleQuota ``. Red with `` !source.refreshToken `` -> `` !(!source.refreshToken) ``.
- Kept `` `does not try another client or quota request after ${failure.name}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchGoogleQuota ``. Red with `` !source.refreshToken `` -> `` !(!source.refreshToken) ``.
- Kept `` returns a redacted configured failure when the alternate client fails `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchGoogleQuota ``. Red with `` !source.refreshToken `` -> `` !(!source.refreshToken) ``.
- Kept `` uses a valid access token without refreshing `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchGoogleQuota ``. Red with `` !accessToken \|\| (typeof source.expires === 'number' && source.expires <= now) `` -> `` !(!accessToken \|\| (typeof source.expires === 'number' && source.expires <= now)) ``.

## inlineCommentSelection.test.ts

- Kept `` a caret with no selection covers its own line `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` selectionLineRange ``. Red with `` stopsAtLineStart `` -> `` !(stopsAtLineStart) ``.
- Kept `` a partial selection on one line covers that line `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` selectionLineRange ``. Red with `` stopsAtLineStart `` -> `` !(stopsAtLineStart) ``.
- Kept `` a multi-line selection covers every line it touches `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` selectionLineRange ``. Red with `` && `` -> `` \|\| ``.
- Kept `` stopping at the start of the next line does not count that line `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` selectionLineRange ``. Red with `` === `` -> `` !== ``.
- Kept `` a selection ending at column 0 of its own line is still that line `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` selectionLineRange ``. Red with `` > `` -> `` >= ``.
- Kept `` matches the shared store id format `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` return `icd-${now}-${randomFraction.toString(36).substring(2, 9)}`; `` -> `` return `icd-${now}`; ``.
- Kept `` different randomness yields different ids at the same instant `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` return `icd-${now}-${randomFraction.toString(36).substring(2, 9)}`; `` -> `` return `icd-${now}`; ``.
- Kept `` an ordinary file keeps its path `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` if (!query) return path; `` -> `` if (!query) return ''; ``.
- Kept `` a Source Control diff resolves to the query's real path `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` resolveCommentFilePath ``. Red with `` !query `` -> `` !(!query) ``.
- Kept `` a malformed query falls back to the URI path `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with ``     } catch {         return path; `` -> ``     } catch {         return ''; ``.
- Kept `` a query without a usable path falls back to the URI path `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` resolveCommentFilePath ``. Red with `` parsed.path?.trim() `` -> `` !(parsed.path?.trim()) ``.
- Kept `` identifies both sides of the active diff `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` resolveCommentOrigin ``. Red with `` 'diff' `` -> `` '' ``.
- Kept `` uses the URI scheme when the active tab is unavailable `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` resolveCommentOrigin ``. Red with `` 'diff' `` -> `` '' ``.
- Kept `` a workspace file can take a comment `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` canCommentOnDocument ``. Red with `` scheme === 'comment' `` -> `` !(scheme === 'comment') ``.
- Kept `` a diff's original side can too, since it resolves to a workspace file `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` canCommentOnDocument ``. Red with `` scheme === 'comment' `` -> `` !(scheme === 'comment') ``.
- Kept `` a file outside the workspace cannot `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` return isInWorkspace; `` -> `` return true; ``.
- Kept `` a comment editor cannot comment on itself `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` canCommentOnDocument ``. Red with `` false `` -> `` true ``.
- Kept `` every held comment is returned, in order `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` return pending.splice(0, pending.length); `` -> `` return pending.pop(); ``.
- Kept `` the hold is emptied, so a later flush delivers nothing twice `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` return pending.splice(0, pending.length); `` -> `` return pending.slice(0, pending.length); ``.
- Kept `` an empty hold drains to nothing `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` return pending.splice(0, pending.length); `` -> `` return pending.pop(); ``.
- Kept `` a comment removed before it was ever delivered is dropped from the hold `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` dropPendingById ``. Red with `` true `` -> `` false ``.
- Kept `` an id that is not held leaves the queue untouched `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` dropPendingById ``. Red with `` false `` -> `` true ``.
- Kept `` an empty hold reports nothing dropped `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` dropPendingById ``. Red with `` false `` -> `` true ``.
- Kept `` a comment the composer never reported holding is given up on `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` return !confirmed; `` -> `` return !!confirmed; ``.
- Kept `` a comment the composer confirmed holding is kept `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` return !confirmed; `` -> `` return !!confirmed; ``.
- Kept `` the deadline outlasts the composer own wait for a directory `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` export const DELIVERY_CONFIRMATION_TIMEOUT_MS = 30_000; `` -> `` export const DELIVERY_CONFIRMATION_TIMEOUT_MS = 3_000; ``.
- Kept `` every surface is told, because only one of them holds the draft `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` for (const target of targets) { `` -> `` for (const target of [Array.from(targets).reduce((first) => first)]) { ``.
- Kept `` a comment still held for a booting surface is dropped from the hold `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` dropPendingById ``. Red with `` === `` -> `` !== ``.
- Kept `` surfaces holding nothing keep their queues intact `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` dropPendingById ``. Red with `` === `` -> `` !== ``.
- Kept `` no surfaces at all is not an error `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` for (const target of targets) { `` -> `` for (const target of [Array.from(targets).reduce((first) => first)]) { ``.
- Kept `` the surface holding the draft speaks for its thread `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` snapshotOwnsThread ``. Red with `` === `` -> `` !== ``.
- Kept `` another tab says nothing about this thread `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` snapshotOwnsThread ``. Red with `` && `` -> `` \|\| ``.
- Kept `` the sidebar does not speak for a panel, nor a panel for the sidebar `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` snapshotOwnsThread ``. Red with `` && `` -> `` \|\| ``.
- Kept `` a thread with no surface yet is owned by nobody `` claims `` packages/vscode/src/inlineCommentSelection.ts ``. Red with `` return Boolean(threadSurfaceId) && threadSurfaceId === snapshotSurfaceId; `` -> `` return threadSurfaceId && threadSurfaceId === snapshotSurfaceId; ``.
- Kept `` a draft absent from the very first snapshot is still in flight `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` reconcileThreadFate ``. Red with `` text === undefined `` -> `` !(text === undefined) ``.
- Kept `` a draft absent after having been seen was removed `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` reconcileThreadFate ``. Red with `` text === undefined `` -> `` !(text === undefined) ``.
- Kept `` a draft present is shown, and counts as seen `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` reconcileThreadFate ``. Red with `` 'show' `` -> `` "" ``.
- Kept `` a draft emptied in the composer drops its thread `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` reconcileThreadFate ``. Red with `` 'dispose' `` -> `` "" ``.
- Kept `` blank and whitespace-only bodies are a cancel `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` shouldDisposeOnEmptyBody ``. Red with `` === `` -> `` !== ``.
- Kept `` any real text is kept `` claims `` packages/vscode/src/inlineCommentSelection.ts `` in `` shouldDisposeOnEmptyBody ``. Red with `` === `` -> `` !== ``.

## localizationBundles.test.ts

- Kept `` every runtime string bundle covers the English keys with matching placeholders `` claims `` packages/vscode/l10n/bundle.l10n.fr.json ``. Red with `` OpenChamber: Failed to open sidebar - {0} `` -> `` OpenChamber: Failed to open sidebar ``.
- Kept `` every manifest bundle covers the English keys `` claims `` packages/vscode/package.nls.fr.json ``. Red with `` "extension.description" `` -> `` "extension.wrongDescription" ``.

## machine-settings.test.js

- Kept `` ignores a value set only in local User settings in a remote window `` claims `` packages/vscode/src/machine-settings.ts `` in `` readMachineSetting ``. Red with `` vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key)) `` -> `` !(vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key))) ``.
- Kept `` keeps the local User value in a local window `` claims `` packages/vscode/src/machine-settings.ts `` in `` readMachineSetting ``. Red with `` vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key)) `` -> `` !(vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key))) ``.
- Kept `` `uses the effective value when ${level} is set in a remote window` `` claims `` packages/vscode/src/machine-settings.ts `` in `` readMachineSetting ``. Red with `` vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key)) `` -> `` !(vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key))) ``.
- Kept `` uses the effective value when VS Code does not report the local level `` claims `` packages/vscode/src/machine-settings.ts `` in `` readMachineSetting ``. Red with `` vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key)) `` -> `` !(vscode.env.remoteName && comesOnlyFromLocalUserSettings(config.inspect<string>(key))) ``.
- Kept `` returns an empty string when nothing is set `` claims `` packages/vscode/src/machine-settings.ts `` in `` readMachineSetting ``. Red with `` \|\| `` -> `` && ``.

## magic-prompts.test.ts

- Kept `` a workspace folder keeps its project prompts in its shared file and resets them on their own `` claims `` packages/vscode/src/bridge-project-setup-runtime.ts `` in `` readSharedFile / createProjectSetupStore ``. Red with `` 'ok' `` -> `` '' ``.
- Kept `` a linked worktree folder uses the project of the same folder in the main checkout `` claims `` packages/vscode/src/magic-prompts.ts `` in `` ownerOfDirectory / createMagicPromptService ``. Red with `` repository `` -> `` !(repository) ``.
- Kept `` a git failure or a broken project file fails the read instead of giving global prompts `` claims `` packages/vscode/src/magic-prompts.ts `` in `` ownerOfDirectory / createMagicPromptService ``. Red with `` repository `` -> `` !(repository) ``.

## managed-opencode-process.test.ts

- Kept `` `managed ${mode} reaps parent and SIGTERM-resistant descendant` `` claims `` packages/vscode/src/managed-opencode-process.ts ``. Red with ``       await unregisterManagedProcess(owned.child.pid); `` -> ``  ``.

## networkDefaults.test.ts

- Kept `` allows slow connections without changing address-family selection `` claims `` packages/vscode/src/networkDefaults.ts `` in `` applyConnectAttemptTimeout ``. Red with `` !netModule.setDefaultAutoSelectFamilyAttemptTimeout `` -> `` !(!netModule.setDefaultAutoSelectFamilyAttemptTimeout) ``.
- Kept `` unsupported runtimes retain their existing behavior `` claims `` packages/vscode/src/networkDefaults.ts `` in `` applyConnectAttemptTimeout ``. Red with `` false `` -> `` true ``.

## openchamberSessionState.test.ts

- Kept `` creates the unread baseline once and reads it back, sharing the web server file `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` readUnreadBaseline / createSessionStateStore ``. Red with `` !(error instanceof Error && isMissingFileError(error)) `` -> `` !(!(error instanceof Error && isMissingFileError(error))) ``.
- Kept `` leaves an unreadable unread baseline alone `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` readUnreadBaseline / createSessionStateStore ``. Red with `` isJsonObject(parsed) `` -> `` !(isJsonObject(parsed)) ``.
- Kept `` archives and restores on OpenCode, reports what it refused, and writes no file `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` forgetEntries / createSessionStateStore ``. Red with `` !ids.some((id) => id in current) `` -> `` !(!ids.some((id) => id in current)) ``.
- Kept `` drops the entry of a session OpenCode now holds, and writes nothing when there is none `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` readJsonObjectFile / createSessionStateStore ``. Red with `` isJsonObject(parsed) `` -> `` !(isJsonObject(parsed)) ``.
- Kept `` keeps OpenCode changes when the archive file cannot be read `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` readArchived / createSessionStateStore ``. Red with `` !parsed `` -> `` !(!parsed) ``.
- Kept `` moves an unreadable file aside instead of overwriting it `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` readJsonObjectFile / createSessionStateStore ``. Red with `` isJsonObject(parsed) `` -> `` !(isJsonObject(parsed)) ``.
- Kept `` merges metadata patches on OpenCode per key and deletes on null `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` readJsonObjectFile / createSessionStateStore ``. Red with `` error instanceof Error && isMissingFileError(error) `` -> `` !(error instanceof Error && isMissingFileError(error)) ``.
- Kept `` folds a legacy entry into the first write, then drops it from the file `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` readJsonObjectFile / createSessionStateStore ``. Red with `` isJsonObject(parsed) `` -> `` !(isJsonObject(parsed)) ``.
- Kept `` replaces non-object values and recurses into objects `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` mergeMetadataPatch ``. Red with `` isJsonObject(value) `` -> `` !(isJsonObject(value)) ``.
- Kept `` folds archive time and stored metadata onto list and detail envelopes `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` overlaySessionResponseBody ``. Red with `` !archived && !stored && unreadSince === null `` -> `` !(!archived && !stored && unreadSince === null) ``.
- Kept `` serves turns that ended before the unread baseline as seen `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` overlaySessionResponseBody ``. Red with `` !archived && !stored && unreadSince === null `` -> `` !(!archived && !stored && unreadSince === null) ``.
- Kept `` leaves the body alone when nothing is known `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` overlaySessionResponseBody ``. Red with `` !archived && !stored && unreadSince === null `` -> `` !(!archived && !stored && unreadSince === null) ``.
- Kept `` matches only the list and single-record session paths `` claims `` packages/vscode/src/openchamberSessionState.ts `` in `` isSessionRecordPath ``. Red with `` \|\| `` -> `` && ``.

## opencode-ready.test.ts

- Kept `` returns immediately when already connected with a URL `` claims `` packages/vscode/src/opencode-ready.ts `` in `` waitForApiUrl ``. Red with `` !manager `` -> `` !(!manager) ``.
- Kept `` does not hand out the URL until status is connected (pre-ready spawn window) `` claims `` packages/vscode/src/opencode-ready.ts `` in `` readyUrl / waitForApiUrl ``. Red with `` manager.getStatus() !== 'connected' `` -> `` !(manager.getStatus() !== 'connected') ``.
- Kept `` holds during a restart and resolves once reconnected `` claims `` packages/vscode/src/opencode-ready.ts `` in `` waitForApiUrl ``. Red with `` !manager `` -> `` !(!manager) ``.
- Kept `` fails fast on error status instead of burning the timeout `` claims `` packages/vscode/src/opencode-ready.ts `` in `` handleStatusChange / waitForApiUrl ``. Red with `` finish(null); `` -> `` ; ``.
- Kept `` falls back to whatever URL exists after the timeout `` claims `` packages/vscode/src/opencode-ready.ts `` in `` waitForApiUrl ``. Red with `` disposeAfterSubscribe `` -> `` !(disposeAfterSubscribe) ``.

## opencode-upgrade-runtime.test.ts

- Kept `` uses the configured registry and Basic headers for the v2 package version `` claims `` packages/vscode/src/opencode-upgrade-runtime.ts `` in `` getOpenCodeUpgradeStatus ``. Red with `` !apiUrl \|\| !manager `` -> `` !(!apiUrl \|\| !manager) ``.
- Kept `` reports invalid registry configuration without a public-registry fallback `` claims `` packages/vscode/src/opencode-upgrade-runtime.ts `` in `` getOpenCodeUpgradeStatus ``. Red with `` !apiUrl \|\| !manager `` -> `` !(!apiUrl \|\| !manager) ``.
- Kept `` reports installed and latest versions from the v2 info route `` claims `` packages/vscode/src/opencode-upgrade-runtime.ts `` in `` getOpenCodeUpgradeStatus ``. Red with `` typeof health?.version === 'string' && health.version.trim() `` -> `` !(typeof health?.version === 'string' && health.version.trim()) ``.
- Kept `` still reports the running version for an externally managed OpenCode `` claims `` packages/vscode/src/opencode-upgrade-runtime.ts `` in `` getOpenCodeUpgradeStatus ``. Red with `` typeof health?.version === 'string' && health.version.trim() `` -> `` !(typeof health?.version === 'string' && health.version.trim()) ``.
- Kept `` rejects external upgrades without contacting OpenCode `` claims `` packages/vscode/src/opencode-upgrade-runtime.ts `` in `` upgradeManagedOpenCode ``. Red with `` 409 `` -> `` 410 ``.
- Kept `` shares concurrent upgrades and permits a new attempt after failure `` claims `` packages/vscode/src/opencode-upgrade-runtime.ts `` in `` upgradeManagedOpenCode ``. Red with `` upgradesInFlight.delete(manager); `` -> `` ; ``.
- Kept `` rejects a missing CLI or manager before executing anything `` claims `` packages/vscode/src/opencode-upgrade-runtime.ts `` in `` upgradeManagedOpenCode ``. Red with `` 409 `` -> `` 410 ``.

## opencodeAuth.test.ts

- Kept `` reads through the shared reader once wired `` claims `` packages/web/server/lib/opencode/auth.js ``. Red with ``   const credentials = await sharedStoredRead(readStored); `` -> ``   const credentials = {}; ``.
- Kept `` throws while OpenCode has no API URL instead of answering empty `` claims `` packages/vscode/src/opencodeAuth.ts `` in `` connected / openCodeCredentialSource ``. Red with `` !apiUrl `` -> `` !(!apiUrl) ``.

## opencodeCliDiscovery.test.ts

- Kept `` Windows prefers the npm CLI on PATH over a standard installation `` claims `` packages/vscode/src/opencodeCliDiscovery.ts `` in `` resolveDetectedOpencodeCliPath ``. Red with `` fromPath `` -> `` !(fromPath) ``.
- Kept `` Unix finds an executable CLI on PATH `` claims `` packages/vscode/src/opencodeCliDiscovery.ts `` in `` resolveDetectedOpencodeCliPath ``. Red with `` fromPath `` -> `` !(fromPath) ``.

## opencodeConfig-npm-registry.test.ts

- Kept `` plugin metadata uses the shared resolver with credential-safe URLs `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` queryPluginRegistry ``. Red with `` 'npm-ok' `` -> `` '' ``.
- Kept `` a Git plugin spec is its own kind and never queries the npm registry `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` queryPluginRegistry ``. Red with `` 'git-ok' `` -> `` '' ``.

## opencodeConfig.config-parse.test.ts

- Kept `` refuses MCP updates that would overwrite a partial-parse config `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` formatJsoncParseError ``. Red with `` `OpenCode configuration at ${filePath} contains invalid JSONC and cannot be loaded safely${location}` `` -> `` null ``.
- Kept `` preserves unrelated keys when updating a valid MCP config `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` returns an empty object for a comment-only config file `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` parseConfigObject ``. Red with `` parseConfigResult(content, filePath).config `` -> `` null ``.
- Kept `` refuses MCP updates against content that yields no JSON value at all `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` formatJsoncParseError ``. Red with `` `OpenCode configuration at ${filePath} contains invalid JSONC and cannot be loaded safely${location}` `` -> `` null ``.
- Kept `` lists custom-layer plugins when a project layer is unparseable `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` listPluginEntries ``. Red with `` switches `` -> `` !(switches) ``.
- Kept `` lists plugins from every folder config OpenCode finds above the project `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` parseConfigResult ``. Red with `` true `` -> `` false ``.
- Kept `` deletes the listed project plugin when OPENCODE_CONFIG is another project file `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` parseConfigResult ``. Red with `` false `` -> `` true ``.
- Kept `` keeps a valid custom layer writable when a project layer is unparseable `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` keeps every comment when a single MCP value changes `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` replaces the config file atomically and leaves no temp file `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` writes through a symlinked config and keeps the link `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` keeps comments when adding a new MCP server `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` parseConfigResult ``. Red with `` true `` -> `` false ``.
- Kept `` keeps comments when deleting an MCP server and the emptied section `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` parseConfigResult ``. Red with `` true `` -> `` false ``.
- Kept `` keeps comments when deleting the only property of a trailing-comma object `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` parseConfigResult ``. Red with `` true `` -> `` false ``.
- Kept `` appends the config after comments of a comment-only file `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` createMcpConfig ``. Red with `` findMcpSource(readMcpSources(layers, workingDirectory), name) `` -> `` !(findMcpSource(readMcpSources(layers, workingDirectory), name)) ``.
- Kept `` writes a new config file as plain JSON when it is missing `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` createMcpConfig ``. Red with `` findMcpSource(readMcpSources(layers, workingDirectory), name) `` -> `` !(findMcpSource(readMcpSources(layers, workingDirectory), name)) ``.
- Kept `` leaves the file byte-identical when nothing changed `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` preserves untouched array entries during a plugin version update `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` parseConfigResult ``. Red with `` true `` -> `` false ``.
- Kept `` preserves CRLF line endings and comments `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` adds and removes only its own skill statement, every other line stays as written `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` parseConfigResult ``. Red with `` false `` -> `` true ``.
- Kept `` falls back to a normalized rewrite when the edit cannot round-trip `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` parseConfigResult ``. Red with `` true `` -> `` false ``.

## opencodeConfig.entity-v2.test.ts

- Kept `` reads a v1 agent markdown file and answers the v2 shape `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` getAgentConfig ``. Red with `` 'md' `` -> `` '' ``.
- Kept `` rewrites a v1 agent file in place, at its own path, in v2 shape `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateAgent ``. Red with `` writeAgentMd(current.path, entity); `` -> `` ; ``.
- Kept `` writes the permission rule array when the client sends a v1 map `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateAgent ``. Red with `` writeAgentMd(current.path, entity); `` -> `` ; ``.
- Kept `` creates a new agent in the v2 agents directory `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` createAgent ``. Red with `` workingDirectory `` -> `` !(workingDirectory) ``.
- Kept `` moves a v1 JSON agent entry into the agents section of the same file `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateAgent ``. Red with `` current.source === 'md' && current.path `` -> `` !(current.source === 'md' && current.path) ``.
- Kept `` clears v1 fields at the v2 location they moved to `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateAgent ``. Red with `` current.source === 'md' && current.path `` -> `` !(current.source === 'md' && current.path) ``.
- Kept `` drops only the variant when a model is set `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateAgent ``. Red with `` writeAgentMd(current.path, entity); `` -> `` ; ``.
- Kept `` reports global and agent rules in evaluation order `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` getProjectAgentPath ``. Red with `` fs.existsSync(candidate) `` -> `` !(fs.existsSync(candidate)) ``.
- Kept `` reads a v1 command file and rewrites it in place as subagent `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` getCommandConfig ``. Red with `` mdPath `` -> `` !(mdPath) ``.
- Kept `` rewrites a v1 theme color as the hex OpenCode migrates it to `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` updateAgent ``. Red with `` writeAgentMd(current.path, entity); `` -> `` ; ``.
- Kept `` answers the project v1 override when the user file already holds the v2 spelling `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` getMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` lists MCP servers from parent folders and edits them where OpenCode reads them `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` getMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` lists and edits global JSONC MCP servers beside a JSON config `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` listMcpConfigs ``. Red with `` throwIfLayerError(layers, layers.paths.userOverridePath); `` -> `` ; ``.
- Kept `` reads a v1 mcp entry and rewrites it under mcp.servers in the same file `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` getMcpConfig ``. Red with `` !source `` -> `` !(!source) ``.
- Kept `` writes plugin specs in the form OpenCode loads and refuses the rest `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` createPluginEntry ``. Red with `` \|\| `` -> `` && ``.

## opencodeConfig.providers.test.ts

- Kept `` validateCustomProviderConfig rejects invalid endpoint and credentials shape `` claims `` packages/web/server/lib/opencode/providers.js `` in `` validateCustomProviderConfig ``. Red with `` false `` -> `` true ``.
- Kept `` validateCustomProviderConfig rejects missing credentials `` claims `` packages/web/server/lib/opencode/providers.js `` in `` validateCustomProviderConfig ``. Red with `` false `` -> `` true ``.
- Kept `` accepts supported protocol adapters and rejects arbitrary npm packages `` claims `` packages/web/server/lib/opencode/providers.js `` in `` validateCustomProviderConfig ``. Red with `` false `` -> `` true ``.
- Kept `` upsertProviderConfig writes and round-trips project config `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` upsertProviderConfig ``. Red with `` scope === 'project' `` -> `` !(scope === 'project') ``.
- Kept `` upsertProviderConfig keeps model limits, capabilities and variants like the web server `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` upsertProviderConfig ``. Red with `` scope === 'project' `` -> `` !(scope === 'project') ``.
- Kept `` round-trips non-default protocol adapters through project config `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` upsertProviderConfig ``. Red with `` scope === 'project' `` -> `` !(scope === 'project') ``.
- Kept `` upsertProviderConfig updates existing entry and clears disabled_providers `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` deepEqualJsonValue ``. Red with `` false `` -> `` true ``.
- Kept `` upsertProviderConfig preserves unmanaged provider and model metadata `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` upsertProviderConfig ``. Red with `` scope === 'project' `` -> `` !(scope === 'project') ``.
- Kept `` renaming a provider keeps canonical and model compatibility `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` deepEqualJsonValue ``. Red with `` false `` -> `` true ``.
- Kept `` a form save keeps the type of a hand-marked image model `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` upsertProviderConfig ``. Red with `` scope === 'project' `` -> `` !(scope === 'project') ``.
- Kept `` a form save writes the type it sends, any type OpenCode knows `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` deepEqualJsonValue ``. Red with `` false `` -> `` true ``.
- Kept `` upsertProviderConfig preserves metadata while migrating the legacy providers alias `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` deepEqualJsonValue ``. Red with `` false `` -> `` true ``.
- Kept `` migrating one legacy providers entry keeps the other legacy entries `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` upsertProviderConfig ``. Red with `` scope === 'project' `` -> `` !(scope === 'project') ``.
- Kept `` upsert then remove restores absence `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` removeProviderConfig ``. Red with `` true `` -> `` false ``.
- Kept `` failed validation does not write config `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` upsertProviderConfig ``. Red with `` !validated.ok `` -> `` !(!validated.ok) ``.
- Kept `` upsert with hasStoredAuth allows config without env `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` upsertProviderConfig ``. Red with `` scope === 'project' `` -> `` !(scope === 'project') ``.
- Kept `` project-scope edit updates project layer without creating a user entry `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` deepEqualJsonValue ``. Red with `` false `` -> `` true ``.
- Kept `` custom-scope edit updates custom layer without creating a user entry `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` deepEqualJsonValue ``. Red with `` false `` -> `` true ``.
- Kept `` finds, edits and removes a provider from a global opencode.jsonc next to opencode.json in place `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` deepEqualJsonValue ``. Red with `` true `` -> `` false ``.

## opencodeConfig.skills.test.js

- Kept `` lists one skill per directory and skips hidden, dependency and nested ones `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` discoverSkills ``. Red with `` workingDirectory `` -> `` !(workingDirectory) ``.
- Kept `` merges OpenCode API skills with locally discovered fallback skills `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` appendSkill / mergeDiscoveredSkills ``. Red with `` !skill `` -> `` !(!skill) ``.
- Kept `` resolves built-in skills without treating the virtual location as a file `` claims `` packages/vscode/src/opencodeConfig.ts `` in `` getSkillSources ``. Red with `` isBuiltInDiscovered `` -> `` !(isBuiltInDiscovered) ``.

## opencodeConfigPaths.test.ts

- Kept `` unset and blank XDG keep the existing global directory `` claims `` packages/vscode/src/opencodeConfigPaths.ts ``. Red with `` path.join(os.homedir(), '.config') `` -> `` path.join(os.homedir(), '.configuration') ``.
- Kept `` global CRUD uses XDG while project writes stay in the project `` claims `` packages/vscode/src/opencodeConfigPaths.ts ``. Red with `` 'opencode');  export const OPENCODE_DATA_DIR `` -> `` 'open-code');  export const OPENCODE_DATA_DIR ``.
- Kept `` a global opencode.jsonc beside opencode.json overrides it when reading `` claims `` packages/vscode/src/opencodeConfigPaths.ts ``. Red with `` 'opencode');  export const OPENCODE_DATA_DIR `` -> `` 'open-code');  export const OPENCODE_DATA_DIR ``.

## opencodeServiceUrl.test.ts

- Kept `` treats loopback spellings of one port as the same server `` claims `` packages/vscode/src/opencodeServiceUrl.ts `` in `` isSameOpenCodeServer ``. Red with `` a.protocol !== b.protocol \|\| a.port !== b.port `` -> `` !(a.protocol !== b.protocol \|\| a.port !== b.port) ``.
- Kept `` never matches another port, scheme, or host `` claims `` packages/vscode/src/opencodeServiceUrl.ts `` in `` isSameOpenCodeServer ``. Red with `` a.protocol !== b.protocol \|\| a.port !== b.port `` -> `` !(a.protocol !== b.protocol \|\| a.port !== b.port) ``.

## opencodeVersion.test.ts

- Kept `` accepts an OpenCode 2.x CLI `` claims `` packages/vscode/src/opencodeVersion.ts `` in `` checkOpenCodeVersionOutput ``. Red with `` true `` -> `` false ``.
- Kept `` rejects a 1.x CLI and names the version it found `` claims `` packages/vscode/src/opencodeVersion.ts `` in `` checkOpenCodeVersionOutput ``. Red with `` false `` -> `` true ``.
- Kept `` rejects output that names no version instead of guessing `` claims `` packages/vscode/src/opencodeVersion.ts `` in `` checkOpenCodeVersionOutput ``. Red with `` false `` -> `` true ``.

## owned-process.test.ts

- Kept `` a child that honors the stdin lease exits on its own and is not killed `` claims `` packages/vscode/src/owned-process.ts ``. Red with ``     child.stdin.end(); `` -> ``  ``.
- Kept `` a child that ignores the lease is tree-killed once the grace runs out `` claims `` packages/vscode/src/owned-process.ts ``. Red with ``     await closesWithin(closed, stdinLeaseGraceMs); `` -> ``  ``.
- Kept `` without a lease the tree is killed at once `` claims `` packages/vscode/src/owned-process.ts ``. Red with ``   if (isRunning(child) && child.pid) await killTree(child.pid); `` -> ``   await closesWithin(closed, stdinLeaseGraceMs ?? 3000);   if (isRunning(child) && child.pid) await killTree(child.pid); ``.
- Kept `` a child that already exited is left alone `` claims `` packages/vscode/src/owned-process.ts ``. Red with ``   if (isRunning(child) && child.pid) await killTree(child.pid); `` -> ``   if (child.pid) await killTree(child.pid); ``.

## patchReconstruction.test.ts

- Kept `` restores indentation OpenCode trimmed from the diff `` claims `` packages/vscode/src/patchReconstruction.ts `` in `` reconstructOriginalContentFromPatch ``. Red with `` hunks.length === 0 `` -> `` !(hunks.length === 0) ``.
- Kept `` restores tab indentation across several hunks and keeps blank lines blank `` claims `` packages/vscode/src/patchReconstruction.ts `` in `` reconstructOriginalContentFromPatch ``. Red with `` hunks.length === 0 `` -> `` !(hunks.length === 0) ``.
- Kept `` leaves untrimmed diffs unchanged `` claims `` packages/vscode/src/patchReconstruction.ts `` in `` reconstructOriginalContentFromPatch ``. Red with `` hunks.length === 0 `` -> `` !(hunks.length === 0) ``.
- Kept `` falls back to pasting old lines when the file does not line up `` claims `` packages/vscode/src/patchReconstruction.ts `` in `` reconstructOriginalContentFromPatch ``. Red with `` hunks.length === 0 `` -> `` !(hunks.length === 0) ``.
- Kept `` rebuilds a deleted file from an empty one `` claims `` packages/vscode/src/patchReconstruction.ts `` in `` reconstructOriginalContentFromPatch ``. Red with `` hunks.length === 0 `` -> `` !(hunks.length === 0) ``.
- Kept `` tells a deletion from an edit `` claims `` packages/vscode/src/patchReconstruction.ts `` in `` isFileDeletionPatch ``. Red with `` && `` -> `` \|\| ``.
- Kept `` returns null when the patch has no hunks `` claims `` packages/vscode/src/patchReconstruction.ts `` in `` reconstructOriginalContentFromPatch ``. Red with `` hunks.length === 0 `` -> `` !(hunks.length === 0) ``.

## pathUtils.test.ts

- Kept `` matches Windows paths that differ only in drive-letter case `` claims `` packages/vscode/src/pathUtils.ts `` in `` pathsEqualWithNormalizedDriveLetter ``. Red with `` === `` -> `` !== ``.
- Kept `` does not ignore case outside the drive letter `` claims `` packages/vscode/src/pathUtils.ts `` in `` pathsEqualWithNormalizedDriveLetter ``. Red with `` === `` -> `` !== ``.
- Kept `` preserves exact comparison for paths without a Windows drive letter `` claims `` packages/vscode/src/pathUtils.ts `` in `` pathsEqualWithNormalizedDriveLetter ``. Red with `` === `` -> `` !== ``.

## plugin-switches.test.ts

- Kept `` maps npm, scoped, path and file specs to the resource OpenCode denies `` claims `` packages/web/server/lib/opencode/plugin-switches.js ``. Red with `` return target ? `plugin:${target}` : null; `` -> `` return target ? `plugins:${target}` : null; ``.
- Kept `` leaves control entries and malformed file URLs without a switch `` claims `` packages/web/server/lib/opencode/plugin-switches.js ``. Red with `` if (isPluginControlSpec(spec)) return null; `` -> `` if (isPluginControlSpec(spec)) return `plugin:${spec}`; ``.
- Kept `` records a switch and reports off, on, or unavailable `` claims `` packages/web/server/lib/opencode/plugin-switches.js ``. Red with `` return read.resources.includes(resource) ? 'off' : 'on'; `` -> `` return read.resources.includes(resource) ? 'on' : 'off'; ``.
- Kept `` writes its own layer when the user does not own OPENCODE_CONFIG `` claims `` packages/vscode/src/plugin-switches.ts `` in `` applyPluginSwitchPolicies ``. Red with `` writeFileAtomic(filePath, `${JSON.stringify({ policies }, null, 2)}\n`); `` -> `` ; ``.
- Kept `` rewrites its own managed file even after it set OPENCODE_CONFIG `` claims `` packages/vscode/src/plugin-switches.ts `` in `` applyPluginSwitchPolicies ``. Red with `` writeFileAtomic(filePath, `${JSON.stringify({ policies }, null, 2)}\n`); `` -> `` ; ``.
- Kept `` merges into OPENCODE_CONFIG_CONTENT when the user owns OPENCODE_CONFIG `` claims `` packages/vscode/src/plugin-switches.ts `` in `` applyPluginSwitchPolicies ``. Red with `` false `` -> `` true ``.
- Kept `` keeps the published denials when the store cannot be read `` claims `` packages/vscode/src/plugin-switches.ts `` in `` applyPluginSwitchPolicies ``. Red with `` writeFileAtomic(filePath, `${JSON.stringify({ policies }, null, 2)}\n`); `` -> `` ; ``.
- Kept `` a fresh launch on an unreadable store starts without denials `` claims `` packages/vscode/src/plugin-switches.ts `` in `` applyPluginSwitchPolicies ``. Red with `` writeFileAtomic(filePath, `${JSON.stringify({ policies }, null, 2)}\n`); `` -> `` ; ``.
- Kept `` fails a launch when denials cannot merge into OPENCODE_CONFIG_CONTENT, and leaves it alone without denials `` claims `` packages/vscode/src/plugin-switches.ts `` in `` applyPluginSwitchPolicies ``. Red with `` false `` -> `` true ``.

## project-setup.test.ts

- Kept `` keeps only non-empty trimmed setup commands `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` drops incomplete actions and duplicate ids, keeps only set optional fields `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeProjectActions ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` dedupes draft starters by type and name `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeDraftStarters ``. Red with `` !type \|\| !name `` -> `` !(!type \|\| !name) ``.
- Kept `` builds the personal view from on-disk keys and nulls a dangling primary action `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` parses a shared file and refuses a broken one `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` merges shared and personal by the agreed rules `` claims `` packages/vscode/src/project-setup.ts `` in `` mergeProjectSetup ``. Red with `` sharedRead.status === 'ok' `` -> `` !(sharedRead.status === 'ok') ``.
- Kept `` trusts only the recorded hash and nothing when nothing executes `` claims `` packages/vscode/src/project-setup.ts `` in `` mergeProjectSetup ``. Red with `` sharedRead.status === 'ok' `` -> `` !(sharedRead.status === 'ok') ``.
- Kept `` rejects wrongly shaped patch keys `` claims `` packages/vscode/src/project-setup.ts `` in `` projectSetupPatchToStored ``. Red with `` !isObjectRecord(patch) `` -> `` !(!isObjectRecord(patch)) ``.
- Kept `` stores a project whose id is too long for a file name under a bounded name `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` reads a long id from its pre-bound file name and moves it on the next write `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` round-trips a patch through the bridge and preserves foreign keys `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` answers a bad patch or project id with a failure, and ignores other messages `` claims `` packages/vscode/src/project-setup.ts `` in `` projectSetupPatchToStored ``. Red with `` !isObjectRecord(patch) `` -> `` !(!isObjectRecord(patch)) ``.
- Kept `` reads the shared file from the checkout the id names `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` writes and removes the shared file through the bridge, trusting the writer `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` serializes two quick updates to one file `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` setup saves, repairs and the last setup removal keep Magic Prompts and unknown keys `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.
- Kept `` changes one key without touching setup or trust, and refuses a file it would have to repair `` claims `` packages/vscode/src/project-setup.ts `` in `` sanitizeSetupCommands ``. Red with `` !Array.isArray(value) `` -> `` !(!Array.isArray(value)) ``.

## provider-env-aliases.parity.test.ts

- Kept `` mirrors GEMINI_API_KEY onto Google Generative AI env names `` claims `` packages/web/server/lib/opencode/provider-env-aliases.js ``. Red with `` const next = { ...env }; `` -> `` const next = {}; ``.
- Deleted `` does not overwrite an already-set preferred Google key `` claims packages/web/server/lib/opencode/provider-env-aliases.js. Both mutations left this test green: `` const next = { ...env }; `` -> `` const next = {}; ``; `` return next; `` -> `` return { ...next, GOOGLE_GENERATIVE_AI_API_KEY: env.GEMINI_API_KEY }; ``. Other blocks in the file may fail.
- Deleted `` returns empty object for invalid input `` claims packages/web/server/lib/opencode/provider-env-aliases.js. Both mutations left this test green: ``     return {}; `` -> ``     return []; ``; ``     return {}; `` -> ``     return null; ``. Other blocks in the file may fail.

## quotaProviders.test.ts

- Kept `` dispatches Charm Hyper through the generic quota API `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchHyperQuota ``. Red with `` Number.isFinite(rawBalance) `` -> `` !(Number.isFinite(rawBalance)) ``.
- Kept `` uses the opencode-go key stored in OpenCode `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenCodeGoQuota ``. Red with `` true `` -> `` false ``.
- Kept `` reads the usage with that key `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenCodeGoQuota ``. Red with `` true `` -> `` false ``.
- Kept `` reports an absent subscription on a 403 `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoApiKey ``. Red with `` true `` -> `` false ``.
- Kept `` names an expired key and the sign-in that replaces it `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoApiKey ``. Red with `` !consoleEntry \|\| consoleEntry.type === 'oauth' `` -> `` !(!consoleEntry \|\| consoleEntry.type === 'oauth') ``.
- Kept `` reads the exact Console meters with an API key, without an organization `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenCodeGoQuota ``. Red with `` true `` -> `` false ``.
- Kept `` falls back to the usage API when the Console status gives the key no Go meters `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenCodeGoQuota ``. Red with `` true `` -> `` false ``.
- Kept `` keeps a 401 without the expired-key code an authentication failure `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoApiKey ``. Red with `` !consoleEntry \|\| consoleEntry.type === 'oauth' `` -> `` !(!consoleEntry \|\| consoleEntry.type === 'oauth') ``.
- Kept `` uses the Console status endpoint and maps meters to windows `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` accepts a wrk_ workspace id from the Console sign-in `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` keeps the meters when the billing balance cannot be read `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` supports Go Plus and keeps usable windows when another meter is malformed `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` supports Go Teams `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` distinguishes an absent subscription from a temporary failure `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` matches web errors for a missing product and normalizes epoch-second resets `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` reads a Go product without access as an absent subscription, not an unreadable response `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` falls back to the API key when the sign-in is not a Console sign-in `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoApiKey ``. Red with `` ownKey `` -> `` !(ownKey) ``.
- Kept `` falls back to the API key when the Console read fails `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` reports the Console error when the fallback key has expired `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` reports the request counters, the budget and the Zen models `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` keeps account budgets separate and reads every model page of each range `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` keeps OpenCode Go usage out of the Zen card `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` drops a range whose later model page is unreadable `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` fails when every range is unusable `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` keeps a zero request count as valid data `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` fails when every range has invalid numeric data `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` drops only the range with invalid numeric data `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` drops a range whose full first page has no usable pagination `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` sends the workspace key and never follows a redirect `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` reports a rejected credential as an authentication failure `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeZenCredential ``. Red with `` consoleCredential `` -> `` !(consoleCredential) ``.
- Kept `` uses the Console token and organization `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID) `` -> `` !(!accessToken \|\| entry.server !== CONSOLE_SERVER \|\| !orgID \|\| !CONSOLE_ORGANIZATION_ID_PATTERN.test(orgID)) ``.
- Kept `` reports a workspace without a credential as not configured `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !entry \|\| entry.type !== 'oauth' `` -> `` !(!entry \|\| entry.type !== 'oauth') ``.
- Kept `` reads the documented key endpoint and emits the current reset window `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` buildResult({       providerId: 'openrouter',       providerName: 'OpenRouter',       ok: true,       configured: true,       usage: {         windows: {           [windowKey]: toUsageWindow({             usedPercent,             windowSeconds,             resetAt,             valueLabel,           }),         },       },     }) `` -> `` null ``.
- Kept `` reads the key endpoint from the configured v2 provider baseURL `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchOpenRouterQuota() `` -> `` null ``.
- Kept `` reads the key endpoint from the legacy provider options baseURL `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchOpenRouterQuota() `` -> `` null ``.
- Kept `` reads the key endpoint from the legacy provider api field `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchOpenRouterQuota() `` -> `` null ``.
- Kept `` strips trailing slashes from the configured baseURL `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchOpenRouterQuota() `` -> `` null ``.
- Kept `` keeps the default key endpoint when the config cannot be parsed `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchOpenRouterQuota() `` -> `` null ``.
- Kept `` maps an unlimited null-limit key to a monthly spent window `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` buildResult({       providerId: 'openrouter',       providerName: 'OpenRouter',       ok: true,       configured: true,       usage: {         windows: {           [windowKey]: toUsageWindow({             usedPercent,             windowSeconds,             resetAt,             valueLabel,           }),         },       },     }) `` -> `` null ``.
- Kept `` maps a lifetime cap to a key_limit window without reset metadata `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` buildResult({       providerId: 'openrouter',       providerName: 'OpenRouter',       ok: true,       configured: true,       usage: {         windows: {           [windowKey]: toUsageWindow({             usedPercent,             windowSeconds,             resetAt,             valueLabel,           }),         },       },     }) `` -> `` null ``.
- Kept `` maps an unrecognized reset period to a key_limit window `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` buildResult({       providerId: 'openrouter',       providerName: 'OpenRouter',       ok: true,       configured: true,       usage: {         windows: {           [windowKey]: toUsageWindow({             usedPercent,             windowSeconds,             resetAt,             valueLabel,           }),         },       },     }) `` -> `` null ``.
- Kept `` clamps percent at 100 while leaving the money label unclamped `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` buildResult({       providerId: 'openrouter',       providerName: 'OpenRouter',       ok: true,       configured: true,       usage: {         windows: {           [windowKey]: toUsageWindow({             usedPercent,             windowSeconds,             resetAt,             valueLabel,           }),         },       },     }) `` -> `` null ``.
- Kept `` uses a weekly window and derives its reset on Monday UTC `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` buildResult({       providerId: 'openrouter',       providerName: 'OpenRouter',       ok: true,       configured: true,       usage: {         windows: {           [windowKey]: toUsageWindow({             usedPercent,             windowSeconds,             resetAt,             valueLabel,           }),         },       },     }) `` -> `` null ``.
- Kept `` rejects management keys with an inference-key error `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` 'Management key configured — quota needs an inference API key' `` -> `` '' ``.
- Kept `` `maps HTTP ${status} to session expiry` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` buildResult({         providerId: 'openrouter',         providerName: 'OpenRouter',         ok: false,         configured: true,         error: response.status === 401 \|\| response.status === 403           ? 'Session expired — please re-authenticate with OpenRouter'           : `API error: ${response.status}`,       }) `` -> `` null ``.
- Kept `` reports invalid JSON as a parse failure `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` buildResult({       providerId: 'openrouter',       providerName: 'OpenRouter',       ok: false,       configured: true,       error: isTimeout         ? 'Request timed out'         : isParseError           ? 'Invalid response from provider'           : error instanceof Error ? error.message : 'Request failed',     }) `` -> `` null ``.
- Kept `` normalizes timeout failures `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` buildResult({       providerId: 'openrouter',       providerName: 'OpenRouter',       ok: false,       configured: true,       error: isTimeout         ? 'Request timed out'         : isParseError           ? 'Invalid response from provider'           : error instanceof Error ? error.message : 'Request failed',     }) `` -> `` null ``.
- Kept `` rejects a response without usable quota data `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` 'No quota data in response' `` -> `` '' ``.
- Kept `` `rejects ${JSON.stringify(payload)} without quota data` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOpenRouterQuota ``. Red with `` 'No quota data in response' `` -> `` '' ``.
- Kept `` maps documented limit kinds to 5h/weekly/monthly windows `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClinePassQuota ``. Red with `` Array.isArray(data?.limits) `` -> `` !(Array.isArray(data?.limits)) ``.
- Kept `` ignores unknown limit types and rejects responses without quota data `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClinePassQuota ``. Red with `` 'No quota data in response' `` -> `` '' ``.
- Kept `` maps 401 to session-expired with ClinePass branding `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClinePassQuota ``. Red with `` buildResult({         providerId: 'cline-pass',         providerName: 'ClinePass',         ok: false,         configured: true,         error: response.status === 401           ? 'Session expired — please re-authenticate with ClinePass'           : `API error: ${response.status}`,       }) `` -> `` null ``.
- Kept `` reports invalid-response on JSON parse failure `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClinePassQuota ``. Red with `` buildResult({       providerId: 'cline-pass',       providerName: 'ClinePass',       ok: false,       configured: true,       error: isTimeout         ? 'Request timed out'         : isParseError           ? 'Invalid response from provider'           : (error instanceof Error ? error.message : 'Request failed'),     }) `` -> `` null ``.
- Kept `` `skips malformed windows independently: ${JSON.stringify(limit)}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClinePassQuota ``. Red with `` Array.isArray(data?.limits) `` -> `` !(Array.isArray(data?.limits)) ``.
- Kept `` `accepts percentage ${JSON.stringify(percentUsed)}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClinePassQuota ``. Red with `` Array.isArray(data?.limits) `` -> `` !(Array.isArray(data?.limits)) ``.
- Kept `` `falls back to a usable token: ${JSON.stringify(entry)}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClinePassQuota ``. Red with `` Array.isArray(data?.limits) `` -> `` !(Array.isArray(data?.limits)) ``.
- Kept `` does not request usage without usable credentials `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClinePassQuota ``. Red with `` false `` -> `` true ``.
- Kept `` recognizes the timeout exception from AbortSignal.timeout `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClinePassQuota ``. Red with `` buildResult({       providerId: 'cline-pass',       providerName: 'ClinePass',       ok: false,       configured: true,       error: isTimeout         ? 'Request timed out'         : isParseError           ? 'Invalid response from provider'           : (error instanceof Error ? error.message : 'Request failed'),     }) `` -> `` null ``.
- Kept `` `displays credit balance ${balance} with unlimited=${unlimited} as ${expected}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCodexQuota ``. Red with `` !accessToken `` -> `` !(!accessToken) ``.
- Kept `` tells an access-enforcement 401 apart from an expired session `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCodexQuota ``. Red with `` codexFailure('Session expired \u2014 please re-authenticate with OpenAI') `` -> `` null ``.
- Kept `` reads the numbers with the CLI sign-in and names its account `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCodexQuota ``. Red with `` !accessToken `` -> `` !(!accessToken) ``.
- Kept `` keeps the usage-page message without a CLI sign-in `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCodexQuota ``. Red with `` !accessToken `` -> `` !(!accessToken) ``.
- Kept `` omits the balance window when credits are absent `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCodexQuota ``. Red with `` !accessToken `` -> `` !(!accessToken) ``.
- Kept `` coalesces concurrent refreshes for the same provider `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProvider ``. Red with `` existing `` -> `` !(existing) ``.
- Kept `` surfaces spend_control individual limit for business accounts `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCodexQuota ``. Red with `` !accessToken `` -> `` !(!accessToken) ``.
- Kept `` `formats the individual allowance for unit ${unit}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCodexQuota ``. Red with `` !accessToken `` -> `` !(!accessToken) ``.
- Kept `` exposes only premium interactions as the primary usage window `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotQuota ``. Red with `` buildResult({       providerId: 'github-copilot',       providerName: 'GitHub Copilot',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` uses the enterprise Copilot API from the active OpenCode login `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotQuota ``. Red with `` buildResult({       providerId: 'github-copilot',       providerName: 'GitHub Copilot',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` `refuses ${label} instead of requesting a host derived from it` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchCopilotQuota() `` -> `` null ``.
- Kept `` does not send the credential when enterprise URL metadata is malformed `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchCopilotQuota() `` -> `` null ``.
- Kept `` add-on path mirrors the primary window shaping `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotAddonQuota ``. Red with `` buildResult({       providerId: 'github-copilot-addon',       providerName: 'GitHub Copilot Add-on',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` derives the credit label from the same used axis as VS Code on fractional credits `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotQuota ``. Red with `` buildResult({       providerId: 'github-copilot',       providerName: 'GitHub Copilot',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` keeps the fractional credit rather than rounding it away `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotQuota ``. Red with `` buildResult({       providerId: 'github-copilot',       providerName: 'GitHub Copilot',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` falls back to the integer remaining when quota_remaining is absent `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotQuota ``. Red with `` buildResult({       providerId: 'github-copilot',       providerName: 'GitHub Copilot',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` reports unlimited plans without a percent `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotQuota ``. Red with `` buildResult({       providerId: 'github-copilot',       providerName: 'GitHub Copilot',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` reports credits used for unlimited plans with usage `` claims `` packages/vscode/src/quotaProviders.ts `` in `` resolveCopilotPlanLabel ``. Red with `` 'Copilot Business' `` -> `` "" ``.
- Kept `` `handles unlimited credits_used ${String(creditsUsed)} in both providers` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotQuota ``. Red with `` buildResult({       providerId: 'github-copilot',       providerName: 'GitHub Copilot',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` returns null/omits plan label for unmapped plan/sku and handles can_signup_for_limited `` claims `` packages/vscode/src/quotaProviders.ts `` in `` resolveCopilotPlanLabel ``. Red with `` 'Copilot Business' `` -> `` "" ``.
- Kept `` keeps Unlimited value label when has_quota is false despite credits_used `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotQuota ``. Red with `` buildResult({       providerId: 'github-copilot',       providerName: 'GitHub Copilot',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` falls back to percent_remaining when entitlement is unusable `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchCopilotQuota ``. Red with `` buildResult({       providerId: 'github-copilot',       providerName: 'GitHub Copilot',       ok: true,       configured: true,       usage: { windows: buildCopilotWindows(payload) },       planLabel,     }) `` -> `` null ``.
- Kept `` parses current limits, model-scoped limits, and extra usage `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClaudeQuota ``. Red with `` buildResult({       providerId: 'claude',       providerName: 'Claude',       ok: true,       configured: true,       usage,     }) `` -> `` null ``.
- Kept `` reports an expired token without asking Anthropic `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClaudeQuota ``. Red with `` 'Claude session expired. Open Claude Code to sign in again.' `` -> `` '' ``.
- Kept `` tells a token without usage access apart from an expired session `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClaudeQuota ``. Red with `` 'Anthropic does not let this Claude token read usage. A token from `claude setup-token` cannot; a Claude Code sign-in (`/login`) can.' `` -> `` '' ``.
- Kept `` keeps serving the last good values while Anthropic rate limits `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClaudeQuota ``. Red with `` buildResult({       providerId: 'claude',       providerName: 'Claude',       ok: true,       configured: true,       usage,     }) `` -> `` null ``.
- Kept `` asks Anthropic again on the next refresh after Retry-After: 0 `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchClaudeQuota ``. Red with `` buildResult({       providerId: 'claude',       providerName: 'Claude',       ok: true,       configured: true,       usage,     }) `` -> `` null ``.
- Kept `` surfaces 5-hour, weekly, and MCP quota windows `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZaiQuota() `` -> `` null ``.
- Kept `` reports a z.ai business failure sent inside an HTTP 200 body `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZaiQuota() `` -> `` null ``.
- Kept `` maps CREDIT_LIMIT entries to windows with credit value labels and plan level `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZaiQuota() `` -> `` null ``.
- Kept `` attaches the nearest available gift reset to the matching windows `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZaiQuota() `` -> `` null ``.
- Kept `` keeps the quota result ok when the gift reset list request fails `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZaiQuota() `` -> `` null ``.
- Kept `` attaches no gift reset while only expired resets remain `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZaiQuota() `` -> `` null ``.
- Kept `` attaches no gift reset for an expired unavailable record `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZaiQuota() `` -> `` null ``.
- Kept `` rejects providers without gift reset support `` claims `` packages/vscode/src/quotaProviders.ts `` in `` activateQuotaGiftReset ``. Red with `` !ZAI_ALIASES.includes(providerId) `` -> `` !(!ZAI_ALIASES.includes(providerId)) ``.
- Kept `` posts the activation request with a fresh requestId `` claims `` packages/vscode/src/quotaProviders.ts `` in `` activateQuotaGiftReset ``. Red with `` !ZAI_ALIASES.includes(providerId) `` -> `` !(!ZAI_ALIASES.includes(providerId)) ``.
- Kept `` threads the record grantType into the activation request unchanged `` claims `` packages/vscode/src/quotaProviders.ts `` in `` activateQuotaGiftReset ``. Red with `` !ZAI_ALIASES.includes(providerId) `` -> `` !(!ZAI_ALIASES.includes(providerId)) ``.
- Kept `` rejects an explicitly invalid grantType before any request `` claims `` packages/vscode/src/quotaProviders.ts `` in `` activateQuotaGiftReset ``. Red with `` !ZAI_ALIASES.includes(providerId) `` -> `` !(!ZAI_ALIASES.includes(providerId)) ``.
- Kept `` throws the API message when activation is rejected `` claims `` packages/vscode/src/quotaProviders.ts `` in `` activateQuotaGiftReset ``. Red with `` !ZAI_ALIASES.includes(providerId) `` -> `` !(!ZAI_ALIASES.includes(providerId)) ``.
- Kept `` maps CREDIT_LIMIT entries to 5-hour and weekly windows with credit labels and plan level `` claims `` packages/vscode/src/quotaProviders.ts `` in `` resolveZhipuaiUsedPercent ``. Red with `` percentage `` -> `` null ``.
- Kept `` still maps legacy TOKENS_LIMIT entries without credit labels `` claims `` packages/vscode/src/quotaProviders.ts `` in `` resolveZhipuaiUsedPercent ``. Red with `` percentage !== null `` -> `` !(percentage !== null) ``.
- Kept `` derives the used percent from currentValue/usage when percentage is missing `` claims `` packages/vscode/src/quotaProviders.ts `` in `` resolveZhipuaiUsedPercent ``. Red with `` percentage !== null `` -> `` !(percentage !== null) ``.
- Kept `` surfaces business failures reported inside HTTP 200 bodies `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZhipuaiCodingPlanQuota() `` -> `` null ``.
- Kept `` treats a null code without success:false as success `` claims `` packages/vscode/src/quotaProviders.ts `` in `` resolveZhipuaiUsedPercent ``. Red with `` percentage !== null `` -> `` !(percentage !== null) ``.
- Kept `` falls back to the code when the envelope message is not text `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZhipuaiCodingPlanQuota() `` -> `` null ``.
- Kept `` falls back to the code when the envelope carries no message `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchZhipuaiCodingPlanQuota() `` -> `` null ``.
- Kept `` builds subscription window keyed by plan name (windowSeconds null) `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` typeof subscription.plan === 'string' && subscription.plan.trim() `` -> `` !(typeof subscription.plan === 'string' && subscription.plan.trim()) ``.
- Kept `` falls back to plan_limit title when plan is missing `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` typeof subscription.plan === 'string' && subscription.plan.trim() `` -> `` !(typeof subscription.plan === 'string' && subscription.plan.trim()) ``.
- Kept `` marks in-overage subscription as 100%, still shows credits `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` typeof subscription.plan === 'string' && subscription.plan.trim() `` -> `` !(typeof subscription.plan === 'string' && subscription.plan.trim()) ``.
- Kept `` surfaces subscription and allowance windows (allowance keyed by period, percent value) `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` typeof subscription.plan === 'string' && subscription.plan.trim() `` -> `` !(typeof subscription.plan === 'string' && subscription.plan.trim()) ``.
- Kept `` uses allowance effective limit = min(limit, credits_remaining + spent) `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` limit !== null && creditsRemaining !== null `` -> `` !(limit !== null && creditsRemaining !== null) ``.
- Kept `` binds allowance ceiling to limit when limit < credits_remaining + spent `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` spent !== null && effectiveLimit !== null && effectiveLimit > 0 `` -> `` !(spent !== null && effectiveLimit !== null && effectiveLimit > 0) ``.
- Kept `` uses weekly as the allowance key when period is weekly `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` (period === 'daily' \|\| period === 'weekly' \|\| period === 'monthly' \|\| period === 'month') `` -> `` !((period === 'daily' \|\| period === 'weekly' \|\| period === 'monthly' \|\| period === 'month')) ``.
- Kept `` uses daily as the allowance key when period is daily `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` (period === 'daily' \|\| period === 'weekly' \|\| period === 'monthly' \|\| period === 'month') `` -> `` !((period === 'daily' \|\| period === 'weekly' \|\| period === 'monthly' \|\| period === 'month')) ``.
- Kept `` falls back to billing_cycle when allowance period is missing or unknown `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` spent !== null && effectiveLimit !== null && effectiveLimit > 0 `` -> `` !(spent !== null && effectiveLimit !== null && effectiveLimit > 0) ``.
- Kept `` marks blocked allowance as 100% with percent value `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` (period === 'daily' \|\| period === 'weekly' \|\| period === 'monthly' \|\| period === 'month') `` -> `` !((period === 'daily' \|\| period === 'weekly' \|\| period === 'monthly' \|\| period === 'month')) ``.
- Kept `` falls back to credits_balance when neither subscription nor allowance exists `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` subscription `` -> `` !(subscription) ``.
- Kept `` maps 401 to session-expired `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` buildResult({         providerId: 'neuralwatt',         providerName: 'NeuralWatt',         ok: false,         configured: true,         error: response.status === 401           ? 'Session expired — please re-authenticate with NeuralWatt'           : `API error: ${response.status}`,       }) `` -> `` null ``.
- Kept `` reports invalid-response on JSON parse failure `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` buildResult({       providerId: 'neuralwatt',       providerName: 'NeuralWatt',       ok: false,       configured: true,       error: isTimeout         ? 'Request timed out'         : isParseError           ? 'Invalid response from provider'           : (error instanceof Error ? error.message : 'Request failed'),     }) `` -> `` null ``.
- Kept `` returns no-quota-data on a 200 payload with no usable windows `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNeuralwattQuota ``. Red with `` subscription `` -> `` !(subscription) ``.
- Kept `` shows a negative stripe_balance as spendable credit `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepinfraQuota ``. Red with `` stripeBalance === null `` -> `` !(stripeBalance === null) ``.
- Kept `` shows a positive stripe_balance as money owed `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepinfraQuota ``. Red with `` stripeBalance === null `` -> `` !(stripeBalance === null) ``.
- Kept `` treats a blank balance as missing data, not as $0.00 `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepinfraQuota ``. Red with `` stripeBalance === null `` -> `` !(stripeBalance === null) ``.
- Kept `` asks to re-authenticate on 401 `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepinfraQuota ``. Red with `` buildResult({         providerId: 'deepinfra',         providerName: 'DeepInfra',         ok: false,         configured: true,         error: response.status === 401 \|\| response.status === 403           ? 'Session expired — please re-authenticate with DeepInfra'           : `API error: ${response.status}`,       }) `` -> `` null ``.
- Kept `` builds credits_balance window from documented USD payload (string balance) `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepseekQuota ``. Red with `` Array.isArray(payload?.balance_infos) `` -> `` !(Array.isArray(payload?.balance_infos)) ``.
- Kept `` falls back to CNY entry with ¥ symbol when no USD entry is present `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepseekQuota ``. Red with `` Array.isArray(payload?.balance_infos) `` -> `` !(Array.isArray(payload?.balance_infos)) ``.
- Kept `` reports no quota data instead of guessing a currency it does not know `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepseekQuota ``. Red with `` 'No quota data in response' `` -> `` '' ``.
- Kept `` selects CNY entry when USD balance is zero and CNY balance is positive `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepseekQuota ``. Red with `` Array.isArray(payload?.balance_infos) `` -> `` !(Array.isArray(payload?.balance_infos)) ``.
- Kept `` prefers USD entry when both USD and CNY have positive balance `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepseekQuota ``. Red with `` Array.isArray(payload?.balance_infos) `` -> `` !(Array.isArray(payload?.balance_infos)) ``.
- Kept `` maps 401 to session-expired `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepseekQuota ``. Red with `` buildResult({         providerId: 'deepseek',         providerName: 'DeepSeek',         ok: false,         configured: true,         error: response.status === 401 \|\| response.status === 403           ? 'Session expired — please re-authenticate with DeepSeek'           : `API error: ${response.status}`,       }) `` -> `` null ``.
- Kept `` reports a normalized timeout error `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepseekQuota ``. Red with `` buildResult({       providerId: 'deepseek',       providerName: 'DeepSeek',       ok: false,       configured: true,       error: isTimeout         ? 'Request timed out'         : isParseError           ? 'Invalid response from provider'           : (error instanceof Error ? error.message : 'Request failed'),     }) `` -> `` null ``.
- Kept `` returns no-quota-data on a 200 payload with no usable balance `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepseekQuota ``. Red with `` 'No quota data in response' `` -> `` '' ``.
- Kept `` keeps a literal zero balance as a valid valueLabel `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchDeepseekQuota ``. Red with `` Array.isArray(payload?.balance_infos) `` -> `` !(Array.isArray(payload?.balance_infos)) ``.
- Kept `` keeps the planUsage path for Pro accounts `` claims `` packages/vscode/src/quotaProviders.ts `` in `` post / fetchCursorQuota ``. Red with `` fetchCursorConnect(path, accessToken, body) `` -> `` null ``.
- Kept `` reads the dashboard individual allowance when Enterprise request limits are null `` claims `` packages/vscode/src/quotaProviders.ts `` in `` post / fetchCursorQuota ``. Red with `` fetchCursorConnect(path, accessToken, body) `` -> `` null ``.
- Kept `` `does not turn a blank dashboard used into zero spend: ${JSON.stringify(used)}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` post / fetchCursorQuota ``. Red with `` fetchCursorConnect(path, accessToken, body) `` -> `` null ``.
- Kept `` falls back to auth/usage and team-scoped GetHardLimit for enterprise accounts `` claims `` packages/vscode/src/quotaProviders.ts `` in `` post / fetchCursorQuota ``. Red with `` fetchCursorConnect(path, accessToken, body) `` -> `` null ``.
- Kept `` reports on-demand spend from GetTeamSpend matched by userId `` claims `` packages/vscode/src/quotaProviders.ts `` in `` post / fetchCursorQuota ``. Red with `` fetchCursorConnect(path, accessToken, body) `` -> `` null ``.
- Kept `` picks the largest request bucket and skips metadata `` claims `` packages/vscode/src/quotaProviders.ts `` in `` post / fetchCursorQuota ``. Red with `` fetchCursorConnect(path, accessToken, body) `` -> `` null ``.
- Kept `` does not report success from plan name alone `` claims `` packages/vscode/src/quotaProviders.ts `` in `` post / fetchCursorQuota ``. Red with `` fetchCursorConnect(path, accessToken, body) `` -> `` null ``.
- Kept `` reports a disabled subscription as an error `` claims `` packages/vscode/src/quotaProviders.ts `` in `` post / fetchCursorQuota ``. Red with `` fetchCursorConnect(path, accessToken, body) `` -> `` null ``.
- Kept `` reads the monthly credit pool as a percentage with the reset time `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` buildResult({       providerId: 'ollama-cloud',       providerName: 'Ollama Cloud',       ok: true,       configured: true,       usage: { windows },       planLabel: plan,     }) `` -> `` null ``.
- Kept `` drops the plan label when /api/me fails, keeping the window `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` buildResult({       providerId: 'ollama-cloud',       providerName: 'Ollama Cloud',       ok: true,       configured: true,       usage: { windows },       planLabel: plan,     }) `` -> `` null ``.
- Kept `` `maps the monthly pool ${JSON.stringify(included)}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` buildResult({       providerId: 'ollama-cloud',       providerName: 'Ollama Cloud',       ok: true,       configured: true,       usage: { windows },       planLabel: plan,     }) `` -> `` null ``.
- Kept `` omits the reset when the payload carries no period `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` buildResult({       providerId: 'ollama-cloud',       providerName: 'Ollama Cloud',       ok: true,       configured: true,       usage: { windows },       planLabel: plan,     }) `` -> `` null ``.
- Kept `` maps a legacy plan session and weekly limit into windows `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` buildResult({       providerId: 'ollama-cloud',       providerName: 'Ollama Cloud',       ok: true,       configured: true,       usage: { windows },       planLabel: plan,     }) `` -> `` null ``.
- Kept `` clamps and skips an unusable legacy limit `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` buildResult({       providerId: 'ollama-cloud',       providerName: 'Ollama Cloud',       ok: true,       configured: true,       usage: { windows },       planLabel: plan,     }) `` -> `` null ``.
- Kept `` shows purchased credit only while it is positive `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` buildResult({       providerId: 'ollama-cloud',       providerName: 'Ollama Cloud',       ok: true,       configured: true,       usage: { windows },       planLabel: plan,     }) `` -> `` null ``.
- Kept `` `rejects a response without a usable pool: ${JSON.stringify(body)}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` false `` -> `` true ``.
- Kept `` `reports an auth failure for HTTP ${status}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` false `` -> `` true ``.
- Kept `` `reports HTTP ${status} without calling it an auth failure` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` false `` -> `` true ``.
- Kept `` `reports ${failure.message}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` false `` -> `` true ``.
- Kept `` does not request usage without an API key `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` false `` -> `` true ``.
- Kept `` reports response body failures `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchOllamaCloudQuota ``. Red with `` false `` -> `` true ``.
- Kept `` `formats balance ${JSON.stringify(balance)} without an untranslated unit` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchHyperQuota ``. Red with `` Number.isFinite(rawBalance) `` -> `` !(Number.isFinite(rawBalance)) ``.
- Kept `` `rejects invalid payload ${JSON.stringify(payload)} instead of showing zero` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchHyperQuota ``. Red with `` Number.isFinite(rawBalance) `` -> `` !(Number.isFinite(rawBalance)) ``.
- Kept `` `uses validated credential variant ${index} for the documented request` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchHyperQuota ``. Red with `` Number.isFinite(rawBalance) `` -> `` !(Number.isFinite(rawBalance)) ``.
- Kept `` `does not request usage with missing or invalid credential variant ${index}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchHyperQuota ``. Red with `` false `` -> `` true ``.
- Kept `` `reports HTTP ${status} as a failure` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchHyperQuota ``. Red with `` buildResult({         providerId: 'hyper',         providerName: 'Charm Hyper',         ok: false,         configured: true,         error: response.status === 401 \|\| response.status === 403           ? 'Session expired — please re-authenticate with Charm Hyper'           : `API error: ${response.status}`,       }) `` -> `` null ``.
- Kept `` reports invalid JSON as a parse failure `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchHyperQuota ``. Red with `` buildResult({       providerId: 'hyper',       providerName: 'Charm Hyper',       ok: false,       configured: true,       error: isTimeout         ? 'Request timed out'         : isParseError           ? 'Invalid response from provider'           : (error instanceof Error ? error.message : 'Request failed'),     }) `` -> `` null ``.
- Kept `` `reports ${message}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchHyperQuota ``. Red with `` buildResult({       providerId: 'hyper',       providerName: 'Charm Hyper',       ok: false,       configured: true,       error: isTimeout         ? 'Request timed out'         : isParseError           ? 'Invalid response from provider'           : (error instanceof Error ? error.message : 'Request failed'),     }) `` -> `` null ``.
- Kept `` `tries the next credential after HTTP ${status} and failed balance` `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-global', 'kimi', 'kimi-for-coding', 'kimi-code-plan-cn']; ``.
- Kept `` reports the preferred error after every key is rejected `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-global', 'kimi', 'kimi-for-coding', 'kimi-code-plan-cn']; ``.
- Kept `` deduplicates keys at the same endpoint while preserving regional candidates `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-global', 'kimi', 'kimi-for-coding', 'kimi-code-plan-cn']; ``.
- Kept `` stays configured when only a later alias holds a usable key `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` `does not switch accounts after HTTP ${status}` `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` `does not switch accounts after a ${failure} failure` `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` returns a successful Moonshot balance before trying another credential `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-global', 'kimi', 'kimi-for-coding', 'kimi-code-plan-cn']; ``.
- Kept `` `honors the ${expired} deadline during body reads` `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-global', 'kimi', 'kimi-for-coding', 'kimi-code-plan-cn']; ``.
- Kept `` finds a China plan credential stored under kimi-code-plan-cn `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchKimiQuota ``. Red with `` true `` -> `` false ``.
- Kept `` prefers the China plan credential over a leftover pre-split kimi-for-coding key `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-global', 'kimi', 'kimi-for-coding', 'kimi-code-plan-cn']; ``.
- Kept `` still reads the global plan and the pre-split ids when they are the only credential `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` skips a blank key and uses the token next to it `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const entry = normalizeAuthEntry(auth[alias] ?? null);     const apiKey = asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token); `` -> `` const entry = normalizeAuthEntry(auth[alias] ?? null);     const apiKey = asNonEmptyString(entry?.key); ``.
- Kept `` keeps a pre-split key ahead of the global plan, as before `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-global', 'kimi', 'kimi-for-coding', 'kimi-code-plan-cn']; ``.
- Kept `` shows the pay-as-you-go balance when the Kimi Code address refuses a platform key `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` keeps the original 401 when the balance read fails too `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` treats a 403 from the Kimi Code address like a 401 `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` reads the 5h and monthly ratios and ignores the duplicate limits[] entry `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` reports the monthly row as a plain percent so it follows the used/remaining setting `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` maps limit_7d to the weekly window when the plan still serves it `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` keeps a zero ratio and skips an entry without one `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` still reads the counted payload from plans that have not migrated `` claims `` packages/vscode/src/quotaProviders.ts ``. Red with `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global']; `` -> `` const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn']; ``.
- Kept `` reads daily and weekly token quotas with millisecond reset times `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNanoGptQuota ``. Red with `` payload.dailyInputTokens !== undefined `` -> `` !(payload.dailyInputTokens !== undefined) ``.
- Kept `` reads a weekly-only subscription and computes usage from its top-level limit `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNanoGptQuota ``. Red with `` 'weekly' `` -> `` '' ``.
- Kept `` prefers current daily quotas over legacy fields and uses the token limit `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNanoGptQuota ``. Red with `` payload.dailyInputTokens !== undefined `` -> `` !(payload.dailyInputTokens !== undefined) ``.
- Kept `` keeps unavailable quota reads unknown `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNanoGptQuota ``. Red with `` payload.dailyInputTokens !== undefined `` -> `` !(payload.dailyInputTokens !== undefined) ``.
- Kept `` preserves zero and clamps exhausted quotas `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNanoGptQuota ``. Red with `` payload.dailyInputTokens !== undefined `` -> `` !(payload.dailyInputTokens !== undefined) ``.
- Kept `` preserves legacy daily and monthly response support `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNanoGptQuota ``. Red with `` payload.dailyInputTokens !== undefined `` -> `` !(payload.dailyInputTokens !== undefined) ``.
- Kept `` does not invent quotas when the account has none `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNanoGptQuota ``. Red with `` true `` -> `` false ``.
- Kept `` reports HTTP failures rather than empty success `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNanoGptQuota ``. Red with `` false `` -> `` true ``.
- Kept `` does not revive a legacy daily cap when the current cap is null `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchNanoGptQuota ``. Red with `` payload.dailyInputTokens !== undefined `` -> `` !(payload.dailyInputTokens !== undefined) ``.
- Kept `` rejects malformed quota responses instead of reporting empty success `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchQuotaForProviderUncoalesced ``. Red with `` fetchNanoGptQuota() `` -> `` null ``.
- Kept `` builds credits_balance from the documented PAYG payload `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchZenmuxQuota ``. Red with `` Number.isFinite(rawCredits) `` -> `` !(Number.isFinite(rawCredits)) ``.
- Kept `` `accepts finite total_credits ${JSON.stringify(totalCredits)}` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchZenmuxQuota ``. Red with `` Number.isFinite(rawCredits) `` -> `` !(Number.isFinite(rawCredits)) ``.
- Kept `` `rejects invalid payload ${JSON.stringify(payload)} instead of showing zero` `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchZenmuxQuota ``. Red with `` Number.isFinite(rawCredits) `` -> `` !(Number.isFinite(rawCredits)) ``.
- Kept `` does not request usage without a Platform API key `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchZenmuxQuota ``. Red with `` false `` -> `` true ``.
- Kept `` reports HTTP 401 as an invalid Platform API key `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchZenmuxQuota ``. Red with `` buildResult({         providerId: 'zenmux',         providerName: 'ZenMux',         ok: false,         configured: true,         error: response.status === 401 \|\| response.status === 403           ? 'Invalid ZenMux Platform API key'           : `API error: ${response.status}`,       }) `` -> `` null ``.
- Kept `` reports invalid JSON as a parse failure `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchZenmuxQuota ``. Red with `` buildResult({       providerId: 'zenmux',       providerName: 'ZenMux',       ok: false,       configured: true,       error: isTimeout         ? 'Request timed out'         : isParseError           ? 'Invalid response from provider'           : (error instanceof Error ? error.message : 'Request failed'),     }) `` -> `` null ``.
- Kept `` builds credits_balance from the documented balance payload `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchKiloQuota ``. Red with `` organizationId `` -> `` !(organizationId) ``.
- Kept `` sends the organization header from the auth entry `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchKiloQuota ``. Red with `` organizationId `` -> `` !(organizationId) ``.
- Kept `` falls back to OpenCode provider options when auth has no organization `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchKiloQuota ``. Red with `` organizationId `` -> `` !(organizationId) ``.
- Kept `` accepts a literal zero balance `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchKiloQuota ``. Red with `` Number.isFinite(rawBalance) `` -> `` !(Number.isFinite(rawBalance)) ``.
- Kept `` rejects a missing balance instead of showing zero `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchKiloQuota ``. Red with `` balance === null `` -> `` !(balance === null) ``.
- Kept `` does not request usage without a valid credential `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchKiloQuota ``. Red with `` false `` -> `` true ``.
- Kept `` reports HTTP 401 as session expired `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchKiloQuota ``. Red with `` buildResult({         providerId: 'kilo',         providerName: 'Kilo Code',         ok: false,         configured: true,         error: response.status === 401 \|\| response.status === 403           ? 'Session expired — please re-authenticate with Kilo Code'           : `API error: ${response.status}`,       }) `` -> `` null ``.
- Kept `` reads usage with the stored access token while it is still valid `` claims `` packages/vscode/src/quotaProviders.ts `` in `` requireXaiAccessToken ``. Red with `` !access \|\| xaiAccessExpired(entry) `` -> `` !(!access \|\| xaiAccessExpired(entry)) ``.
- Kept `` never exchanges the rotating refresh token when the access token is expired `` claims `` packages/vscode/src/quotaProviders.ts `` in `` requireXaiAccessToken ``. Red with `` !access \|\| xaiAccessExpired(entry) `` -> `` !(!access \|\| xaiAccessExpired(entry)) ``.
- Kept `` reports a missing credential as unconfigured without contacting xAI `` claims `` packages/vscode/src/quotaProviders.ts `` in `` fetchXaiQuota ``. Red with `` false `` -> `` true ``.
- Kept `` reads the shared billing reader with the stored key `` claims `` packages/vscode/src/quotaProviders.ts `` in `` openCodeGoConsoleCredential ``. Red with `` !entry \|\| entry.type !== 'oauth' `` -> `` !(!entry \|\| entry.type !== 'oauth') ``.

## sessionNotifications.test.ts

- Kept `` a finished turn shows a VS Code notification with an action that opens the session `` claims `` packages/vscode/src/sessionNotifications.ts `` in `` createSessionNotifier ``. Red with `` picked === deps.openSessionLabel `` -> `` !(picked === deps.openSessionLabel) ``.
- Kept `` dismissing the notification opens nothing `` claims `` packages/vscode/src/sessionNotifications.ts `` in `` createSessionNotifier ``. Red with `` picked === deps.openSessionLabel `` -> `` !(picked === deps.openSessionLabel) ``.
- Kept `` stays quiet while the chat is in view, unless the user asked to be notified while focused `` claims `` packages/vscode/src/sessionNotifications.ts `` in `` createSessionNotifier ``. Red with `` requireHidden && deps.isChatAttended() `` -> `` !(requireHidden && deps.isChatAttended()) ``.
- Kept `` every open chat reports the same event; it shows once `` claims `` packages/vscode/src/sessionNotifications.ts `` in `` createSessionNotifier ``. Red with `` requireHidden && deps.isChatAttended() `` -> `` !(requireHidden && deps.isChatAttended()) ``.
- Kept `` the settings test notification shows on every press, without an action `` claims `` packages/vscode/src/sessionNotifications.ts `` in `` createSessionNotifier ``. Red with `` requireHidden && deps.isChatAttended() `` -> `` !(requireHidden && deps.isChatAttended()) ``.

## settings-files.test.ts

- Kept `` rejects invalid JSON `` claims `` packages/vscode/src/settings-files.ts `` in `` parsePreferencesDocument ``. Red with `` false `` -> `` true ``.
- Kept `` rejects a wrong version `` claims `` packages/vscode/src/settings-files.ts `` in `` parsePreferencesDocument ``. Red with `` 'not a version-1 preferences document' `` -> `` '' ``.
- Kept `` rejects non-object fields `` claims `` packages/vscode/src/settings-files.ts `` in `` parsePreferencesDocument ``. Red with `` !isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields) `` -> `` !(!isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields)) ``.
- Kept `` rejects an entry without a value `` claims `` packages/vscode/src/settings-files.ts `` in `` parsePreferencesDocument ``. Red with `` !isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields) `` -> `` !(!isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields)) ``.
- Kept `` accepts an empty document and defaults a missing stamp to 0 `` claims `` packages/vscode/src/settings-files.ts `` in `` parsePreferencesDocument ``. Red with `` !isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields) `` -> `` !(!isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields)) ``.
- Kept `` keeps the stamp for unchanged values and restamps changed ones `` claims `` packages/vscode/src/settings-files.ts `` in `` buildPreferencesFields ``. Red with `` value === undefined \|\| !isProfileSettingsKey(key) `` -> `` !(value === undefined \|\| !isProfileSettingsKey(key)) ``.
- Kept `` compares structurally, so an equal object keeps its stamp `` claims `` packages/vscode/src/settings-files.ts `` in `` buildPreferencesFields ``. Red with `` value === undefined \|\| !isProfileSettingsKey(key) `` -> `` !(value === undefined \|\| !isProfileSettingsKey(key)) ``.
- Kept `` drops profile keys the document no longer carries and ignores non-profile keys `` claims `` packages/vscode/src/settings-files.ts `` in `` buildPreferencesFields ``. Red with `` value === undefined \|\| !isProfileSettingsKey(key) `` -> `` !(value === undefined \|\| !isProfileSettingsKey(key)) ``.
- Kept `` skips undefined values `` claims `` packages/vscode/src/settings-files.ts `` in `` buildPreferencesFields ``. Red with `` value === undefined \|\| !isProfileSettingsKey(key) `` -> `` !(value === undefined \|\| !isProfileSettingsKey(key)) ``.
- Kept `` excludes profile keys and keeps instance and unknown legacy keys `` claims `` packages/vscode/src/settings-files.ts `` in `` instancePartOf ``. Red with `` value === undefined \|\| isProfileSettingsKey(key) `` -> `` !(value === undefined \|\| isProfileSettingsKey(key)) ``.
- Kept `` classify keys by the checked-in registry snapshot `` claims `` packages/vscode/src/settings-files.ts `` in `` isProfileSettingsKey ``. Red with `` === `` -> `` !== ``.
- Kept `` preferences.json sits beside settings.json `` claims `` packages/vscode/src/settings-files.ts ``. Red with `` const PREFERENCES_FILE_NAME = 'preferences.json'; `` -> `` const PREFERENCES_FILE_NAME = 'settings.json'; ``.
- Kept `` serialize then parse yields the same fields, and flatten yields the values `` claims `` packages/vscode/src/settings-files.ts `` in `` parsePreferencesDocument ``. Red with `` !isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields) `` -> `` !(!isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields)) ``.
- Kept `` the snapshot names at least one per-surface profile key `` claims `` packages/vscode/src/settings-files.ts `` in `` isPerSurfaceSettingsKey ``. Red with `` && `` -> `` \|\| ``.
- Kept `` a surface write lands under the surface and leaves the base as it was `` claims `` packages/vscode/src/settings-files.ts `` in `` buildPreferencesFields ``. Red with `` changed && !changed.has(key) `` -> `` !(changed && !changed.has(key)) ``.
- Kept `` a per-surface key the write did not change keeps its whole entry `` claims `` packages/vscode/src/settings-files.ts `` in `` buildPreferencesFields ``. Red with `` options.changedKeys `` -> `` !(options.changedKeys) ``.
- Kept `` a per-surface key first set from one surface has no base `` claims `` packages/vscode/src/settings-files.ts `` in `` parsePreferencesDocument ``. Red with `` !isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields) `` -> `` !(!isPlainObject(parsed) \|\| parsed.version !== PREFERENCES_DOCUMENT_VERSION \|\| !isPlainObject(parsed.fields)) ``.
- Kept `` a write whose view never held a per-surface key keeps the other surfaces' values `` claims `` packages/vscode/src/settings-files.ts `` in `` buildPreferencesFields ``. Red with `` key in fields \|\| !isPerSurfaceSettingsKey(key) `` -> `` !(key in fields \|\| !isPerSurfaceSettingsKey(key)) ``.
- Kept `` rejects an unknown surface in the file `` claims `` packages/vscode/src/settings-files.ts `` in `` parsePreferencesDocument ``. Red with `` !isSettingsSurface(surface) \|\| !isPlainObject(surfaceEntry) \|\| !('value' in surfaceEntry) `` -> `` !(!isSettingsSurface(surface) \|\| !isPlainObject(surfaceEntry) \|\| !('value' in surfaceEntry)) ``.

## settings-registry-gate.test.ts

- Kept `` withholds secret keys and keeps everything else `` claims `` packages/vscode/src/settings-registry-gate.ts `` in `` withoutSecretSettings ``. Red with `` fields[key]?.secret === true `` -> `` !(fields[key]?.secret === true) ``.
- Kept `` the real registry marks the UI password and tunnel tokens secret `` claims `` packages/vscode/src/settings-registry-gate.ts `` in `` withoutSecretSettings ``. Red with `` fields[key]?.secret === true `` -> `` !(fields[key]?.secret === true) ``.
- Kept `` accepts archived-only retention in the shared instance settings `` claims `` packages/vscode/src/settings-registry-gate.ts `` in `` filterPersistableSettingsChanges ``. Red with `` !Object.prototype.hasOwnProperty.call(fields, key) `` -> `` !(!Object.prototype.hasOwnProperty.call(fields, key)) ``.
- Kept `` keeps stored shared fields and preserves their values as sent `` claims `` packages/vscode/src/settings-registry-gate.ts ``. Red with ``     if (!Object.prototype.hasOwnProperty.call(fields, key)) continue; `` -> ``     if (!Object.prototype.hasOwnProperty.call(fields, key)) { next[key] = value; continue; } ``.
- Kept `` drops keys the registry does not know `` claims `` packages/vscode/src/settings-registry-gate.ts ``. Red with ``     if (!Object.prototype.hasOwnProperty.call(fields, key)) continue; `` -> ``     if (!Object.prototype.hasOwnProperty.call(fields, key)) { next[key] = value; continue; } ``.
- Kept `` drops computed, local, and desktop-shell owned keys `` claims `` packages/vscode/src/settings-registry-gate.ts `` in `` filterPersistableSettingsChanges ``. Red with `` !Object.prototype.hasOwnProperty.call(fields, key) `` -> `` !(!Object.prototype.hasOwnProperty.call(fields, key)) ``.
- Kept `` ignores prototype keys that are not registry fields `` claims `` packages/vscode/src/settings-registry-gate.ts ``. Red with ``     if (!Object.prototype.hasOwnProperty.call(fields, key)) continue; `` -> ``     if (!Object.prototype.hasOwnProperty.call(fields, key)) { next[key] = value; continue; } ``.
- Kept `` the checked-in snapshot drops derived-at-read and desktop-shell keys but keeps profile settings `` claims `` packages/vscode/src/settings-registry-gate.ts ``. Red with ``     if (!Object.prototype.hasOwnProperty.call(fields, key)) continue; `` -> ``     if (!Object.prototype.hasOwnProperty.call(fields, key)) { next[key] = value; continue; } ``.

## sseProxy.test.js

- Kept `` forwards upstream SSE chunks without reserializing event data `` claims `` packages/vscode/src/sseProxy.ts `` in `` openSseProxy ``. Red with `` await pipeSseResponse(activeResponse, signal, onChunk, stallTimeoutMs); `` -> `` ; ``.
- Kept `` keeps the caller's query on the single v2 event stream `` claims `` packages/vscode/src/sseProxy.ts `` in `` createSseUrl ``. Red with `` url.searchParams.append(key, value); `` -> `` ; ``.

## sseProxy.test.ts

- Rewritten `` closes a quiet upstream SSE stream after the stall timeout `` claims `` packages/vscode/src/sseProxy.ts ``. Red with ``     try {       await pipeSseResponse(activeResponse, signal, onChunk, stallTimeoutMs); `` -> ``     try { ``.
- Rewritten `` resets the stall timeout when upstream bytes arrive `` claims `` packages/vscode/src/sseProxy.ts ``. Red with ``       if (value && value.length > 0) {         resetStallTimer(); `` -> ``       if (value && value.length > 0) { ``.

## viteConfig.test.ts

- Rewritten `` bundles worker imports into one file `` claims `` packages/vscode/vite.config.ts ``. Red with `` inlineDynamicImports: true `` -> `` inlineDynamicImports: false ``.

## webviewHtml.test.ts

- Rewritten `` allows blob URLs for workers without allowing blob scripts `` claims `` packages/vscode/src/webviewHtml.ts ``. Red with `` const workerSrc = uniqueTokens([webview.cspSource, 'blob:', devServerOrigin]); `` -> `` const workerSrc = uniqueTokens([webview.cspSource, devServerOrigin]); ``. Rewrite moved to `` packages/vscode/src/SessionEditorPanelProvider.newSession.test.js ``.
- Rewritten `` installs a CSP document before changing sidebar webview options `` claims `` packages/vscode/src/ChatViewProvider.ts ``. Red with ``     webviewView.webview.html = getCspBootstrapHtml(); `` -> ``  ``. Rewrite moved to `` packages/vscode/src/SessionEditorPanelProvider.newSession.test.js ``.

## workingDirectoryChange.test.js

- Kept `` returns unchanged when the selected directory already matches `` claims `` packages/vscode/src/workingDirectoryChange.ts `` in `` resolveWorkingDirectoryChange ``. Red with `` false `` -> `` true ``.
- Kept `` updates the directory without requiring an OpenCode server restart `` claims `` packages/vscode/src/workingDirectoryChange.ts `` in `` resolveWorkingDirectoryChange ``. Red with `` true `` -> `` false ``.
- Kept `` trims the selected directory before comparing `` claims `` packages/vscode/src/workingDirectoryChange.ts `` in `` resolveWorkingDirectoryChange ``. Red with `` true `` -> `` false ``.

## workspaceResolver.test.js

- Kept `` returns an empty list without throwing `` claims `` packages/vscode/src/workspaceResolver.ts ``. Red with `` const seen = new Map<string, WorkspaceFolderCandidate>(); `` -> `` const seen = new Map<string, WorkspaceFolderCandidate>([['', { name: '', path: '' }]]); ``.
- Kept `` preserves its name and path `` claims `` packages/vscode/src/workspaceResolver.ts ``. Red with `` const seen = new Map<string, WorkspaceFolderCandidate>(); `` -> `` const seen = new Map<string, WorkspaceFolderCandidate>([['', { name: '', path: '' }]]); ``.
- Kept `` returns them sorted alphabetically by name, case-insensitive `` claims `` packages/vscode/src/workspaceResolver.ts ``. Red with `` const seen = new Map<string, WorkspaceFolderCandidate>(); `` -> `` const seen = new Map<string, WorkspaceFolderCandidate>([['', { name: '', path: '' }]]); ``.
- Kept `` keeps only the first occurrence and discards duplicates by path `` claims `` packages/vscode/src/workspaceResolver.ts ``. Red with `` const seen = new Map<string, WorkspaceFolderCandidate>(); `` -> `` const seen = new Map<string, WorkspaceFolderCandidate>([['', { name: '', path: '' }]]); ``.
- Kept `` strips them from every returned path `` claims `` packages/vscode/src/workspaceResolver.ts ``. Red with `` const seen = new Map<string, WorkspaceFolderCandidate>(); `` -> `` const seen = new Map<string, WorkspaceFolderCandidate>([['', { name: '', path: '' }]]); ``.
- Kept `` treats paths that differ only by trailing separators as the same folder `` claims `` packages/vscode/src/workspaceResolver.ts ``. Red with `` const seen = new Map<string, WorkspaceFolderCandidate>(); `` -> `` const seen = new Map<string, WorkspaceFolderCandidate>([['', { name: '', path: '' }]]); ``.
