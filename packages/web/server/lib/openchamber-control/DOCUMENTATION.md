# OpenChamber Control Service

## Purpose

This module owns the typed control contract shared by the OpenChamber CLI and
the managed OpenCode `openchamber` tool. Both adapters delegate to
`createOpenChamberControlService()`; neither adapter may call or spawn the
other.

## Boundaries

- `service.js` validates and executes the fixed project, model, session, and
  scheduled-task action allowlist. `actions.js` marks CLI-only actions with
  `agentExposed: false` (currently `schedule.status`); the agent tool consumes
  the filtered `OPENCHAMBER_AGENT_TOOL_*` exports. `schedule.toggle` requires
  the `disabled` boolean and replaces separate enable/disable actions; its
  `enabled` is the saved state, never the requested one. Loop tasks and the
  refusal to enable a repository loop are the scheduled-task service's rules
  (`../scheduled-tasks/DOCUMENTATION.md`, *Local approval*).
  `schedule.list` also returns scheduler status as `scheduler`.
  `schedule.update` patches a task in place: only the fields the call names
  change, the id and run state stay, and a task driven by a loop file is
  refused (the file is its source).
  `schedule.create` and `schedule.update` accept `targetSessionId`, validated
  by the scheduled-task service. An empty update clears the target. Create
  without a model inherits the target selection; an explicit agent overrides
  it. A task without a target still requires a model.
- `project-knowledge.js` runs the `knowledge.*` actions of the
  `openchamber_knowledge` agent tool (`list`, `save`, `delete`, `show`;
  `kind` names note, todo or plan) against
  `../project-context/runtime.js`. The owner is the session directory (or the
  given `projectId` / `directory`) resolved by the same resolver session
  knowledge and memory use, so what an agent writes is what the next session
  is given. Notes it creates are `source: agent` with the calling session as
  origin; payload provenance is ignored. Plans are handed out as file paths
  (`list`, and the answer to `save`), never as text: the agent reads a plan
  and makes small edits, such as ticking a step, with its own file tools, and
  `save` creates or replaces one whole. `expected` guards a replacement only:
  a save that carries it without an `id` is a 400, never a silently ignored
  conflict check. The actions answer `403` while
  `agentKnowledgeToolEnabled` is `false`. `show` checks the plan exists and
  sends `openchamber:plan-open-request` to every connected window, like
  `file.open`; every layout opens the plan the way a click in the Project
  knowledge Plans list does: in place in the panel on desktop and web, in the
  drawer's plan viewer on mobile. No
  window reached is `503`.
- `render-page.js` runs `render.page` for the `openchamber_render` agent tool. Only `html` is required: a page sent without a title is named after its own `<title>`, else its first h1 to h3, else "Page", with the same rule the chat uses (`renderedPage` in `packages/ui/src/lib/opencode/tools.ts`). Weaker models sent title and html in separate calls, each refused call costing the whole page again; a missing html now also asks for both in one call.
  The chat draws the page from the call's own input, so the action stores
  nothing: it checks `html` (at most 200,000 characters) and `title` (at most
  120) and answers `403` while `agentRenderToolEnabled` is `false`. With
  `awaitAnswer` the action waits in `createPageAnswers`, keyed by session and
  call id, until `answerPage` resolves it (`POST /api/openchamber/render/answer`
  from the chat: a summary of at most 500 characters and data of at most
  16,000 characters as JSON) or the request is aborted. Nothing outlives the
  call, so a second answer, an answer for a call that ended, and an answer
  after a server restart are a `404`, never a silent success.
  `onPageWaitChange` hears both ends of a wait. The server's wiring
  (`index.js`) lists the page with the session's pending requests
  (`trackWaitingPage` in `../opencode/session-runtime.js`), broadcasts
  `openchamber:page-waiting` / `openchamber:page-settled` to the clients, and
  sends the same "Input needed" notification a form gets.
  `renderPageImageSources` lists the local images a page names by absolute
  path (in quotes or a CSS `url()`, PNG, JPEG, GIF or WebP, at most 12). The
  image grant route (`../markdown-image-grants/`) allows exactly those, and the
  chat reads them with the same rule.
- `tier-chooser-card.js` builds the standardized `render.page` cards for the
  model tier chooser (`Select Execution Tier`, one tile per tier submitting
  `{ tier, model }`) and the quota fallback (`Quota Limit Reached`, tiles for
  switch-provider, downgrade-tier and wait-for-reset submitting
  `{ action: 'fallback', provider, tier }`). Pure helper: plain data in
  (tiers, models.dev pricing, quota context), an HTML document string out;
  pricing lookup stays with the caller. Every interpolated value is
  HTML-escaped, and styling uses the `font-sans` class with `--bg-base`,
  `--text-primary`, `--border-base` and `--accent-primary`.
- `routes.js` is the authenticated CLI HTTP adapter. It forwards one action,
  preserves service status and partial-result details, and propagates request
  cancellation. It also carries the chat's answer to a waiting page.
- `../agent-tool/runtime.js` is the managed-tool adapter. It wraps service
  results in the versioned native-tool envelope and uses a separate ephemeral
  loopback credential.
- `../openchamber-sessions/routes.js` and `../scheduled-tasks/service.js` own
  their domain operations and are composed into this service.

## Invariants

- Session status and messages come from official directory-scoped OpenCode
  APIs. Message output includes only ordered `text` parts.
- Cursor walks always end: the message walk and the session-directory walk
  stop on an empty page, a missing or repeated cursor, or the
  `MAX_PAGES_PER_WALK` page cap, so a server that keeps handing out fresh
  cursors cannot loop them forever. Past the cap the message walk returns
  the partial history collected so far with `truncated: true` on the
  `session.messages` result, and directory resolution returns
  null (unresolved), never a fabricated complete result.
- Wait (CLI only; the agent tool refuses it) never treats an initial idle
  response as completion after dispatch. It requires observed activity or a
  newly completed assistant message.
- Timeout and cancellation are failures, never authoritative idle results.
- `returnResult` on create/send/fork hands the dispatched session's final
  answer back to the calling session (`options.contextSessionId`) through
  `../dispatch-results/`. It is checked before anything is created: it needs a
  calling session, a prompt, an injected `dispatchResults` (else 503), no
  `wait`, and a send may not target the caller itself. After the dispatch the
  result carries `resultDelivery`: `pending` with a note for the agent, or
  `not-scheduled` with the reason (the prompt never landed, or registering
  failed); the session keeps running either way, so neither is thrown.
- `returnResult` and `wait` must be booleans when present. Both are compared
  with `=== true`, so a string `"true"` (the tool path forwards raw JSON, and a
  model or harness can stringify a boolean) would read as false: a dispatch
  whose result is never delivered, or a wait that returns at once. A
  non-boolean is rejected with a 400 before anything is created, the same way
  `schedule.toggle` requires its `disabled` boolean.
- Validation that protects side effects runs before session creation or
  dispatch. An explicitly requested model, agent, or variant is checked against
  the directory's own OpenCode agent and provider lists before any session,
  worktree, or goal is created, because `prompt_async` accepts an unusable
  selection and then fails only on the event stream. A failed or empty lookup
  never turns a valid selection into a rejection.
- `promptDispatched` reports an observed dispatch, never an accepted request.
  After `prompt_async` the service confirms a new user message reached the
  session; when it does not, the result reports `promptDispatched: false` with
  `promptError` instead of claiming success.
- Send and fork dispatches without an explicit model/agent/variant reuse the
  target session's last user-message selection before falling back to the
  configured defaults; only session creation resolves defaults directly.
- `session.create` with `pullRequest` passes the number, `worktree` and
  `branch` as folder and local-branch names, and `branchOff` when given, to
  the session service, which creates the worktree through the injected
  `createChangeRequestWorktree` (the Git routes' contributor pipeline) before
  any session exists. It checks out the request's branch, or with `branchOff`
  starts a new branch from its head; without `branchOff` the profile setting
  `pullRequestWorktree` decides. A new branch is `branch`, else the
  `pullRequestBranchTemplate` (default `{name}-from-pr-{pr}`) filled with the
  worktree name, the number and the head. Without `worktree`, the control
  service names the worktree from the prompt as it does for any new worktree
  (`resolvePullRequestWorktreeName`); a checked-out request's worktree is
  named after its branch. A fork's request cannot be branched off (409).
  A malformed number or `branchOff`, or `startRef`/`setUpstream` beside it, is
  a 400; a server without that pipeline answers 501 and never makes a plain
  branch worktree instead; a provider or transfer refusal keeps its status and
  message, and no session is created.
- `session.moveToWorktree` moves a session into a new worktree of its
  repository and is the session service's `moveToWorktree`
  (`../openchamber-sessions/worktree-move.js`). The session defaults to the
  caller, the source directory to where that session lives (the global
  session list, else the call's directory), `worktree` names the folder and
  is required, `branch` and `startRef` are optional, and `existingBranch`
  checks out a branch that already exists in place of both. The worktree is made by
  the same `createWorktree` pipeline as `session.create`, waits for the same
  bootstrap, then the uncommitted changes of the files named in `carry`
  travel in one git stash applied by hash (nothing moves without it), and the
  session is moved last through OpenCode's
  `session.move`. A failure after the worktree exists removes it again and
  puts the changes back; when restoring fails too, the error names the stash
  so nothing is lost. A 409 means the changes did not apply on the start ref.
  Without `startRef` the move starts from the repository's default branch
  (its local copy first), or from the project root's HEAD when the `agent`
  start setting is `project-root`.
- A session created in a new worktree (`session.create` with `worktree` or
  `pullRequest`) or moved into one (`session.moveToWorktree`) starts in the same
  folder of that worktree as the project opens on in its repository: a project
  at `repo/ai` starts in `<worktree>/ai`, a project at the repository root
  starts at the worktree root (`../openchamber-sessions/worktree-start-directory.js`,
  the folder from `git rev-parse --show-prefix` through `resolveWorktreeTopLevel`).
  The result's `directory` is that folder and `worktree.path` stays the checkout
  root. When the checkout lacks the folder, it cannot be checked, or git cannot
  report the project's folder, the session starts at the worktree root and the
  result carries `startDirectoryFallback` (`missing`, `unverified` or `unknown`).
  The field is for API callers; the OpenChamber UI does not read it, because it
  resolves its own start folder and shows its own warning. `unknown` also covers a
  failed git read: `resolveWorktreeTopLevel` answers without a `prefix` then,
  which is never taken for "the project is at the repository root". For a move,
  the project is the registered project whose path contains the session's
  directory inside the same checkout (the longest one), so a session in
  `repo/ai/src` follows `repo/ai`. A session in another worktree, `<wtA>/ai/src`,
  lies in no project path; its folder in that checkout (`ai/src`) picks the
  longest registered project of the primary checkout whose folder holds it, so it
  also follows `repo/ai` when `repo` is registered too. A project around a
  worktree placed inside the repository folder (`repo/.worktrees/a`) does not
  count as containing it. The UI applies the same rule
  (`projectPathForCheckoutFolder`). A requested agent or model is validated in the
  directory the request names, the project's own folder, as before: a new worktree
  does not exist yet, and its start folder mirrors that one. Git work (carrying
  changes, removal) stays on the worktree root.
- Default agents resolve from the owning project before global settings and
  OpenCode defaults. Directory-based requests identify the project before
  creating a worktree; existing linked worktrees resolve through Git's primary
  worktree root. Send/fork fallback uses that same owner. Configured model IDs
  and effort preferences survive missing catalog entries rather than silently
  dispatching with a different model.
- Usage errors name the missing or conflicting input so CLI and agent-tool
  callers can correct an invalid request without an upfront usage manual.
- Explicit `projectId` or `directory` scope takes precedence over the managed
  tool's current-session directory fallback; the fallback never creates a
  conflicting second scope. Session reads (`session.list`, `session.status`,
  `session.messages`) resolve `projectId` through the session service's
  `resolveDirectory`, the lookup create/send/fork use: an unknown project is a
  404 and a missing project folder a 400, never a read of the current or every
  directory. Every `session.*` action refuses `projectId` and `directory`
  together with a 400, so neither silently wins. `session.status` and
  `session.messages` with no explicit scope resolve the target session's
  own directory from the global session list, the way send and fork do,
  and use the calling session's directory only when the session is not
  found there. The directory in the result is the one the read used.
- One failed directory status lookup produces `unknown` for only that
  directory and does not erase other session results.
- `session.create` runs in a new git worktree by default (`resolveAutoWorktree`
  in `service.js`): `worktree` names it (an absolute path when it starts with
  `/`, created exactly there by `resolveCandidateDirectory` in
  `../git/service.js`), `newWorktree: false` (or `worktree: false`) opts out,
  and otherwise the name is generated from the prompt by
  `../git/worktree-name.js` using `worktreeNameModel`, else the session's
  `model`, else the project or global `defaultModel`, else OpenCode's small
  model. A failed generation falls back to a random adjective-noun name, and a
  directory that is not a git repository stays in place; the result carries
  `autoWorktree: { mode, name?, naming?, model?, reason? }`. The same naming
  helper backs `POST /api/git/worktrees/generate-name`, which the composer's
  auto-create switch calls.
- A worktree `session.create` makes, named or automatic, starts where the call's
  `startRef` says. Without one the session service
  (`../openchamber-sessions/routes.js`) follows the profile settings through
  `resolveWorktreeStartFrom(settings, 'agent')` in `../git/worktree-start-ref.js`:
  the `agent` entry of `worktreeStartFromOverrides`, else `worktreeStartFrom`,
  else the default remote's default branch. `project-root` leaves the start
  ref out, so the worktree starts from the project root's branch;
  `remote-default` sets the default remote's default branch from local refs,
  the same rule the UI applies. A repository whose remotes name no default
  branch gets the project root's branch; a failed branch read fails the call.
- A new worktree's branch, when the call names none, is the
  `worktreeBranchTemplate` (default `{name}`) filled with the worktree name made
  fit for a branch (a path's last segment for an exact `/path`; spaces and
  characters git refuses become `-`), with `-2`, `-3`… when a local branch
  already has it (`../git/branch-name-template.js`). When a parallel call took
  that name between the branch read and the creation, `session.create` reads
  the branches again and retries once with the next free name; a branch the
  call named is never renamed. `session.create` and `session.moveToWorktree`
  both name branches this way; before the template existed, an unnamed branch
  was `openchamber/<name>`. A pull request branch-off without `branch` gets the
  same suffix from the session service's branch read.
- Action modules (`session-actions.js`, `config-actions.js`,
  `integration-actions.js`, `integration-service-actions.js`,
  `provider-actions.js`, `environment-actions.js`, `project-setup-actions.js`,
  `model-choice-actions.js`)
  are passed in as `actionModules` and dispatched by action name before the
  built-in actions; their definitions are part of
  `OPENCHAMBER_CONTROL_ACTION_DEFINITIONS`.
- `integration-service-actions.js` runs the connected-service actions:
  `integrations.list` (every section below at once; a section that fails
  carries `error` and the others stay), `github.status|activate|remove|cli`,
  `gitlab.status|activate|remove|cli`,
  `linear.status|activate|disconnect|mapping|preferences`,
  `binding.get|set` (a repository's source-control binding) and
  `extensions.list|get|toggle|settings|disconnect`. Each one calls the
  operation its Settings route calls: the GitHub, GitLab, Linear, guest and
  source-control route modules return those operations, and
  `../opencode/feature-routes-runtime.js` hands them out through
  `getIntegrationOperations` once the routes are registered (before that the
  actions answer 503). A refusal keeps the route's status and message.
  Secrets: no action signs in or takes a token, password or client secret;
  an input object with a key ending in token, secret, password, passphrase or
  key, in singular or plural form, is refused with 400 before any operation
  runs; every answer has such keys
  removed at any depth (`withoutSecrets`). `github.remove`, `gitlab.remove`,
  `linear.disconnect`, `extensions.disconnect` and every `binding.set` except
  `bindingOperation: provider` need `confirm: true`. GitLab actions accept
  gitlab.com and instances already in the credential store only, so an agent
  cannot make the server probe an address the user never connected. Left to
  the user: signing in (device flow, OAuth, pasted tokens, OAuth clients),
  approving an extension's capabilities, installing, updating or removing an
  extension, and an extension service's socket path. None of the actions
  sends conversation content anywhere, so enterprise mode gates none of them;
  extension grants stay narrowed by enterprise mode in the catalog itself.
- `environment.get`/`environment.set` (`environment-actions.js`) read and
  change the variables OpenChamber gives the processes it starts, for the
  user or a configured project (`../environment`). The agent sees names, vault
  references (`op://…`) and each reference's last read, never a plain value,
  and can set only a vault reference or `null`: a plain value could be a
  secret, so the whole call is refused and nothing is saved. A project change
  calls `invalidateProject`; the managed OpenCode reads a change when it
  restarts.
- `models.choices` (`model-choice-actions.js`) returns the notes built from
  the model and effort choices the user made by hand, the most recent choices
  (`limit`, default 50) and whether recording is on
  (`../model-choices/DOCUMENTATION.md`). Read only: turning recording off and
  clearing the history stay with the user in Settings.
- `projects.setup` returns a configured project's setup through
  `projectConfigRuntime.readProjectSetup`, the same read as
  `GET /api/projects/:projectId/config`; an unknown id is a 404. It is read
  only: worktree setup commands and project actions run outside OpenCode's
  permission rules, so an agent able to write them could run commands it was
  never allowed to. Writing them stays with the user in Settings.
- `projects.add`/`projects.remove` are the only destructive-adjacent actions
  wired: `projects.add` mirrors `POST /api/openchamber/directory` exactly
  (`validateDirectoryPath`, `createProjectIdFromPath`, `persistSettings`), so
  an agent-added project is indistinguishable from one added through the UI;
  `projects.remove` only drops the configured entry via `persistSettings`,
  which recomputes `activeProjectId` on its own — the checkout, its sessions
  and its worktrees are left untouched. Both 503 when the server has not
  wired `fsPromises`/`validateDirectoryPath`/`persistSettings`/
  `createProjectIdFromPath`. Worktree deletion is still not part of the
  action contract.
- `projects.add`, `projects.update` and `projects.remove` read the project
  list and write the changed list inside one call to the settings runtime's
  `updateSettings`, which holds the save lock `persistSettings` uses. Two
  project changes close together, or one beside a UI save, therefore cannot
  write over each other. A refusal (unknown id, a value the sanitizer drops)
  is thrown inside that call and writes nothing. A server that has not wired
  `updateSettings` reads, then persists, as before.
- `projects.list` returns each project's per-project settings
  (`EDITABLE_PROJECT_SETTINGS` in `service.js`: the fields `sanitizeProjects`
  keeps that Project settings edits). `projects.update` changes them through
  `persistSettings`; it runs the new list through `sanitizeProjects` first and
  refuses the whole call when the sanitizer would drop or rewrite a value, so
  a value it reports as saved is the value stored. Path, id and timestamps are
  not editable.
- `settings.get`/`settings.set` (`config-actions.js`) take an optional
  `surface` (`web`, `desktop`, `vscode`, `mobile`) and pass it to
  `readSettingsFromDiskMigrated`/`persistSettings`, the same surface rule as
  `/api/config/settings`. Without one they read and write the base values;
  `settings.get` then also returns `surfaces`, each surface kind's own values
  for the registry's `perSurface` keys, because the sidebar layout, themes and
  font sizes the user changes in the app are stored per surface and the base
  read alone shows them as absent.
- `settings.devices` (`config-actions.js`) lists the device settings each open
  window reported (`../device-settings/store.js`, `PUT /api/config/device-settings`):
  the registry's device-scoped keys, which `settings.get` cannot show because
  they live in the window's own storage. One entry per window, memory only, at most 20, keys
  outside the registry's device scope dropped. Read only. 503 when the server
  did not wire the store.
- `opencode.config.set` (`config-actions.js`) writes the user file (default),
  the project file, or with `configScope: custom` the file the user's own
  `OPENCODE_CONFIG` names, the file Settings writes when it is set. Without
  `OPENCODE_CONFIG` a custom write is refused rather than redirected.
  OpenChamber's managed config file is set only in OpenCode's environment, so
  this layer never points at it. `merged` is read only. The merged view and the
  `shadowed` answer follow OpenCode's order: user, then custom, then project, a
  later file winning (`readConfigLayers` in `../opencode/shared.js`). In
  enterprise mode every `opencode.config.set` is refused with 403
  (`code: 'enterprise_mode'`): one write can add a provider or a destination for
  conversation content.
- `session.archive` / `session.unarchive` move a session out of (and back
  into) the active list through the session service's `archive` /
  `unarchive`, so open windows hear the same broadcast as a UI archive; a
  server whose session service lacks those methods falls back to the
  injected `archiveStore`, and one with neither answers 503. A session the
  store refuses to archive is a 500, never a claimed success. Archiving is
  reversible, so the agent tool may use it — that is how throwaway sessions
  an agent created are removed through the same API.
- `subagentPolicy` (`{ models, excludedModels, agentOverrides }`, model
  selectors such as `provider/model` or `provider/*`) travels unchanged on
  `session.create`, through the session service to OpenCode's session create
  body, and `session.subagentPolicy` replaces it on an existing session
  through `session.update`. OpenCode owns the shape and its checks, so this
  layer forwards the value and never narrows or rewrites it. A change
  applies to subsessions started after it.
- `session.delete` permanently removes a session through the
  directory-scoped client's `session.remove`. It is CLI-only
  (`agentExposed: false`, like `schedule.status`): permanent deletion stays
  a human's action, so the agent tool rejects it before the service runs.
  The service also refuses to delete the session a call is running in.
- `session.link` records a code change under review or an issue on a session
  (`../openchamber-sessions/session-link.js`), defaulting to the calling
  session. When to link is not in the action's description but at the head of
  the tool description and in the session context
  (`../session-knowledge/DOCUMENTATION.md`): what the work is about, never one
  mentioned in passing. It sends one service-neutral record (`url`, `title`, `kind`
  `change` or `issue`, optional `identifier`) and nothing is looked up, so any
  tracker works. The URL decides what is stored: a GitHub pull or issue
  address becomes the GitHub entry (kind from the path, live state as for any
  link), a Linear issue address the Linear entry, anything else an `external`
  entry shown by identifier. A GitLab merge request or issue address (the
  `/-/merge_requests/N` shape on any host) is keyed by the thread, so linking
  it again from a tab like `/diffs` or with a query refreshes the one entry. It only adds or refreshes links, never removes
  one: the user owns removal. A missing field or a non-http(s) URL is a 400 and
  nothing is written.
- `file.open` shows a file in the user's viewer. `file-open.js` resolves a
  relative path against the session directory (an explicit `directory` wins),
  refuses a relative path with no directory at all, checks the target is an
  existing file, then hands `{ path, directory, sessionId }` to the injected
  `emit`, which `index.js` writes to every UI control stream as
  `openchamber:file-open-request`. Nothing comes back: opening a tab does not
  fail quietly on a client, so the count of clients reached is the signal, and
  zero is a 503, never a claimed success. Paths outside the workspace are
  allowed on purpose: screenshots and recordings often land in a temp
  directory, and the viewer already reads such files.
- `browser.capture` writes its image on the server, into
  `.openchamber/screenshots/` under the scoped project directory, and returns
  the project-relative path rather than the image bytes. The client that took
  the picture may be on a different machine than the repository, and a path is
  what an answer, a commit, or a review can use; base64 in a tool result cannot
  be any of those. The agent's label is reduced to a filename fragment, never
  used as a path. The result also states how to present the image, because chat
  renders the image paths written in a finished answer below that message —
  saving the file is not what shows it to anyone.
- `browser.close` removes a browser tab the calling session opened, and is
  refused for any other tab, including the user's own tab an action without
  `tabId` might otherwise fall back to (`../browser-control/DOCUMENTATION.md`).
  Closing is panel state, so the client that owns the tab performs it through a
  registered closer, not the page view; the server only validates `tabId` and
  forwards the action like the rest.
