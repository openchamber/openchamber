# @openchamber/sdk

Build extensions for [OpenChamber](https://openchamber.dev). An extension can show a panel on the right-hand rail or run actions in the background without a panel. It can read the current project and session, show toasts, put text in the chat box, attach a task to a session, and, once the user approves it, start sessions and send prompts. This package is the contract between the extension and the app.

Full guide: [Build an extension](https://openchamber.dev/docs/sdk/). Reference: [Host API](https://openchamber.dev/docs/sdk/host/) and [UI kit](https://openchamber.dev/docs/sdk/ui/). Extensions with a local process: [GUEST_SERVICES.md](./GUEST_SERVICES.md).

Extensions load in OpenChamber web and desktop. VS Code and mobile do not load them yet.

## Install

```bash
npm install @openchamber/sdk
```

The package ships compiled JavaScript with type declarations, so any bundler works. Its version matches the OpenChamber release it shipped with, so `@openchamber/sdk@1.24.0` is the contract of OpenChamber 1.24.0.

## Preview builds

Preview packages are for testing unreleased SDK changes against a matching development build of OpenChamber. They do not imply compatibility with the published app of the same base version.

```bash
npm install @openchamber/sdk@preview
```

Maintainers can run **Publish SDK preview** in GitHub Actions, select the source branch, and enter a positive preview number. For example, `1` publishes `1.23.2-preview.1` under the `preview` npm tag. Each publication needs an unused number. The workflow uses the existing `NPM_TOKEN` secret and publishes only the SDK. It changes the version in its temporary checkout, without creating commits or release tags or changing `latest`.

The workflow must exist on the default branch before GitHub exposes its manual trigger. Once it does, select `bohdan/dev` to publish that branch's SDK. Enable `dry_run` to validate without publishing. Validation installs the packed SDK in an isolated project and checks its imports, TypeScript declarations, and extension bundler before publishing that same archive.

## What you ship

A folder with three files:

- `package.json` with an `openchamber` block (the manifest)
- `panel/index.html`, the page OpenChamber shows
- `panel/main.js`, your script built into one classic file (an IIFE; the page runs in a sandboxed iframe and cannot load ES modules)

OpenChamber never compiles your code. Build `panel/main.js` yourself. The package includes a bundler command that runs on Bun; esbuild with `--format=iife --platform=browser` does the same job.

```bash
bunx openchamber-guest-bundle panel/main.ts panel/main.js
```

Then install the folder from Settings → Extensions → Add. Folder installs run from your folder, so edit, rebuild, and reload. A `.zip` or an https git or zip link is copied into OpenChamber's data folder instead; ship the built files only. Git installs can update from Settings → Extensions when the repository's `version` is newer than the installed one, so bump `version` to ship an update; `https://…/panel.git#v1` pins a tag or branch.

A complete three-file example is on the [Build an extension](https://openchamber.dev/docs/sdk/) page. Six examples are at [github.com/openchamber/openchamber/tree/main/packages/sdk/examples](https://github.com/openchamber/openchamber/tree/main/packages/sdk/examples).

## Manifest

Git installs also accept SSH addresses such as `git@github.com:owner/extension.git` and `ssh://git@github.com/owner/extension.git`. The fingerprint menu in Settings → Extensions selects Global Identity or a Git identity on the active server. That identity is reused for update checks and updates. On a remote instance, SSH keys and any unlocked SSH agent must be available to the server process, not just your desktop. See [Extensions](https://docs.openchamber.dev/extensions/) for details.

```json
{
  "name": "@acme/hello",
  "version": "1.0.0",
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=1.24.0" },
    "contributes": {
      "panel": {
        "id": "acme-hello",
        "name": "Hello",
        "icon": "window",
        "entry": "panel/index.html"
      },
      "attach": "dialog",
      "capabilities": ["prompt", "sessions"],
      "actions": [
        { "id": "create-task", "label": "Create task from message", "where": "message", "roles": ["assistant"] },
        { "id": "summarize", "label": "Summarize session", "where": "session", "payload": ["messages"] }
      ],
      "commands": [{ "name": "task", "description": "Attach a task by id" }],
      "tools": [{ "match": "mcp.tasks.*", "name": "Tasks", "icon": "checkbox-circle", "title": "{input.id}", "output": "table", "columns": ["id", "title", "status"] }],
      "integration": {
        "name": "Acme",
        "description": "Tasks from Acme",
        "token": {
          "apiOrigin": "https://api.acme.example",
          "account": { "path": "/me", "name": "login" },
          "scheme": "bearer"
        },
        "settings": [{ "id": "list-id", "label": "List ID" }]
      }
    }
  }
}
```

- `version` is required semver. Settings → Extensions shows it on the card.
- `apiVersion` is `1`. Anything else is refused.
- `engines.openchamber` is optional (`1.24.0` or `>=1.24.0`). Older OpenChamber builds refuse the install.
- `panel.id` is kebab-case and unique. `icon` is a Remixicon name (`RiWindowLine` becomes `window`) or an SVG inside the folder. `entry` is the visible panel's HTML file. Leave `entry` out to have no rail icon or panel. Add `background.entry` for executable actions and commands; with neither entry, the extension can only declare `tools`, as in `examples/tools-only`.
- `background: { "entry": "background/index.html" }` supplies separate sandboxed HTML for background actions and slash commands. Its scripts must be built. It runs on demand, not continuously or at installation. A panel can coexist with it.
- `attach` is optional. `"dialog"` opens the page in a window from the + menu next to the chat box; `true` or `"panel"` opens the rail panel instead. `ctx.surface` tells the page which one it is in. The object form `{ "mode": "dialog", "entry": "panel/attach.html" }` gives the window its own page. When the user clicks the attached chip, the page opens again with that item in `ctx.item` (`null` from the + menu), so it can show the item instead of the list.
- `actions` is optional: menu entries on messages (`where: "message"`, optionally only `roles: ["assistant"]`) and on sessions (`where: "session"`). By default, picking one opens your page with that message or session in `ctx.item` (`kind: "message"` with the text, or `kind: "session"`; add `payload: ["messages"]` to get the conversation too). Set `mode: "background"` to call `onAction` without opening UI, as shown below. Up to 8.
- `commands` is optional: slash commands for the chat box, up to 8. `/task DEMO-2` calls your `host.onResolve` handler instead of the model; return a chip to attach it, or `null` for nothing. A name the app already has is ignored.
- `tools` is optional: how your tool calls look in the chat, up to 16, no code. `match` is the tool name OpenCode reports (`mcp.tasks.*` matches every tool under that prefix); `name` and `icon` (a Remixicon name or an SVG inside the folder, like `panel.icon`) set the header, `title` and `subtitle` are templates like `{input.id}` or `{output.total} open`, and `output` picks the body: `text`, `json`, `markdown`, `code` (with `language`), or `table` (with `columns`, rows from the output array or `output.items`). Leave `output` out to keep the app's own detection.
- `capabilities` lists what needs the user's approval: `prompt` to send messages, `sessions` to create sessions and worktrees, `files` to read and write inside the open project, `model` for one-off text generation with the user's Small Model (`host.generate`, no session involved). An `integration` adds `network`, a `service` adds `service`, `filesystem` patterns (like `["~/.config/opencode/opencode.json"]`) add `filesystem`, which lets `readFile`, `writeFile`, `listDir`, and `stat` reach those paths outside the project, and a session action with `payload: ["messages"]` adds `conversation`. The user approves the whole list once at install. Calls outside it fail with `NOT_GRANTED`.
- `integration` is optional. It adds a card at Settings → Integrations. `token` takes a pasted API token (`scheme: "bearer"` for `Authorization: Bearer`, `"basic"` for a username and token pair as Jira Cloud wants), `oauth` runs an authorize flow with a pasted client id, and `host: { "provider": "linear" }` reuses the Linear account already connected in OpenChamber. The page never sees the token; OpenChamber makes the calls through `host.request`.
- `service` is optional. It declares a local process OpenChamber starts next to the extension. It runs with the user's full access and no sandbox, so declare one only when the page cannot do the job. See [GUEST_SERVICES.md](./GUEST_SERVICES.md). With `provides: ["browser"]` the service can stand in for the agent's browser, so agents browse on the server with no desktop app open; the user picks it in Settings → OpenChamber Tools. With `surface: true` it shows a live picture in the rail that the user can watch and take over, and hand back to the agent; add `panel.entry` (with `panel.dock` and `panel.size`) for your own controls docked beside it.

## Actions without opening a panel

Set `mode: "background"` on a message or session action to run it without opening the rail or a dialog:

```json
{ "id": "message-length", "label": "Show message length", "where": "message", "mode": "background" }
```

Register `onAction` immediately after `connectHost` in your background script, or your panel script when no background entry is declared:

```ts
const host = connectHost();
host.onAction(async (item) => {
  if (item.kind === 'message' && item.action === 'message-length') {
    await host.toast({
      kind: 'info',
      message: `Message length: ${item.text.length} characters.`,
      copy: true,
      dismiss: true,
      persistent: true,
    });
  }
});
```

Each click runs in a fresh hidden iframe. Await all work inside the handler, including the toast. OpenChamber removes the iframe when the handler finishes and reports thrown errors as toasts. Loading and execution together have a 20-second limit. A runtime switch, disabling the extension, or withdrawing approval also ends the invocation. Completed side effects are not rolled back or retried.

`ctx.surface` is `"background"`; skip drawing your UI in that case. `ctx.item` stays `null`, so the action runs only through `onAction`, without repeated `onItem` snapshots. The session and directory context stay with the clicked target even if the user changes chats. OpenChamber loads `background.entry` when declared and falls back to `panel.entry` for existing extensions. Omit `mode`, or use `"open"`, to open a visible panel or dialog. See `examples/hello-kit` for separate panel and background scripts.

To remove the panel and its rail icon entirely, use this `contributes` block:

```json
{
  "panel": { "id": "message-tools", "name": "Message Tools", "icon": "apps" },
  "background": { "entry": "background/index.html" },
  "actions": [
    { "id": "message-length", "label": "Show message length", "where": "message", "mode": "background" }
  ]
}
```

The `panel` object retains the extension's identity for Settings and approval dialogs; only `panel.entry` creates a visible panel. Without it, every action must use `mode: "background"`, and `attach` and `page` cannot open a view. Slash commands call `onResolve` in the background entry, with `ctx.surface` also set to `"background"`. Capabilities, services, integrations, storage, and file access use the same approval checks. An attached chip can still be sent to the model or opened with its browser button; clicking to reopen the extension shows a no-panel notice.

This addition requires a matching OpenChamber build. For unreleased SDK preview builds, use the app built from the same revision.

## Toast buttons

`host.toast` accepts three optional fields:

- `copy: true` adds Copy for the displayed message. Use `copy: { text: "..." }` to copy a different value, up to 32,000 characters. Whitespace in that value is preserved.
- `dismiss: true` adds OK to close the toast.
- `persistent: true` keeps the toast on screen until dismissed and always adds OK, even if `dismiss` is false.

Copy keeps the toast open and shows Copied on success. A failed copy shows an error beside the button so the user can retry. OpenChamber translates the buttons and handles clicks itself, so they work after a background action's iframe has closed. `await host.toast(...)` waits only for the host to show the toast, not for a button click. Omit these fields for an ordinary timed toast.

## In the page

For a full-screen board, add `"page": true` under `contributes`, or `"page": { "entry": "panel/page.html", "title": "Board" }` for separate HTML. Users open it from the Extension pages menu above the session list. `ctx.surface` is `"page"`. The extension cannot open the page itself.

For a small readout in the chat's Work Status panel, add `"statusSection": { "entry": "status/index.html", "title": "Recent commits" }`. It needs no `panel.entry`, so a section-only extension has no rail icon. `ctx.surface` is `"status"`. Call `host.setHeight(px)` when your content changes size; the host stops growing the frame at 320 px and your page scrolls after that. `examples/git-graph-status` is a complete section with a local service.

With `sessions` approved, use `listProjects()`, `listWorktrees(projectId)`, and `listSessions(projectId)`. Subscribe through `await onProjects(listener)`, `await onWorktrees(projectId, listener)`, or `await onSessions(projectId, listener)` and retain the returned unsubscribe function. Snapshots distinguish loading, ready, and error; session activity and observed turn outcomes are separate from your task status.

`startSession` accepts `projectId` and `worktree: { kind: "new", name: "fix-login", baseBranch: "main" }` or `{ kind: "existing", directory }`. It preserves the current screen by default. `openSession(sessionId)` explicitly opens the chat. `host.storage.get/set/delete/keys` stores your own JSON on the connected server without a file-access grant. See [API.md](./API.md) for limits and partial results. The `tasks-demo` page exercises these methods together.

```ts
import { connectHost, HostRequestError } from '@openchamber/sdk';

const host = connectHost();

host.onReady((ctx) => {
  document.body.dataset.theme = ctx.theme.mode;
});

host.onSession((session) => {
  document.querySelector('#session')!.textContent = session?.title ?? '';
});

try {
  const user = await host.request({ method: 'GET', path: '/me' });
} catch (error) {
  if (error instanceof HostRequestError && error.code === 'DISCONNECTED') {
    await host.oauthStart();
  }
}

await host.toast({ kind: 'info', message: 'Hello' });
await host.compose({ text: 'Ask about the latest diff' });
await host.attach({
  providerId: 'acme-hello',
  id: 'TICKET-1',
  title: 'Login is broken',
  url: 'https://example.com/TICKET-1',
});
await host.startSession({
  providerId: 'acme-hello',
  id: 'TICKET-1',
  title: 'Login is broken',
  url: 'https://example.com/TICKET-1',
  worktree: true,
  text: 'Optional first message',
});
await host.prompt({ text: 'Fix the login', send: true });
await host.setBadge(3); // number on the rail icon; null clears it
await host.openCommit(sha); // show a commit of the open project in the Diff view
await host.setHeight(document.body.scrollHeight); // Work Status section: frame height, clamped by the host
const { text } = await host.generate({ prompt: task.description, system: 'One-line summary only.' }); // capability model

host.onResolve(({ command, args }) => {
  // the user typed /task DEMO-2
  const task = findTask(args.trim());
  return task ? { providerId: 'acme-hello', id: task.id, title: task.title, url: task.url } : null;
});

host.onItem((item) => {
  if (item?.kind === 'message') showMessage(item.text);      // "Create task from message"
  if (item?.kind === 'session') showSummary(item.messages);  // "Summarize session"
});
```

Every method, its limits, and the error codes are on the [Host API](https://openchamber.dev/docs/sdk/host/) page.

## UI kit

`@openchamber/sdk/ui` has buttons, fields, a searchable dropdown, checkboxes, tabs, badges, lists, empty states, spinners, banners, separators, progress bars, menus, and safe text, all drawn with the app's colours and fonts. Apply `applyHostReady` on every `onReady`, but mount controls and register listeners once. Repeated snapshots must not erase inputs or drafts. Every mount returns `{ update, dispose }`. Use `update` to pass changed values back to controls, including `tabs.update({ activeId })` and `select.update({ value })` inside `onChange`. See the [UI kit examples](https://docs.openchamber.dev/sdk/ui/) for input state and tab switching.

```ts
import { applyHostReady, mountList } from '@openchamber/sdk/ui';

let mounted = false;
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (mounted) return;
  mounted = true;
  mountList(document.querySelector('#root')!, {
    items: tasks.map((task) => ({ id: task.id, leading: task.key, title: task.title })),
    onSelect: (id) => {
      const task = tasks.find((item) => item.id === id);
      if (task) void host.attach({ providerId: 'acme-hello', id, title: task.title, url: task.url });
    },
  });
});
```

OpenChamber supplies thin, theme-aware native scrollbars inside extension documents, including nested lists, tabs, and textareas. Like the app's own, they stay hidden until you hover or scroll. The UI kit includes the same defaults for development previews. Existing installed bundles get the host stylesheet without rebuilding. Custom rendering hosts can use `GUEST_SCROLLBAR_CSS` from `@openchamber/sdk`. Authors can override these default rules; an extension's CSP still applies.

## Schemas

`@openchamber/sdk/schemas` exports the zod schemas for the manifest and the messages, for tools that validate extensions. The main entry has no zod dependency, so a page bundle stays small.

## Scope

This package covers the page, the manifest, the messages, and the UI kit. The page gets no terminal, no git, no files outside what it declared, and no access to OpenChamber's React tree. A declared `service` is different: it is a real process with the user's rights, so it can do anything the user can, and the approval dialog says so. `apiVersion` 1 is frozen; new methods arrive with the app's releases and this package's version.
