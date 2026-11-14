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
  change, the id and run history stay, and a task driven by a loop file is
  refused (the file is its source).
  A standalone `time` changes a once task's time while keeping its date, or a
  single-time weekly task's time while keeping its weekdays. It must be a
  nonempty `HH:mm` value. Daily, cron and multi-time weekly tasks require an
  explicit schedule replacement; incompatible or ambiguous time patches fail
  before upsert. Omitted timezone inherits the stored timezone through project
  config normalization, including schedule replacements. An explicit nonempty
  timezone replaces it. Timezone clearing and creation behavior are unchanged.
  Rejected patches leave the requested fields, schedule and run history
  unchanged by the patch. The preceding task list reconciles the scheduler
  before validation and may persist legitimate state recalculations, including
  `state.updatedAt`, even when the patch is rejected before upsert. A failed
  atomic patch write preserves the prior valid snapshot at that write boundary.
  Scheduler synchronization also follows the save; a failure there retains the
  committed change on disk.
  `schedule.create` and `schedule.update` accept `targetSessionId`, validated
  by the scheduled-task service. An empty `targetSessionId` on update clears
  the target. Create
  without a model inherits the target selection; a model or agent the task
  names switches the target session to it on every run, so the tool
  descriptions say so. A task without a target still requires a model. When a call names a
  model, it is checked against the execution directory's catalog first. The
  scheduled-task service resolves the project checkout or Chats root through
  its storage/public ID mapping. A target task uses the target session's own
  directory, including a stored target omitted from an update. Clearing a target
  returns to the project catalog. An unknown id is a 400; an empty catalog
  stands down because a cold location's first read is not evidence of absence.
  Only the model the call names is checked, so an update that names no model
  validates nothing. This server runs for web, Electron, hosted mobile and
  Capacitor clients; the VS Code extension does not run it.
  `schedule.create` and `schedule.update` also accept the isolation fields
  `runInWorktree`, `baseBranch` and `cleanupWorktree`, the same choices the
  editor stores for a git project's task. All three are refused together with
  an existing-session target, because that session's own directory wins and
  the fields would otherwise be stored and ignored. `runInWorktree` and
  `cleanupWorktree` must be booleans, and `baseBranch` a nonempty string, or
  empty or null on update to clear the stored branch. Anything else is a 400
  before upsert, because the CLI HTTP route forwards raw JSON and a wrong type
  would turn isolation off or erase the branch.
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
  conflict check. Notes and todos carry `planId`, todos `dependsOn`, under
  the storage rules of `../project-context/DOCUMENTATION.md`; an update may
  send only those fields. `list` narrows notes, todos and plans to one `planId`; `ready: true`
  keeps only unfinished todos whose dependencies all exist and are completed,
  judged on the whole stored list before the plan filter. Readiness is never
  stored. A plan save with `sessionId` sets or replaces (`null` clears) the
  existing plan's session link; it carries no markdown, and a call with
  both, or without an `id`, is refused before anything is written. That
  input names the plan's session and never a note's origin. A field the
  tool declares for another kind is a 400. The actions answer `403` while
  `agentKnowledgeToolEnabled` is `false`. `show` checks the plan exists and
  sends `openchamber:plan-open-request` to every connected window, like
  `file.open`; every layout opens the plan the way a click in the Project
  knowledge Plans list does: in place in the panel on desktop and web, in the
  drawer's plan viewer on mobile. No
  window reached is `503`.
- `generate-image.js` runs `image.generate` for the `openchamber_image` agent tool, off by default. It reads `agentImageToolEnabled` (`403` while off) and `agentImageModel` (`provider/model`, `409` while unset) on every call and asks OpenCode's `POST /api/experimental/generate/image` (OpenCode 2.2), which takes no location, so it starts no MCP servers. The session keeps its own model. Reference images are read from the agent's paths (PNG, JPEG, GIF or WebP by signature, at most 8 of 10 MB each). The generated bytes go to files, never into the result: a picture stored with the session would sync a few megabytes to every client per call. Without `path` they land in OpenCode's temporary folder (`os.tmpdir()/opencode/generated-images`), which OpenCode tells agents they may read and write without asking; more than one image numbers the rest `-2`, `-3`. OpenCode's tagged errors become actions for the agent: a missing or non-image model asks the user to choose another, a provider refusal passes on the provider's reason. The result is `{ model, images: [{ path, mime }], cost? }`; `generatedImagePaths` reads the paths back from the stored envelope for the image grant route.
- `usage-read.js` runs `usage.read` for the `openchamber_usage` agent tool, off by default. It reads `agentUsageToolEnabled` on every call (`403` while not `true`) and loads the quota module through the `loadQuota` dependency (absent: `503`). It runs the readers Settings → Usage runs, with the page's deadlines: the configured-provider list within 10 seconds, then every configured provider in parallel, each within 30 seconds. Only the providers the page reads are asked (`listUsagePageProviders`, `../quota/DOCUMENTATION.md`), so an agent never causes a request the page does not make. The result is `{ providers, notConfigured }`: each provider's result exactly as `GET /api/quota/:providerId` answers it, and the ids of the page's providers without a credential. A provider that throws or misses its deadline is its own failed entry (`ok: false`, `configured: true`, `usage: null`, `error`), and the others stay. A provider list that fails or times out does what the page does, asking every provider, and the result carries `listError` instead of `notConfigured`; it is never an empty list. `providerId` reads one provider without the list read; an id the page does not read is a `400` naming the ids it does. Nothing is cached: each call is a fresh read, under the readers' own limits (concurrent reads of one provider share a request; Claude answers from its last sample during a 429 cooldown, so `fetchedAt` can be newer than the numbers). A cancelled turn ends the wait with `499`; the shared reads finish for their other callers.
- `render-page.js` runs `render.page` for the `openchamber_render` agent tool. It takes `html` or `ui` (a program in the UI block language, which the chat draws with its own components; the server cannot parse it, so a client that cannot draw it answers the wait with `notDrawn` errors, and the agent gets them in its result). Only one of them is required: a page sent without a title is named after its own `<title>`, else its first h1 to h3, else "Page", with the same rule the chat uses (`renderedPage` in `packages/ui/src/lib/opencode/tools.ts`). Weaker models sent title and html in separate calls, each refused call costing the whole page again; a missing html now also asks for both in one call.
  The chat draws the page from the call's own input, so the action stores
  nothing: it checks `html` (at most 200,000 characters) and `title` (at most
  120) and answers `403` while `agentRenderToolEnabled` is `false`. A call
  with `share` is refused first when sharing is unavailable (`403`,
  `code: 'enterprise_mode'`) and with `awaitAnswer` or `answerLater` (`400`), then makes its
  group through `sharePages` (`../share-pages/`) and returns at once without
  any link or PIN. With
  `awaitAnswer` the action waits in `createPageAnswers`, keyed by session and
  call id, until `answerPage` resolves it (`POST /api/openchamber/render/answer`
  from the chat: a summary of at most 500 characters and data of at most
  16,000 characters as JSON, or `declined: true` when the user declined, which
  ends the call with `{ answered: false, reason: "declined" }` and a note that
  tells the agent not to choose for them) or the request is aborted. Nothing outlives the
  call, so a second answer, an answer for a call that ended, and an answer
  after a server restart are a `404`, never a silent success.
  Before it waits, the action reads the session's OpenCode inbox. A message
  the user steered into the turn that the agent has not read yet means they
  wrote before the page appeared (a queued one waits for the turn to end
  anyway, and one an agent or OpenCode's scheduler sent, `isAgentPrompt`, is
  not the user writing, so neither counts); OpenCode delivers it only after this call returns, so
  waiting held it back and an answer on the page reached the agent first.
  The call then returns at once with `{ answered: false, reason:
  "chat-sent-earlier" }` and a note that the message is not an answer to the
  page, and the chat says so under the page. A failed inbox read counts as
  no message, and the page waits. One case stays open: a prompt sent just
  before the page appeared that OpenCode was still preparing (attachments
  are read first) and that reaches the inbox only after this read; the page
  then waits as before.
  `onPageWaitChange` hears both ends of a wait. The server's wiring
  (`index.js`) lists the page with the session's pending requests
  (`trackWaitingPage` in `../opencode/session-runtime.js`), broadcasts
  `openchamber:page-waiting` / `openchamber:page-settled` to the clients, and
  sends the same "Input needed" notification a form gets.
  A turn that ends (`session.idle`, `session.error` in `index.js`) releases
  the session's waits through `releaseAnswerWaits`: they leave the pending
  list, and a late answer is a `404`. See *Why a released page keeps its
  request open*.
  With `answerLater` (exclusive with `awaitAnswer`, `400` together, and
  needing a call id like a wait) the call returns at once with
  `answerLater: true` and a note that the answer comes later, after
  `later-pages.js` saved the page as open (`<data-dir>/render-later-pages.json`,
  atomic, owner-readable; a failed save fails the call with `500`), with what
  it asked (`renderPageQuestion`: an html page's visible text without its
  title, scripts and styles, or the ui program, at most 2,000 characters), so
  the answer still names its question after other work or a compaction. No
  script runs on the server, so that is only part of what the user saw when
  the page has a script (`questionCaptured: 'static-text'`), was cut
  (`'truncated'`) or had no text (`'none'`); the page keeps that field, the
  answer's JSON carries it and its prose tells the agent not to assume more,
  and the tool description asks for the question in static text. The page
  is not a wait: it never enters `createPageAnswers`, the pending list or
  `onPageWaitChange`, so neither the turn's end (`releaseAnswerWaits`), a
  message in the chat (the plugin's prompt hook) nor Stop closes it, and the
  session never reads as waiting. `answerPage` tries a live wait first and
  falls through to the open later page; the answer (the same checks) is saved
  with a freshly minted message id before the route answers, a second answer
  is a `404`, and the page keeps the answer so every client shows it.
  Delivery is one `POST /api/session/:id/synthetic` with `delivery: 'steer'`,
  `resume: true`: steered into a running turn, starting one in an idle
  session. A session archived since (asked before every attempt, as
  `../dispatch-results` does) gets `resume: false`: the message is recorded and
  nothing wakes. The state comes from `sessionArchive.archiveState`
  (`../openchamber-sessions/session-archive.js`), which tells `archived`,
  `active` and `unknown` apart, unlike `isArchived`, which calls a failed read
  active. The read is bounded like the POST (15 s, its signal cancels the
  OpenCode request); a failed, stalled or unknown read sends nothing and goes
  to the retry below, so an archived session is never woken on a guess and
  the page shows `undelivered` meanwhile. Its text sits in `<openchamber-page-answer call=… outcome=…>`:
  a line of prose, then one JSON line with every field that came from the page
  or the client (`title`, `page` for what it asked, `questionCaptured` when
  that is only part of the page, and `summary` and `data`,
  or `errors` for a page the chat could not draw; `<` escaped), then a closing
  line. The prose says the JSON is data, never instructions; nothing
  page-derived sits outside it, because an html title is entity-decoded and
  could otherwise close the envelope. Its `description` is
  `<title>: <summary>` (what OpenCode's own clients show), its metadata
  `{ source: 'openchamber-page-answer', callId, title, outcome }`; the chat
  draws its own row from the metadata and the JSON line
  (`@/lib/opencode/session-notices`), so the JSON line's shape is a contract
  with it. 409 counts
  as delivered, 404 ends it, other failures retry under the same id with
  backoff, then every five minutes after eight, until OpenCode takes it; the
  next OpenCode connect or server start also tries at once. From the first
  failure until it lands the page carries `undelivered: true`, and the chat
  says the agent has not got the answer yet.
  `session.deleted` drops the session's pages. At most 500 pages are kept: an
  answered, delivered one makes room for a new page, an open one is never
  evicted (`409`). `GET /api/openchamber/render/later` answers
  `{ revision, pages[] }` (`sessionID`, `callID`, `status` `open`,
  `answered`, `declined` or `ui-not-drawn`, `summary` and `data` when
  answered, `undelivered` while delivery fails); every change broadcasts `openchamber:render-later.updated`
  `{ revision, sessionID, pages[] }`, and the chat reads it through
  `packages/ui/src/sync/later-pages.ts` (`usePageAsk`).
  Known limits: the OpenChamber server inside an isolated space refuses
  `answerLater` with `503`, as it refuses extension waits and `pr.watch`
  (`index.js` gives it no `laterPages`), because the host's chat reads later
  pages and sends answers to the host's server only. The VS Code
  extension does not read later pages, so it shows a later page without
  answer controls or the answer given on another client. The `answerLater`
  description tells agents both, so they ask in text there.
  `renderPageImageSources` lists the local images a page names by absolute
  path (in quotes or a CSS `url()`, PNG, JPEG, GIF or WebP), every one of them.
  The image grant route (`../markdown-image-grants/`) allows exactly those, and
  the chat reads them with the same rule. `fitRenderPageImages` checks the
  files and takes them in page order while they add up to at most
  `RENDER_PAGE_IMAGE_BUDGET_BYTES` (25 MB); the grant route serves a page by it.
  The action checks the page the same way before answering, so the agent hears
  what the user will see: when an image will not show, the result carries
  `images` (`shown`, `notShown` with each path and its reason, and `weightMB`
  against `budgetMB` when the budget cut it) and a note telling the agent to
  split the page or use smaller images. A page whose images all show answers
  as before.
- `secret-request.js` runs `secret.request` for the `openchamber_secret`
  agent tool. The call waits in its own `createPageAnswers` instance, so the
  session shows as waiting for the user exactly like a page (pending list,
  `openchamber:page-waiting` with the label as title, "Input needed"), while
  a page's answer route can never reach a secret's wait. The chat answers
  through `POST /api/openchamber/secret/answer` with the value or
  `declined: true`. The route writes the value to
  `<data-dir>/secrets/<random>` (file `0600` created with `wx`, directory
  `0700`) and only then settles the wait with the path; when the call
  stopped waiting meanwhile, the file is removed and the answer is a `404`.
  A write that fails partway removes its file, and so does an answer that
  settles the wait just as the call is aborted. Like a page, the card does
  not wait when `hasUnreadChat` finds a message the user sent before it
  appeared; the call answers `{ answered: false, reason: 'chat-sent-earlier' }`.
  The value never enters the tool call, its result, OpenCode's store or the
  agent's context; the agent reads the file inside its own command, so the
  card says the agent's commands can read it. `createSecretFiles().sweep()`
  deletes files 24 hours after they were written, on server start and
  hourly. Answers `403` while `agentSecretToolEnabled` is `false`.
- `secret-run.js` runs `secret.run` (and `secret.forget`) for the same tool,
  through `createSecretRequests`, so one answer route and one wait registry
  serve both kinds of card. The call names a `program`, its `args`, a `reason`
  and 1 to 8 `inputs` (`env`, `label`, optional `placeholder`); a malformed
  call is a `400` before any card. Only a call the agent tool marks
  `secretRunAuthorized` runs (the secret tool's plugin, after OpenCode's shell
  permission for the command line, see `../agent-tool/DOCUMENTATION.md`);
  anything else is a `403`. Before it waits, the call reads the values the
  chat remembers; with none missing it runs at once and no card waits. While
  the card waits, `GET /api/openchamber/secret/fields` names the fields it
  asks for and the ones it reuses (names only; a `404` once it stopped
  waiting), and the card reads them there. The answer carries exactly the
  asked fields, each non-empty, plus the ones the user ticked to remember;
  the values pass the wait in memory, never through its data. The command
  runs once with `runCommand` from `../spaces/run-command.js`, without a
  shell, in the session's directory, with the values added to the server's
  environment, stdin closed, the process tree killed on Stop, a chat message
  or `timeoutMs` (default 2 minutes, at most 10), on every platform that
  module supports, Windows included. stdout and stderr are kept in a 1 MB
  window, every value is replaced by `[secret:NAME]`, and the last 32,000
  characters of each go back with the exit code and the env names still
  remembered. Remembered values live in memory only, per session and env
  name, for 10 minutes from submission; use does not extend them, a restart
  drops them, and `secret.forget` drops the session's.
- `routes.js` is the authenticated CLI HTTP adapter. It forwards one action,
  preserves service status and partial-result details, and propagates request
  cancellation. It also carries the chat's answer to a waiting page.
- `../agent-tool/runtime.js` is the managed-tool adapter. It wraps service
  results in the versioned native-tool envelope and uses a separate ephemeral
  loopback credential.
- `../openchamber-sessions/routes.js` and `../scheduled-tasks/service.js` own
  their domain operations and are composed into this service.

## Invariants

- `projects.list` offers registered projects and the server's Chats destination.
  `session.create` accepts its `openchamber:chats` id to create a separate managed
  chat directory. With no explicit scope, creation still uses the caller's directory.
  Later session actions use the returned directory, or their existing resolution
  by session id. The Chats id is a creation destination, not a registered project.
  Chats creation and directory-scoped send/fork do not infer a project or its defaults from Git,
  including when the configured Chats root is inside a registered checkout.
  Membership compares the canonical directory and root so symlink aliases keep
  the same projectless behavior.
- Chats creation belongs to the session service. It reuses the directory allocator
  in `../scheduled-tasks/chats-scope.js`, including the configured Chats root.
  Failed creation removes only an empty directory. Once OpenCode creates the
  session, a failed prompt keeps its directory. Chats cannot request a worktree.
- Session status and messages come from official directory-scoped OpenCode
  APIs. Message output includes only ordered `text` parts.
- `session.status` and `session.messages` ask OpenCode's `session.get` first,
  because the active-session map names only running sessions: a session it
  does not name is idle or does not exist. An unknown id is a 404. A lookup
  that fails is a 503 with its own message, never a 404 or an idle status.
- A session status is `busy`, `idle`, or `waiting`: a running session with an
  open permission, form, secret card or page (`readPendingRequests`). A
  permission the server answers by itself does not count
  (`isPermissionAutoAnswered`, the rule notifications use; in `safety` mode the
  read waits for the verdict). Each session answers for itself: a parent whose
  child waits stays `busy`. The pending list comes from this server's event
  stream, so a request opened before this server connected to OpenCode reads as
  `busy`. `session.list` with `withStatus` uses the same rule.
- Wait (CLI only; the agent tool refuses it) never treats an initial idle
  response as completion after dispatch. It requires observed activity or a
  newly completed assistant message. A `waiting` session ends the wait at once
  with that status, because the user may never answer; the CLI then exits
  non-zero, so a script does not read it as finished.
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
- A dispatch that names a model but omits `variant` resolves its level in the
  same order as the composer: the agent pin and the project or Settings default
  for that model, then the profile's `lastUsedEfforts` entry, then Default. A
  send that names no model keeps the session's own selection, and a remembered
  level the model no longer lists is ignored.
- `session.create` with `pullRequest` passes the number, and `worktree` and
  `branch` as folder and local-branch names, to the session service, which
  creates the worktree through the injected `createChangeRequestWorktree`
  (the Git routes' contributor pipeline) before any session exists. A
  malformed number, or `startRef`/`setUpstream` beside it, is a 400; a
  server without that pipeline answers 501 and never makes a plain branch
  worktree instead; a provider or transfer refusal keeps its status and
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
- A new worktree from `session.create` (`worktree` or `pullRequest`) or
  `session.moveToWorktree` runs the project's setup commands, as one from the
  New worktree dialog does. The server resolves them itself
  (`../projects/worktree-setup.js`) from the registered project's merged setup
  (`readProjectSetup`), because no client is there to show the trust prompt:
  shared commands the user has not trusted are left out, the personal ones
  still run, and the result names the skipped ones in
  `untrustedSetupCommandsSkipped`. That is the dialog's answer when the user
  skips them. The project is the one a move's start folder follows (below),
  for a create too. A directory outside every registered project gets no
  setup. The commands run inside the bootstrap, so the session is created or
  moved only after they finished, whatever `setupWorktreeWait` says: an agent
  works in the folder at once. The 60-second bootstrap deadline covers git's
  part; once the bootstrap reports `git-ready`, the commands get three more
  minutes, which keeps the call well inside the agent tool's request window
  (Bun's fetch gives up after about six minutes). A command still running past
  that gets a 503 and no work starts in the worktree, so a command that never
  exits cannot hold every agent create and an agent never edits files a setup
  is still writing. A create answers `partialAction: worktree-created` with no
  session, as for any failed prerequisite below; the retry in that folder gets
  the same answer until the setup finishes. A move answers
  `partialAction: worktree-setup-running` with the worktree's `directory`, stops
  before stashing anything and leaves the session and its files where they
  were: a setup command could overwrite a carried file once the stash, the only
  other copy, is dropped. The same move again, from the same session with the
  same worktree input, moves into that worktree once its setup finished, while
  the folder is still a worktree of the repository. The mover keeps the
  worktrees it left this way in memory, so after a restart a retry makes a new
  one, as the first call would. A failed retry leaves that worktree in place,
  since another session may have entered it meanwhile. A move that goes ahead applies its `carry` files after
  the setup, so a carried dependency change needs the install run again. A
  failing command is logged and does not fail the bootstrap, as on every
  creation path. A move that fails after the worktree exists stops the setup
  commands (`cancelSetup` in `removeWorktree`), so a command that never exits
  cannot strand the worktree; the changes go back without waiting for that.
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
- A create with a prompt resolves its selection in the target directory before
  creating an OpenCode session. It reads discovery once with a 10-second request
  deadline. Unavailable agent/config reads, an empty agent list, or a configured
  agent absent from the list produce 503; no fallback model is dispatched from
  those snapshots. A missing saved default agent is named in the error with a
  hint to update the default or pass an explicit agent; it never silently picks
  another agent. An explicit agent that needs only a model does not require the
  saved default agent to exist. Model precedence stays unchanged.
  Explicit model/agent pairs keep their existing validation,
  and send/fork reuse the session selection before requesting defaults.
- Worktree-dependent operations await the tracked bootstrap promises, including
  setup, with the deadlines above, then check the final status once. Git-ready
  alone is insufficient. Creating in an existing checkout subdirectory checks
  bootstrap at the checkout root while retaining the session's requested folder.
  If a create prerequisite fails after making a worktree,
  the error carries `partialAction: worktree-created` and `directory`, with no
  session ID. The caller can retry that directory without a `worktree` parameter.
  The CLI prints the retained directory and a retry command preserving the
  prompt and selection options without creating another worktree.
  An empty-session create without a prompt keeps its existing selection behavior.
- Usage errors name the missing or conflicting input so CLI and agent-tool
  callers can correct an invalid request without an upfront usage manual.
- Explicit `projectId` or `directory` scope takes precedence over the managed
  tool's current-session directory fallback; the fallback never creates a
  conflicting second scope. Session reads (`session.list`, `session.status`,
  `session.messages`) resolve `projectId` through the session service's
  `resolveDirectory`, the lookup create/send/fork use: an unknown project is a
  404 and a missing project folder a 400, never a read of the current or every
  directory. An action that names a session ID resolves its directory by
  reading that session by ID (unscoped) first: a moved session can leave a
  stale copy under the directory the call came from, which the global list can
  return first. The list is the fallback. Every `session.*` action refuses
  `projectId` and `directory` together with a 400, so neither silently wins.
- One failed directory status lookup produces `unknown` for only that
  directory and does not erase other session results.
- `session.list` returns top-level sessions newest first (OpenCode's
  `parentID: null`); `children` adds subagent sessions. Each session is
  trimmed to `id`, `title`, `directory`, `updated`, `archived`, `parentID`,
  `agent`, `model`, `outcome` (plus the In work fields and `status` below):
  the raw OpenCode record averaged about 1,100 characters on real sessions,
  a session in work about 1,750, with tokens, cost, permissions and every
  metadata namespace; the trimmed one about 300. The chat's tool row reads
  `directory` and falls back to `location.directory` for calls stored before. While In work is on
  (`sessionWorkEnabled`), every session carries `inWork` and
  `doneSuggested`, by the sidebar block's rule
  (`../session-work/membership.js`: top level, not archived, not a Chat,
  `work.state` open; the hint while it is newer than `time.idle`). Filters:
  `inWork`, `busy` (in OpenCode's active map, so busy or waiting) and `query`
  (every word in the title, case-insensitive, matched here because OpenCode's
  `search` is SQLite `LIKE`, case-sensitive outside ASCII). `inWork` and
  `busy` read every project unless `projectId` or `directory` scopes them and
  return every match unless `limit` is given; a filtered read asks for pages
  of 200. `inWork` while In work is off is a 409, and a failed active-map read
  under `busy` is a 503, never an empty list. `busy` stops paging once it saw
  every running session.
- `session.markDone` and `session.track` write the record the app's Done and
  Track write (`userStatePatch` in `../session-work/state.js`) through the
  injected `updateSessionMetadata`, the session metadata store's queued
  write that broadcasts the change, so every window updates. The session
  defaults to the caller and is read first (unknown is a 404). Track refuses
  a session that can never be in work (400) and an archived one (409); Done
  takes any session, as the app's button does. Both are a 409 while In work
  is off and a 503 on a server without the store.
- Destructive session/worktree deletion and project-path registration are not
  part of the action contract.
- `session.send` to an archived top-level session restores it, with its
  archived subsessions, once OpenCode accepts the prompt, as a send from the
  composer does: the user follows that session and would otherwise find it
  only in the archive. A failed restore is logged and leaves the send standing.
- `session.create`, `session.send` and `session.fork` called from a session
  pass that session as `promptedBySessionId` (except a send to the caller
  itself). The session service records it on the prompt's message as
  `metadata.openchamber.promptedBy { sessionID, title }`, and the transcript
  links back to the sender under that message. The title is read when the
  prompt goes out; a failed read records the id alone. A slash-command
  prompt goes through `session.command`, which takes no metadata, so it
  carries no link.
- `work.name` names the task the session (default: the calling one) works on
  (`../openchamber-sessions/work-naming.js`, wired through the `workNaming`
  dependency; without it the action answers 503). In a linked worktree it sets
  the branch description (`setWorktreeTaskTitle` in `../git`). It never changes
  a session title or its metadata. In the main checkout or a plain folder it
  answers `named: false`: those tasks use their session titles and need no naming.
  Inside an isolated space the call persists an agent proposal and publishes it
  on that server's control stream. The host owns the displayed space title;
  see `../spaces/DOCUMENTATION.md`, "Task titles". A copied user title inside
  makes the call answer `named: false` with that title.
  A name
  the user gave stays: the call changes nothing and answers `named: false`
  with the current name. When to call it is in the session context, next to
  the linking guidance (`WORK_NAME_GUIDANCE`). Both that guidance and the
  action's description ask for the name in the language of the user's latest
  message, the rule generated session titles follow; agents that work in
  English otherwise named a Ukrainian user's tasks in English. Branch names
  stay in English. While the worktree's branch is
  OpenChamber's unpushed placeholder (`readRenameableGeneratedBranch`), the
  call also requires `branch` and renames it (`renameGeneratedWorktreeBranch`),
  answering `branch` and `branchRenamed: true`; without `branch` it fails with
  400, says how to call it, and names nothing. Any other branch, and the main
  checkout, is not renamed: a `branch` passed there answers
  `branchRenamed: false` with a note, so the agent does not take the call for
  a rename.

  Moving a session into a new worktree carries its current title to the branch
  description as agent-owned. Existing `metadata.openchamber.workTitle` with
  `by: 'user'` makes the carried title user-owned. Explicit creation titles and
  UI renames still record that marker; no metadata migration runs.
- `pr.watch` and `pr.unwatch` let the calling session wait on its pull
  requests without polling: `pr.watch` takes the address in the control tool's
  own `url` input and hands it to `prWatch` (`../pr-watch/DOCUMENTATION.md`),
  which reads it, follows it and wakes the session once when it changes.
  `pr.unwatch` stops the one at `url`, or every one without it. Both act only
  on the calling session, never one the input names.
- `wait.list`, `wait.start` and `wait.stop` are the same kind of wait for the
  built-in timer and for what an extension's service follows
  (`../extension-waits/DOCUMENTATION.md`): `wait.start` takes `source`
  (`timer` or `<extension>/<wait>`) and `args`, `wait.stop` an optional
  `waitId`, all three only for the calling session.
- `session.link` records a code change under review or an issue on a session
  (`../openchamber-sessions/session-link.js`), defaulting to the calling
  session. When to link is not in the action's description but at the head of
  the tool description and in the session context
  (`../session-knowledge/DOCUMENTATION.md`): what the work is about, never one
  mentioned in passing. It sends one service-neutral record (`url`, `title`, `kind`
  `change` or `issue`, optional `identifier`) and nothing is looked up, so any
  tracker works. The URL decides what is stored: a github.com pull or issue
  address becomes the GitHub entry (kind from the path, live state as for any
  link), an item link a registered tracker's `matchUrl` claims a tracker
  entry (`{ id: '<provider>:<IDENTIFIER>', kind, provider, identifier }`;
  Linear's id stays `linear:ENG-12` and its kind stays `linear` while the
  `/api/linear` alias exists, so older bundled UIs keep showing and keeping
  it; other trackers are `kind: 'tracker'`, see
  `../trackers/DOCUMENTATION.md`), anything else an `external` entry shown by identifier.
  A github.com discussion is such an external entry, identified `#N` unless the
  agent named it, under the id the UI writes when one is attached
  (`link:<origin>/<owner>/<repo>/discussions/<N>`), and newer UIs read it as a
  discussion by its address.
  A change request or issue address that a source-control provider's
  `urls.thread` names (GitLab's `/-/merge_requests/N` shape on any host) is
  keyed by the thread, so linking it again from a tab like `/diffs` or with a
  query refreshes the one entry. A missing field or a non-http(s) URL is a 400
  and nothing is written.
- `session.unlink` removes a link from a session, defaulting to the calling
  session, whoever made the link. The agent names it the way it linked it: the
  control tool's `url` or `identifier` input (also read beside the action), or
  the same complete `link` it linked with; the tool schema requires `title` and
  `kind` in `link`, so a bare identifier goes in `identifier`. A url removes
  every entry that linking the address would key the same (a `/files` or `/diffs` tab names its thread) or that is
  stored under the same address; an identifier matches an entry's
  `identifier`, its id, or a github.com entry's `#N`, in any case. The removal is
  the Work Status unlink's own transform (`buildLinkedIssuesPatch` in
  `../openchamber-sessions/session-linked-issues.js`), decided inside the
  session's metadata write turn. No match is a 404 that lists the session's
  links; an identifier that names more than one is a 409 that removes nothing
  and asks for the url.
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

## Decisions

### Why time-only patches require an unambiguous schedule

A once task has one time and a single-time weekly task has one slot to replace.
Daily and cron selectors already encode their time, and a multi-time weekly
task does not identify which slot a standalone `time` should change. Rejecting
those patches lets callers provide an explicit replacement without silently
dropping slots or ignoring the requested time.

### Why a background message waits behind a page and does not end it

A dispatched session's result, a pull request or extension wait's wake, a
workflow report, a restart resume, another agent's `session.send`, a run of
OpenCode's own scheduler or a prompt queued for after the turn can arrive
while a page or a secret card waits. OpenCode keeps it
in the session's inbox until the waiting call returns, and the agent reads it at
the next step, right after the user's answer. The alternative, ending the wait
so the agent reads the message at once and asks again, loses the question the
user was reading, and the result told the agent the user had written. A
queued prompt would not even follow the result: OpenCode delivers it only
after the turn. A message the user writes in the chat still ends the wait, as
does an undelivered prompt the user moves (back) to steer, and `hasUnreadChat` counts only
the user's steered messages. A prompt counts as an agent's when its metadata names a sending session in
`openchamber.promptedBy.sessionID`, as `session.send` writes it, or carries the `schedule: { id }` marker of OpenCode's
scheduler (`isAgentPrompt` in `render-page.js`); the sender is not checked,
since this decides what the agent reads and grants nothing. Any other prompt
counts as the user's, because a person typing in the TUI or calling the API is
the user too. An agent's `session.send` of a slash command is the known gap:
it reaches OpenCode's command endpoint without that metadata (see
`../agent-tool/DOCUMENTATION.md`). The chat keeps a
background synthetic message out of the transcript while the wait lasts (`holdPendingSynthetic` in `packages/ui`, read
through `SyntheticMessage.pending`): drawn as a new turn, it took the question
out of the chat.

### Why a released page keeps its request open

In one OpenCode no call outlives its turn, so `releaseAnswerWaits` finds
nothing there. It exists for a second OpenCode on the same database. An
`opencode` CLI command, an agent's shell included, can start
`opencode serve --service`. At start it takes over every turn with an open
execution claim, also one alive in the OpenCode this server runs, and it
inherits the callback URL and token through the shell's environment. Its page
call reaches this server, but a chat message goes to this server's OpenCode,
whose prompt hook has no such call. That turn runs and ends, and the page stayed
listed until the server restarted: the question mark in the sidebar, background
messages held out of the chat. Aborting the request cleared that too, but the
other OpenCode's turn then woke up and answered the same message, so the chat
had two replies and, with a real model, two agents in one session. The release
takes the page off the list and leaves that call parked until its request
ends: that OpenCode exits, this server restarts, or the user stops a turn in
the session (`abortSession`).

### Why a later page is its own store and not a wait that outlives its call

A page kept in `createPageAnswers` would count as a pending request: the
session would read as waiting, the sidebar would show its question mark, and
the chat holds background messages out of the transcript while a page waits
(`holdPendingSynthetic`), for as long as the user takes. Its turn's end, a chat
message and Stop all end waits on purpose. A later page asks nothing of the
turn, so it lives beside the waits, saved on disk because the user may answer
after a restart.

### Why a later answer steers into a running turn

`../extension-waits` and `../pr-watch` deliver only into an idle session,
because the agent did not ask for their news at that moment. A later answer
is the reply to a question the agent asked; it goes out at once, and the agent
reads it at its next step or as a new turn. The delivery keeps their other
rules: an id saved before the first attempt, 409 as delivered, 404 as the end.

### Why secret.run keeps secret.request beside it

`secret.run` delivers a value to one process and returns redacted output, so
the agent's later commands, and a program's verbose or error output, never see
it. It cannot serve a program that reads a secret from a file (a key file, a
kubeconfig, a client certificate), so `secret.request` stays for those. A
proposal to replace the file mode outright (#6086) was declined for that
reason.

### Why remembering a value is the user's tick, not the agent's flag

Reusing a password across a script's retries saves typing, but a value kept in
memory is one more place it lives. The agent asking for reuse would decide
that for the user, and a one-time code would be kept on the agent's word. The
card offers the choice per field instead, off by default; the agent only learns
which env names are remembered from the result.

### Why the card reads its fields from the server and not from the call

Which fields a run still needs depends on what the chat remembers, which only
the server knows, and every client must draw the same card. The first build
passed them to the plugin as NDJSON progress frames into the call's progress
metadata; OpenCode publishes that only to clients connected at that moment and
keeps none of it in the stored call, so a reload or a second device showed no
fields while the call waited. The card now asks the server once the wait is
announced (`openchamber:page-waiting`), which every client hears or reads from
the host's pending snapshot. The values a run uses are read when it starts, so
a remembered value that expires while the user fills another field is still
used.

### Why work.name leaves session titles alone

Session titles belong to OpenCode or the user. A metadata ownership marker
cannot distinguish a generated title from a user rename made in another
client or an older release, so `work.name` has no session-title write path.

### Why session.unlink names a link by url or identifier and not by entry id

The agent knows the address and label it linked, while the stored id depends
on how the server keyed it (`acme/app#7`, `linear:ENG-12`,
`link:<thread address>`) and on who linked it. Matching what the agent can name
lets it remove links the user or the UI made too. An identifier such as `#7`
can name links in two repositories, so an ambiguous one removes nothing and
the url decides.

### Why selection is checked before creating a session

The target directory's agent snapshot determines its model bindings. Missing
discovery cannot establish the default choice. Checking it once before creation
lets the caller retry a known directory without polling, sending a prompt with
an unintended model, or accumulating empty sessions.

### Why a dispatched session links back from its prompt and does not nest in the sidebar

A dispatched session used to nest under the caller's work in the sidebar
(`metadata.openchamber.originSessionID` on the session). These sessions are
the user's own conversations, such as PRs a triage session splits off for a
separate discussion: nesting hid them under one chevron, reshuffled them when
the caller was archived, and made `work.name` in each of them rename the
caller. They stay roots now, and the link sits on the prompt that started
them, where it says who sent which message.

### Why Chats uses an explicit destination id

The existing `openchamber:chats` id lets agents choose from `projects.list`
without changing the current-directory default or treating a reserved word as
a filesystem path. Chats remains outside the registered project list on disk.

### Why schedule create and update check the named model against the catalog

A dead model id otherwise saves successfully and fails only when the task
fires. Validation runs before storage using the scheduled-task service's scope
resolution and `existing-session.js` target validation. Worktree and Chats
catalogs can differ from the caller's catalog.

An empty catalog stands down under the same rule as session selection checks.
Only a newly named model is checked, so tasks with removed models remain
editable and disableable. The matcher accepts the catalog `id` and upstream
`modelID`, which can differ for display overrides. Catalog read failures still
fail the action. Partial catalogs retain the same risk as session selection
validation.

This check covers the control actions only. Agent and variant validation,
the UI editor, loop-file validation and changes to target-session pinning
remain outside this fix for #5950.

### Why usage.read leaves out the account

Codex reports the email it is signed in with (`accountLabel`), which the page
shows next to the provider name. An agent needs the windows and resets, and
its result goes to the session's model provider, which may be another company
than the one the account is at, so `usage.read` drops the field.

### Why usage.read reads fresh and does not reuse a recent result

The tool returns what Settings → Usage would show if the user opened it now,
and the page itself caches nothing on the server: a load or a refresh runs the
readers again. A short server-side cache would spare providers when an agent
calls the tool in a loop, but it would add a freshness rule the page does not
have, and the issue left that choice to the maintainer. The tool description
asks agents to read once per decision instead.

### Why a failed provider list asks every provider and is not an error

The page treats a list it could not read as "ask every provider", because a
provider can hold a credential OpenCode does not report (Claude reads Claude
Code's own credentials). Answering an error there would hide usage the page
still shows; answering an empty list would read as "nothing configured". The
fallback keeps the page's behavior and says why in `listError`.
