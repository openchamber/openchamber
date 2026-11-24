# SDK examples

## Ownership

Each folder is a runnable reference for one SDK surface: panels, pages, background actions, chat blocks, file editors, status sections, local services, the provider roles, waits and an OpenCode plugin. A folder installs from the repository without a build step. The TypeScript files are the source and the checked-in `.js` beside each entry is its bundle, which is what the host loads.

`shared.ts` is presentation shared by the panels and is compiled into each bundle. It is not an SDK export.

The fake servers are in-memory test doubles of their role's contract: `source-control-provider/fake-forge.ts`, `tracker-provider/tracker-server.ts`, `quota-provider/usage-server.ts` and `notification-webhook/receiver.ts`. The example tests start them on a loopback port. They keep only the sample data the examples need and lose it when they stop. `git-graph-status` reads a real project and `service-echo` runs a real command instead.

## Invariants

- A checked-in bundle matches its source and the current SDK. `packages/sdk/scripts/examples.test.ts` rebuilds every entry and compares the text. Change the TypeScript, regenerate the bundle with `scripts/bundle-guest.ts`, and commit both. Never edit a `.js` bundle by hand.
- Every local service listens on `127.0.0.1`, takes `OPENCHAMBER_SERVICE_PORT` and `OPENCHAMBER_SERVICE_TOKEN`, and reaches the app only through the host proxy.
- Provider services call the network through `create*Outbound` with the call's handle. The host adds the credential and pins the request to the account's origin; no example holds a token.
- A panel applies `applyHostReady` on every `ready` snapshot and does its one-time mount behind a flag. A controlled field calls its handle's `update` instead of being redrawn.
- Everything that arrives from outside a frame is parsed before use: block arguments written by a model, an attach item's `data`, a service answer. A value that does not parse becomes a readable failure, never partial state.

## Decisions

### Why the Git graph lanes copy the app's Git view

`git-graph-status/status/graph.ts` owns the example's lane layout. The Git view no longer draws a commit graph (its history is a plain list), so there is no app copy to keep in step with.

### Why the Git service leaves optional locks off and accepts an empty repository

`git-graph-status/service/main.ts` runs only read commands in the user's working directory. Each call sets `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`, so a history read takes no lock the user's own git waits on and blocks on no credential prompt. A repository with no commits has no `HEAD` yet; the log read answers git's "unknown revision" with an empty history, and any other failure stays an error.

### Why a merge's numbers come from its first parent

Commit details diff a merge against its first parent, which is the change the merge brought into the checked-out line and what a pull request view shows.

### Why manual refs are matched instead of passed through

The Manual range sends ref names. `revisions` keeps only names present in `git for-each-ref` output, so a name the section never listed never reaches the argument list.

### Why the section clears details, republishes header controls, and reloads on a finished turn

A detail read started before a refresh can describe a commit whose hash stayed but whose content a rewrite replaced; `load` drops the cache and reloads only the open row. The host retires header callbacks when the directory changes, even when the next mode is identical, so a project switch clears the published signature before republishing. An agent turn that ends may have committed, so the section reloads on the `started` to `completed` transition and on no other status event.

### Why storage preferences are keyed by a hash of the path

Storage keys are capped at 128 characters and a project path can exceed that. `prefsKey` uses an FNV-1a hash of the directory under a `prefs:` prefix.

### Why the graph draws straight lanes under curves and the dot

`drawRowGraph` appends passing and stub connectors first, curves over them, and the dot last. At a crossing the curves and the dot must cover the straight lanes; another order leaves a lane running through a commit dot.

### Why older hosts keep the semantic palette

`syntax-*` tokens are recent. `view.ts` writes each lane colour as `var(--oc-syntax-keyword, var(--oc-primary))` and so on, so a host without syntax tokens still draws a readable graph from the semantic colours.

### Why a chat block draws its arguments and answers only on a click

Block arguments are written by a model. `agent-desk/blocks/chart.ts` renders them as text and bars and attaches no behaviour to them. The single button is the only path that answers the agent, and it is disabled once answered.

### Why the browser stub paints its own page and still returns a PNG for a capture

The stub exists to exercise the browser contract and the host's routing without Chrome, and the host writes a capture to a file. `renderFrame` paints the fake page with rectangles so the viewer, control hand-off and input path can be seen working, and `browser.capture` returns a real 1×1 PNG so the capture path runs end to end.

### Why the browser stub starts its frame sequence above zero

A surface viewer asks for frames after the last one it drew, and its first request uses `after=0`. `seq` starts at 1, so that request is answered with a picture instead of waiting for a change.

### Why the browser stub refuses unknown tab ids and closes

It has one page and no tabs. A request that names a tab, or asks to close, gets a failure; answering from the single page would report an action the provider did not perform.

### Why the checklist version is a content fingerprint

The host compares versions to decide whether the editor's text is the one on disk. `checklistVersion` hashes the serialized text, so undoing back to the saved text gives the saved version and no edit. The baseline is the text this editor would write back, which is why opening a file that spells `[X]` does not count as an edit.

### Why the checklist keeps every line it does not understand

`parseChecklist` recognizes only `- [ ]` and `- [x]` item lines. Every other line stays a `text` line and `serializeChecklist` writes it verbatim, so saving never rewrites a heading, table or code fence.

### Why a save can leave the editor dirty

`createFileSaveTracker` compares the version the host saved with the current one. An edit typed while the host was writing has a different version, so the editor reports dirty after `file-saved` and the host's write does not end the user's edit.

### Why the source-control service splits a diff per file

`splitUnifiedDiff` keys each `diff --git` part by the file's new path, or its old path for a deletion, and keeps each part's header. This is the split OpenChamber's built-in Gitea host makes, and the comparison view and file walkthrough expect that shape.

### Why a branch's pull request may be closed

`findBranchPull` looks through open pull requests first, then the newest closed one. A merged or abandoned branch then shows its history in the status line instead of offering to open a pull request that already exists.

### Why a scan limit is an error

A branch status that stops at the scan limit cannot know whether a pull request exists further in. `findBranchPull` and `readChangedFiles` throw `SCAN_LIMIT` instead of answering "none" or a partial file list, because the wrong answer would be acted on.

### Why a comment edit checks the comment's item

Gitea comment ids are repository-wide. `itemCommentPath` reads the comment and compares its `issue_url` or `pull_request_url` with the resolved item before an edit or delete. Without that check an id belonging to another item would be changed while this item's mutation record claims the write.

### Why a fork pull request names its head owner and a merge carries the head commit

Gitea reads a bare head ref as a branch of the target repository, so `perform` prefixes the owner when the head repository is not the target. The merge endpoint accepts `head_commit_id` and refuses once the branch has moved past it, so passing the head the user saw turns a changed branch into a refusal instead of a merge of commits nobody reviewed.

### Why mutations resolve before they perform, and what reconcile may claim

OpenChamber records the target and the idempotency digest. The service resolves what the write acts on, performs it once, and on a later `mutation.reconcile` reports `succeeded` or `failed` only from evidence the forge still holds. An edit the forge no longer shows, and a comment, leave `outcome-unknown`, because the service cannot tell a lost write from one never sent.

### Why a fork pull request's file reads go to the target repository

Gitea keeps a fork pull request's head commit in the target repository as well. `readChangeRequestFile` reads both the merge base and the head from the target, so one repository answers both sides of the file.

### Why an unknown tracked item is left out

`liveSummaries` drops an item the forge cannot answer and fails the whole batch only on 401. An unknown item is not a closed one, and a list that showed it as closed would hide work the user still has.

### Why the tracker sends upper-case identifiers

OpenChamber compares tracker identifiers case-insensitively in upper case. `toSummary` and `toLiveSummary` upper-case the server's key, and `tracker-server.ts` matches keys case-insensitively so a pasted lower-case link still resolves.

### Why the tracker handlers are typed through the SDK's maps

`Handlers` maps each `TrackerProviderMethod` to its own input and answer type. A wrong field in a handler fails `bun run --cwd packages/sdk type-check` instead of reaching a runtime cast.

### Why the quota service keeps a not-configured branch

OpenChamber answers "not configured" itself when OpenCode holds no credential for a listed provider. The service keeps the same answer for a call that still arrives, so the branch is deliberate and not dead code.

### Why the quota service has a fixed API address

OpenChamber gives a service none of the host's environment. `TEAPOT_USAGE_URL` is read for the example's own test, which starts a server on a free port; in the app the address is the example's fixed default.

### Why the journal treats an empty list as every project and acknowledges an event it skips

`SESSION_JOURNAL_PROJECTS` unset is the common case for a user with no list to write, so an empty list means every project and a non-empty list is an allow-list. OpenChamber treats a successful answer as delivered, so the journal answers `ok` for an event it chose not to write and reserves a failure for a write that failed on this side.

### Why the task board parses an attach item and queues a late brief

`item.data` is whatever this extension put on the attach payload, carried back by the host untouched and typed as unknown; `attach.ts` parses it and falls back to the saved task, so a malformed or older payload still opens. A brief requested before the board closes arrives after it reopens and may outlive its task, so the board queues the answer, matches it to the saved task by the prompt the draft was made from, and reports a brief whose task changed instead of attaching it to the wrong one.

### Why the fake forge writes one hunk per modified file and mirrors Gitea's comment addresses

The fake forge only modifies files, so each changed file is the whole file in one hunk, which is enough for the service's per-file split. Gitea answers a pull request comment with `pull_request_url` and an empty `issue_url`, and an issue comment the other way round; the fake copies that so `itemCommentPath` is exercised against the same field the real forge sends.
