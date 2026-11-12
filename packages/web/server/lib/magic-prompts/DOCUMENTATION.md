# Magic Prompts

## Ownership

Server storage for Magic Prompt overrides in two scopes: global (`<data dir>/magic-prompts.json`) and project (the `magicPrompts` key of the checkout's `.openchamber/project.json`, written through `../projects`, which owns that file). For a directory it answers which overrides apply; built-in text lives only in the client (`packages/ui/src/lib/magicPrompts.ts`).

`service.js` handles every request for both transports: `routes.js` adapts Express, and the VS Code extension host (`packages/vscode/src/magic-prompts.ts`) calls it with its own project list and owner resolution. Keep `runtime.js` and `service.js` free of imports outside this folder, so the extension bundle takes nothing else from the server.

`routes.js` returns `overridesForDirectory` for server features whose prompt
runs on the server. The walkthrough reads `walkthrough.instructions` through it
(`../walkthrough/DOCUMENTATION.md`); that prompt has no built-in text, so the
server needs none.

## Invariants

- **Project over global over built-in, by key presence.** An empty string is a value and wins. A directory no registered project owns gets the global map alone.
- **The owner of a directory** is the deepest registered project holding it. In a linked git worktree, the same path in the primary checkout decides, unless a project registered at or inside that worktree holds the directory. Paths are compared with symlinks resolved (through the nearest existing parent for a folder not created yet), because git reports checkouts that way: a project registered through a symlink, such as `/tmp` on macOS, still owns its worktrees.
- **Read failure is not empty success.** A missing file or `magicPrompts` key is no overrides. An unreadable or invalid file is an error: a directory read that needs it fails, the Settings view reports that scope as `invalid` beside the readable one, and every write to that scope is refused with the bytes left as they are. The answer is never a smaller map and never built-in text.
- **A selector names one scope.** Selectors are query values; a body carrying `scope` or `projectId`, or any ambiguous selector, is a 400 with nothing written, so a project edit never lands in the global file.
- **Writes keep what they do not own.** Unknown top-level keys of the global file survive. Project writes change only `magicPrompts`, never repair the file, and follow the locking limits in `../projects/DOCUMENTATION.md`. The global file is replaced through a temporary sibling; its write queue is per runtime instance.

## Decisions

### Why the server resolves the owner and not the client

The client knows projects and worktrees only as far as its stores have loaded them, so a cold start or an undiscovered worktree gave a wrong owner. The server reads the project list and git at read time, so every client gets one answer.

### Why one request service for Express and VS Code

The extension host had a TypeScript copy of the stores, selectors and error mapping, and every rule changed twice. Only request parsing, the project list, owner resolution and the shared-file writer differ per runtime.

### Why `sessionDirectory` and not `directory`

The spaces dispatcher forwards an `/api` request whose `directory` or `x-opencode-directory` names a folder under `/spaces/` into that space (`../spaces/DOCUMENTATION.md`). The overrides are this host's settings, so the read keeps its own parameter and stays on the host. No project holds a space folder, so work in a space reads the global prompts.

### Why the server returns overrides and the client adds built-in text

Built-in text changes with the client build. Keeping it only in the client means no prompt text lives in two places.
