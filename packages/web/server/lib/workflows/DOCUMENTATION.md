# Agent workflows

## Purpose

A workflow is a JavaScript script an agent writes to fan a large task out to
many agents: a review per file, an audit across many routes, a migration of
many files, research cross-checked across sources. OpenChamber runs the script
here, in its own server, so the agent that asked stays free. The user approves
each run's plan in the chat before anything starts, unless they let agents
start runs without approval, and when the run ends its report is delivered
into the session that proposed it.

The tool is off until the user turns it on (`agentWorkflowToolEnabled`, Settings
→ General → OpenChamber Tools). Off means no `openchamber_workflow` tool and no
session guidance, and the runtime refuses every action that proposes, runs or
saves one. Under it, `agentWorkflowAutoApprove` (off by default) lets
`workflow.run` start a run at once, and `agentWorkflowAutoApproveLeads` does
the same only for a run a lead proposes (`../session-lead/`); Settings shows
the pair as one choice: no, for leads, always. The app hides the Workflows panel, its rail entry and work-status
section, reads no runs, and a past run's card says workflows are off
(`packages/ui/src/lib/workflows/availability.ts`).

Workflow agents' sessions carry `metadata.openchamber.kind = 'workflow-agent'`
and `metadata.openchamber.parentID`, the session that ran them. The sidebar
leaves them out of its subagent rows (one run can start a hundred); the run's
card and the Workflows panel open them.

## Ownership

- `script.ts`: parses a script into `meta` (`name`, `description`, `phases`)
  and the body, and checks that the body compiles. Errors are written for the
  agent that wrote the script.
- `sandbox.ts`: runs a body in a worker thread, inside a vm context that sees
  only `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()` and `args`.
- `agent-session.ts`: one workflow agent is one session, either fresh or a
  native fork of another agent's session when the call names `forkFrom`.
  It is linked to the proposing session by metadata, prompted once and awaited
  until its turn ends. A schema correction is a follow-up prompt in the same
  session. A fresh agent copies what a child would inherit from the proposing
  session: its folder, its permission rules, and its model when the call
  names none; a fork takes them from its source instead. An agent asked for a
  schema answer also gets an allow for `openchamber_workflow_answer`. Also
  posts the report as a synthetic message.
- `json-schema.ts`: the small part of JSON Schema `agent({ schema })` checks.
- `store.ts`: run files under `<data-dir>/workflow-runs/`, one per run. A
  settled run (finished, report delivered) stays in memory only as
  `lightenWorkflowRun(run)`: no script, prompts or full answers, enough for
  `summarizeRun` to give the same summary. `get` reads the whole run from its
  file. Kept whole, 35 real runs held 12 MB of the server's heap; light, 1.7 MB.
  `list()` therefore hands out light runs for settled ones: read a run's
  prompts or answers through `get`.
- `runtime.ts`: the run lifecycle, the limits, replay, the report, and the
  agent tool's `workflow.*` actions (`executeAction`).
- `routes.ts`: the user's side for the chat card, the work-status panel and
  the Workflows panel: `GET /api/openchamber/workflows?sessionId=` or
  `?directory=` (run summaries of a session or of every session in a
  directory; `directory` repeats for a project's folder and its worktrees), `GET /api/openchamber/workflows/saved?directory=` (the project's
  saved workflows), `POST /api/openchamber/workflows/start` (the user runs a
  saved workflow: in the given session, or a new one made for it, started at
  once since the click is the approval, reported back and waking that session
  like a run its agent proposed; `scriptDirectory` names the project folder a
  saved workflow is read from when the session is in a worktree), `GET /api/openchamber/workflows/:runId` (the last 200 log lines, the
  script, args and result), `GET /api/openchamber/workflows/:runId/agents/:key`
  (one agent's prompt and full answer),
  `POST /api/openchamber/workflows/:runId/{approve,decline,stop,resume}` and
  `DELETE /api/openchamber/workflows/:runId`. Delete takes only a finished
  run (a running or waiting one is stopped or declined first), removes its
  file and an undelivered report with it, and broadcasts
  `openchamber:workflow-run-removed`; the agents' sessions stay. The agent tool
  has no delete action: removing a run is the user's call.
- Each agent's model and spend (`modelUsed`, `usage`: cost and tokens) are read
  from its session once its call settles and kept on the run, so the panel
  shows them after the sessions are gone; a failed read leaves them out.

The tool declaration (description, parameters, the scripting guide on
`script`) lives with the other managed tools in `../agent-tool/runtime.js`;
the action list in `../openchamber-control/actions.js`; when to offer a
workflow in `../session-knowledge/runtime.js` (`WORKFLOW_GUIDANCE`).

## Lifecycle

1. `workflow.run` parses the script (or reads a saved one by name), stores a
   run in `awaiting-approval` and answers at once with its id. Nothing runs.
   With `agentWorkflowAutoApprove` on, or `agentWorkflowAutoApproveLeads` on
   and the proposing session a lead, the run is admitted as if approved
   instead: its first save is already `running`, its first log line says it
   started without approval, and the answer says so. A failed first save
   publishes no run.
2. The chat draws the run as a card in place of the call, with Run and Don't
   run; the work-status panel offers the same. Approve starts it; decline ends
   it as `declined`.
3. Running: the sandbox calls `agent()`, each call waits for a slot
   (`MAX_CONCURRENT_AGENTS`), creates its child session and waits for its turn.
   Every change is broadcast as `openchamber:workflow-run` (throttled per run)
   with the run's summary. The file is saved at each state change and when an
   agent starts, gets its session and ends, so a restart loses at most the log
   lines and phase moves since, and an agent that was working shows as stopped
   with its session, counted against the limit.
4. The script returns (`completed`), throws (`failed`), or is stopped
   (`stopped`). Agents still running are interrupted and counted as stopped.
5. The report, a synthetic message `<openchamber-workflow …>` with metadata
   `{ source: 'openchamber-workflow', runId, name, state }`, goes into the
   proposing session. A completed or failed run wakes it (`resume: true`); a
   declined or stopped one does not, because the user is the one who acted.

`workflow.status` and `workflow.result` read a run's progress and any agent's
full answer by key or session id; the agent can only reach runs its own
session proposed. `workflow.save` writes a script to
`.openchamber/workflows/<name>.js` in the session's directory, and
`workflow.run` with `name` runs it.

## Invariants

- No run starts for the first time without the user's approval: their click
  through the route, or `agentWorkflowAutoApprove` (or, for a lead's run,
  `agentWorkflowAutoApproveLeads`), which the server reads from the settings
  file and the proposing session's metadata on every `workflow.run`. The agent tool has no approve
  action and no input that skips approval, so no client can start a run
  without one of the two. `workflow.resume` restarts a
  `failed` or `stopped` run without asking again: it is the plan the user
  already approved, the same script and args, and the agent limit below still
  counts the agents of every attempt.
- An agent of a running workflow cannot propose another workflow: one level of
  fan-out only.
- A run starts at most `MAX_AGENTS_PER_RUN` agents across all its attempts
  (`agentsStarted`; replayed answers do not count); further `agent()` calls
  resolve to null, show as failed and leave a log line. At most `MAX_CONCURRENT_AGENTS` work at once.
- `agent()` resolves to the answer text, the parsed JSON when a schema was
  given, or null when the agent failed, was stopped, or gave no answer matching
  the schema in three tries. A prompt that is not a non-empty string rejects
  in the script, a bug in the script itself; invalid `id`/`forkFrom`
  references fail the run.
- `id` uniquely names a call within its run; `forkFrom` names a successfully
  completed call of the same run. Both are non-empty strings of at most 120
  characters: a malformed name, a duplicate `id`, or a `forkFrom` that names
  an unknown, unfinished or failed call rejects the host call and fails the
  run before any prompt goes out, inside `parallel()` too. The sandbox checks
  the name's type before the options cross to the host as JSON, where a
  function would vanish and a BigInt would drop every option. The names live
  only in the running script: an agent record stores neither, and a resume
  learns them again as the script replays.
- A fork goes through OpenCode's native `session.fork`, so the new session
  starts from the source's history. The server then writes the same
  `workflowAgentMetadata` link onto the fork as on a fresh agent — pointing at
  the run's proposing session, not the source — sets the source's permission
  rules with `openchamber_workflow_answer` re-scoped to this call (allowed
  when it asks for a schema, denied otherwise, since a copied allow would let
  a branch answer a schema it was never asked). The fork inherits the
  source's agent and model; the server switches either only when the call
  names a different one or the fork came back without it, since a switch to
  the same value still writes a switch record. The source must read and
  parse before the fork is made: an unreadable or unrecognized source fails
  the call with no fork and no prompt, and a run stopped during the read
  never forks. Everything after that — answers, schema follow-ups, stop,
  resume — works as for a fresh agent.
- `parallel(tasks)` starts every task at once (the agent slots do the
  queueing) and waits for all of them, takes at most 4096, and turns a task
  that throws into null with a log line. `pipeline(items, ...stages)` runs each
  item through the stages on its own, each stage called as
  `(previous, item, index)`, with no wait between stages; a stage that throws
  or gives null (a failed agent) ends that item as null and the others go on.
- An agent with a phase moves `currentPhase` there when it starts, and a phase
  not in `meta.phases` joins `phases`, so a pipeline that files agents under
  phases shows its progress like a script that calls `phase()`.
- The agent limit counts agents when they start (after their slot), so calls
  still queued when a run stopped do not use up the limit for its resume.
- An answer the answer tool accepted stands even if the agent's turn then
  ends in an error; only a stop of the run discards it.
- An agent's phase is the `phase` option of its `agent()` call, else the last
  `phase()`: inside parallel branches the global one may belong to another
  branch. The phase is presentation only and not part of the replay key.
- A schema answer is the last value `openchamber_workflow_answer` accepted
  during the agent's turn; only without one is the final text parsed, with up
  to two follow-ups asking for the tool or bare JSON. The tool answers only the
  session of an agent whose call asked for a schema, and only while that call
  runs.
- The schema check covers `type`, `properties`, `required`,
  `additionalProperties: false`, `items` and `enum`; other keywords pass
  unchecked (`json-schema.ts`).
- A script is at most 100 000 characters and its `args` at most 50 000 as JSON;
  a run without `args` reads `{}`.
- A report is minted with its message id before the first delivery attempt
  and saved, so a retry never delivers twice (409 counts as delivered).
- `save()` captures an isolated snapshot at call time and rejects its own caller
  on failure. Later queued writes still run in order. A failed first write never
  publishes a run; a failed replacement retains the previous working object.
  `get()` and `list()` return mutable working references, including unsaved
  changes. Only a successful save establishes the snapshot read after restart.
- Approval and resume reserve the run before awaiting their checkpoint, so
  overlapping admissions start one execution. A failed checkpoint rejects before
  starting the worker and restores the prior fields, logs and shared references.
  A saved-workflow start uses the same checkpoint; failure leaves its proposed
  run waiting and retains any new, empty parent session.
- An agent-start checkpoint precedes child creation. The child-ID checkpoint
  precedes its first prompt. Failure sends no prompt and leaves any already-created
  empty child available. A failure before child creation refunds its agent count;
  existing interruption accounting stays unchanged. Agent checkpoint failures resolve `agent()` to null;
  final-save failures cannot replace an answer with a rejected promise.
- A terminal state and its report ID must commit before delivery, including
  `deliverPending()`. If the worker ended but the terminal save fails, its ended
  working state stays visible, its report is withheld, and the execution releases
  resources. The same undelivered report stays in memory to protect the last
  durable snapshot from retention. Existing logs and server warnings expose the
  failure. Restart reads
  the last successful disk snapshot and never reruns agents automatically.
- A failed delivered-marker save retains the delivered flag and the same report
  ID in memory. Restart reconciles that ID through OpenCode's 409 response; it
  neither rolls back the posted report nor reruns its agents. Recovery failure of
  one stale run withholds that report without blocking other runs.
- A run that was `running` when the server stopped is marked `stopped` with
  "OpenChamber restarted…" on the next start; its report goes out once the
  OpenCode event hub connects (`deliverPending`). The run records the server
  process that runs it (`ownerPid`, optional `ownerStartedAt`); a start in
  another process leaves the run alone while its PID is alive and its process
  start identity matches. A reused PID with a different identity is recovered
  as stopped. Every skipped run is logged in the server console, without
  writing to the other owner's run file.
- A run is in the runtime's `active` map from admission until its worker ends
  and its terminal checkpoint settles, including failure. A stop before the worker
  exists is honoured once it does. The report goes out after the run left `active`, so a
  slow delivery never holds a finished run as running.
- Only a `failed` or `stopped` run resumes. Completed answers an attempt did
  not ask for again stay on the run for the next attempt.
- A prompt is never sent once the run stopped; one in flight when it stopped
  interrupts the turn it started.
- The tool is never behind Code Mode: the chat draws the run's card from the
  tool's own call, which an `execute` script would hide.
- The run files are owner-readable only; a file that does not parse is moved
  aside and the rest load. At most 100 runs are kept; finished ones are pruned
  by oldest end, never an open one, the one just saved, or one whose report
  has not gone out.
- An agent waits for its session's idle event and falls back to a poll when an
  event is missed, such as across a reconnect of the event hub. An unknown
  status is never taken as the turn being over.
- An agent whose parent session cannot be read does not start, so it never runs
  on permission rules looser than the parent's. Its allow rules are appended
  after the parent's rules, so they win.
- Interrupting an agent that is already gone is logged and ignored: the run is
  being stopped either way.
- A schema with a `required` key that `additionalProperties: false` rules out
  fails before an agent runs.
- A PID whose liveness check answers `EPERM` is alive: the process exists and
  belongs to another user.
- A run the user deleted stays deleted. A report delivery or an agent still
  settling holds its object, and a later save must not write its file back.
  Deleting also cancels the run's throttled broadcast, which would otherwise
  put the run back on screen.
- Report delivery re-checks the report object at every attempt. A resume that
  replaced the report is never delivered or marked by an older attempt, and
  both a 409 and a 404 mark the report delivered.
- An agent's session id is saved and announced immediately, before the agent
  works: the chat leaves workflow agents out of its subagent rows by that id,
  and a restart needs it to report the agent as stopped. A stop that arrives
  during that save creates no session.
- A stop of the run ends every agent at once, so only an agent's own end leaves
  a log line.
- A worker that cannot start fails the run; the run never stays running.
- A run stores only the agent options the script gave, because the replay key
  hashes that object. JSON drops undefined fields, so an absent `args`, model
  or schema reads as absent rather than null.
- A submitted answer is checked as JSON text first and as it came last, so
  `"42"` still answers a schema that wants a string.
- A light run keeps one character past the preview limit, so `truncate` adds
  its ellipsis exactly when the full text would have.
- Older run files can lack `agentsStarted` and the owner fields; the schema
  accepts them and a missing agent count reads as 0.
- Pruning runs after a committed save, so a retention failure is logged and
  never turns that save into a failed one.
- A settled run read through `get()` is held whole until the next save makes it
  light again, so a resume, a delete and retention see the same working object.
  Concurrent first reads share one read, and the full record is published only
  over the light form it was read for.
- A deletion removes the run again after its file is gone, because a queued
  save may have republished it meanwhile.
- Delivering pending reports waits for recovery to finish, so the reports of
  runs it just marked go too. It can be called again while it runs.
- Messages the worker queued before the run ended belong to no run and are
  dropped.
- `args` can arrive as a JSON string because a tool call argument may be
  stringified, so a string that looks like an object or array is parsed.

## Decisions

### Why stored values retain their schema-inferred types

`WorkflowRun` and `WorkflowAgent` come from the store's Zod schemas. Their
`args`, `schema` and `result` fields remain unchecked values. Reading a run
does not establish a JSON Schema contract for its result, and saving preserves
the existing mutable-reference and snapshot behavior without adding validation.
`WorkflowRunStore.version` retains the literal file version accepted by that
schema.

### Why runtime contracts keep unchecked fields

`contracts.ts` names the runtime's injected services and execution state.
Its schema view exposes only an unchecked `type` field; accepting a plain
object does not validate JSON Schema keywords or the eventual answer.
Agent options, submitted answers, arguments and stored results retain their
producer's checked types until the existing checks narrow them.

String arguments keep native string coercion before the JSON-looking test and
JSON parsing, including boxed strings. Refunding an agent uses numeric
conversion, preserving subtraction's behavior if the optional count is absent.
Rollback removes newly added own fields from the store's mutable plain objects.

### Why script text uses a structural contract

The shared `isString` check accepts boxed strings as well as primitive strings.
`WorkflowText` describes the text operations the parser uses, so typing the
parser preserves that acceptance rule. Metadata still crosses the vm boundary
through JSON and keeps its existing plain-object, field and phase checks.

### Why the worker message types follow the embedded producer

The worker source stays JavaScript inside its evaluated string. `WorkerMessage`
describes only messages that source emits to its private parent port. Agent
options and results remain unchecked, while prompts, phase titles and log lines
follow the worker's existing checks and string conversions. Checks inside the
embedded source remain necessary because workflow scripts are untyped.

### Why the workflow client accepts an explicitly undefined variant

`agent-session.ts` passes the schema-inferred parent model directly to
`@opencode/client`. The schema permits `variant: undefined`. The SDK's
`SessionCreateInput.model.variant` declaration excludes explicit undefined,
but its implementation passes the model into `JSON.stringify`, which omits
that property without validating or transforming the model first.
`opencode-client.d.ts` declares that dependency boundary locally and keeps the
SDK's remaining request fields and response types. A mutable mapped type
permits the existing incremental request construction without changing the
SDK's readonly contract elsewhere. The parent model is never rewritten to
satisfy the declaration.

### Why schema keys still use native coercion

Entries in `type` and `required` are unchecked. `Object.fromEntries` supplies
native property-key coercion for entries that are not already keys. Type
lookups still see inherited members and bind the dictionary as the receiver.
A missing entry does not match; a non-callable entry such as `__proto__`
still throws a `TypeError`.

`../opencode/session-activity.d.ts` supplies the activity probe's optional
signal and leaves active-status values unchecked. `agent-session.ts` keeps its
existing omitted-signal call.

### Why route inputs retain their parsed optional fields

`routes.ts` uses the application contract from `../shared/http-contracts.js`
and the runtime's inferred methods. Required path parameters follow the matched
Express paths; body and query fields pass through the existing Zod schemas.
The action guard keeps the existing set-membership check before indexing the
runtime. `startSaved` accepts explicit undefined for `scriptDirectory` and
`sessionId`, because its route schema permits those values and passes them
through unchanged.

### Why working references and call-time snapshots have separate contracts

Execution closures, replay and report cancellation share run and report object
identity. Keeping those working objects preserves their coordination, while each
queued write owns a separate immutable snapshot. Admission replaces only the
fields it changes and copies logs before appending, so rollback preserves nested
history and references without keeping a second standing copy of every run.

### Why terminal-save failure keeps the ended working state

The worker has ended, so restoring `running` would claim activity with no worker.
The ended state remains visible with a diagnostic and a withheld report. Newly minted
reports are ineligible during their checkpoint as well as after failure; reading
working objects from the store cannot establish permission to deliver them.
The failed report object stays undelivered in memory because removing it would
make the ended run eligible for pruning and delete its last durable snapshot.

### Why recovery compares process start identity

A PID can be reused after a crash or reboot. `ownerStartedAt` identifies the
process instance using Linux boot ID and process start ticks, macOS `ps`
start time in UTC with a fixed locale, or Windows UTC process start ticks
through PowerShell. The macOS timestamp has one-second resolution. Probes
have a 5-second command timeout and do not require a server heartbeat.

The store remains version 1 and accepts records with only `ownerPid`, or no
owner fields. Legacy PID-only records keep their liveness check. When process
metadata is unavailable, recovery preserves a live PID's run and logs the
unverified identity; a dead PID is still recovered. This conservative fallback
can leave a legacy or unverifiable reused PID marked running, but avoids
stopping another server's live work. A record owned by the current PID on
startup is recovered because this runtime has no worker for it.

### Why the server runs the script and not OpenCode's Code Mode

Code Mode runs a script inside the agent's own tool call, so the agent's turn
stays busy for the whole run, and OpenCode's subagent tool is not callable
from Code Mode (`codemode: false`). Running here, the tool call answers at
once, the run survives the agent's turn, and the report arrives the way a
dispatched session's result does.

### Why a worker with a vm context, evaluated from a string

The worker can be terminated whatever the script does, including a loop that
never yields, and its heap is capped. The vm context keeps the server's
modules, `process`, timers and network out of the script's reach. This is not
a boundary against the agent, which has a shell; it keeps a script from
reaching or stalling the server. The worker source is a string (`eval: true`)
so it runs the same from the source tree under Bun, from `node_modules` under
Node, and from inside the desktop app's asar archive, where a worker file path
would not load. `parallel()` and `pipeline()` are written inside that context,
in the script's own realm, so the promises and arrays they return belong to the
script.

### Why agents are linked by metadata and not OpenCode's `parentID`

OpenCode 2.3 reports every busy period of a child session into its parent as a
`<subagent>` message and wakes the parent for a model turn, with no opt-out
(`subagent.notify` was removed in #63413). As OpenCode children, a run of 60
agents woke the proposing session 60 times, each for an empty "completed
without a text response" notice, while the run already reports once at its
end. So an agent has no OpenCode `parentID`, and OpenChamber reads the
metadata link as its parent everywhere it asks "is this a subsession, and of
what": `sessionParentId` in `../session-lineage.js` on the server (auto-accept
inheritance, notifications, In work, assists, the agent tool's session list,
search) and the projection in the UI (`packages/ui/src/lib/sessionWorkflowMetadata.ts`),
so they nest, archive and roll up cost as before. `hasWorkingChildren` in
`../opencode/session-activity.js` counts a running agent, and a running
subagent of an idle one, for its parent, so a goal audit or a turn-end
notification still waits for the run. A send that restores an archived
session finds its archived agents by the same link
(`../openchamber-sessions/routes.js`). A forked agent carries the same link,
so it nests, cascades and notifies like a fresh agent, and a session the
user forks by hand from a workflow agent copies its metadata and nests
under the same proposer, as a hand fork of any workflow agent does; agents
of a deleted or pruned run stay linked to their proposer like any other
sessions. Usage statistics are OpenCode's own
aggregate, which classifies sessions by `parentID` alone, so there an agent
counts as a top-level session and its prompts as user prompts. An agent
lives at the proposing session's directory: there is no isolated copy per
agent yet, and a script that edits files gives each agent files of its own.

### Why replay keys on the prompt and not on the call's position

`resume` runs the script again from the top. Each `agent()` call is keyed by a
hash of its prompt and options plus how many times the same pair was asked
before, and a call whose key completed last time returns its saved answer
without a session. Calls in `parallel()` start in an order that can change
between attempts; keying by position would rerun finished agents or, worse,
hand an answer to the wrong call. `Math.random()`, `Date.now()` and `new
Date()` throw in the sandbox so a prompt cannot differ between attempts by
accident.

A fork call's key includes the source session id, so a source that ran again
in a later attempt cannot hand its older branch's session to a new fork call.
A named call whose saved session OpenCode reports as not found runs again
instead of replaying, because every fork of it would fail on each resume; a
read that fails any other way keeps the replay.

### Why a schema answer goes through a tool and not the final text

Asking for "only JSON" and parsing the last reply depends on the model
complying; each miss costs a whole extra turn, and a model that wraps its
answer in prose misses often. A tool checks the value when it is called and
returns the mismatch as an error, so the agent fixes it in the same turn.
OpenCode 2 has no per-prompt structured output (1.x's `format: json_schema` is
gone), and no per-prompt tool switch either, so the tool is denied in every
session by the managed config and allowed in the agent's session through
its session `permissions`. Putting it behind Code Mode instead was
weighed: every session would still list it in the catalog, and an agent would
need an `execute` round trip to answer. The text path stays as the fallback
for an OpenCode the managed config does not reach.

### Why approval is a stored state and not a held tool call

`render.page` with `awaitAnswer` holds its call open until the user answers.
A workflow run instead is stored as `awaiting-approval` and the call answers
at once: the card reads the run from this server, so it survives a reload,
shows on every device, and the agent's turn is not held while the user reads
the plan.

A session an agent runs for its own work (`session.create` with `ownWork`)
can propose a run too, and nobody reads that session's chat. Its card also
shows in the chat of the session the user does read, the top of the chain
of such workers, named after the worker that proposed it
(`packages/ui/src/components/chat/workflows/OperatorChildWorkflowApprovals.tsx`).
The run is still the worker's, and its agents nest under the worker.

### Why approval can be switched off, and why enterprise mode does not gate it

The approval click is what stops an agent from spending many agents unasked,
and it also stops agreed work at night: a user who asks for a pilot and then
the full run on the best model is away when the agent is ready. The setting
removes only the click; the session guidance still has the agent agree the
plan and models in the chat, and the agent limits stay. A run started this way
stays inside the enterprise boundary: its agents are OpenCode sessions on this
machine using the providers the session already uses, so the setting crosses
nothing enterprise mode guards and has no policy key.

### Why the setting is read on the server at each run

The client only writes the setting. `workflow.run` reads it from the settings
file when the agent calls it, so a cleared checkbox holds whatever a client
sends, and a change applies to the next run without an OpenCode restart.

### Why the client gets the origin and the directory travels as a header

Every v2 route lives under `/api` and the client appends that itself, so the
client is built from the origin alone. The directory is a request header, so
one client can be built per session directory without rebuilding route paths.

### Why `/workflows/saved` is registered before `/:runId`

Express matches routes in registration order. After `/:runId`, `saved` would be
read as a run id.

### Why delete checks the run state and not the active set

An execution leaves `active` only once its end save resolves, so for a moment
after the run's end is saved the run is finished yet still listed there. The
run's state is the rule: a running or awaiting run is stopped or declined
first. Deleting in that overlap is safe, because the deletion drops an
undelivered report and the removed-run guard keeps the run from coming back.

### Why the preview is copied through JSON

A slice of a long string keeps the whole string alive in V8, so the preview is
copied out to let the full answer go. The copy keeps one character past the
preview limit so `truncate` still adds its ellipsis exactly when the full text
would have.

### Why a run caps its agents

A script with a loop must not be able to spend a subscription in a minute, so
a run works at most 8 agents at once and starts at most 200 across its
attempts. A run that needs more is split into several.

### Why the Linux process start ticks are read after the last `)`

`/proc/<pid>/stat` keeps the command in parentheses, and that command can
contain spaces and closing parentheses. The start time is the 20th
space-separated field after the final `)`, so splitting anywhere earlier reads
the wrong field.

### Why the meta object is evaluated in a fresh context

`meta` is a plain literal, so anything that needs more than a short timeout is
not one. The literal crosses back as JSON, which makes the object belong to the
server's realm and leaves only literal values in it. Its end is found by
counting braces outside strings, template literals and comments, and the value
is evaluated separately, so only its extent has to be found.

## Runtime parity

Web and desktop with a managed OpenCode: available when the build flag is set
(the agent tool exists only there). VS Code and an external OpenCode: the
agent tool is not injected, so no run is ever proposed. Mobile clients see the
card, approve and stop runs, and get the report through the server they are
connected to; the work-status panel is not shown on phones.
