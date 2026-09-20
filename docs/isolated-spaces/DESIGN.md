# Isolated spaces: design

Status: design agreed on 2026-09-19. [STAGES.md](STAGES.md) says what is built. Owner and reviewer: Yulia.

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
3. Network is the user's choice per space: allowlist or open internet. In both modes the gatekeeper blocks the user's private networks, link-local ranges, and cloud metadata addresses.
4. Grants can be given at creation and during work. They cannot be taken back. They disappear with the space.
5. OpenChamber stores no secret values. It remembers only the name of the host source (an env variable, a file, the `gh` token) so "same as last time" is one click.
6. The agent in a space asks for no tool permissions by default. The existing per-session switch stays. A grant dialog says that the agent can use the grant without confirmation.
7. Apply in two ways: as a branch with the agent's commits, or as uncommitted changes. If the uncommitted variant does not apply cleanly, touch nothing and offer the branch.
8. The apply dialog has "delete the space afterwards", on by default. Discard always deletes, after confirmation.
9. The chat stays as a read-only archive after apply and after discard, until the user deletes it.
10. Closing OpenChamber does not stop a space. OpenChamber can restart a stuck OpenCode inside it.
11. A space stops itself after several idle hours. The threshold is a setting and the behaviour can be turned off. Stopping keeps files.
12. The user never needs a terminal to manage containers. OpenChamber shows and manages only what it created.
13. Model login. API-key providers, including coding plans that issue a key, go through the gatekeeper. OpenAI browser login works by handing over only the short-lived access token while the host stays the only refresher. Copilot's token is long-lived, so its dialog carries a stronger warning. Claude Pro/Max browser login is unavailable because OpenCode removed it.
14. Previewing a dev server that runs inside a space is part of the first release.
15. Default image first. Project-defined images (`devcontainer.json`, Dockerfile) are a later stage.
16. Surfaces: web, desktop, mobile. VS Code never gets this feature. The entry point is absent there on purpose, and that must be visible in code.

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

Seven operations. Everything else is written once on top of them.

| Operation | Meaning |
|---|---|
| check | Can this place be used, and what can it really do |
| create | Internal network, gatekeeper, space, all labelled |
| list | Find our spaces by label |
| exec | Run a command inside the space or the gatekeeper |
| connect | Give the host a channel to the server inside the space |
| stop, start, remove | |
| verify | Re-inspect a created container against the requested hardening |

`exec` is the control channel. Code transfer, grant delivery, token refresh, and repair all use it. The space's network cannot see it.

Capabilities are probed, never declared. A place proves it restricts the network by a real attempt to get out.

Implementations call the system CLI from the server: `docker`, `docker` with an SSH target, `kubectl` with an explicit context and namespace on every call, and `container`. The SSH variant uses the system `ssh` with the user's keys and config. It needs key authentication and leaves the Electron SSH manager untouched. Follow the tunnel provider registry in `packages/web/server/lib/tunnels/` as the pattern for the contract, and the child-process rules in the `desktop-shell` skill for every spawn.

The runtime's labels are the single source of truth about spaces. The host keeps no state file for them. The host stores place settings, names of secret sources, and archived chats. Service refs under `refs/openchamber/` in the user's repository are allowed, because the start snapshot must survive git's garbage collection to remain the base of the result patch.

### Versions

The base image is a public image pinned by digest, independent of OpenChamber releases. It needs Node on glibc, because both terminal libraries ship prebuilt glibc binaries. Stage 0 used `node:22-bookworm`.

The manager fills a tools volume from a trusted one-shot container that can reach the npm registry, and mounts it read-only into spaces. The volume holds the host's OpenChamber server version, a matching OpenCode, and OpenCode's first-start plugin, so a space downloads nothing to start. The server refuses to start without OpenCode beside it. Measured in stage 0: install about 27 seconds once per place, space start 1.2 seconds, 377 MB on disk, about 0.5 GB of memory per idle space, most of it OpenCode.

Run the space with an init process and `openchamber serve --foreground`. Without them the container cannot stop cleanly.

No new release artifact. When the host updates, spaces pick up the new version at their next start, or when the agent finishes its turn. A busy agent is never interrupted for an update.

A development build cannot reuse the registry install, because same-numbered local packages differ from the published ones. Stage 1 packs the local `web` and `sdk` packages and installs those tarballs in the filler container. Nothing delivers a server bundle today: the SSH manager's `uploadBundleOverSsh` option is stored but never read.

### Code in and out

Git talks to git over the control channel. No network, ports, archives, or shared folders.

The host always drives. Exact command sequences, timings, and the hostile-container results are in [stage-0/e4-git-over-exec.md](stage-0/e4-git-over-exec.md).

- Inside the space: a plain non-bare repository at the space path. The host pushes only to `refs/openchamber/*` (`base`, `start-index`, `start`), never to `refs/heads/*`.
- In: send the current snapshot first and the history in the background. A push cannot deepen a shallow receiver, so the history goes to a side bare repository inside the space, followed by a local unshallow there. Uncommitted changes travel as two snapshot commits built from a copy of the index with the user's normal git config, so the working tree, the index, and the global ignore file are respected and untouched. They unfold in the space as staged and unstaged changes. Author name and email travel. Signing keys stay on the host.
- Untracked files that no ignore rule covers do travel. The create dialog lists the files that travel with uncommitted changes before the user confirms.
- Out: snapshot everything in the space. Fetch into a throwaway quarantine repository first, under a size cap and a timeout that the host enforces itself, because git has neither. Then promote the result into `refs/openchamber/spaces/<id>/result` with object checks, no tags, no submodule recursion, and an empty refmap. A killed fetch leaves its partial pack in the throwaway repository, and the process left inside the space needs its own clean-up.
- The host builds the patch from the two fetched trees. The space never supplies patch text. Apply with a plain dry run followed by a plain apply, both with binary support. The three-way mode fails on a working tree with unstaged edits.
- What gets applied is what the host fetched, whatever the screen in the space showed.
- The project's existing worktree setup commands run in the space after code arrives.
- First release limits, each with a warning at creation: submodules stay empty, Git LFS files arrive as pointers.

### Gatekeeper

The space sits on an internal network whose only other member is the gatekeeper. The gatekeeper also resolves DNS for the space.

- **Corridor.** A CONNECT tunnel to allowed domains. The gatekeeper sees the destination only.
- **Window.** Reverse-proxy mode for services that need a secret. The tool in the space talks to the gatekeeper, which adds the secret and forwards over TLS. OpenCode's provider base URL, git's URL rewrite, and npm's registry setting point at it. No certificates are installed in the space and no TLS is intercepted.
- One gatekeeper per space. Secrets live in its memory only, never in container settings, labels, env, or on disk. After a machine restart the space shows "needs access" and the user re-grants in one click.
- The manager changes grants and the allowlist through `exec`, live, without a restart.
- The journal records destination and decision for every attempt, without paths or bodies. The UI reads it for blocked attempts and for "where did the agent go".
- Presets use exact domains. Tell the user in the grant dialog to prefer narrowly scoped tokens, because a git push grant reaches every repository the token reaches.

Stage 0 proved the window and the corridor with fake keys and a fake model server. Details and the working `opencode.json` are in [stage-0/e3-model-window-and-short-token.md](stage-0/e3-model-window-and-short-token.md).

- The window sets the secret header per provider: `Authorization` for OpenAI-style APIs, `x-api-key` for Anthropic. With `options.baseURL` and a dummy `options.apiKey` in the space's provider config and no stored auth entry, OpenCode's built-in auth plugins stay out of the way.
- Space environment: `HTTPS_PROXY` and `HTTP_PROXY` for the corridor, `NO_PROXY` naming the gatekeeper so window traffic skips the corridor, `NODE_USE_ENV_PROXY=1` so the agent's Node scripts use the proxy, `OPENCODE_DISABLE_MODELS_FETCH=1`, and `OPENCODE_DISABLE_AUTOUPDATE=1`. Tools that ignore the proxy, such as ssh, fail because no route exists.
- Short OpenAI token: the record is an `oauth` entry with the real short `access`, a dummy `refresh`, and the real `expires`. The manager pushes a fresh one over `exec` with `PUT /auth/openai` on the OpenCode server inside the space, and it takes effect on the next request. If the space had no OpenAI record when its project instance loaded, dispose that instance after the first push. Keep `auth.openai.com` off every allowlist so a space can never rotate the user's refresh token. When the token expires the user sees a clean "Token refresh failed", once, with no retry loop.
- Never set `OPENCODE_AUTH_CONTENT` in a space. It wins over the file until restart.
- Read a turn's failure from session events. `opencode run --attach` exits 0 on a provider error.
- A space with an OpenAI browser login must leave `provider.openai.options.baseURL` unset. Whether the two conflict is unverified.

### Dispatcher, sessions, events

- A space's code lives at a path that is unique per space and identical on both sides, such as `/spaces/<id>/<repo>`. The UI treats it as one more project directory.
- The client addresses the space. The dispatcher never guesses. A request goes to a space only when its path starts with `/api/spaces/<id>/` and the id is in the manager's label-derived list. The dispatcher authenticates the user, strips the prefix, the user's cookies, bearer token, and URL token, adds the space's own token, and streams the rest untouched. It reads no directory, body, session id, or terminal id. Server-side recognition was rejected in stage 0: the terminal socket multiplexes all terminals, the dev tunnel names only a port, about ten route families carry the directory only in a body or carry only a session id, and with no directory the host silently falls back to the last opened one. See [stage-0/e2-dispatcher-recognition.md](stage-0/e2-dispatcher-recognition.md) for the inventory and the special cases.
- In the UI one pure function turns a directory into the prefix at call time, applied in the SDK fetch wrapper, in `runtimeFetch`, and in a helper for socket and asset URLs. Nothing is cached, which keeps it inside the runtime-switch rule. Every UI request already goes through `runtimeFetch`.
- Two server guards only reject. A prefixed request whose directory lies outside that space's root gets a 400. An unprefixed request whose directory lies under `/spaces/` gets a stable 4xx before the path gate and before the last-directory fallback.
- Session-keyed actions take the directory from the session record and fail without a server-confirmed one. The current-directory fallback in the session actions goes away once spaces exist.
- Host only, never prefixed: provider and auth pages, settings, GitHub, Linear, voice, guests, project routes. Refused across the boundary: moving a session, worktree and git-integrate actions, `/api/fs/serve`, and `/api/preview/proxy`. `/api/fs/raw` from a space is forwarded with `nosniff` and safe content types only.
- The new socket and asset paths must join the exact-match allowlists for the relay, URL-token auth, and the Electron realtime proxy, or mobile fails silently.
- The manager issues a fresh space token over `exec` at every host start. Responses from a space cannot set cookies, and files from a space never render as pages under the app's origin.
- The session list is the host list plus each reachable space's list, with a completeness mark per space. An unreachable space keeps its last known sessions, marked stale. Missing answers never mean deletion. The merge treats a space's list and events as untrusted: it drops any record whose directory lies outside that space's root and never lets a space overwrite a host session id.
- Unverified until stage 1: that OpenCode inside a space reports a session's directory exactly as the space path, without canonicalising it.
- Each space has its own event connection with its own state, attached after the v2 event translation layer, with exponential backoff. After a gap the client re-reads that one space.
- Activity dots, unread marks, and notifications work for space sessions because their events feed the same watcher. At startup the host asks spaces for their state.
- The idle timer lives inside the space, so it works while OpenChamber is closed.

### Skills to load

`openchamber-change-discipline` always. `ui-api-decoupling`, `relay-transport`, and `sync-state-invariants` for the dispatcher, sessions, and events. `desktop-shell` for every child process. `theme-system`, `locale-ui-patterns`, and `settings-ui-patterns` for UI. All user-facing text goes through the locale system in every supported language.

## Later

Project-defined images, submodules, sandbox services (a different trust model because code and grants go to a third party), Copilot through the gatekeeper, bringing new host changes into a running space.
