# OpenCode adapter

## Ownership

This module owns official OpenCode SDK calls and translation from wire records
to the shared UI domain model. Sync owns transcript membership and store writes.
Wire session and message shapes stay inside this adapter. Stores and rendering
consume the domain model across web, desktop, VS Code and both mobile clients.
The domain model also exports integration connections, authentication methods,
form fields, answers and conditions, and permission effects for shared UI consumers.
Tool-name branching belongs in `tools.ts`; unknown plugin and MCP tools retain
generic rendering.

## Invariants

- `getSessionMessage` reads only the requested session. Pins, message references
  and linked-message existence checks must retain this strict behavior.
- `getToolContentMessage` is reserved for `completeToolContent`, which checks
  that the displayed transcript already holds the message and a shelled result.
  It projects the result into that transcript without changing other readers.
- Ancestor reads follow only server-provided `parentID` links after a message
  404. At most 32 sessions, including the requested session, are read. An ended
  or cyclic chain, the limit, a missing session or a runtime switch returns the
  first message 404. Other errors stop the walk and propagate unchanged.
- A runtime switch during a successful read also discards that response. Sync
  independently checks runtime identity and transcript membership before writing.
- A send that switches the session's agent first reads the folder's agent list.
  Sync also passes the agent when the session already sits on one the folder's
  loaded catalog lacks, so that session gets the same check.
  An agent missing from it throws `AgentUnavailableError` before any switch,
  the model included. A failed or empty list lets the switch through. The class
  lives in `agent-unavailable-error.ts`, so code that only reads the error does
  not load the client.

### Transport and authoritative state

- Every mutation in a multi-request send checks the captured runtime identity.
  A switch after context admission or a cancellation note must stop the remaining
  requests before they reach another server.
- Directory-scoped reads and location eviction name the folder the user is
  working in. An unscoped location request starts or evicts OpenCode's own
  working directory, including its MCP servers.
- Read cancellation and deadlines remain active through JSON body delivery.
  Manual signal composition retains both the caller's cancellation and the
  timeout on WebViews without `AbortSignal.any`. Long-lived streams are excluded.
- Folder trust refusal suspends the request until an answer. Saved trust permits
  a retry, including trust saved in another window; a decline remains a refusal.
- `LocationNotFoundError` stays outside the HTTP 404 tag map. Permission readers
  interpret 404 as settled, so mapping a missing location to it would let
  auto-accept fail open. Other permission and form read failures preserve state.
- A transport failure leaves a mutation's outcome unknown because the server
  may already be running it. Only a routing failure proves nondelivery. Prompt
  retries cannot follow a lost transport response.
- Directory probes distinguish missing from unknown. Batched probes share a
  request within the admission window, respect the server's cap and resolve as
  unknown across a runtime switch. Filesystem stats describe OpenChamber's
  machine; only OpenCode's own refusal proves its working folder is gone.
- Home and chats roots belong to the same valid server response. The injected
  desktop home applies only to the local runtime. A failed read cannot use the
  legacy fallback for a server that omits `chatsRoot`; the home route resolves
  against runtime state at call time, before client rebinding completes.
- Failed activity reads remain distinct from authoritative empty maps. The host
  snapshot covers its own sessions; isolated-space sessions require their space's
  snapshot. Host timestamps use `serverTime` for elapsed time and staleness so
  device clock skew cannot change activity.
- Providers for an isolated space come from the host in the space's originating
  project, where project-defined providers exist. Models and defaults come from
  the space. Provider inventories include image models so image-only providers
  remain visible, while chat pickers exclude those models.

### Identity, projection and event ordering

- Client-minted IDs use OpenCode's ID format so optimistic records reconcile in
  place with server records by identity; transcript order never comes from IDs
  (`sync/DOCUMENTATION.md`, rule 10). ID and JSON helpers stay
  independent of the client so local state creation does not load transport or
  inherit a mocked client.
- Domain agent `name` holds the wire ID used for writes; `displayName` holds the
  wire display label. Catalog model IDs take precedence over provider API model
  names because derived models can share an API model name.
- An explicit default thinking level travels without a variant, clearing a
  previous effort. It compares equal to OpenCode's recorded `"default"` variant;
  a domain `null` variant must not reach the wire.
- Page projection and live events produce identical part identities and tool
  states. Text and reasoning ordinals count separately by kind, and tool parts
  use call IDs. A text item followed by another content item is sealed even
  while its message remains open, keeping its final line visible after reload.
- Local interrupted message and tool closures yield to later server completions.
  A stopped or failed turn and a bare status update carry different evidence;
  question replies veto recovery, while cancellation needs tool-specific evidence.
- Session switches and archive events retain the server's update timestamp to
  prevent older reads from rolling them back. Viewed watermarks name the idle
  transition the viewer saw so a later completed turn stays unread.
- Execution-start arrival time uses the device clock. End events retain a known
  start and supply a fallback only for streams joined late. Shell completion
  matches by `shellID` because the start-derived message ID is unavailable then.
- Event translation remains pure and explicitly accounts for every closed wire
  event variant. Only open-ended plugin RPC frames reach the default branch;
  adding an upstream event must expose an exhaustiveness failure. PTYs retain
  their own transport, and only session-tagged shell commands affect turns.
- Turn order comes from OpenCode's per-session `durable.seq`, never from event
  times. `wire-admission.ts` keeps the newest sequence one event stream has seen
  per session and reports a turn start or end that is not newer as stale; the
  event pipeline drops it before translation (`sync/DOCUMENTATION.md`, *Why turn
  boundaries follow OpenCode's sequence and not the client clock*).
- Config folding preserves named entries from lower-priority documents. Policy
  decisions read every document because the effective document retains only the
  last policy list. Policy ordering and legacy resource spellings mirror
  OpenCode; connected Console workspace statements are outside this read.

### Transcript and result contracts

- Message lookup walks cursor pages until a match or exhaustion, with a repeated
  cursor ending the walk. A fixed window cannot prove absence because plumbing
  messages can displace conversation records. Evicted history resumes from the
  oldest retained message using OpenCode's cursor format.
- Context records are admitted before their prompt or slash command. Visible
  context IDs precede the prompt ID. A staged revert commits before any context
  is admitted because committing deletes records beyond its boundary. The
  pre-send callback runs after context admission, immediately before dispatch.
- Skill mentions resolve composer names to server IDs. Missing names retain the
  caller's instruction fallback. A skill disappearing before admission permits
  retrying the same message ID without that attachment.
- Cancellation notes explain the user's stop without forbidding future work or
  resuming the session. Grouped shell stops post one note before concurrent
  kills. A failed note stops nothing; a failed kill leaves successful kills in
  effect. A runtime switch after the note leaves work running on the old server.
- Synthetic running-subagent entries are client-only and cannot be revert or
  fork boundaries. A completion finishes an existing call's row; command-started
  children get a standalone report only when their start falls in loaded history
  and no call names them. Older or unknown starts remain reachable in the child
  session list.
- Image tool metadata and synthetic completion messages provide live job
  boundaries. The global job list supplies authority after a stream gap.
- Notice rows avoid duplicating context chips, tool completions, child reports
  and specialized cards. Instruction changes appear only for an environment
  move; plugin descriptions remain verbatim. Page answers parse the JSON line
  inside the envelope by splitting on `\n`, since JSON retains U+2028 and U+2029
  and a regex dot stops at them. Notices during work belong to that step's
  Activity rows.
- A collapsed tool row retains status, times, input, metadata and error when its
  result is shelled. Expanded rows fetch the full message. Finished read and
  skill calls discard result bodies because their rows open the file in the app.

### Catalogs and tool input

- Integration snapshots belong to the runtime and are provisional when Settings
  opens. Credential writes and credential events trigger replacement reads;
  earlier reads cannot overwrite later ones. A failed web-search-provider read
  keeps integrations visible rather than filtering out possible model providers.
- Plugin inventories throw on failed reads. Checks retain the last outdated
  flag for an individually unreachable target, and updates send one target per
  request because a batch failure would obscure which plugin failed. Updates
  obey the configured spec without rewriting it or adding implicit `@latest`.
- Tool input parsing retains independently valid fields and entries. It mirrors
  server boolean string normalization, nested-parameter precedence and render's
  spilled-action recovery so a page the server waits on also appears in chat.
  Other multi-action tools do not recover spilled actions. Shared-page JSON text
  is decoded once, as on the server.
- Render-page title extraction and secret-run command formatting match their
  server implementations. Waiting pages survive interruption; shared pages
  appear as cards and cannot wait for answers in this chat. User-facing cards
  remain visible with Activity collapsed while they need an answer.
- A Code Mode call can replace a direct tool row only when exactly one completed
  call supplies the successful script's result. The call's own status remains
  authoritative even when its script catches a failure. Direct-name matching
  joins namespaces with underscores; MCP server lookup uses the longest known
  prefix because server names can contain underscores.
- Web-search provider integrations can exist before they enter the connected
  search list, so `metadata.websearch` identifies them for connection and model
  provider filtering. Unsupported connection forms remain with OpenCode's
  connect flow. Unknown result or consent shapes fall back to generic rendering,
  and failed reads never become empty inventories.

## Decisions

### Why unchanged catalog and form types use domain aliases

Integration, form and permission contracts retain their complete SDK shapes
through aliases in `model.ts`. Consumers import these names from the adapter so
an upstream API change has one owning folder without adding runtime conversion.

### Why fresh provider reads wait for post-call requests

Provider, model and default-model reads share one catalog promise per directory
on the active SDK instance. `fresh` waits for any request started before the
call, including another fresh request. Callers waiting on the same read share
the replacement started afterward. Joining an earlier fresh request lost a
second catalog change arriving during that request. Catalog invalidations
coalesce by resource revision above this adapter. Reconnect clears the request map;
obsolete completions cannot remove the replacement runtime's entries.

### Why the Zen provider is renamed in the provider read

OpenCode names the `opencode` provider "OpenCode", or "<workspace> / OpenCode"
after a Console sign-in, and the same sign-in also connects `opencode-go`, so
users read the pair as one provider listed twice. `getProvidersForConfig`
renames it to "OpenCode Zen", which reaches every surface that shows provider
names: Settings, the model pickers, Context and usage. A label on the Settings
card alone was rejected because the pickers would keep the confusing name. The
workspace name stays visible on the provider's Console account. Other Console
providers keep OpenCode's name, where the workspace prefix tells them apart
from a provider connected with the user's own key.

### Why a missing agent stops the send instead of being skipped

OpenCode records any agent name and fails only the next turn, so the send has
to check first. Skipping the agent write and sending on the session's current
agent was rejected: the composer would show one agent while another answered.
The send stops and the composer shows the error, so the user picks an agent.
Before that, the agent picker marks such an agent with a warning
(`components/chat/agentAvailability.ts`), read from the loaded catalog of the
composer's own folder; a catalog still loading marks nothing.

### Why an empty agent list is read again after `model.default`

Since OpenCode 2.2.7 `agent.list` answers before a location's plugins have
registered their agents, so the first read of a folder OpenCode has not started
is an empty list, while `model.default` waits up to 5 seconds for those plugins.
`listAgents` (`folder-agents.ts`) takes an empty answer as not ready, waits on
`model.default` and reads once more, and that second answer is the folder's
list. Committing the first answer made the agent picker mark the session's
agent as missing until `agent.updated` re-read the list. Reading the models
before every agent read was rejected: a warm folder would pay a second round
trip for nothing. When the wait times out the second answer is used as it is
and the `agent.updated` re-read covers the rest; failing the read there would
fail the app's start whenever plugins are slow. A runtime switch during the wait
stops before the second read, so it never reaches the new host with the old
folder. `getLocationAvailability` only probes whether the folder exists, so it
reads `agent.list` once without the wait.

### Why ancestor reads belong to tool completion

A child transcript can list a tool message stored by its parent. Completing an
existing shell needs that result, but broadening strict reads would make pins
and references attribute parent messages to a child and make existence checks
accept messages outside that session's history. All shared UI runtimes use the
same completion path through the runtime-aware SDK transport.

### Why tool shells use capability discovery and not unconditional headers

A restored session can request its first page before discovery completes. Pages
share a bounded wait so the first page can omit large results without hanging
all later reads. Discovery failure remains retryable. A plain-page success after
a header failure disables shells for that runtime; relay connection loss keeps
them enabled because the tunnel has no CORS or proxy header filter.

### Why command blocks use linking notes and not shell metadata

`session.shell` accepts no metadata, so a synthetic note is the durable link
between a reply block and its shell run after reload. The note has no description
to avoid a notice row. A shell row hides only when its reply is loaded, keeping
the result visible somewhere; a run the user stops needs no continuation.

### Why usage details load on demand and not with the report

The initial report sends `tools: "none"` because the server's default summary
scans every tool call. Detail loading recomputes the report using its loaded
range so the counts cover the same window. The viewer's timezone defines day
buckets, and a project filter names an OpenCode project ID.

### Why attachments use OpenCode's temp folder and not the UI's filesystem

OpenCode's temp directory is on the machine its agents can read, including when
the UI and OpenChamber server run elsewhere. Each upload uses a fresh folder to
prevent repeated filenames from overwriting earlier attachments. File names are
restricted to their basename so they cannot escape that folder.
`temp-files.ts` writes a batch one file at a time. A file's bytes may be a
reader called right before its own write, so a batch of large documents holds
one in memory at a time. A caller that passes `runtimeKey` gets a batch that
stops before its next request once the runtime switched, so the rest of one
draft's files never reach the new runtime.
