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
- `routes.js` is the authenticated CLI HTTP adapter. It forwards one action,
  preserves service status and partial-result details, and propagates request
  cancellation.
- `../agent-tool/runtime.js` is the managed-tool adapter. It wraps service
  results in the versioned native-tool envelope and uses a separate ephemeral
  loopback credential.
- `../openchamber-sessions/routes.js` and `../scheduled-tasks/service.js` own
  their domain operations and are composed into this service.

## Invariants

- Session status and messages come from official directory-scoped OpenCode
  APIs. Message output includes only ordered `text` parts.
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
  together with a 400, so neither silently wins.
- One failed directory status lookup produces `unknown` for only that
  directory and does not erase other session results.
- Destructive session/worktree deletion and project-path registration are not
  part of the action contract.
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
  entry shown by identifier. It only adds or refreshes links, never removes
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
