# Isolated spaces: design

Status: design agreed on 2026-09-19. [STAGES.md](STAGES.md) says what is built. Owner and reviewer: the maintainer.

Read this file before working on any stage. Then read the stage you are building in [STAGES.md](STAGES.md), the rules in [TESTING.md](TESTING.md), and the facts in [LESSONS.md](LESSONS.md) when a decision looks strange. LESSONS.md explains why.

## What it is

The user lets an agent work inside a container, on a copy of the project. When the task is done, the user applies the result to their own code base or discards it.

Motives, all of them in scope: protect the user's machine, let the agent run without permission prompts, keep host secrets away from the agent, and keep project tooling off the host.

## The boundary rule

Every limit is a restriction the agent cannot undo from inside. A promise is worthless here.

Everything that crosses the boundary crosses because the user decided it, one item at a time. Apply this rule to every design choice. If a choice relies on the agent behaving, it is wrong.

The host treats everything that comes out of a space as untrusted data to display, never as a command.

## Words

- **Space.** One container with the agent and a copy of the code. It holds several sessions, like a worktree. A new space always gets a new container. Only images and the per-project package cache are shared.
- **Place.** Where spaces run: local Docker, Docker on another machine over SSH, a Kubernetes cluster, Apple `container`. Later, sandbox services. The user can configure several places and one default.
- **Gatekeeper.** A small separate container next to each space. It is the space's only way out.
- **Space manager.** New server module in `packages/web`. Creates, finds, stops, and removes spaces. Moves code in and out. Delivers grants.
- **Dispatcher.** A thin layer in front of the existing server. It forwards requests that belong to a space to the server inside that space.
- **Grant.** A credential or an opened domain that the user gives a space. There are two grades, shown to the user in plain words:
  - **Uses without seeing.** The gatekeeper holds the secret and adds it to requests. Model API keys, git over https, private npm.
  - **Handed over.** A file or variable inside the space that the agent can read. `.env`, SSH keys, cloud CLI keys, the short-lived OpenAI login token, the Copilot token.

## Product decisions

1. Code enters as a copy. Nothing from the host is mounted into a space.
2. Start from a clean commit or with the user's uncommitted changes. Files matched by `.gitignore` never travel.
3. Network is the user's choice per space: allowlist or open internet. In both modes the gatekeeper blocks the user's private networks, link-local ranges, and cloud metadata addresses, takes names and not addresses, and allows port 443 only, so a space can never attack a third party's other services from the user's address.
4. Grants can be given at creation and during work. They cannot be taken back. They disappear with the space.
5. OpenChamber stores no secret values. It remembers only the name of the host source (an env variable, a file, the `gh` token) so "same as last time" is one click.
6. The agent in a space asks for no tool permissions by default. The existing per-session switch stays. A grant dialog says that the agent can use the grant without confirmation.
7. Apply in two ways: as a branch with the agent's commits, or as uncommitted changes. If the uncommitted variant does not apply cleanly, touch nothing and offer the branch. Decided on 2026-09-22 for stage 3b: in the branch, whatever the agent left uncommitted in the space goes on top as one extra commit whose message says it holds the uncommitted changes from the space; when nothing was uncommitted there is no extra commit. So the branch holds exactly what the space held. Applying as uncommitted changes may run the user's own configured filters, Git LFS among them, for files that a `.gitattributes` already in the user's working tree covers, the same as a `git pull` from someone else would. A filter named by a `.gitattributes` that arrives in the same patch does not run, and neither does one named by a `.gitattributes` that is not in the working tree now, when the host reads the project back to decide what an apply brings: it reads with the attributes the working tree holds, and runs no smudge filter. A file such a filter keeps, which the agent changed and an apply wrote, cannot be updated as uncommitted changes a second time, because the filter reads it back as another file: that apply is refused with a message that says so, closing the way. The branch runs nothing. Applying as uncommitted changes a second time, after the agent worked on and the work came out again, brings only what is new since the last such apply; the host remembers what it applied as a service ref beside the start and the result. A patch is not one write: an apply that fails in the middle says so and leaves the remembered ref where it was. **Decided on 2026-09-23:** once applying a space's work as uncommitted changes has been refused, because the user's project and the agent's work went apart, that way is closed for that space and the work is taken as a branch from then on. The user is told that once, at the refusal, and every later attempt says the same thing rather than a fresh collision message. Nothing is applied in part and nothing is lost: the branch holds everything, the rounds already applied included. An apply that stopped in the middle closes it too, because the project is then in a state that cannot be reasoned about. Nothing reopens it. **Decided on 2026-09-24:** a name the agent made that the user's computer cannot hold, such as a reserved Windows name or two names that differ only in case, is refused before any apply, touching nothing, with a message that asks for the agent to rename it; that refusal does not close the way, because the project and the space did not go apart. The same holds for a rename that changes only the case of a name, which `git apply` cannot apply on a disk that ignores case: it is refused with its own message, touching nothing, and the branch holds it. Whether a disk ignores case is the repository's own setting, as git found it. An apply the host did not live to record is recognised at the next call from the working tree: finished and recorded, never started and forgotten, or reported as partly applied. **Decided on 2026-09-25:** a user who applies the work as uncommitted changes, dislikes it, throws it all away, has the agent redo it and applies again gets the whole work again, as if the thrown-away apply never happened, and the way stays open. "Thrown away" is decided file by file, made exact on 2026-09-25 in round eight: a file the last apply changed is thrown away when it is back as it was before that apply and no commit of the user's changed it since; it is kept when it holds what the apply wrote; and it is the user's own edit when it holds neither, or when a commit of the user's made since that apply changed it, a revert among them. Going back, a reset or a checkout of an older commit, makes no commit, so what it put back counts as thrown away. An edit of the user's, committed or not, is never a throw-away, and an edit on another file does not matter. When every file of the last apply is thrown away, the whole work since before it comes again; when every file of every apply so far is, the whole work from the start of the space. This holds after a pull, a switch to another branch or in another linked worktree, as long as each file of the last apply is back as it was: a pull or a rebase that brings a colleague's change into one of those files leaves it holding neither side, which is an edit, so that throw-away is refused as a part, though the whole work would fit. An amend that drops a file of the last apply from the user's commit rewrites that commit instead of making one, so the file counts as thrown away; a new commit that drops it counts as the user's change. Whatever the user did to a file that counts as an edit is judged like any other edit: the apply goes on if the new work fits, and is refused, closing the way, if it does not. When only part of the last apply is gone, the apply is refused and the way closes, even when the redo touches only other files, because any apply would leave the thrown-away part out without a word: the message names the files that are back as before and the ones that are still there or changed since, says that the branch holds everything, and, where a file still there differs from what HEAD holds, that those files must be removed or committed before that branch can be merged or switched to. An edit of the user's on one of those files is not throwing it away. The whole work also comes again when the same work is applied again with nothing new brought out: the user threw it away and asks for it again. If the whole work does not fit the project, the apply is refused and the way closes, as for any refusal. After two applies, throwing away only the second brings the second round again on top of the first. A change the host cannot see in the working tree, such as a change of line endings that the user's own attributes undo, or a repository the agent made inside its project, counts as kept. The host remembers what each apply was built from and where HEAD was, so the answer is exact; a space applied before this was recorded behaves as it did before. When reading the project back to decide this takes too long, or a file there cannot be read as a plain file, the apply is refused and the way closes, rather than every later apply failing the same way.
8. The apply dialog has "delete the space afterwards", on by default. Discard always deletes, after confirmation.
9. The chat stays as a read-only archive after apply and after discard, until the user deletes it.
10. Closing OpenChamber does not stop a space. OpenChamber can restart a stuck OpenCode inside it.
11. A space stops itself after several idle hours. The threshold is a setting and the behaviour can be turned off. Stopping keeps files.
12. The user never needs a terminal to manage containers. OpenChamber shows and manages only what it created.
13. Model login. API-key providers, including coding plans that issue a key, go through the gatekeeper. OpenAI browser login works by handing over only the short-lived access token while the host stays the only refresher. Copilot's token is long-lived, so its dialog carries a stronger warning. Claude Pro/Max browser login is unavailable because OpenCode removed it.
14. Previewing a dev server that runs inside a space is part of the first release.
15. Default image first. Project-defined images (`devcontainer.json`, Dockerfile) are a later stage.
16. Surfaces: web, desktop, mobile. VS Code never gets this feature. The entry point is absent there on purpose, and that must be visible in code.
17. The user turns the feature on. A switch in Settings, off by default. It is the same switch the feature hides behind while it is built: at the first release it becomes the user's instead of being removed. The feature needs a container runtime, makes containers on the user's machine and downloads an image of about 1.6 GB, so it should not be in the way of people who will not use it.
18. Turning the switch off stops every space and keeps its files, so turning it back on finds them where they were. A banner beside the switch says that before the user commits, and it appears only when there is something to stop: how many spaces, that their files are kept, and that they come back. A space that could not be stopped, because a runtime is not running or a place cannot be reached, is reported as still running rather than quietly counted as stopped, and for a place on another machine the promise is only what OpenChamber can do from here. Removing spaces is never part of turning the switch off. It is its own action, offered once the switch is off, and it goes through the confirmation that lists what would be lost. A checkbox that deletes a user's work alongside a settings toggle is not a confirmation: the two decisions differ in cost, one is reversible and the other is not, and one checkbox cannot tell five empty spaces from two that hold a day's work.
19. While the switch is off the feature does nothing at all: no process, no `docker` or other runtime command, no connection, no reading of runtime state, no route, no entry point. Its first process is a consequence of the user turning the switch on or acting in the feature's own screens. In particular, nothing probes whether a runtime is available in order to decide whether to show an entry point — the entry point is there because the switch is on, and the probe lives inside the funnel. A probe at start-up would run `docker` for everyone, including people who never asked for any of this.

## User journey

0. **Set up a place, once.** "Where should the agent work?" On this computer, on another machine over SSH, in a cluster. OpenChamber checks the choice itself and answers in plain words. It says when a place cannot restrict the network and when keys would leave the user's machine. Setting up a place pulls the image in the background.
1. **Create.** In the new-session target picker, next to "New worktree", sits "New isolated space". Four choices: place, starting point, network, grants up front. Each grant shows its grade.
2. **Prepare.** A group with a container badge appears under the project at once, with a line that says what is happening now. The session opens immediately and the user can write the task; the message queues and sends itself when the space is ready. The agent starts as soon as code arrives, while dependencies may still install. Errors name the setting to fix.
3. **Work.** Sessions in the group behave like any session. The agent keeps working when OpenChamber is closed. With an OpenAI browser login it works until the short token expires, about an hour, then waits for the user to open OpenChamber.
4. **The agent lacks something.** The group shows blocked attempts from the gatekeeper's journal with an "Open" action. "Grant access" sits on the group and in the session header. Granting goes through the host.
5. **Review.** The usual git panel and diff. A dev server from the space opens in the built-in browser.
6. **Decide.** Apply as a branch, apply as uncommitted changes, or discard.
7. **Afterwards.** The chat remains as a read-only archive.
8. **When something breaks.** Status on the group. Three actions from soft to hard: restart OpenCode, restart the container, delete. An unreachable space says so and the rest of the app keeps working. After a restart OpenChamber finds its spaces by itself.
9. **Overview.** A project's spaces open from the project menu, next to worktrees. The places page in Settings shows every place with what runs on it, orphaned spaces, and disk used by images and caches with a clean-up action. An unreachable place shows its spaces as unreachable, never as an empty list.

## Architecture

### Parts

```
        HOST                                 PLACE
┌────────────────────────┐         ┌─────────────────────────────────────┐
│ OpenChamber server     │ manages │  ┌────────────┐      ┌───────────┐  │
│  ┌──────────────────┐  │────────►│  │ gatekeeper │◄─────│   space   │  │
│  │ space manager    │  │         │  │ keys,      │ only │ agent,    │  │
│  ├──────────────────┤  │ forwards│  │ allowlist  │ exit │ code copy │  │
│  │ dispatcher       │  │◄───────►│  └─────┬──────┘      └───────────┘  │
│  └──────────────────┘  │         │        ▼ internet                   │
└────────────────────────┘         └─────────────────────────────────────┘
```

A space runs the same pair as the host: an OpenChamber server and OpenCode. The host talks only to the OpenChamber server in the space. Only three narrow points touch OpenCode directly, and they live in one small module so an OpenCode format change is a one-file edit: provider configuration that points at the gatekeeper, the login record for the short OpenAI token, and moving a chat to the host for the archive.

The space runs as a non-root user with a read-only root filesystem, all capabilities dropped, no privilege escalation, the engine's seccomp profile, a process limit, a memory limit with no extra swap, a capped log, no container-runtime socket, and no bind mounts. The order is create, verify, start: the place re-reads the real container state before the container ever runs and refuses to start it if anything differs. The owning list of flags and checks is `packages/web/server/lib/spaces/DOCUMENTATION.md`.

Host resources are part of the boundary. Without a memory limit and a log cap, an agent can exhaust the host's memory or fill its disk through its own output. Each place has a default space size in its settings; the user is not asked per space. Named Docker volumes have no size limit with the default driver. That is a known limit.

An internal Docker network alone still lets a space reach services that listen on all interfaces of the Docker host, through the bridge gateway. On native Linux that host is the user's machine. The Docker place creates the network with `gateway_mode_ipv4=isolated` and IPv6 off, which removes the host's address from the bridge, and verification fails on an engine that ignores the option. It needs Docker Engine 28 or newer. A permanent escape test starts a listener on the host and proves the space cannot connect. Every later place must pass the same test.

### The place contract

Eight operations. Everything else is written once on top of them.

| Operation | Meaning |
|---|---|
| check | Can this place be used, and what can it really do |
| create | Internal network, gatekeeper, space, all labelled |
| list | Find our spaces by label |
| exec | Run a command inside the space or the gatekeeper |
| exec argv | The argv that runs a command in the space with its input and output attached, for a caller that starts the process itself, such as git pushing code in over `ext::`. Checked like `exec` before it is handed out |
| connect | Give the host a channel to the server inside the space |
| stop, start, remove | |
| verify | Re-inspect a created container against the requested hardening |

`exec` is the control channel. Code transfer, grant delivery, token refresh, and repair all use it. The space's network cannot see it.

Capabilities are probed, never declared. A place proves it restricts the network by a real attempt to get out.

Implementations call the system CLI from the server: `docker`, `docker` with an SSH target, `kubectl` with an explicit context and namespace on every call, and `container`. The SSH variant uses the system `ssh` with the user's keys and config. It needs key authentication and leaves the Electron SSH manager untouched. Follow the tunnel provider registry in `packages/web/server/lib/tunnels/` as the pattern for the contract, and the child-process rules in the `desktop-shell` skill for every spawn.

The runtime's labels are the single source of truth about spaces. The host keeps no state file for them. The host stores place settings, names of secret sources, and archived chats. Service refs under `refs/openchamber/` in the user's repository are allowed, because the start snapshot must survive git's garbage collection to remain the base of the result patch.

### Versions

The base image is a public image pinned by digest, independent of OpenChamber releases. It needs Node on glibc, because both terminal libraries ship prebuilt glibc binaries. Stage 0 used `node:22-bookworm`.

The place fills a tools volume from a trusted one-shot container that can reach the npm registry, and mounts it read-only into spaces. The volume holds the host's OpenChamber server version, a matching OpenCode, and OpenCode's plugin package, so a space downloads nothing to start. The server refuses to start without OpenCode beside it. A filled volume never changes. Other content means another volume, so a running space keeps the programs it started with. Measured in stage 1b: a fill takes about 36 seconds once per tools content, 438 MB on disk, 2.3 seconds from create to a healthy server, about 370 MiB of memory per idle space, most of it OpenCode.

OpenCode itself runs without the plugin package. A project's own plugins, under `.opencode/plugin` or `.opencode/plugins` since OpenCode 2, import it, and a link to the package above the project directories is what lets them load. Without it OpenCode 2.0.15 marks such a plugin failed at once and downloads nothing. OpenCode 1 behaved differently: its tool listing waited for a background install of the package, 131 seconds with no network, and the same link removed the wait. `NODE_PATH` did not help there. Stage 1b also set `npm_config_fetch_retries=0` for that wait; stage 2 removed that variable, because the corridor refuses an unallowed request at once and npm does not retry a refusal.

Run the space with an init process and `openchamber serve --foreground`. Without them the container cannot stop cleanly.

No new release artifact. When the host updates, a stopped space moves to the new tools at its next start: the place makes its container again on the new volume, and the space's files stay in its own volumes. A running space is never touched. Moving a running space when the agent finishes its turn needs session activity, which only the dispatcher stage knows, so it is not built yet.

A development build cannot reuse the registry install, because same-numbered local packages differ from the published ones. The place installs packed tarballs of the local `web` and `sdk` packages instead, with an npm override so that the local `sdk` wins everywhere. Deciding that a host is a development build is wiring and not built yet. Nothing delivers a server bundle today: the SSH manager's `uploadBundleOverSsh` option is stored but never read.

### Code in and out

Git talks to git over the control channel. No network, ports, archives, or shared folders.

The host always drives. Exact command sequences, timings, and the hostile-container results are in [stage-0/e4-git-over-exec.md](stage-0/e4-git-over-exec.md).

- Inside the space: a plain non-bare repository at the space path. The host pushes only to `refs/openchamber/*` (`base`, `start-index`, `start`), never to `refs/heads/*`.
- In: send the current snapshot first and the history in the background. A push cannot deepen a shallow receiver, so the history goes to a side bare repository inside the space, followed by a local unshallow there. Uncommitted changes travel as two snapshot commits built from a copy of the index with the user's normal git config, so the working tree, the index, and the global ignore file are respected and untouched. They unfold in the space as staged and unstaged changes. Author name and email travel. Signing keys stay on the host.
- Untracked files that no ignore rule covers do travel. The create dialog lists the files that travel with uncommitted changes before the user confirms.
- Out: snapshot everything in the space. Fetch into a throwaway quarantine repository first, under a size cap and a timeout that the host enforces itself, because git has neither. Then promote the result into `refs/openchamber/spaces/<id>/result` with object checks, no tags, no submodule recursion, and an empty refmap. A killed fetch leaves its partial pack in the throwaway repository, and the process left inside the space needs its own clean-up.
- The snapshot inside, as built in stage 3b: the agent's HEAD, plus one commit on top made from a copy of the index when anything is uncommitted. The agent's working tree and index stay as they are.
- The fetch into the quarantine uses `--update-shallow`, and the promote into the user's repository does not. Measured by the maintainer's probe on three machines: while the space's repository is still shallow, before its history arrived or after that failed, a fetch without the option prints a warning and exits 0 without writing the ref. A space that forges its `shallow` file gets the same silent exit 0 from the promote, and the user's repository stays complete. So after each fetch the host reads the ref itself, and a missing ref is a failure. Exit code 0 is never trusted.
- The fetch takes exactly the commit the snapshot inside says it made, which the snapshot reports on a channel of its own. A space can move its own ref between the two, and a reviewer did: the host delivered one commit while warning about another.
- The size cap on the transfer is not enough: 1.5 GB of zeros travelled as a 1.4 MB pack. Before anything is promoted, the host also sizes what the result would write once inflated, and every new file in its history, without inflating anything, and bounds the number of changed paths and new objects. It does that in the quarantine, which sees the start through its alternates, so an oversized result never enters the user's repository. Before an apply as uncommitted changes the host also bounds the folders the changed paths pass through, and how deep they lie in all, because a patch pays for each: a result of a few hundred objects can name millions of them, and the branch holds such work.
- Two things of the agent's do not arrive whole, and neither is refused: a repository it made inside its project travels as a gitlink with no commits behind it, and a conflicted merge travels as content with its markers. Code out reports both to the caller, which warns before the user applies.
- The host builds the patch from the two fetched trees, with git's plumbing, which ignores the user's diff settings such as `diff.noprefix` and `diff.relative`. The space never supplies patch text. Apply at the top level of the work tree with a plain dry run followed by a plain apply, both with binary support and whitespace checks off, so a user's `apply.whitespace=fix` cannot change what is written. Never three-way, never with the index, never with unsafe paths. The three-way mode fails on a working tree with unstaged edits.
- What gets applied is what the host fetched, whatever the screen in the space showed.
- The project's existing worktree setup commands run in the space after code arrives; stage 5 runs them.
- First release limits, each with a warning at creation: submodules stay empty, Git LFS files arrive as pointers.

### Gatekeeper

The space sits on an internal network whose only other member is the gatekeeper.

On Docker the gatekeeper runs no DNS server. Measured in stage 2 on Engine 29.2.1: the embedded DNS resolves the gatekeeper's network alias from inside the space, and public names still do not resolve there. So the space resolves container aliases only, and the gatekeeper resolves a public name itself when it opens a tunnel. A place where alias resolution on a host-only network does not work, such as Apple `container`, needs the gatekeeper to resolve for the space, and brings that with it.

- **Corridor.** A CONNECT tunnel to allowed domains. The gatekeeper sees the destination only.
- **Window.** Reverse-proxy mode for services that need a secret. The tool in the space talks to the gatekeeper, which adds the secret and forwards over TLS. OpenCode's provider base URL, git's URL rewrite, and npm's registry setting point at it. No certificates are installed in the space and no TLS is intercepted.
- One gatekeeper per space. Secrets live in its memory only, never in container settings, labels, env, or on disk. After a machine restart the space shows "needs access" and the user re-grants in one click.
- The manager changes grants and the allowlist through `exec`, live, without a restart.
- The journal records destination and decision for every attempt, without paths or bodies. The UI reads it for blocked attempts and for "where did the agent go".
- Presets use exact domains. Tell the user in the grant dialog to prefer narrowly scoped tokens, because a git push grant reaches every repository the token reaches.

Stage 0 proved the window and the corridor with fake keys and a fake model server. Details and the working `opencode.json` are in [stage-0/e3-model-window-and-short-token.md](stage-0/e3-model-window-and-short-token.md).

- The window sets the secret header per provider: `Authorization` for OpenAI-style APIs, `x-api-key` for Anthropic. With `options.baseURL` and a dummy `options.apiKey` in the space's provider config and no stored auth entry, OpenCode's built-in auth plugins stay out of the way.
- Space environment, as stage 2 built it: `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY` and `http_proxy` for the corridor, `NO_PROXY` and `no_proxy` naming the gatekeeper, `localhost` and `127.0.0.1`, `NODE_USE_ENV_PROXY=1` so the agent's Node scripts use the proxy, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, and `OPENCHAMBER_RELAY_HOST=off` so a space never hosts the relay. Tools that ignore the proxy, such as ssh, fail because no route exists. Three things were measured and each of them decided a line above. curl 7.88.1 ignores an uppercase `HTTP_PROXY` on purpose, so the lowercase spelling is not optional. curl and Node both send loopback traffic to the proxy, so loopback must be in `NO_PROXY` or the host's own health check inside a space goes to the corridor. Node 22 ignores proxy variables entirely without `NODE_USE_ENV_PROXY=1`.
- `npm_config_fetch_retries=0` is gone, which answers the question stage 1b left. Measured with `npm view opencode-ai version`, OpenCode 1's package name at the time, from a space-like container: with no route at all, 70 seconds; through a corridor that answers an immediate 403, 0.3 seconds with npm's default retry settings, because npm does not retry a 403. The agent's own `npm install` has its retries back.
- Short OpenAI token: the record is an `oauth` entry with the real short `access`, a dummy `refresh`, and the real `expires`. Stage 0 proved this with OpenCode 1.18.31: the manager pushed a fresh record over `exec` with `PUT /auth/openai`, it took effect on the next request, an expired token gave a clean "Token refresh failed" once with no retry loop, and a space with no OpenAI record when its project instance loaded needed that instance disposed after the first push. None of that carries over as written. OpenCode 2.0.15 has no `PUT /auth/openai` and no instance dispose. It keeps logins as rows of a `credential` table in its SQLite database, and its routes under `/api/credential/` only relabel, activate or delete a stored login; a new one is stored only by the login flows under `/api/integration/`. How the manager puts the short token in, whether an update reaches a running session, and how an expired token behaves are unknown on OpenCode 2 until the stage that builds it measures them.
- What protects the user's login is that the long-lived refresh token never enters the space. That holds in both network modes. The gatekeeper refuses `auth.openai.com` on top of it, and what that refusal is worth depends on the mode: in allowlist mode the host is unreachable; in open mode it is only made harder, because the space reaches every public host on 443 and can go through a third-party intermediary, whose name is all the corridor sees. Measured in stage 2: refusing the name alone was not even a lock, because the space could reach the same host by its address, so the corridor takes names and refuses address targets in both modes.
- OpenCode 1 read the whole login store from `OPENCODE_AUTH_CONTENT`, which won over the file until restart. OpenCode 2.0.15 has no such variable. It does take a provider key from its environment, under the names its catalog lists, `OPENAI_API_KEY` among 218, and treats it as a login. So can a key inside `OPENCODE_CONFIG_CONTENT`. None of them belongs in a space: the hardening check allows only the variables the space is given and the base image's own, and the escape suite fails if OpenCode inside reports any login or its login table holds a row. Whether such a variable would win over a stored login is unknown.
- Read a turn's failure from session events. `opencode run --attach` exits 0 on a provider error.
- A space with an OpenAI browser login must leave `provider.openai.options.baseURL` unset. Whether the two conflict is unverified.

### Dispatcher, sessions, events

- A space's code lives at a path that is unique per space and identical on both sides, such as `/spaces/<id>/<repo>`. The UI treats it as one more project directory.
- The client addresses the space. The dispatcher never guesses. A request goes to a space only when its path starts with `/api/spaces/<id>/` and the id is in the manager's label-derived list. The dispatcher authenticates the user, strips the prefix, the user's cookies, bearer token, and URL token, adds the space's own token, and streams the rest untouched. It reads no directory, body, session id, or terminal id. Server-side recognition was rejected in stage 0: the terminal socket multiplexes all terminals, the dev tunnel names only a port, about ten route families carry the directory only in a body or carry only a session id, and with no directory the host silently falls back to the last opened one. See [stage-0/e2-dispatcher-recognition.md](stage-0/e2-dispatcher-recognition.md) for the inventory and the special cases.
- In the UI one pure function turns a directory into the prefix at call time, applied in the SDK fetch wrapper, in `runtimeFetch`, and in a helper for socket and asset URLs. Nothing is cached, which keeps it inside the runtime-switch rule. Every UI request already goes through `runtimeFetch`.
- Two server guards only reject. A prefixed request whose directory lies outside that space's root gets a 400. An unprefixed request whose directory lies under `/spaces/` gets a stable 4xx before the path gate and before the last-directory fallback. Both read the directory where the request carries it in the open, the query and the directory header; the dispatcher reads no body. The host's own directory gate refuses a space directory too, for the routes that pass a body through it; a body the OpenCode proxy forwards untouched is not read by anyone on the host.
- Session-keyed actions take the directory from the session record and fail without a server-confirmed one. The current-directory fallback in the session actions goes away once spaces exist.
- Host only, never prefixed: provider and auth pages, settings, GitHub, Linear, voice, guests, project routes. Refused across the boundary: moving a session, worktree and git-integrate actions, `/api/fs/serve`, and `/api/preview/proxy`. `/api/fs/raw` from a space is forwarded with `nosniff` and safe content types only. The server inside takes the space token as a password only, so the dispatcher logs in once per space and holds the session cookie; the token travels as a bearer nowhere.
- The new socket and asset paths must join the allowlists for the relay, URL-token auth, and the Electron realtime proxy, matched by shape as the guest surfaces are, or mobile fails silently. The socket forwarder presents the loopback origin to the server inside, as the relay host does to the host, and never the client's.
- The place writes one space token at create, into a file under the space's HOME, and the server inside reads it only when it starts. The host keeps no copy on disk: it reads the token back over `exec` at the first request to that space and keeps it in memory for the life of the process. The host does not issue a fresh token at its own start: that would need a restart of the server inside, which interrupts the agent, and buys nothing, because the agent can read the token anyway; it protects the server from others and never from the agent. Rotation belongs with the repair actions, where restarting the server inside is what the user asked for. Responses from a space cannot set cookies, and files from a space never render as pages under the app's origin.
- The session list is the host list plus each reachable space's list, with a completeness mark per space. An unreachable space keeps its last known sessions, marked stale. Missing answers never mean deletion. The merge treats a space's list and events as untrusted: it drops any record whose directory lies outside that space's root and never lets a space overwrite a host session id.
- Verified with OpenCode 2.0.15: a session created with `location.directory` set to `/spaces/<id>/<repo>` reports exactly that directory. `?directory=` on session create is ignored and the session lands in the space's HOME. A directory reached through a symlink comes back as the link path, not the real path, so OpenCode normalises nothing. OpenCode 1.18.31 resolved the link. So the host hands OpenCode real paths only, which is now the whole defence, and compares what comes back against the real space root.
- Each space has its own event connection with its own state, attached after the v2 event translation layer, with exponential backoff. Its events enter the host's hub marked with the space's id, and only the consumers that asked for space events see them: the browser streams and the status watcher do, and a consumer that acts on the host's OpenCode by directory does not. After a gap the client re-reads that one space.
- Activity dots, unread marks, and notifications work for space sessions because their events feed the same watcher. At startup the host asks spaces for their state.
- The idle timer lives inside the space, so it works while OpenChamber is closed.

### Skills to load

`openchamber-change-discipline` always. `isolated-space-boundary` for trust-boundary changes in hardening, networks and gatekeeper policy, exec and lifecycle, grants and credentials, code transfer and apply, dispatcher isolation, preview content, or protection tests. `ui-api-decoupling`, `relay-transport`, and `sync-state-invariants` for the dispatcher, sessions, and events. `desktop-shell` for every child process. `theme-system`, `locale-ui-patterns`, and `settings-ui-patterns` for UI. All user-facing text goes through the locale system in every supported language.

## Later

Project-defined images, submodules, sandbox services (a different trust model because code and grants go to a third party), Copilot through the gatekeeper, bringing new host changes into a running space.
