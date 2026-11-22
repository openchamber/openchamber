# Managed OpenChamber Agent Tool

## Purpose

This module exposes OpenChamber to agents as typed OpenCode custom tools. There
are two, because controlling sessions and driving a page are separate intents
the user can want independently:

- `openchamber` — projects, sessions, worktrees, and showing a file to the
  user (`file.open`). Enabled while the persisted `agentControlToolEnabled`
  setting is not `false`.
- `openchamber_schedule` — the `schedule.*` actions of the same control
  service, for scheduled tasks. Enabled while `agentScheduleToolEnabled` is not
  `false`. It used to be part of `openchamber`; reading settings sets it to
  `false` once for someone who had switched the control tool off
  (`settings-runtime.js`), so the split hands nobody a tool they turned off.
  Like the control tool, a stale plugin is not refused: the CLI runs the same
  actions, so the service cannot tell an agent call from a CLI one.
- `openchamber_web` — looking at and interacting with the page in OpenChamber's
  browser panel. Enabled while `agentWebToolEnabled` is not `false`.
- `openchamber_notify` — `notify.send`, a notification to the user through
  `lib/notifications/emit-route.js` (same limits and rate window as
  `POST /api/notifications/emit`). Off by default: enabled only while
  `agentNotifyToolEnabled` is `true`, and the control service refuses the
  action when the setting is off, so a stale plugin cannot keep paging.
- `openchamber_knowledge` — the project's Notes, Todos and Plans, the items of
  the Project knowledge panel (`knowledge.list`, `save`, `delete`, `show`,
  with `kind` naming note, todo or plan; plans are files, so list and save
  give their path and the agent reads and edits them with its own file tools;
  dispatched by
  `../openchamber-control/project-knowledge.js` into
  `../project-context/runtime.js`). On by default: enabled while
  `agentKnowledgeToolEnabled` is not `false`, and the control service refuses
  these actions when it is, so a stale plugin cannot keep writing. Writes are
  attributed to the session OpenCode reported, never to a payload field.
- `openchamber_render` — `render.page`, a self-contained HTML page (`html`,
  `title`) the chat draws inline above the agent's answer, such as a chart or
  table. The page travels in the call's input, which OpenCode stores and
  syncs, so the server keeps no copy: `../openchamber-control/render-page.js`
  only checks the input (`html` at most 200,000 characters so the callback
  body stays under its 1 MB limit, `title` at most 120) and the setting.
  On by default: enabled while `agentRenderToolEnabled` is not `false`, and the
  control service refuses the action when it is, so a stale plugin cannot
  keep drawing. When to draw is stated only in the line every session carries
  (`../session-knowledge/DOCUMENTATION.md`, *When to draw a page*), along with
  the mockup exception: a mockup of the user's own project takes its look from
  that project's code. The tool description keeps the look rules agents broke
  most (no page background, no outer card, theme variables). How to write the
  page is the `html` input's description: layout, boxes, the theme variables
  the chat injects (`packages/ui/src/components/chat/message/parts/htmlRender.ts`;
  change both together), how a page with its own colors, such as a project
  mockup, keeps clear of them (a color on all its text and a background of its
  own, since the injected base stylesheet colors unset text and the frame is
  transparent), image files by path from anywhere on the machine as
  the image grant route allows, and the temporary directory to save a
  screenshot in (`os.tmpdir()/opencode`) so it stays out of the project. How
  to ask on a page is the `awaitAnswer` input's description.
  With `awaitAnswer` the call waits for the user's answer on the page. The
  plugin sends the call id (`context.id`) with the callback so the server can
  find the waiting call when the chat answers it, and copies the answer into
  the call's metadata (`metadata.openchamber.answer`), so every client shows
  the page as answered. The waiting callback sends Bun's `timeout: false`,
  since Bun's fetch otherwise ends a request with no response after about six
  minutes. While the call waits, OpenCode holds any chat message
  for that session until the call returns, so the plugin registers a
  `session.prompt` hook: a prompt for the session, from any sender, aborts the
  waiting call, which returns `{ answered: false, reason: "chat" }`, and the
  agent reads the message next.

Both default to on, are toggled in Settings → General → OpenChamber Tools, and take
effect in the running OpenCode within a couple of seconds — OpenChamber rewrites
the managed config file OpenCode watches (see
`lib/opencode/managed-config-file.js`). Installs where the user's own
environment sets `OPENCODE_CONFIG` fall back to `OPENCODE_CONFIG_CONTENT` and
still need a restart for a toggle. Each tool carries only its own actions and
only the parameters those actions use, so turning one off removes its inputs
from the schema rather than leaving them visible. The plugin is injected only
when OpenChamber launches and owns the OpenCode process, and not at all when
both settings are `false`.

- Every tool is registered with `options: { codemode: false }`, so it is a
  direct tool in the model's tool list. OpenCode 2 otherwise puts plugin tools
  behind its Code Mode `execute` tool, where the model sees only a
  size-limited catalog; with a few large MCP servers ours dropped out of it and
  agents concluded the tool did not exist. `agentToolsCodeMode: true` (the
  "Run through Code Mode" checkbox in the same section, off by default) flips
  all of them to `codemode: true`, except `openchamber_render`: the chat draws
  a page from that tool's own call (its input and stored result), and inside
  an `execute` script the call is only an entry in `execute`'s list, so the
  page never showed.
- A direct tool is part of the request's tool list, which providers cache as
  the start of the prompt, so turning one on or off makes a running session's
  next turn skip the prompt cache. A Code Mode tool changes only the catalog,
  which OpenCode keeps as a session baseline and updates by appending a message.
  The Settings page says which switches cost the cache for the current
  `agentToolsCodeMode` (measured in developing-today/openchamber#149), and only
  while `managedToolsApplyLive` from `GET /api/config/settings` is true: with an
  external OpenCode or a user-owned `OPENCODE_CONFIG` a switch waits for a
  restart and leaves the running session alone.
- The plugin accepts the action's inputs either inside `parameters` or beside
  `action`, because models produce both shapes; an explicit `parameters` object
  wins on a conflict. Rejecting the flattened shape turned a call that plainly
  carried a `url` into "url is required", which reads as a broken tool rather
  than a malformed call. The schema declares the inputs only inside
  `parameters`, and `additionalProperties: true` at the root lets flattened
  inputs and unknown fields (a stale `wait` or `timeout`) through to the
  adapter.

### Why scheduling is its own tool and not part of `openchamber`

Scheduling is a separate intent from running sessions, and its ten inputs
(`taskId`, `name`, `daily` ... `disabled`) rode in the control tool's schema on
every request. As its own tool it can be switched off by someone who never
schedules, and each schema lists only the inputs its actions take. The rest of
the control tool stays one tool: its actions share `sessionId`, `directory`,
`prompt` and `model`, and split apart they would repeat them. `name` and
`disabled` stay in the control tool as well: its provider, model, MCP, skill and
integration toggles take them, so the schedule tool redeclares them bare.

### Why the inputs are declared once and not beside `action` too

Copying every input to the schema root would let the descriptions reach a
model that fills in the flattened shape, but outside Code Mode the schema
ships with every request: the copy costs about 8.7k characters per turn when
all tools are on, and the flattened calls already work through
`additionalProperties`.

## Runtime flow

1. The OpenChamber HTTP listener binds and publishes its authoritative port.
2. `materializePlugin()` writes the plugin under
   `<instance-dir>/agent-tool/` and returns its directory; the managed
   config layer lists that directory in `<instance-dir>/opencode.managed.json` and
   rewrites the file whenever a tool setting changes. `<instance-dir>` is
   `<data-dir>/run/instances/<server-pid>/`, or the folder of the managed OpenCode this server adopted (`../opencode/instance-dir.js`):
   the plugin carries this server's tool declarations, so a second server on
   the same data dir must not overwrite it (#4470). The plugin source is
   written as `index.js`, with a `package.json` whose `exports` resolves the
   entrypoint, plus a `server.js` re-export of `index.js`'s default export:
   OpenCode probes `<dir>/server` first and the Bun resolve bug
   (developing-today/opencode#16) breaks its fallback to `index.js`, so
   without `server.js` a plugin reload fails with `Cannot find module '…/openchamber-agent-tool/server'`.
3. `createChildEnv()` adds a random per-child token and the callback URL to the
   managed OpenCode child environment. They are present even while every tool
   is off, so a tool switched on later can call back without a restart. The URL
   points at loopback, except when the listener is bound to one concrete
   address (`--host <ip>`): that socket does not answer on loopback, so the URL
   uses the bound address instead.
4. The plugin calls `POST /api/openchamber/agent-tool` with its typed input and
   the session id OpenCode gives the tool; OpenChamber resolves the session's
   directory on its own side.
5. The route delegates the fixed action allowlist directly to the shared
   OpenChamber control service. The CLI uses the same service through its
   authenticated HTTP adapter, so Goal Mode ordering, CLI wait behavior,
   result delivery, partial-failure reporting, and scheduled-task contracts
   have one owner.
6. Each action definition owns a short presentation title and a separate
   agent-facing description. The generated schema uses the description to state
   required inputs or one non-obvious behavior, while completed calls use the
   short title in native tool metadata.

## Agent context budget

Every tool's description, action descriptions and input schema ride in every
request, so each rule is stated once, in the fewest words that keep it, at the
level where the agent needs it: the tool description says what the tool is
and the few rules that hold for every call, an action description its required
inputs and one non-obvious behavior, a parameter description its format,
default and when to set it. Field names and JSON types carry the rest.

- Every tool description stays within 2048 characters, which a test enforces.
  Claude Code before 2.1.296 passes an MCP tool description on only up to
  2048 characters (4096 after), and the plugin that runs it uses whichever CLI
  the user installed; the input schema reaches the model whole. A rule that
  only matters while writing one input, such as the page layout rules on
  `html`, is that input's description.
- The tool exposes one shared parameter object rather than repeating parameters
  in a large per-action union.
- The action schema carries `oneOf` and no `enum`. A node combining `enum` and
  `oneOf` is valid JSON Schema, but some OpenAI-compatible gateways reject it
  and answer with an empty completion instead of an error.
- A tool with a single action (render, notify) declares `action` as a plain,
  optional string and always runs its one action. A weaker model put the whole
  render call into `action` as a JSON string, title included, with the html
  beside it; the strict `oneOf` refused that before the tool ran, and every
  retry sent the whole page again. Such a string is revived, and its fields
  fill only what the call did not already carry.
- Obvious fields rely on their names and JSON types. Parameter descriptions are
  reserved for formats, dependencies, scope, and behavior that cannot be safely
  inferred from the field name.
- Session dispatches never wait. An agent that needs the outcome sets
  `returnResult`: the call still returns at once, with
  `resultDelivery.status: 'pending'` and a note telling the agent not to poll
  or sleep, and the session's final answer is delivered into the calling
  session when it finishes (`../dispatch-results/`). The schema carries no
  `wait` or `timeout`, and the adapter answers a stale `wait`, `timeout`, or
  `lastAssistant` on a dispatch with a usage error naming `returnResult`
  (`agentOnlyUsageError`). `session.messages` does not wait either: it reads
  what is there. The control service keeps `wait` for the CLI only.
- Boolean inputs cross two checks. The generated adapter normalizes exactly
  the strings `"true"` and `"false"` for the fields the calling tool's own
  parameter schema declares `type: 'boolean'` (derived from that schema at
  generation time), because a harness can stringify a boolean on the way and
  every downstream `=== true` would read it as false. Every other value keeps
  its identity, and the server check still refuses it: the plugin forwards raw
  JSON, so a field declared `type: 'boolean'` in any tool's schema that arrives
  as anything else fails the call with a usage error naming the field
  (`nonBooleanParameterError`), before any action runs. A callback that
  bypasses the adapter is refused the same way, so the strictness never depends
  on the plugin having normalized first.
- `parameters.link` for `session.link` can arrive as a JSON string even though
  the schema declares an object (#4591). The generated entry parses it once
  before the merge and keeps the result only when it is a plain object;
  anything else reaches `linkInputSchema` unchanged. No other field is
  revived, so prompts and titles that happen to look like JSON stay text.
- The description draws the line against OpenCode's own `subagent` tool:
  `subagent` when the agent delegates part of its own task and wants the
  answer for itself, `session.*` when the user asks for a separate session
  they will follow and talk to.
- The tool exposes only agent-relevant actions
  (`OPENCHAMBER_AGENT_TOOL_ACTIONS`): `schedule.status` stays CLI-only because
  `schedule.list` already returns scheduler status, and enable/disable are one
  `schedule.toggle` action driven by the `disabled` boolean.
- The tool description frames intent: created sessions and scheduled tasks are
  user-facing work the user follows up with. The agent must not decide on its
  own to delegate parts of its current task, but an explicit user request to
  create, send, or schedule always wins, even when it relates to the current
  task (strict models otherwise read the old unconditional "never delegate" as
  a hard ban and refused user-requested sends).
- Optional behavior switches (`worktree`, `pullRequest`, `goal`, `agent`,
  `variant`, `returnResult`) state their default and an explicit "only when
  the user asks" rule so agents do not invent worktrees, goal mode, or result
  deliveries the user never requested.
- `pullRequest` is a pull or merge request number in the project. The session
  starts in a worktree made from it the way the New worktree dialog makes one
  (`../git/DOCUMENTATION.md`, *Worktree creation from a GitHub pull request*);
  everything else about the request is resolved on the server.
- `session.moveToWorktree` moves the calling session (or `sessionId`) into a
  new worktree of its repository (`../openchamber-sessions/worktree-move.js`).
  `worktree` is required there and `startRef` defaults to the repository's
  default branch; `existingBranch` checks out a branch that already exists
  instead, local or remote (`origin/feature`), and cannot be combined with
  `branch` or `startRef`. `carry` names the files whose uncommitted changes
  go along; nothing else moves. The tool description introduces
  the move: what it does, when a checkout looks busy,
  and that whether to use it depends on how the user works, so the agent asks
  first unless the request already calls for separate work. It also says
  why to prefer it over `git worktree add` (the session moves along). It is an
  introduction on purpose. It used to be a rule in every session, with a
  setting to move unasked, and that made one person's workflow everybody's.
  The session context names the branch (`../session-knowledge/`), and
  OpenCode tells the agent when it changed between its messages, which the
  agent cannot see for itself.
- Detailed combination rules are enforced by the shared control service and
  returned as actionable usage errors only after an invalid call. Per-action
  examples and a repeated per-action parameter schema are intentionally omitted.

### Why the plugin removes some of OpenCode's own tools

While the control tool is on, the plugin's tool transform removes
`opencode_worktree_create` and `opencode_models` (`OPENCODE_TOOLS_REPLACED_BY_CONTROL`).
OpenCode registers its tools before config plugins and replays transforms in
that order, so the removal reaches them, and a removed tool leaves the Code
Mode catalog too. Two ways to do one thing made agents pick by accident:
`worktree_create` checks out a detached copy of the current commit and leaves
the session behind, so on someone else's branch it starts from their commits,
where `session.moveToWorktree` and `session.create` with a worktree branch
from the default branch. `models` searches the whole catalog; `models.search`
does the same without the models the user hid in the picker and with
favorites and recent models first. `session_move`, `session_rename`,
`worktree_list` and `worktree_remove` stay: the control tool has no
equivalent, and `session_move` is the only way to move a session into a
directory that already exists. OpenCode's system line that points agents at
`session_move` after creating a worktree stays with them.

### Why a rule about when to act lives only in the session context

When to link an issue, save a memory or draw a page is stated once, in every
session's context (`../session-knowledge/`), and no tool description repeats
it. A trigger has to reach an agent that has not thought of the tool yet: told
only in the `session.link` action, an agent investigating an issue never linked
it, and with the rule in the session context the next agent linked the issue
first thing (2026-10-02). The tool descriptions carried a second copy of each
trigger, which cost about 2,000 characters per request and pushed two of them
past the 2048-character cut.

## Security invariants

- The callback accepts same-machine requests only and requires the current
  per-child bearer token using a timing-safe comparison. Same-machine means a
  loopback source, or, for a listener bound to one concrete address, a source
  equal to that address: the OS sources a local connection to `<ip>` from
  `<ip>`. A wildcard bind keeps the loopback-only rule, and another machine on
  the network always arrives with its own address.
  `callback-address.js` owns this rule; the repository credential helper
  (`lib/git/repository-credential-runtime.js`) reaches the server the same way
  and shares it.
- The token is never persisted, logged, returned to the UI, or written into
  the materialized plugin.
- The plugin adds the callback host to `NO_PROXY`/`no_proxy` inside the managed
  child when it loads. Without that, an `HTTP_PROXY` in the child's environment
  would receive a non-loopback callback, token included, because `fetch` has no
  per-request way to skip the environment proxy.
- Inputs map to a fixed action and parameter allowlist. There is no arbitrary
  CLI, shell, route, or URL forwarding.
- `projects.add`/`projects.remove` expose project registration itself —
  adding/removing the configured entry only, via the same settings path the
  UI's directory picker uses. `projects.update` changes a project's display
  and default settings only, never its path or id. Session/worktree deletion
  is still not exposed.
  OpenCode's own `worktree_remove` stays available to the agent, behind the
  `edit` permission, so the control tool's description says only that this
  tool cannot delete.
- Connected services (`integrations.list`, `github.*`, `gitlab.*`,
  `linear.*`, `binding.*`, `extensions.*`;
  `../openchamber-control/integration-service-actions.js`) can be read and
  changed, never signed in to: no action takes a token, password or client
  secret, an input holding a key named like one is refused, and answers have
  such keys removed. Signing out and changing Git credentials need `confirm`.
  Approving an extension's capabilities and installing, updating or removing
  one stay with the user.
- A cancelled turn aborts the session's in-flight actions. OpenCode 2 gives a
  plugin tool no abort signal and the plugin's request stays open, so the
  server tracks in-flight actions per session and `abortSession(sessionID)` is
  called from the event dispatch in `server/index.js` when the stream reports
  `session.idle` with `aborted: true`; the abort signal then reaches the
  shared service as before. A dropped HTTP request still aborts as well.

## Result contract

Every completed call returns JSON:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "action": "session.create",
  "data": {}
}
```

Command and operational failures use the same envelope with `ok: false` and
an `error` object. OpenCode-level cancellation can still produce a native tool
error state.

## Runtime parity

- Web and Desktop managed OpenCode: injected automatically.
- External OpenCode selected with `OPENCODE_HOST` or skip-start: not injected,
  because OpenChamber does not control that process environment.
- VS Code: not injected; the extension owns a separate OpenCode lifecycle.
- Hosted and Capacitor mobile clients use the server's managed OpenCode tool
  when connected to such a server; no tool runs in the client runtime.

## The calling tool is part of the request

Each generated tool sends its own name with every callback. Models routinely
drop the namespace their tool's name appears to supply — `openchamber_memory`
asked for `memory.read` gets called as `read` — and resolving the bare name
inside the calling tool's action set makes that unambiguous even where it is not
globally (`delete` belongs to both schedule and memory).

Resolution never reaches outside the tool that asked: `open` from the memory
tool fails rather than driving the browser. An unresolvable action answers with
the actions that tool actually has, because an error that only says
"unsupported" leaves the model to guess a second wrong name — which is exactly
what happened before this existed.
