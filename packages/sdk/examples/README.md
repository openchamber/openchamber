# Example extensions

Five small extensions that exercise the SDK contract end to end. They are built
and checked in so they install as-is; edit `main.ts` and rebuild with the command
below when you change one.

| Folder | Capabilities it asks for | What it shows |
| --- | --- | --- |
| `hello-kit` | none | Every UI kit control, the pushes from the app (session, directory, theme), toast, clipboard, open URL, compose into the chat box. No approval dialog. |
| `tasks-demo` | `prompt`, `sessions`, `conversation` | A fake task list. Attach a task as a chip, link it to the current session, start a session (optionally on a worktree), send a prompt. Appears in the composer + menu as a dialog that loads its own page (`panel/attach.html`, declared as `attach: { mode: "dialog", entry }`): from the + menu it is a picker (`ctx.item` is null); click the attached chip and the same dialog opens on that task's details (`ctx.item` set) with the status and comments it put on `attach` as `data`, read back from `ctx.item.data` (list lookup as fallback), and a Send to chat button. Also declares two `actions` and one command: "Create task from message" on assistant messages opens the dialog on that message's text (`ctx.item.kind === "message"`) with a Create button that toasts and attaches; "Summarize session" in the session menus (`payload: ["messages"]`, hence `conversation`) shows the message count and the first 200 characters of each; `/task DEMO-2` in the chat box is answered by `host.onResolve` in `panel/main.ts` (the app mounts that page off-screen when the panel is closed) and attaches the task. The rail icon shows the open-task count through `host.setBadge` until you open the panel. Exercises the approval dialog and `NOT_GRANTED` when you decline. |
| `service-echo` | `service` | A local service process (Node HTTP server on loopback). The panel calls it through `host.serviceRequest` and shows status. Exercises the service approval and spawn/stop lifecycle. |
| `github-token` | `network` | A token integration against `https://api.github.com`. Paste a GitHub token in Settings → Integrations, then the panel lists your repositories through `host.request`. Exercises the OAuth/token store and the request proxy. |
| `config-editor` | `filesystem` | Reads `~/.config/opencode/opencode.json` (declared under `contributes.filesystem`), parses it, and shows it as a browsable tree (Explore tab: keys, types, drill into objects and arrays) next to a raw editor (Raw tab) that saves back atomically. Exercises the outside-project file scope, the missing-file and invalid-JSON states, and the approval dialog's pattern list. |

## Install

1. Run the app: `bun run dev` from the repo root, open the URL it prints.
2. Settings → Extensions → paste the absolute path of a folder below → Add:
   - `<repo>/packages/sdk/examples/hello-kit`
   - `<repo>/packages/sdk/examples/tasks-demo`
   - `<repo>/packages/sdk/examples/service-echo`
   - `<repo>/packages/sdk/examples/github-token`
   - `<repo>/packages/sdk/examples/config-editor`
3. Approve what the dialog lists (or Remove to see the refusal path). The icon appears on the context rail.

## Rebuild after editing

From the repo root:

```bash
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/hello-kit/panel/main.ts packages/sdk/examples/hello-kit/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/service-echo/service/main.ts packages/sdk/examples/service-echo/service/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/config-editor/panel/main.ts packages/sdk/examples/config-editor/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/tasks-demo/panel/main.ts packages/sdk/examples/tasks-demo/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/tasks-demo/panel/attach.ts packages/sdk/examples/tasks-demo/panel/attach.js
```
