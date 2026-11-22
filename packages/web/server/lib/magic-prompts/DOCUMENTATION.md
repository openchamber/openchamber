# Magic Prompts

## Ownership

Server storage for Magic Prompt overrides in two scopes: global (`<data dir>/magic-prompts.json`) and project (the `magicPrompts` key of the checkout's `.openchamber/project.json`, written through `../projects`, which owns that file). For a directory it answers which overrides apply; built-in text lives only in the client (`packages/ui/src/lib/magicPrompts.ts`).

`service.ts` handles every request for both transports: `routes.ts` adapts Express, and the VS Code extension host (`packages/vscode/src/magic-prompts.ts`) calls it with its own project list and owner resolution. Keep `runtime.ts` and `service.ts` free of runtime imports outside this folder, so the extension bundle takes nothing else from the server. Relative import specifiers retain `.js` for source resolution and emitted Node modules.

`routes.ts` returns `overridesForDirectory` for server features whose prompt
runs on the server. The walkthrough reads `walkthrough.instructions` through it
(`../walkthrough/DOCUMENTATION.md`); that prompt has no built-in text, so the
server needs none.

## Invariants

- **Project over global over built-in, by key presence.** An empty string is a value and wins. A directory no registered project owns gets the global map alone.
- **The owner of a directory** is the deepest registered project holding it. In a linked git worktree, the same path in the primary checkout decides, unless a project registered at or inside that worktree holds the directory. Paths are compared with symlinks resolved (through the nearest existing parent for a folder not created yet), because git reports checkouts that way: a project registered through a symlink, such as `/tmp` on macOS, still owns its worktrees. The worktree mapping uses git's own prefix, which is right also for a directory reached through a symlink.
- **Read failure is not empty success.** A missing file or `magicPrompts` key is no overrides. An unreadable or invalid file is an error: a directory read that needs it fails, the Settings view reports that scope as `invalid` beside the readable one, and every write to that scope is refused with the bytes left as they are. The answer is never a smaller map and never built-in text.
- **The global file is filtered; a project map is refused whole.** An entry in the global file with a bad id or a non-string value is dropped on read. The `magicPrompts` map of a project file is hand-edited and committed, so one wrong entry makes that scope `invalid` instead of silently changing which prompt applies.
- **Override maps hold their keys as own properties.** A map is rebuilt through `Object.defineProperty`, so the prompt id `__proto__` (the id pattern allows it) stays an ordinary key instead of changing the prototype; an `undefined` value removes the key.
- **A selector names one scope.** Selectors are query values; a body carrying `scope` or `projectId`, or any ambiguous selector, is a 400 with nothing written, so a project edit never lands in the global file. An unknown `projectId` is a 404, never a fallback to the global file.
- **Response shape follows the selector.** A request without `projectId` answers with the global state alone, as it always has; one naming a project answers with both scopes of that project.
- **Writes keep what they do not own.** Unknown top-level keys of the global file survive. Project writes change only `magicPrompts`, never repair the file, and follow the locking limits in `../projects/DOCUMENTATION.md`. A project write that leaves its map empty removes the `magicPrompts` key. The global file is replaced through a temporary sibling; its write queue is per runtime instance.
- **The project file owner's refusals are mapped, not guessed.** `readSharedProjectFile` answers an invalid file as `status: 'invalid'` with a reason. `updateSharedProjectEntry` refuses an invalid file with `code: 'shared_config_invalid'`, a gone checkout with the message `project checkout not found`, and an id unsafe for its lock file's name with the message `projectId contains unsupported characters`; the project runtime turns these into `project_config_invalid`, `project_checkout_missing` and `project_id_unsupported`.
- **The registered projects are read on each call**, so a project added or removed between requests takes effect without a restart.

## Decisions

### Why the server resolves the owner and not the client

The client knows projects and worktrees only as far as its stores have loaded them, so a cold start or an undiscovered worktree gave a wrong owner. The server reads the project list and git at read time, so every client gets one answer.

### Why one request service for Express and VS Code

The extension host had a TypeScript copy of the stores, selectors and error mapping, and every rule changed twice. Only request parsing, the project list, owner resolution and the shared-file writer differ per runtime.

### Why `sessionDirectory` and not `directory`

The spaces dispatcher forwards an `/api` request whose `directory` or `x-opencode-directory` names a folder under `/spaces/` into that space (`../spaces/DOCUMENTATION.md`). The overrides are this host's settings, so the read keeps its own parameter and stays on the host. No project holds a space folder, so work in a space reads the global prompts.

### Why the server returns overrides and the client adds built-in text

Built-in text changes with the client build. Keeping it only in the client means no prompt text lives in two places.

### Why a query value reaches the service as a one-element list

Express parses a repeated or nested parameter into an array or object. Passing its parsed value wrapped in a list lets the service accept one string and refuse anything else, instead of the routes having to choose a value out of many.

### Why legacy combined keys still expand

Older builds stored `git.commit.generate` and `git.pr.generate` as a single value. Merging still expands that key: its first line fills `<key>.visible` and the rest `<key>.instructions`, only where the same map has no split key and the part is not blank. Ignoring the combined key would silently lose overrides saved by an older build.

### Why raw selectors retain arrays and objects

The request contract includes the parsed query values Express can pass, including repeated and nested values. Only one non-empty string passes the service's selector parser. VS Code supplies string arrays through the same contract.

### Why the route adapter uses the shared HTTP contract

`../shared/http-contracts.ts` owns the request, response and router types.
The adapter specializes its query and path parameters without copying the
transport contract. Request bodies stay unparsed until the text and selector
guards run.

### Why storage checks remain after conversion

JSON text supplies JSON values, with object shape and entry validation applied after parsing. Global reads still filter invalid entries; project reads still reject the whole map. Filesystem and shared-project errors are checked where they enter the runtime. Internal prompt ids and text arrive through typed service calls, after transport validation. A present legacy key must have a string value, and an invalid project scope must have an owner; explicit invariant failures retain those assumptions without assertions or fallback values.
