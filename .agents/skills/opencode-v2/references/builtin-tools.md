# Hiding a built-in tool from the managed OpenCode

Each way below drops the tool from the model's list, not only its call.
Sources: `packages/core/src/tool.ts`, `plugin/internal.ts`,
`plugin/supervisor.ts`, `tool/plugin/opencode.ts` in the reference checkout.

1. **Tool transform in our generated plugin.** `setup({ tool: { transform } })`
   gets an editor with `remove(id)` and `update(id)`; `id` is the effective
   name `<namespace>_<name>` (`opencode_worktree_create`). Internal plugins
   register before config packages and transforms replay in registration
   order, so our `remove` sees the built-ins.
2. **Permission deny.** A rule `{ action: <tool's permission>, resource: "*",
   effect: deny }` drops the tool in `Tool.snapshot` (`whollyDisabled`). The
   permission is the effective name unless the tool sets its own:
   edit/write/patch and `opencode_worktree_remove` use `edit`. Denying
   `execute` turns Code Mode off, and its tools then come back as direct
   tools, so it hides nothing.
3. **Disable an internal plugin.** `-<plugin.id>` in the config `plugins`
   list. `managed-config-file.js` writes `-opencode.browser` into
   `opencode.managed.json`, and `-opencode.tool.image-generate` while
   `openchamber_image` is on.

`opencode.tools` holds `session_rename`, `session_move`, `worktree_create`,
`worktree_list`, `worktree_remove` and `models`, all Code Mode only
(`codemode: true`; `session_move` and `worktree_*` pinned), so they sit in the
`execute` catalog, present whenever any Code Mode tool is. It also registers a
session `context` hook that adds a system line pointing agents at
`tools.opencode.session_move` on every request. Disabling `-opencode.tools`
removes the tools and that line together.

A plugin's `session.hook("context")` can edit `event.system` and
`event.tools` per request, for a change narrower than the three above.
