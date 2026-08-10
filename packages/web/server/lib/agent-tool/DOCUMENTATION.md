# Managed OpenChamber Agent Tool

## Purpose

This module exposes OpenChamber orchestration to agents as one typed OpenCode
custom tool named `openchamber`. It is injected only when OpenChamber launches
and owns the OpenCode process, and only while the persisted
`agentControlToolEnabled` setting is not `false` (default on; toggled in
Settings → General → OpenCode CLI and applied on the next managed OpenCode
restart).

## Runtime flow

1. The OpenChamber HTTP listener binds and publishes its authoritative port.
2. `prepareManagedOpenCodeEnv()` materializes the plugin under
   `<openchamber-data-dir>/agent-tool/` and appends its `file://` URL to
   `OPENCODE_CONFIG_CONTENT` without replacing existing plugin entries.
3. A random per-child token and loopback callback URL are added only to the
   managed OpenCode child environment.
4. The plugin calls `POST /api/openchamber/agent-tool` with its typed input and
   OpenCode's authoritative session directory.
5. The route delegates the fixed action allowlist directly to the shared
   OpenChamber control service. The CLI uses the same service through its
   authenticated HTTP adapter, so Goal Mode ordering, wait behavior,
   partial-failure reporting, and scheduled-task contracts have one owner.
6. Each action definition owns a short presentation title and a separate
   agent-facing description. The generated schema uses the description to state
   required inputs or one non-obvious behavior, while completed calls use the
   short title in native tool metadata.

## Per-send model gating

Injection happens once per managed OpenCode process, before any model is known,
so this tool — like every OpenCode built-in — is declared to models that cannot
call tools. `capabilities.toolcall` is populated from config but never read in
OpenCode's request path. Providers that reject function calling outright then
fail every send: Vertex Gemini image models return `Unable to submit request
because the model does not support function calling`.

That rejection is triggered by the presence of *any* `functionDeclarations`, so
suppressing only `openchamber` does not fix it — the stock agents begin with
`"*": "allow"`, so a dozen built-ins still reach the provider. Shared UI
therefore gates the whole set per send: `resolveAgentToolGate`
(`packages/ui/src/sync/agent-tool-gate.ts`) maps the selected model's
`capabilities.toolcall` to `{"*": false}` or `{"*": true}`. The deny drops the
`tools` field from the provider request entirely; the allow restores every tool,
including this module's injected one.

`tools` does two things in OpenCode, and both matter here. It is stored on the
user message and filters that request, and it also **replaces** the session's
permission ruleset and persists it. Because of the second effect, clients send
the complete desired map on every send, never a partial patch, so switching
models self-corrects.

Constraints and consequences:

- Replacement is wholesale rather than a merge, so OpenChamber assumes sole
  ownership of the session permission ruleset on this path. OpenChamber writes
  session permissions nowhere else (`opencodeClient.updateSession` whitelists
  `title`, `metadata`, and `time.archived`), and its own auto-accept and
  scheduled-task policies are OpenChamber-side settings rather than session
  rules — but a rule set on the same session by another OpenCode client is
  discarded by the next send from OpenChamber.
- The gate is independent of `agentControlToolEnabled` and of whether this module
  injected anything, because it governs every tool rather than only this one. It
  is therefore correct in runtimes where the control tool is never injected
  (VS Code, external OpenCode) — see Runtime parity below.
- Unknown capability is treated as tool-capable: metadata may not have loaded
  yet, and defaulting to disabled would strip tools from models that support
  them. The cost is that the rejection can still occur on a send that races
  metadata loading.
- Subagent sessions inherit `deny` rules from their parent, so a subagent spawned
  while an image model was selected starts with tools denied even if its own
  model could use them. The child ruleset is derived once at spawn.
- Because the ruleset persists, a session left denied by an image-model send
  stays denied for later server-side dispatches into that session (scheduled
  tasks, goal continuations) until the next gated send restores it.
- Upstream marks `tools` `@deprecated` in favour of setting permissions on the
  session. The non-deprecated `session.update` path merges instead of replacing,
  so it could never flip a deny back to allow; this field is the only lever that
  self-corrects.

Only the normal prompt path is gated. `session.command` (slash commands) and
`session.shell` accept no `tools` field in the OpenCode API at all, and a
command's own pinned model outranks the model the client sends, so a command
bound to a non-tool-calling model still reaches the provider ungated. Server-side
dispatchers that post `prompt_async` directly (scheduled tasks, goal
continuations, obligatory context) are also ungated, though they inherit whatever
ruleset the last gated send persisted.

This is a client-side mitigation for the paths OpenChamber controls, not a
complete fix. The complete fix belongs upstream: OpenCode already knows
`capabilities.toolcall` and could return no tools when the selected model cannot
call them, which would cover every send path for every client.

## Runtime parity for the gate

The gate runs wherever the shared send path runs, including runtimes where this
module injects nothing. That is intentional: it governs all tools, so it is
meaningful even without the control tool present, and the client cannot know
whether the running OpenCode process loaded the plugin.

## Agent context budget

- The tool exposes one shared parameter object rather than repeating parameters
  in a large per-action union. Action descriptions carry only required inputs,
  defaults, or one non-obvious semantic detail.
- Obvious fields rely on their names and JSON types. Parameter descriptions are
  reserved for formats, dependencies, scope, and behavior that cannot be safely
  inferred from the field name.
- Session dispatches do not wait by default. Agents are told to set `wait` only
  when the user asks or the next step requires the completed result.
- The tool exposes only agent-relevant actions
  (`OPENCHAMBER_AGENT_TOOL_ACTIONS`): `schedule.status` stays CLI-only because
  `schedule.list` already returns scheduler status, and enable/disable are one
  `schedule.toggle` action driven by the `disabled` boolean.
- The tool description frames intent: created sessions and scheduled tasks are
  user-facing work the user follows up with, never a channel for the agent to
  delegate parts of its own current task.
- Optional behavior switches (`worktree`, `goal`, `agent`, `variant`, `wait`)
  state their default and an explicit "only when the user asks" rule so agents
  do not invent worktrees, goal mode, or waits the user never requested.
- Detailed combination rules are enforced by the shared control service and
  returned as actionable usage errors only after an invalid call. Per-action
  examples and a repeated per-action parameter schema are intentionally omitted.

## Security invariants

- The callback accepts loopback requests only and requires the current
  per-child bearer token using a timing-safe comparison.
- The token is never persisted, logged, returned to the UI, or written into
  the materialized plugin.
- Inputs map to a fixed action and parameter allowlist. There is no arbitrary
  CLI, shell, route, or URL forwarding.
- Session/worktree deletion and project-path registration are not exposed.
- An aborted tool request propagates an abort signal into the shared service.

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

The per-send tool gate is deliberately *not* conditioned on any of the above —
see "Runtime parity for the gate" under Per-send model gating.
