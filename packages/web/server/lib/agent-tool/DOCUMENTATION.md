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
