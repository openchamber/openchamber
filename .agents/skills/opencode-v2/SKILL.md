---
name: opencode-v2
description: Load for any work that touches OpenCode, including its routes, events, message or session shapes, plugins, the pinned CLI/client version, "what's new in OpenCode 2.x", or a bug that looks like OpenCode behaving differently than OpenChamber expects.
---

# OpenCode 2.x in this repository

A bug report that mentions 1.x behaviour (`/session` without `/api`, `message.updated`
events, `auth.json`, `@opencode-ai/sdk`) describes the old world. Answer from
the 2.x code.

## Where the boundary lives

- `packages/ui/src/lib/opencode/client.ts` — every official OpenCode call the
  shared UI makes; `projection.ts` turns wire shapes into the OpenChamber
  domain model in `model.ts`; `events.ts` translates wire events;
  `plugins.ts` translates the experimental plugin routes; `session-stats.ts`
  translates the experimental `session.stats` usage route; `websearch.ts`
  translates web search (providers, the `websearch` config choice, keys, the
  tool's text result and its first-use consent form). Rendering and stores
  read the domain model; fix a missing field there, never with a shim.
- `packages/web/server/lib/opencode/proxy.js` forwards `/api/*` as-is (2.x
  serves under `/api` itself) and folds OpenChamber-owned session state into
  the records it serves. `env-runtime.js` launches `opencode serve`.
- Plugins OpenChamber generates for OpenCode: `plugin-spec.js` and
  `agent-tool/runtime.js`, declared through the watched
  `<dataDir>/opencode.managed.json` (`OPENCODE_CONFIG`), so a settings change
  applies without a restart. Only the binary, port and external toggle restart.
- OpenCode watches `opencode.json` and agent files itself: an edit reaches
  sessions already open, with no restart or new session. Check what loaded with
  `opencode api get /api/agent -H "x-opencode-directory: <project dir>"`.
- Hiding a built-in OpenCode tool from the managed child:
  [references/builtin-tools.md](references/builtin-tools.md).

## Every directory-scoped read starts a location

On 2.x a read through the location middleware builds that directory's
location, and the build starts every configured local MCP server for it. The
location then lives until an hour without session events. So each read names
a directory, and only one the user is working in:

- **Which routes:** agent, plugin, model, provider, integration, mcp, usage,
  form, permission request list, fs, command, skill, rpc, pty, shell,
  reference, vcs, websearch, config, location (`protocol/src/api.ts` lists the
  groups with `locationMiddleware`). Session routes resolve the session's own
  location; `GET /api/session`, `/api/session/active`, `/api/credential` and,
  since 2.2.0, `/api/project` are global and start nothing. Since 2.2.0 the
  session update (except generating a title), fork and agent and model
  switches no longer build the session's location either.
- **How the directory travels:** the `x-opencode-directory` header,
  percent-encoded, or a `location[directory]` query. A `?directory=` query is
  ignored.
- **A read without one** answers for OpenCode's own working directory, the
  user's home for a managed OpenCode, and starts a fleet there. The UI reads
  through `opencodeClient` with the current directory; server code with no
  directory of its own uses the lifecycle's `getDefaultOpenCodeDirectory()`,
  the last-used directory it warmed at startup.
- **Fan-out is the failure:** a loop over every project, worktree or store
  directory starts one fleet each. A refresh after a catalog event re-reads
  only the directories the events named; they are already running.
- **Releasing one:** 2.x has no `/instance/dispose`. `DELETE /api/debug/location`
  (`client.debug.location.evict`) with the directory disposes that location;
  `GET /api/debug/location` lists the running ones and starts none.

A report of processes multiplying, memory climbing with MCP servers enabled,
or MCP servers starting in projects nobody opened: reproduce it with
[references/mcp-spawn-probe.md](references/mcp-spawn-probe.md) before reading
code.

## Workarounds for what 2.x cannot do

Each exists because 2.x has no route for it. When a tag adds the route,
the workaround goes and the record comes from OpenCode.

- **Archive entries an older OpenChamber kept**: `session-archive.js` pushes
  `archive-store.js` entries to OpenCode after start
  (`packages/web/server/lib/opencode/DOCUMENTATION.md`, session archive state).
- **1.x sessions created after the one-shot migration**:
  `v1-migration-topup.js` rewinds the migration cursor before a managed start,
  only when no revisited session has 2.x activity.
- **Error bodies**: the generated client drops the body of an HTTP status a
  route does not declare, so session update/delete/archive report the status
  without OpenCode's message or log `ref`.

An upstream ask is the last resort. Solve it on our side first: provider-specific
failure handling, for one, goes in the managed `limit-failover` plugin, whose
session `retry` hook fires on every failure while attempts remain (non-retryable
ones too, with `decision.retry: false`). An item joins the ask list only once
verified in OpenCode's code and the provider's docs; never list one as "if so,
it drops". Behaviour that may be intended goes up as "bug or intended?", not
as a fix.

Open asks upstream (OpenCode Slack): declaring 500 bodies on session
mutations; built-in provider plugins setting
attribution headers only when the client has not set its own, so a client can
name itself to a provider (today some plugins overwrite provider-level
headers). Dropped: an import route for missing 1.x
sessions (the top-up workaround is enough); `agent.list` waiting for plugin
activation (2.4.0 made every route answer at once, and waiting is the
client's job). Check the newest tag before re-asking.

Watched upstream issues, checked on every new tag (status with
`gh issue view <n> --repo anomalyco/opencode`, then the tag's diff):

- **#59605**: `generate/*` runs in the `~/.config/opencode` location since
  #44773, so each call starts a second copy of every local MCP server. Until
  it is fixed, Jev stays off OpenCode's `generate/decisions`; once it is,
  Jev calls can move to that route (`routing/DOCUMENTATION.md`).
- **#59606** (closed): `PredicateQuestion` had no `criteria`. 2.2.7 adds an optional
  `criteria: { true?, false? }` (#62819), so the Jev
  features that ask yes/no questions with true/false criteria
  (`session-work/questions.js`, `session-goal/audit.js`) can move once #59605
  is fixed, after re-measuring their wording against OpenCode's prompt.

## Patches over OpenCode's bugs

The bundled server carries two fixes for OpenCode's file watching on Windows
(`packages/web/opencode-server/windows-folder-watch.mjs`, reasons in the
`DOCUMENTATION.md` beside it). On every new tag, read
`git diff vPINNED..vNEWEST -- packages/core/src/filesystem/watcher.ts packages/core/src/filesystem/location-watcher.ts packages/core/src/vcs.ts`
and say for each patch whether it stays:

- **Deleted folder** (`fs.watch` wrapper): goes when `watcher.ts` itself closes
  a watch whose event carries an absolute path, or stops using `fs.watch` for
  folders. Nothing fails when OpenCode changes here, so only this check finds
  a patch that is no longer needed or no longer reached.
- **Unchanged `HEAD`** (`headWatchPlugin` in
  `packages/web/scripts/prepare-opencode-server.mjs`): goes when OpenCode
  ignores a `HEAD` event whose file did not change. Bundling fails when the
  rewritten text is gone: port the rewrite, or remove it if OpenCode fixed the
  cause. The build cannot see a `HEAD` watch that moved to another path while
  the old text stayed, so check that `location-watcher.ts` still subscribes
  with `type: "file"`.

A patch is removed or ported only after its Windows scenario ran on the new
tag's staged server: delete an open worktree and see idle CPU fall back to
near zero; change only the access time of `.git/HEAD` repeatedly and see no
git commands; switch a branch and see `/api/vcs` report it.

## Settled: ours stays, rejected

Maintainer decisions. A "what's new" report proposes these again only when a
tag brings a capability that answers the stated reason.

- **Kept ours:** the server-owned message queue over the 2.x inbox; OpenChamber's
  git routes over 2.x `vcs` beyond `vcs.get`/`vcs.init`; the `agent-tool`
  plugin over client MCP (`mcp.client`), whose tools are per directory,
  visible to every client there including the TUI, always behind Code Mode,
  without plugin hooks or metadata, and cost one more MCP server per client
  and directory.
- **Rejected:** a `session.context` breakdown card. The route returns raw
  messages, so any per-category numbers would be estimates, and the
  maintainer wants no inaccurate figures.

## Behaviour to expect

Verified against live 2.x servers; re-check on a newer tag before relying on a
gap.

- **A cold location's catalog is not authoritative, and the client waits.**
  Since 2.4.0 no route waits for plugins (#63814): the first model, provider,
  agent or default-model read of a directory not started yet answers an empty
  list (`null` default), and the full one comes once the plugins activated,
  about half a second later on a bare config, announced by `*.updated` events
  with that `location.directory`. `plugin.list` stays empty until the first
  activation ends, so every catalog read first calls `waitForLocationPlugins`
  (`packages/ui/src/lib/opencode/location-plugins.ts` for the UI,
  `packages/web/server/lib/opencode/location-plugins.ts` for the server and
  VS Code, `waitForPluginList` there for raw-fetch readers such as the message
  queue and session warming): it polls `plugin.list` every 25 ms for up to 5 seconds, as
  OpenCode's own CLI does (`packages/cli/src/services/plugin-startup.ts`).
  On a warm location that is one quick request. A failed probe or a runtime
  switch counts as not ready: catalog reads that would commit an empty answer
  throw, readers that only refine (agents, skills) read anyway. `listAgents` reads first and
  waits only on an empty answer; committing the empty list made the agent
  picker flag the session's agent as missing. Server session selection
  (`openchamber-sessions/selection-inputs.ts`) refuses default selection with
  503 when the wait runs out, or when an OpenCode before 2.4 answers
  `ServiceUnavailableError` with `service: 'plugin'`. Recovery after a
  partial read still rides on the events (`markConfigCatalogStale`). A new
  catalog read goes through the wait too.
- **`generate.*` runs in the global config location** (`~/.config/opencode`),
  whatever directory the request names, and no longer waits for its plugins:
  the first call after start, or after an hour idle, answers
  `ModelNotFoundError` for a model a plugin provides. Small-model generation,
  the VS Code commit-message bridge and `image.generate` retry that error with
  backoff.
- **Plugin providers exist only in the running OpenCode.** Nothing about them
  reaches `opencode.json` or `auth.json`; `/api/provider` is the only view, and
  it strips `options.fetch`, so nothing tells a directly callable provider from
  one that only works through OpenCode. Without a zen login OpenCode sets
  `options.apiKey = "public"` on zen and trims it to free models: those run on
  OpenCode's infrastructure and are called only through OpenCode.
- **A session whose directory was deleted** still reads, but location-scoped
  requests answer 404 `LocationNotFoundError`. `STATUS_BY_TAG` does not map it
  to 404 on purpose: `fetchPermission` reads 404 as "settled", which would let
  auto-accept fail open. `POST /api/session/:id/move` works on such a session.
- **A background shell or a subagent has no clean cancel.** `shell.remove`
  kills the process but hands the agent a `Shell.NotFoundError`; interrupting a
  subagent's child session (no job-cancel route) reports "Subagent cancelled".
  Agents relaunch either, so `stopBackgroundShell` and `stopSubagent` post a
  cancellation note to the agent first.
- **Subagents always run in the background since 2.3.0.** The `subagent`
  call settles at once with `metadata.status: "running"`, and the parent gets
  a `<background-result kind="subagent">` report every time the child goes
  idle (`<subagent>` before 2.4.0; `background-result.ts` reads both). Foreground calls exist
  only in older history; `readBackgroundSubagentChildID` tells the two apart.
- **Any session created with `parentID` reports to its parent** (2.3.0):
  every busy period that ends with an assistant message sends a `<background-result kind="subagent">`
  report into the parent's inbox and wakes it for a model turn, whoever
  prompted the child. There is no opt-out (`subagent.notify` was removed in
  #63413). A session OpenChamber runs and collects itself, such as a workflow
  agent, is created without `parentID` and linked by metadata
  (`workflows/DOCUMENTATION.md`).
- **A plugin tool that reads `context.signal` opts into a cooperative stop**
  (2.3.0): on the user's Stop the signal aborts and whatever the tool returns
  is stored as the call's result. The `agent-tool` plugin reads it, so its
  generated `execute` rethrows once the signal aborted
  (`agent-tool/DOCUMENTATION.md`).
- **A shell call the user stops fails with the output so far** (2.3.0):
  `metadata.interrupted: true` and `metadata.notice` (the model's note at the
  end of the message). The row shows it as stopped (`toInterruptedShellPart`).
- **Built-in tool names moved in 2.4.0.** The image tool is `generate_image`
  (was `experimental_image_generate`, also the image-job notice's `source`);
  automations have their own `automation` namespace (`automation_list` in the
  registry, `automation.list` in Code Mode) and session tools sit under
  `opencode.session` (`opencode_session_rename`, `opencode.session.rename`).
  `opencodeNamespaceTool` reads every form; plugin IDs did not change.
- **MCP skills** (2.4.2, flag `mcp_skills`, off in releases): `skill.list`
  returns a server's skill as `<server>:<skill>` with path
  `skill://<id>/SKILL.md` and an empty `content`; the body comes from
  `experimental.skill.file`, and a prompt that attaches one can fail with
  `SkillLoadError` (502). OpenCode caches a read body per digest for the life
  of the process, so testing a failing read needs a fresh OpenCode.
- **Tool results carry no structured output on the wire.** The UI reads
  `content` text and `metadata`; a tool's `output` schema change (2.3.0 made
  edit/write strings and patch `{}`) does not reach it.
- **`time.firstToken`** on assistant messages (2.3.0, event
  `session.step.first-token`) marks the first output of any kind, a tool call
  included, so it is not a text TTFT.
- **`settings.tls` on a provider** (2.3.0) presents a client certificate on
  model requests only: web fetch, remote MCP servers and OpenChamber's own
  requests do not get it, which is why model discovery presents it itself.
- **`opencode run --agent X` uses the default model**, not the agent's: pass
  `-m provider/model#variant` in batch runs.
- **A shell allowlist is code execution** for an agent that reads untrusted
  text. The shell permission check skips declarations (`shell/parse.ts`), so
  `export X=...` or `declare -x` runs unchecked, and an allowed binary then
  runs a program the environment names (`gh`: `GH_PAGER` with
  `GH_FORCE_TTY=1`, `BROWSER`, `EDITOR`; `git`: `GIT_CONFIG_*` such as
  `gpg.program`). CI bot agents (`.opencode/agent/issue-intake.md` and the
  other bots) get `permissions` deny `*` with only read/grep/glob allowed and
  no token; the workflow prefetches into `.oc-context/` and posts the answer.
  Re-check `shell/parse.ts` on the new tag before giving any CI agent a shell.
- **Measuring session loads on real data:**
  [references/session-load-sweep.md](references/session-load-sweep.md).
- **A scratch `opencode serve` started from the app's shell answers 401**:
  the shell inherits the desktop's `OPENCODE_PASSWORD`, which wins over
  `OPENCODE_SERVER_PASSWORD`. Start it with `env -u OPENCODE_PASSWORD` (Basic
  auth user `opencode`).

## Sources of truth

- Reference checkout `~/projects/opencode`, branch `origin/dev` and its
  `v2.x.y` tags (`origin/v2` is abandoned; upstream PRs target `dev`). Maintainer
  machine only: where the path is absent, report it as unavailable and answer
  from the pins below. Server
  behaviour: `packages/core/src`, HTTP surface: `packages/server/src/handlers/*`,
  wire types: `packages/schema/src`, `packages/protocol/src/groups`.
- Minimum supported version: `MINIMUM_OPENCODE_VERSION` in
  `packages/web/server/lib/opencode/compatibility.js`; raise it when OpenChamber
  starts depending on a route a newer tag added.
- Pinned version: the `@opencode/*` devDependencies in
  `packages/web/package.json` and `packages/electron/package.json` (`@opencode/server` and the packages the
  bundled server imports, `packages/web/opencode-server`), the four native wrapper packages in `packages/web/package.json` `dependencies` (`@lydell/node-pty`, `@parcel/watcher`, `@ff-labs/fff-node`, `@opencode/pty`), and
  `@opencode/client` / `@opencode/schema` in the root, ui, web and vscode
  manifests. They move together,
  including `opencode.url` in `flake.nix` (see the bump steps).

## "What's new in OpenCode 2.x?"

Answer from the diff. Done when every API-facing change between the pinned
tag and the newest tag is classified.

1. In the reference checkout: `git fetch origin --tags`, pinned = the `@opencode/server` version in `packages/electron/package.json`,
   newest = `git tag -l 'v2.*' | sort -V | tail -1`, then
   `git diff --stat vPINNED..vNEWEST -- packages/schema/src packages/protocol/src packages/server/src packages/client packages/plugin/src`. Ignore `packages/tui`, `packages/app`, `packages/web`.
2. Classify each change to a route, event, schema or plugin hook:
   **breaks us** (name the consuming OpenChamber file), **fixes a workaround**
   (name the one above that can go and what the user gains), **closes an open
   ask**, or **neutral**.
3. Check every watched upstream issue and every patch above (*Patches over
   OpenCode's bugs*) against the new tag.
4. Report in that order with the maintainer's decisions explicit: remove,
   adopt, still ask, which watched issue the tag closes, and which patch stays.

## Bumping the pinned OpenCode

Move every pin to the same tag and check out that tag in the reference
checkout (`git checkout vX.Y.Z` in `~/projects/opencode`), `bun install`, then `bun run type-check`
(it covers `packages/ui`, `packages/web` and `packages/vscode`); the isolated ui suites; web vitest; vscode
tests. A new message `type` or event needs a case in `model.ts` and
`events.ts` before it renders.

Both `@openchamber/web` (including the Docker image) and desktop bundle OpenCode's server from those npm packages
(`packages/web/opencode-server`), and `server.mjs` there copies the
option mapping of OpenCode's `packages/cli/src/server-process.ts`. Diff that
file between the tags (`git diff vOLD..vNEW -- packages/cli/src/server-process.ts packages/cli/src/node packages/cli/vite.node.config.ts`)
and carry over every change to the `default` and `stdio` modes: a new
environment variable, option or startup step, and a new native loader or
rewrite in the Node build. Then `bun run --cwd packages/web prepare:opencode-server`,
`bun run --cwd packages/electron prepare:opencode-server` and `verify:opencode-server`,
and one real turn through the staged server
(`packages/web/opencode-server/DOCUMENTATION.md`). A bump also runs the check in
*Patches over OpenCode's bugs*.

Set `opencode.url` in `flake.nix` to the same `vX.Y.Z` tag and run
`nix flake update opencode` from the OpenChamber root. Include `flake.nix` and
`flake.lock` in the bump. OpenChamber's Bun cache derives from `bun.lock` through
bun2nix; OpenCode's dependency hashes come from the pinned upstream source.
There is no hash-baking workflow to repair a mismatched pin after merge.
Run `nix build --no-link .#openchamber .#openchamber-desktop`; `nix-eval` CI
also evaluates and builds both on x86_64-linux, aarch64-linux and aarch64-darwin.
If Nix is unavailable locally, report that and require those CI jobs to pass.

The OpenCode `node_modules` hash comes from the tag's `nix/hashes.json` unless
the per-tag table in `flake.nix` (`hash = { "vX.Y.Z" = { <system> = ...; }; }`)
overrides it. OpenCode's bot refreshes `hashes.json` on `dev` after a release,
so a tag whose release changed dependencies ships stale hashes. On a hash
mismatch, add an entry for the new tag with all three systems and drop the old
tag's entry:

- **aarch64-darwin**: the `got:` of a local `nix build --no-link .#openchamber`.
- **x86_64-linux and aarch64-linux**: push the bump, then
  `gh workflow run nix-eval.yml --ref <branch>`; each failing job's log shows
  `got:`. Add both, push, and run it again until all three jobs pass. Building
  OpenCode's own flake in Docker (`node_modules_updater`) gives a different
  hash, because it uses OpenCode's nixpkgs and Bun, not ours. An Apple Silicon
  Mac cannot compute x86_64-linux at all: `nixos/nix` under Rosetta or qemu
  fails on the pty, and Bun crashes under qemu (no AVX).

The Linux half is part of the bump, not a separate decision: once the bump is
committed and the local darwin build passes, push the branch and run
`nix-eval` without asking, then fix the hashes, commit, push and rerun until
all three jobs pass. The bump is done only then. A darwin mismatch means the
Linux hashes are stale too, so run `nix-eval` even when you cannot see them fail
locally.
