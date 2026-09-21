# Managed System Prompt Optimizer

## Purpose

This module injects an opt-in OpenCode plugin only when OpenChamber launches
and owns the OpenCode process and `optimizeSystemPrompt` is enabled. The plugin
replaces OpenCode's built-in behavioral/provider prompt with a short identity
while preserving the environment, project instructions, MCP instructions,
skills, conversation history, and separately supplied tools.

## Runtime flow

1. Settings persist `optimizeSystemPrompt` in OpenChamber's `settings.json`.
2. The setting is applied when managed OpenCode restarts.
3. The runtime materializes the plugin under
   `<openchamber-data-dir>/system-prompt/` and appends its `file://` URL to
   `OPENCODE_CONFIG_CONTENT` without replacing existing plugin entries.
4. The plugin tracks the selected agent through `chat.message`. The transform
   runs only for sessions using the built-in `build` or `plan` agent.
5. The transform locates OpenCode's environment boundary and removes only the
   preceding text. If the boundary is absent, it leaves the prompt unchanged.

## Limitations

OpenCode exposes the assembled prompt rather than structured sections. A custom
prompt configured by overriding the `build` or `plan` agent occupies the same
prefix as the built-in provider prompt, so the optimizer also removes that
override. Other agents are never transformed. The setting is off by default.

Plan-mode restrictions and build-mode transitions are not part of the removed
prefix. OpenCode injects those as synthetic message reminders after system
prompt transformation and separately enforces plan restrictions through tool
permissions.

The plugin is not injected for external OpenCode servers or VS Code's separate
OpenCode lifecycle.
