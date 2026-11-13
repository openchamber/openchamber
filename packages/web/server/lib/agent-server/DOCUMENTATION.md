# Agent server boundary

## Ownership

This module connects an owner-authority front door to a separate, untrusted
agent-account OpenChamber server. It owns normalized HTTP/socket ownership,
agent password sessions, bounded server-owned reads, typed control fanout, and
the one-way settings projection. Spaces owns the shared forwarding, socket,
session-merge and space-event mechanics. The server composition chooses which
runtimes exist; account permissions and hostd enforce filesystem authority.

`ownership.js` is the method/path authority. Unknown API routes go to the agent;
an agent failure never enters an owner project handler. Static assets and auth
remain local. The global session list uses the existing Spaces merge only when
the request has neither a directory nor a cursor.

## Invariants

- Front-door configuration requires a token and an HTTP loopback origin with
  no credentials, path, query or fragment. `localhost` is pinned to IPv4
  loopback. Invalid or partial configuration fails startup.
- Owner auth and origin checks precede forwarding. Owner credentials, scoped
  URL tokens, forwarding headers and upstream cookies never cross back into
  the other authority. Parameters keep their case; ownership comparisons do not.
- Authentication is shared across HTTP, sockets and readers. The cookie stays
  in memory, renews at 90% of Max-Age and gets one fresh login after a 401.
  A consumed body is never replayed. Redirects are errors.
- JSON reads have byte and whole-read time bounds. SSE readers bound both the
  unfinished line and cumulative event, including chunks split across CRLF.
- The dispatcher owns response header filtering and content neutralization.
  For already-sandboxed preview/guest routes it imposes its own sandbox policy;
  an upstream cannot grant itself same-origin script authority.
- Agent control/notification types have explicit schemas. Parsed objects are
  reconstructed, unknown types dropped, and provenance removed recursively.
  Browser requests carry `origin: 'agent'`, `spaceId: null`. They are data for
  the agent browser partition, not permission to drive an owner tab.
- Native events, typed events and listed sessions reject consumed directory
  fields under Space roots and session IDs already claimed by the owner index.
  Display text mentioning a Space is not a routing claim.
- Shared notification types are consumed only from notifications, not twice
  from both streams. The notification callback reaches control SSE plus the
  local notification SSE/WS consumers. File/render/secret replies still go to
  the agent-owned request route.
  Validated goal/review/browser-help/PR announcements also reach owner device
  delivery under owner settings and enterprise content rules. Raw OpenCode
  trigger kinds and the deliberately live-only notify tool are not pushed twice.
- Tracked-item interest and presence POSTs are local in front-door mode. Each
  UI control connection owns its items and visibility until that connection
  closes. `tracked-items.js` sends their union under the front door's upstream
  control connection id, obtained from a validated `event-stream-ready` frame.
  UI connection ids never leave the front door. Refresh POSTs still forward.
- The union uses the agent's item keys and 300-item bound. Visible connections
  precede hidden ones; within each group, the most recent interest or presence
  request wins. Items beyond the first 300 distinct keys are omitted upstream
  until capacity or priority changes. Each UI request retains its complete local
  set and receives only its own states from the agent's union answer.
- Upstream interest writes are serialized and repeated when the union,
  visibility or upstream control connection changes. Each UI interest request
  reads a fresh agent answer even when the union is unchanged. Aggregate
  visibility transitions also send presence before replacing interest, preserving
  the agent's refresh-on-return floor. Disconnect clears the successful-send
  baseline; reconnect registers all retained interests with the new id.
  Failed writes retain local interests
  and return 503 to awaiting requests; a subsequent request or reconnect retries.
  Background close/reconnect failures do not create an independent retry loop.
  Closed UI ids answer 409 for interest, as in single-account mode.
- Tracked-item answers use the bounded authenticated `agent-upstream.json`
  transport and `trackedItemEventSchema`. Keys must match their items. Unknown
  fields are stripped and states outside the union are excluded. Typed state
  events keep fanning out to every UI control client. The UI store indexes by
  runtime and item key, and selectors read their requested items only.
- Mirrored preferences are authoritative on the front door. Version 1 is an
  explicit key and nested-field projection. Enqueue captures a reconstructed
  snapshot; serialized PUTs ignore agent responses. Failure preserves the owner
  save. Per-session `permissionAutoAccept` policy stays on the agent;
  `permissionDefaultMode` remains an owner preference.
- New registry paths require literal `true` from a trusted ownership predicate
  or successful `shareProject` before saving. Default sharing fails with
  `share_project_unavailable`. Neither request claims nor agent answers establish
  ownership. Successful shares are not rolled back if a later path is refused.
- Display metadata is computed as the server account serving the route. The
  front door accepts only bounded `projectName` and `branch` strings and never
  falls back to git or worktree resolution after a delegated failure.
- Agent-only `GET /api/openchamber/host-credentials/providers`, `/provider`
  and `/secret` run behind API authentication. Provider queries require exactly
  one absolute registered project directory; `/provider` also requires the
  existing grant provider-id rule. Unknown and duplicate query parameters fail.
  Registration is conditional on agent-server mode, independent of the Spaces
  switch, because the agent server never owns Spaces.
- Provider definitions and environment-key answers are reconstructed through
  schemas, with a 256 KiB response cap and a 5-second whole-request deadline.
  Lists contain at most 256 providers and no keys or headers. Definitions contain
  at most 256 models and 32 headers; keys and text values are at most 8192
  characters. Model JSON has bounded nesting and collection sizes. A returned
  definition must identify the provider the front door requested. Agent fields
  cannot choose a space, grant id, purpose or reviewed inference model.
- Stored credentials use agent-only `GET /host-credentials/credentials` under
  `/api/openchamber`. The ordinary `GET /api/credential` remains refused.
  The agent route reads local OpenCode and preserves the SDK's `{ data }`
  envelope. Login replacement uses `POST /host-credentials/renewed-login`, which
  accepts only OAuth values for an already selected ChatGPT or Copilot login of
  the same method; it cannot connect a new provider or replace a key with a login.
  Existing-login renewal stays available in enterprise mode. Deletion uses the
  existing `DELETE /api/credential/:id` proxy. The SDK gets the authenticated
  upstream fetch, never owner OpenCode auth headers. The transport bounds replies
  to 4 MiB and 30 seconds; private routes also enforce the 256 KiB response cap
  and a 256 KiB renewal-body cap. The reader reconstructs at most 256 rows, bounded
  credential fields and metadata, and rejects duplicate active integrations.
  Renewal responses must retain the requested integration and login method.
  A failed read never falls back to owner environment, project files or keys.
- The front-door request gate refuses the whole `host-credentials` namespace for
  owner clients. Only server-owned calls through the direct agent upstream use
  it. The agent server mounts it after API authentication, so agent responses
  cannot turn these server-owned reads into a client credential-list endpoint.
- Secret responses use `Cache-Control: no-store`. Values travel in response
  bodies only, never error messages or logs. Failure codes distinguish malformed
  requests, unregistered projects, invalid replies, oversized replies and
  unavailable credential sources. Error bodies from the agent are allowlisted
  codes only; their free-form text never reaches Spaces.

- Agent-only `/api/openchamber/protected-mcp-agent/identity` and `/names` GETs
  accept exactly one absolute, registered `directory`. Identity uses the same
  git-common-directory resolver as the managed plugin. Both routes and their
  front-door readers reconstruct bounded replies. Identities exclude control
  characters and have at most 4096 characters; names use the protected MCP name
  rule with at most 64 characters and 256 names per reply.
- Agent-only `PUT /api/openchamber/protected-mcp-agent/selections` accepts a
  complete selection snapshot, with the bounds and per-file atomic replacement
  contract in [protected MCP](../protected-mcp/DOCUMENTATION.md). Normal API
  authentication guards all 3 routes. The front door refuses the namespace to
  its clients and uses its authenticated upstream for server-owned requests.
  Agent identities and mirror replies never participate in deciding which
  connections the service subject permits.

## PR fix-loop services

Approval-mode PR fix loops run in the front door, with its own authoritative
`pr-fix-loops.json`. Auto loops remain agent-owned. The
[PR fix-loop contract](../pr-fix-loop/DOCUMENTATION.md#front-door-approval-runtime)
owns mode/id routing, merged-list rejection of agent worker or approval claims,
receipt identity and lifecycle. Single-account behavior is unchanged.

Private `/api/openchamber/fix-loop-services` routes register only with
`OPENCHAMBER_AGENT_SERVER=1`, after normal API authentication. Only server-owned
calls through the authenticated
agent upstream use them; the front-door gate refuses their entire namespace to
owner clients. The front door initiates every call. The agent has no callback
into the front door, a Space or hostd.

Services reuse existing GitHub readers and Git services. POST operations are
`admit`, `feedback`, `author-permission`, `failed-checks`, `read-binding`,
`fetch-head`, `capture-ref`, `publish`, `review-operation` and `head-metadata`.
`GET head-bundle` streams the exact-head bundle. Each request carries only its
required owner, repo, PR number, opaque account id, registered project directory,
exact commit and ref. All project paths must canonically match a registered
agent project. GitHub tokens stay in the agent account.

POST inputs use strict schemas with a 256 KiB cap; reconstructed JSON replies
have a 4 MiB cap. Front-door requests have a 30-second deadline, except
`fetch-head`, `publish` and `failed-checks`, which allow 600 seconds: the last
downloads up to five job logs. Bundles retain the existing D2a transfer caps.

A feedback reply keeps what the runtime reads of each body: the agent marker,
the loop's `mentionText`, which the request carries, and the first 4,000
characters. Longer bodies are clipped, and the marker and mention go back in
when the cut removed them. A reply that still exceeds 4 MiB is clipped to 1,000
and then 100 characters, so a pull request with many long comments still reads.

Fetch-head names its contributor ref after the pull request, so retries for one
pull request overwrite one ref in the project.

The merged list leaves out, alone, an agent entry outside the automatic loop
shape, one that repeats an id, and one naming an owner identity or a Space
session. Creation drops request fields no route reads, such as the key and
thread a linked pull request row sends. Creations run one at a time, local and
forwarded alike, from the 409 check until their work settles, whether or not the
client is still waiting. A request whose client left before its turn does
nothing.

The installer moves approval loops and prepared workers in `pr-fix-loops.json`
to the front door with `spaces/`, and keeps automatic loops on the agent.

Agent replies remain untrusted and cannot select a loop, Space, host session or
publication authority. The front door generates receipt identities and retains
the existing fresh-provider, binding and exact-head checks. Exact-head seeding
and result promotion reuse the D2a bundle/code-out path; worker operations use
the front door's Spaces dispatcher. Failed reads preserve loop and receipt
state. No private service response or failure authorizes front-door project
access.

Creation keeps one automation per host session and pull request across both
instances. The front door refuses with `409 fix_loop_automation_conflict` an
approval loop when an agent loop still holds that session or pull request, and
an automatic loop when one of its own approval loops does. A forwarded creation
names `pushMode: 'auto'`, so the agent's own defaults cannot turn it into an
approval loop the agent cannot run.

## Projects another account owns

In a separated install the human account owns the projects and the agent server
runs as the agent account. git refuses a repository another account owns until
that account lists it in `safe.directory`. At startup and after every settings
write, `git-trust.js` adds each registered project folder and the folder that
holds its `.git` to the agent's global git configuration. It only adds entries.

Bundle transfers and fix-loop project services run git with every user and
system configuration off, so the global list does not reach them. After the
registration check, their git's global configuration is a file of the private
transfer folder that lists only those two folders of the one project the request
names. A `-c safe.directory` would not do: git before 2.38 reads that key from
system and global configuration only, and Ubuntu 22.04 ships git 2.34 with the
ownership check.

## Decisions

### Why approval orchestration stays in the front door

An agent callback for worker operations would cross the one-way account boundary
and give the agent access to front-door Space authority. A separate approval
runtime keeps that authority local while the agent answers bounded credential
and project operations. Auto mode keeps its existing agent-owned runtime.

### Why tracked interests share the upstream control connection

The agent service accepts interests only for its own open control connections.
The front door owns UI control ids and aggregates them into the one connection
it opens to the agent. Forwarding a UI id fails that ownership check. Keeping
the aggregation here preserves single-account service behavior and lets a new
upstream connection restore every still-open UI interest.

### Why the interest union prioritizes visible recent requests

The agent accepts at most 300 items per connection. One upstream control stream
therefore requires a bounded union across UI clients. Visible clients get the
capacity first, followed by the most recent requests; omitted items remain
locally registered so closing a client or changing visibility can restore them.

### Why credential reads run in the agent account

The agent account owns OpenCode credentials, browser logins, provider config and
model-key environment variables. The front door owns grant decisions and reads
those sources through its authenticated upstream. Both accounts can see agent
secrets by design; this flow sends no front-door secret to the agent. Existing
grant and enterprise policy remain at their current enforcement points. These
reads stay on loopback and add no external listener or provider-creation route.

### Why private credential routes preserve the public refusal

The ordinary credential-list proxy deliberately refuses to disclose all keys to
UI clients. An agent-only route reads local OpenCode for the front door's server
operations, and the front door refuses that route to its clients. Renewal has a
separate existing-login-only route because ordinary credential creation is
provider entry and is refused in enterprise mode. Both single-account credential
access and public credential refusals keep their existing behavior.

### Why environment names exclude runtime configuration

Environment reads accept `^[A-Za-z_][A-Za-z0-9_]{0,255}$`. Case-insensitive
prefix exclusions cover `OPENCHAMBER_`, `OPENCODE_` and `HERMES_OC_` control
credentials; `NODE_` and `NPM_` runtime configuration; `XDG_` storage paths;
`SSH_`, `GIT_` and `DOCKER_` execution and transport configuration; and
`SYSTEMD_` and `INVOCATION_` service state. Exact exclusions cover `UI_PASSWORD`,
`CREDENTIALS_DIRECTORY`, `NOTIFY_SOCKET`, `LISTEN_FDS`, `LISTEN_PID` and
`LISTEN_FDNAMES`, including the legacy UI password and systemd credential/socket
locations. These are application and process controls, outside model-key access.
Custom-provider `env` references use the same filter. Single-account reads retain
their existing environment behavior.

### Why one composition and not a second server entrypoint

One `FRONT_DOOR` branch gates executor construction, start and subscriptions.
Copying the composition would let new project runtimes silently appear on the
owner side. With neither special mode configured the existing composition runs.

### Why the Spaces dispatcher and not another proxy

Spaces already owns the streaming body, header, response-policy and socket
boundary. An optional authenticated target reuses those mechanics while keeping
its default place transport unchanged.

### Why the front door serves its own event hub

Upstream events cannot establish space provenance. Local SSE and both message
sockets consume the front-door hub; a directory socket filters that same hub
instead of opening an unchecked upstream stream.

### Why session permission policy stays on the agent

Forwarded session routes mutate and persist permission policy on the agent.
Replaying the front door's legacy `permissionAutoAccept` snapshot could restore
an auto mode the user revoked, including after an agent restart. The projection
excludes that key entirely and mirrors only the default preference.

### Why versioned replacement rather than an ordinary merge

Ordinary settings PUT preserves omitted fields. The mirror marks a full
version-1 snapshot with `x-openchamber-settings-mirror: 1`; only agent-server
mode accepts that contract. Before merging it removes absent allowlisted keys
from the current document, including fields whose ordinary sanitizer has no
clear value. Non-allowlisted agent state remains intact. Supported explicit
clear values also travel in each snapshot, including first startup; no
in-memory previous-send baseline is needed to clear stale disk values.

### Why sharing fails closed

The default composition has no hostd sharing integration. New registry paths
need a trusted ownership decision or successful sharing before saving. Missing
integration refuses the registry change without an owner filesystem fallback.

### Why project MCP metadata can come from the agent

Project identity chooses a selection filename and ordinary names describe
conflicts. Neither grants a protected connection. The front door can accept
bounded, validated agent metadata while the service subject remains the union
of front-door selections. Project requests require registration on both sides;
delegation failure never reads a project on the front door.

### Why Space project transfer stays on the agent

`space-transfer-routes.js` registers only in agent-server mode, after normal UI
authentication. Every operation requires an exact canonical match in mirrored
`settings.projects` and a valid 12-hex space id. Snapshot and result refs use only
that id's `refs/openchamber/spaces/<id>/` namespace. Apply as branch separately
accepts the explicitly requested branch through the existing branch validator.
Query and JSON schemas reject client-selected ref names.

`space-transfer.js` owns snapshot metadata and project-side operations. The
existing snapshot code creates the start ref; bounded, versioned metadata binds
its project, base, staged commit, start commit, prefix, identity and object format.
Metadata reads recheck the project ref and parent chain. Missing or malformed
metadata is never an empty snapshot. Missing sidecars of existing spaces can be
reconstructed only from the front door's recorded base and the existing start
ref, with the same parent checks and without resnapshotting. Malformed sidecars
are refused. Shallow-root lists are bounded object ids and are refreshed from
the project on every snapshot read. Deletion removes the namespace
and its metadata. Existing single-account transfers do not use this format.

The endpoints under `/api/openchamber/space-transfer/<id>/` are POST/GET
`snapshot`, GET `bundle`, POST `result`, GET `apply-state`, POST `apply-branch`,
POST `apply-changes` and DELETE `refs`. All require `directory` in the query.
GET `snapshot` also accepts the recorded `base` for legacy reconstruction. The
result upload requires `start` and `result` object ids. Bodies carrying
bundles stream as `application/x-git-bundle`; JSON never contains bundle bytes.
The shared authenticated `agent-upstream.request` supplies the cookie, refuses
redirects and never replays a consumed mutation body.

The front door imports complete start bundles into operation-private repositories.
It uses the existing sender and quarantine against those mirrors, then returns
a checked result bundle to the agent. The agent checks the result header, start
prerequisite and object format, then reuses quarantine measurement and promotion.
Neither side accepts additional advertised refs. Project access never becomes a
front-door fallback, including after an unreachable agent or an invalid response.

The bundle, JSON, timeout, disk-cost and shallow-source limits are defined under
"Front-door source" in [Spaces](../spaces/DOCUMENTATION.md). This transport stays
on the already-configured authenticated loopback connection. It adds no listener,
provider entry or off-machine content flow.

## Remaining boundary work

Track E enforces agent browser partitions. Account isolation,
unit hardening and hostd grant validation require the separate three-account
harness; the same-account functional run proves none of those protections.
