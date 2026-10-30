# Agent workflows

## Purpose

A workflow is a JavaScript script an agent writes to fan a large task out to
many agents: a review per file, an audit across many routes, a migration of
many files, research cross-checked across sources. OpenChamber runs the script
here, in its own server, so the agent that asked stays free. The user approves
each run's plan in the chat before anything starts, and when the run ends its
report is delivered into the session that proposed it.

The feature ships dark: `OPENCHAMBER_WORKFLOWS_ENABLE` (`feature-flag.js`)
decides whether it exists at all. Without it there is no runtime, no routes, no
`openchamber_workflow` tool, no settings row and no session guidance. With it,
the tool is on unless the user switches it off (`agentWorkflowToolEnabled`).

## Ownership

- `script.js`: parses a script into `meta` (`name`, `description`, `phases`)
  and the body, and checks that the body compiles. Errors are written for the
  agent that wrote the script.
- `sandbox.js`: runs a body in a worker thread, inside a vm context that sees
  only `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()` and `args`.
- `agent-session.js`: one workflow agent is one OpenCode child session of the
  proposing session (`parentID`), prompted once and awaited until its turn
  ends; a schema correction is a follow-up prompt in the same session. An
  agent asked for a schema answer gets its parent's permission rules plus an
  allow for `openchamber_workflow_answer`. Also posts the report as a synthetic
  message.
- `json-schema.js`: the small part of JSON Schema `agent({ schema })` checks.
- `store.js`: run files under `<data-dir>/workflow-runs/`, one per run.
- `runtime.js`: the run lifecycle, the limits, replay, the report, and the
  agent tool's `workflow.*` actions (`executeAction`).
- `routes.js`: the user's side for the chat card, the work-status panel and
  the Workflows panel: `GET /api/openchamber/workflows?sessionId=` or
  `?directory=` (run summaries of a session or of every session in a
  directory), `GET /api/openchamber/workflows/saved?directory=` (the project's
  saved workflows), `POST /api/openchamber/workflows/start` (the user runs a
  saved workflow: in the given session, or a new one made for it, started at
  once since the click is the approval, reported back and waking that session
  like a run its agent proposed), `GET /api/openchamber/workflows/:runId` (the last 200 log lines, the
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

- No run starts for the first time without the user's approval through the
  route; the agent tool has no approve action. `workflow.resume` restarts a
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
  the schema in three tries. The only rejection is a `TypeError` for a prompt
  that is not a non-empty string, a bug in the script itself.
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
  unchecked (`json-schema.js`).
- A script is at most 100 000 characters and its `args` at most 50 000 as JSON;
  a run without `args` reads `{}`.
- A report is minted with its message id before the first delivery attempt
  and saved, so a retry never delivers twice (409 counts as delivered).
- A run that was `running` when the server stopped is marked `stopped` with
  "OpenChamber restarted…" on the next start; its report goes out once the
  OpenCode event hub connects (`deliverPending`). The run records the server
  process that runs it (`ownerPid`); a start in another process leaves the run
  alone while that process is alive, so a second OpenChamber over the same
  data directory (a dev server next to the desktop app) cannot stop it.
- A run is in the runtime's `active` map from the moment it is `running`
  until its end is saved; a stop that arrives before the worker exists is
  honoured once it does. The report goes out after the run left `active`, so a
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

## Decisions

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
would not load.

### Why agents are child sessions of the proposing session

OpenCode lists them as that session's subagents, so they are visible, open
like any subagent, and their cost rolls up into the session. A child session
lives at its parent's location, so agents share the session's directory: there
is no isolated copy per agent yet, and a script that edits files gives each
agent files of its own.

### Why replay keys on the prompt and not on the call's position

`resume` runs the script again from the top. Each `agent()` call is keyed by a
hash of its prompt and options plus how many times the same pair was asked
before, and a call whose key completed last time returns its saved answer
without a session. Calls in `parallel()` start in an order that can change
between attempts; keying by position would rerun finished agents or, worse,
hand an answer to the wrong call. `Math.random()`, `Date.now()` and `new
Date()` throw in the sandbox so a prompt cannot differ between attempts by
accident.

### Why a schema answer goes through a tool and not the final text

Asking for "only JSON" and parsing the last reply depends on the model
complying; each miss costs a whole extra turn, and a model that wraps its
answer in prose misses often. A tool checks the value when it is called and
returns the mismatch as an error, so the agent fixes it in the same turn.
OpenCode 2 has no per-prompt structured output (1.x's `format: json_schema` is
gone), and no per-prompt tool switch either, so the tool is denied in every
session by the managed config and allowed in the agent's session through
`session.create`'s `permissions`. Putting it behind Code Mode instead was
weighed: every session would still list it in the catalog, and an agent would
need an `execute` round trip to answer. The text path stays as the fallback
for an OpenCode the managed config does not reach.

### Why approval is a stored state and not a held tool call

`render.page` with `awaitAnswer` holds its call open until the user answers.
A workflow run instead is stored as `awaiting-approval` and the call answers
at once: the card reads the run from this server, so it survives a reload,
shows on every device, and the agent's turn is not held while the user reads
the plan.

## Runtime parity

Web and desktop with a managed OpenCode: available when the build flag is set
(the agent tool exists only there). VS Code and an external OpenCode: the
agent tool is not injected, so no run is ever proposed. Mobile clients see the
card, approve and stop runs, and get the report through the server they are
connected to; the work-status panel is not shown on phones.
