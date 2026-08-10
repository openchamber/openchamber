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

## Models that cannot call tools

OpenCode declares every registered tool to the provider regardless of the
selected model: `capabilities.toolcall` is populated from config but never read in
the request path. Providers that reject function calling outright therefore fail
every send. Vertex Gemini image models ("Nano Banana") return
`Unable to submit request because the model does not support function calling`.

This tool makes the problem unavoidable through configuration alone. Stock agents
begin with `"*": "allow"`, and a user who denies every tool by name still cannot
name `openchamber`, because nothing in the UI reveals that it exists. The only
working user-side workaround is a hand-written agent with `permission: {"*": deny}`.

**There is no safe client-side fix.** The lever OpenCode exposes is the per-send
`tools` map, which it converts into the session permission ruleset and persists,
replacing prior contents. Every variant fails:

- `{"openchamber": false}` removes one declaration; the ~11 stock built-ins still
  reach the provider, so the rejection stands.
- `{"*": false}` does suppress the whole set, but the deny persists: later sends
  on a tool-calling model in that session also get no tools.
- `{"*": true}` to recover is a privilege escalation. A rule is evaluated for
  approval as well as for filtering, so a wildcard allow turns an agent's
  `edit: deny` into `allow` and `bash: ask` into `allow`, suppressing the
  approval prompt. Suppressing tools must never widen permissions.
- `session.update` accepts `permission` but merges rather than replaces, so it
  cannot clear a deny either.

The fix belongs upstream, where the capability is already known: return no tools
when `!model.capabilities.toolcall`. That covers every send path for every client
with no permission side effects. A client-side fix could not have covered
`session.command` or `session.shell` regardless — the OpenCode API has no `tools`
field on either route.

Submitted upstream as anomalyco/opencode#41463 (issue #41464). Once a release
carrying it is out, image models work with any agent and this section is history
rather than an active constraint; until then the only user-side workaround is the
wildcard-deny agent above.

A second, independent OpenCode bug sits behind this one: `SessionProcessor` has no
`case "file"`, so an image returned as Gemini `inlineData` is discarded and never
becomes a message part. The two are sequential — the fix above lets the request
through, and that one makes the result visible. Fixing only the first yields a
billed request whose image is silently dropped. anomalyco/opencode#40126 addresses
it on the `v2` branch; `dev` is unfixed.

OpenChamber needs no change for either. The receive path is already type-agnostic:
`file` is absent from `SKIP_PARTS` in `packages/ui/src/sync/event-reducer.ts`, the
`message.part.updated` reducer upserts any part type, `filterVisibleParts` never
drops `file`, and `AssistantMessageBody` already renders `MessageFilesDisplay`,
which filters on `type === "file"` without checking the message role. That leg is
a code read rather than an executed test — there is no component-render harness
for `MessageBody` — so a live generation is the first real check.

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
