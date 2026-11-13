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

Open asks upstream (OpenCode Slack): declaring 500 bodies on session
mutations; `provider.list` and `agent.list` waiting for plugin activation the
way `model.list` does since 2.0.27 (done in 2.2.0; the cold-catalog
recovery in `useConfigStore` can go); built-in provider plugins setting
attribution headers only when the client has not set its own, so a client can
name itself to a provider (today some plugins overwrite provider-level
headers). Dropped: an import route for missing 1.x
sessions (the top-up workaround is enough). Check the newest tag before re-asking.

Watched upstream issues, checked on every new tag (status with
`gh issue view <n> --repo anomalyco/opencode`, then the tag's diff):

- **#59605**: `generate/*` runs in the `~/.config/opencode` location since
  #44773, so each call starts a second copy of every local MCP server. Until
  it is fixed, Jev stays off OpenCode's `generate/decisions`; once it is,
  Jev calls can move to that route (`routing/DOCUMENTATION.md`).
- **#59606**: `PredicateQuestion` has no `criteria`, so the Jev features that
  ask yes/no questions with true/false criteria (`session-work/questions.js`,
  `session-goal/audit.js`) cannot move to `generate/decisions` without
  re-measured wording.

## Behaviour to expect

Verified against live 2.x servers; re-check on a newer tag before relying on a
gap.

- **A cold location's catalog is not authoritative.** The first provider/model
  read for a directory not started yet answers an empty list, then a partial
  one without plugin providers, and the full list about two seconds later,
  announced by `provider.updated` / `model.updated` with that
  `location.directory`. Recovery rides on those events (`markConfigCatalogStale`).
  Since 2.0.27 `model.list` and `model.default` wait up to 5 seconds for the
  location's plugins; `provider.list` and `agent.list` still answer early, so
  the recovery stays.
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
- **`opencode run --agent X` uses the default model**, not the agent's: pass
  `-m provider/model#variant` in batch runs.
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
- Pinned version: `opencodeCli.version` in `packages/electron/package.json`
  (the bundled binary) and `@opencode/client` / `@opencode/schema` in the
  root, ui, web and vscode manifests, plus `@opencode/cli@` in the
  Dockerfile. They move together, including `opencode.url` in `flake.nix`
  (see the bump steps).

## "What's new in OpenCode 2.x?"

Answer from the diff. Done when every API-facing change between the pinned
tag and the newest tag is classified.

1. In the reference checkout: `git fetch origin --tags`, pinned = `opencodeCli.version`,
   newest = `git tag -l 'v2.*' | sort -V | tail -1`, then
   `git diff --stat vPINNED..vNEWEST -- packages/schema/src packages/protocol/src packages/server/src packages/client packages/plugin/src`. Ignore `packages/tui`, `packages/app`, `packages/web`.
2. Classify each change to a route, event, schema or plugin hook:
   **breaks us** (name the consuming OpenChamber file), **fixes a workaround**
   (name the one above that can go and what the user gains), **closes an open
   ask**, or **neutral**.
3. Check every watched upstream issue above against the new tag.
4. Report in that order with the maintainer's decisions explicit: remove,
   adopt, still ask, and which watched issue the tag closes.

## Bumping the pinned OpenCode

Move every pin to the same tag and check out that tag in the reference
checkout (`git checkout vX.Y.Z` in `~/projects/opencode`), `bun install`, then `bun run type-check`
(it covers `packages/ui`, `packages/web` and `packages/vscode`); the isolated ui suites; web vitest; vscode
tests. A new message `type` or event needs a case in `model.ts` and
`events.ts` before it renders. Verify `@opencode/cli@<tag>` exists on npm:
the desktop packaging and the Docker image install it.

Set `opencode.url` in `flake.nix` to the same `vX.Y.Z` tag and run
`nix flake update opencode` from the OpenChamber root. Include `flake.nix` and
`flake.lock` in the bump. OpenChamber's Bun cache derives from `bun.lock` through
bun2nix; OpenCode's dependency hashes come from the pinned upstream source.
There is no hash-baking workflow to repair a mismatched pin after merge.
Run `nix build --no-link .#openchamber .#openchamber-desktop`; `nix-eval` CI
also evaluates and builds both on x86_64-linux, aarch64-linux and aarch64-darwin.
If Nix is unavailable locally, report that and require those CI jobs to pass.
