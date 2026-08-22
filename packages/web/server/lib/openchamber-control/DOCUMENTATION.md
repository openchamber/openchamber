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
  the `disabled` boolean and replaces separate enable/disable actions;
  `schedule.list` also returns scheduler status as `scheduler`.
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
- Wait never treats an initial idle response as completion after dispatch. It
  requires observed activity or a newly completed assistant message.
- Timeout and cancellation are failures, never authoritative idle results.
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
- Usage errors name the missing or conflicting input so CLI and agent-tool
  callers can correct an invalid request without an upfront usage manual.
- Explicit `projectId` or `directory` scope takes precedence over the managed
  tool's current-session directory fallback; the fallback never creates a
  conflicting second scope.
- One failed directory status lookup produces `unknown` for only that
  directory and does not erase other session results.
- Destructive session/worktree deletion and project-path registration are not
  part of the action contract.
- `browser.capture` writes its image on the server, into
  `.openchamber/screenshots/` under the scoped project directory, and returns
  the project-relative path rather than the image bytes. The client that took
  the picture may be on a different machine than the repository, and a path is
  what an answer, a commit, or a review can use; base64 in a tool result cannot
  be any of those. The agent's label is reduced to a filename fragment, never
  used as a path. The result also states how to present the image, because chat
  renders the image paths written in a finished answer below that message —
  saving the file is not what shows it to anyone.
