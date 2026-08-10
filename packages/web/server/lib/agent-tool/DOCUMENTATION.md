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
so the tool would otherwise be declared to models that cannot call tools.
Providers that reject function calling outright — Vertex Gemini image models
return `Unable to submit request because the model does not support function
calling` — then fail every send.

Shared UI therefore gates the tool per send. `resolveAgentToolGate`
(`packages/ui/src/sync/agent-tool-gate.ts`) maps the selected model's
`capabilities.toolcall` to OpenCode's per-send `tools` map, keyed by the
`OPENCHAMBER_AGENT_TOOL_NAME` exported here.

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
- The map is sent regardless of `agentControlToolEnabled`. That setting only
  takes effect on the next managed OpenCode restart, so between toggling it off
  and restarting the tool is still injected, and skipping the gate would let the
  provider rejection back in. Naming a tool that was never injected is inert:
  OpenCode filters the tools that exist and matches rule names as literal
  wildcards, so the rule matches nothing and cannot affect another tool. This is
  also what makes the gate safe in runtimes where the tool is never injected
  (VS Code, external OpenCode) — see Runtime parity below.
- Unknown capability is treated as tool-capable: metadata may not have loaded
  yet, and defaulting to disabled would silently remove the tool from models
  that support it. The cost is that the rejection can still occur on a send that
  races metadata loading.
- Subagent sessions inherit `deny` rules from their parent, so a subagent spawned
  while an image model was selected starts without the control tool even if its
  own model could use it. The child ruleset is derived once at spawn; only
  `openchamber` is affected.
- Upstream marks `tools` `@deprecated` in favour of setting permissions on the
  session. The non-deprecated path merges instead of replacing, so it could never
  flip a deny back to allow; this field is the only lever that self-corrects.

Only the normal prompt path is gated. `session.command` (slash commands) and
`session.shell` accept no `tools` field in the OpenCode API, and a command's own
pinned model outranks the model the client sends, so a command bound to a
non-tool-calling model still reaches the provider ungated. Closing that needs an
upstream API change.

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

The per-send gate is deliberately *not* conditioned on any of the above. It runs
in every runtime that uses the shared send path, including those where the tool
was never injected, because the client cannot know whether the running OpenCode
process actually loaded the plugin — `agentControlToolEnabled` describes intent
for the next restart, not the live process. Naming an absent tool is inert (see
Per-send model gating), so the uniform behavior is safe and keeps the gate honest
in the window where intent and process disagree.
