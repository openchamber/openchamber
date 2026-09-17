# Extension gallery

Six examples to use, explore, and adapt. The five panel extensions also have full-screen pages. Their layouts respond to the iframe width, use the host's light/dark theme, and keep your input when the host updates its context.

| Folder | In the app | Try this |
| --- | --- | --- |
| `hello-kit` | **SDK Playground** | Explore Components, Live context, Host actions, and Storage. Change an input, switch the host theme, compose a chat draft, and save a note for your next visit. The examples expose their SDK calls under How this works. No capability approval needed. |
| `tasks-demo` | **Task Board** | Add your own task, edit its brief and status, attach it to chat, or start an agent in a chosen project/worktree. Linked sessions stay with the task. Draft a brief with the Small Model. `/task DEMO-2` and message/session actions use the same saved tasks. |
| `github-token` | **Repository Explorer** | Connect GitHub in Settings → Integrations → Extension accounts → GitHub (token). Search and filter repositories, load another page, inspect a repository, and add its context to chat. Sample repositories let you explore the layout before connecting. |
| `service-echo` | **Local Service Lab** | Send an echo request, inspect its response and round-trip time, and watch the service state. Try an invalid path to see the host refuse it. The optional system-information experiment requires `uname` on the server. |
| `config-editor` | **Config Studio** | Browse and filter JSON keys, edit or format the raw file, then compare the on-disk content with your draft before saving. Reads only the declared `~/.config/opencode/opencode.json` path on the connected instance. |
| `tools-only` | **Tool Gallery** | Render review findings and project checks as tables inside chat. This extension has no panel. Its optional read-only MCP fixture makes the results reproducible; see [its README](./tools-only/README.md). |

## Install and explore

1. Run `bun run dev` from the repository root and open the printed URL.
2. In **Settings → Extensions**, add an absolute example folder, such as `<repo>/packages/sdk/examples/hello-kit`.
3. Approve the requested capabilities. Remove uninstalls the extension, so its panel will not run.
4. Open its context-rail panel or choose its full-screen page from the Extension pages menu above the session list.

The checked-in JavaScript makes each folder installable without a build step. Provider requests and agent sessions are real when you connect an account or click Start session. Task Board's initial tasks and Repository Explorer's disconnected sample collection are sample data. An idle agent does not mark a task Done.

Task Board stores one record per task, including deletion markers for sample tasks. Editing one task cannot erase unrelated tasks. A malformed record stays untouched and is reported while other tasks remain usable. Use Refresh to see edits made in another open panel; simultaneous edits to the same task are last-write-wins. Board notes use a separate key. Storage failures do not block project/session subscriptions.

Config Studio validates JSON syntax, not every OpenCode configuration option. Review shows up to 80,000 characters per side; Save writes the full draft. A completed save preserves edits typed while it was in flight. Unsaved changes disable Reload until you save or discard them.

## Read the implementation

- `shared.ts` is presentation code for these examples, not a new SDK API. It supplies the responsive shell, section layout, plain-text output, and theme-token CSS. Bundles embed it, so installations do not need that source file.
- `tasks-demo/panel/tasks.ts` owns task validation and storage; `board.ts` composes the UI; `workspace.ts` owns live project/session subscriptions and generation guards.
- Every panel applies `applyHostReady` on repeated snapshots and mounts once. Controlled inputs call their handle's `update`. Provider and conversation data render as text.
- Example source uses the workspace SDK and the repository's existing Zod dependency for boundary validation. To move an example into its own repository, copy `shared.ts` into that package, adjust its imports, and declare `@openchamber/sdk` and `zod` where used.
- The optional Tool Gallery MCP fixture is a separate process. Installing the extension never starts it or changes OpenCode configuration.

Panel copy is intentionally English so the source stays easy to follow. A localized extension can select its own dictionaries using `HostReadyContext.locale`; an iframe cannot use the host's React i18n context.

## Rebuild

From the repository root:

```bash
bun run --cwd packages/sdk build
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/hello-kit/panel/main.ts packages/sdk/examples/hello-kit/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/github-token/panel/main.ts packages/sdk/examples/github-token/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/service-echo/panel/main.ts packages/sdk/examples/service-echo/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/service-echo/service/main.ts packages/sdk/examples/service-echo/service/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/config-editor/panel/main.ts packages/sdk/examples/config-editor/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/tasks-demo/panel/main.ts packages/sdk/examples/tasks-demo/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/tasks-demo/panel/attach.ts packages/sdk/examples/tasks-demo/panel/attach.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/tasks-demo/panel/page.ts packages/sdk/examples/tasks-demo/panel/page.js
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/tools-only/mcp.ts packages/sdk/examples/tools-only/mcp.js
```

Rebuild all panels after editing `shared.ts` or the SDK. Commit built files with the extension; installation never builds source or installs dependencies. Bump the extension's own version when publishing an update through Git.

## Check

```bash
bun run --cwd packages/sdk type-check
bun run --cwd packages/sdk lint
bun run --cwd packages/sdk test
bun test packages/ui/src/lib/guests/sdk-examples.test.ts
```

SDK checks cover example TypeScript, manifests, persistence failures, the optional MCP fixture, and freshness of all nine bundles. UI-owned DOM tests exercise those bundles with a simulated host. These tests never read your real config or use a provider credential.
