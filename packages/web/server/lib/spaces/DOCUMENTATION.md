# Spaces module

Design, words, and product decisions are in [docs/isolated-spaces/DESIGN.md](../../../../../docs/isolated-spaces/DESIGN.md). Read it first. Stages are in `STAGES.md` next to it, test rules in `TESTING.md`.

This is stage 2. Nothing imports the module yet: no routes, no settings, no UI. A space has one way out, its own gatekeeper, and nothing the host has not allowed passes through it.

## What the module owns

Creating, finding, stopping, starting, and removing isolated spaces on a place, and proving that a created space has the restrictions it was asked for. Since stage 1b a space runs an OpenChamber server and OpenCode, started from a tools volume that is mounted read-only. Since stage 2 every space has a gatekeeper container of its own: the corridor a space reaches the internet through, the window that adds a secret the space never sees, and the journal of what was allowed and refused.

- `manager.js`: `createSpaceManager({ registry, now })`. Generates the space id, builds the spec with the default memory limit of 4 GiB, calls the place. Keeps no state file and no cache. Every answer is read from the place at call time.
- `layout.js`: what a space looks like from the inside, for every place. User, HOME, work path, tools path, the port and the token file of the server inside, the space environment, and the space command.
- `space-server.js`: `createSpaceServerChannel({ exec, wait, now })`. Everything the host does to the server inside, written once on top of `exec`: store and read the token, link the OpenCode plugin, send an HTTP request, wait until the server is ready.
- `gatekeeper-channel.js`: `createGatekeeperChannel({ exec, wait, now })`. The same for the gatekeeper: write its program, wait until its corridor accepts, set the network mode and the allowlist, add a grant, read the journal. It also exports `GATEKEEPER_PROGRAM`, the text of the program file.
- `gatekeeper-program.cjs`: the program that runs inside a gatekeeper. One self-contained CommonJS script on Node's standard library, run by the container and by its own unit test with the same arguments.
- `exec-http.js`: the pieces the two channels share, and the only place where the dangerous details live: the curl argv, a request as a curl config, and the parser for an answer that came out of a container.
- `tools.js`: tools sources and the content key. `createRegistryToolsSource`, `createPackedToolsSource`, `readHostToolVersions`, `toolsContentKey`.
- `tools-filler.js`: the fixed program of the filler container and the framing of its stdin.
- `tools-pack.js`: `packLocalTools` packs the local `web` and `sdk` packages of a checkout for a development build. Nothing calls it yet except tests. Deciding when a host is a development build is wiring for a later stage.
- `places/registry.js`: place registry, same pattern as the tunnel provider registry. Sealed after boot.
- `places/docker.js`: the local Docker place. `createDockerPlace({ runCommand, dockerPath, owner, toolsSource, wait, now })`. `wait` is the pause used by rollbacks and by the readiness wait. `now` stamps the tools labels and is the clock of the readiness wait. Both are injectable so tests do not sleep.
- `places/docker-tools.js`: the tools volume of the Docker place. Ensure, fill, fill rollback, pruning.
- `places/docker-engine.js`: how both of them call the docker CLI. Run, inspect, find by label, remove.
- `hardening.js`: the `docker create` argv for a space and for its gatekeeper, the argv for both networks and for the three one-shot containers, and the pure checkers that compare `docker inspect` output with them.
- `labels.js`: label keys, resource names, space ids, tools keys, label parsing.
- `run-command.js`: the only file that starts a process.
- `errors.js`: `SpaceError` with a `code`.
- Test support, never imported by product code: `places/contract-suite.js`, `places/escape-suite.js`, `places/memory-place.js`, `places/fake-docker.js`, `places/docker-live-support.js`.

## Place contract

A place has a non-empty `id` and these operations. The registry rejects a place that lacks one.

| Operation | Contract |
|---|---|
| `check()` | Never rejects for an expected problem. Resolves `{ available: true, version, os, arch, hostIsolation }` or `{ available: false, code, message }`. The message names what the user must fix. `hostIsolation: false` means a space on this place could reach services that listen on the place's host. It is a capability, and the manager decides later what to do with it. |
| `create(spec)` | `spec` is `{ id, name, project, created, memoryBytes }`. Resolves when the gatekeeper runs with its corridor accepting connections, the space runs, both verify clean, and the server inside the space reports OpenCode ready. Rejects with code `space_name_taken` when the id is in use. A rejected create has rolled back. `details.rollbackFailures` lists what it could not remove, and `details.uncertain: true` means a step was interrupted and the place may still finish it, so the caller should show the spaces list. |
| `list()` | Resolves `[{ id, name, project, created, state, orphans, damaged, missing }]`. `state` is the state of the space container: `running`, `exited`, or `missing`, because that is what `start`, `stop` and `remove` act on. `orphans` lists `{ kind, name }` resources whose space container is gone. `damaged: true` means the container exists and `missing` names what the space needs and does not have right now: a lost network or volume, or a gatekeeper that is absent, or one that is not running while the space is. `list` only reads and repairs nothing. A place failure rejects. It never resolves an empty list instead. |
| `exec(spaceId, argv, { stdin, timeoutMs, target })` | Runs `argv` as the space user, in the space or, with `target: 'gatekeeper'`, in its gatekeeper. Resolves `{ code, stdout, stderr }` for any exit code of the command. Any other target is rejected with `invalid_exec_target`. |
| `stop(spaceId)`, `start(spaceId)` | Keep files. `stop` stops the space and then its gatekeeper; `start` starts the gatekeeper, waits for its corridor, and only then the space. A running space is left alone. `start` resolves when the server inside is ready again. A stopped space moves to the current tools first, see "New tools at the next start". `start` is the only operation that repairs a half-done move. |
| `remove(spaceId)` | Resolves `{ removed, failed }`. Missing resources count as removed. Removing an unknown space resolves with both lists empty. |
| `verify(spaceId)` | Resolves the list of `{ check, message }` violations of the space and of its gatekeeper. A gatekeeper that is absent is the violation `gatekeeper_missing`, and every check of the gatekeeper's own is named `gatekeeper_*`. Empty means verified. |

`connect` from DESIGN.md arrives with the dispatcher stage. Stage 2 talks to the server inside and to the gatekeeper through `exec` only, see "The exec channel" and "The gatekeeper".

The contract suite is fixed against being rewritten per place, not against a new stage. Stage 2 added three assertions to it and changed none: the gatekeeper target runs in a container of its own, which a hostname of its own shows and the absence of the space's work directory confirms; `exec` takes those two targets and rejects any other with `invalid_exec_target`; and the gatekeeper is gone after `remove`, which is checked against the container and not against the space record. From here on a place cannot host a space without a gatekeeper, so every later place is held to that too. `places/memory-place.js` has two containers for this reason, and the three assertions were each confirmed to fail against a place that fakes one.

A new place is done when `runPlaceContractSuite` and `runEscapeSuite` pass against it.

## Labels

Labels are the only record of a space. Every container, network, and volume carries all of them. Since stage 2 that includes the gatekeeper container and the outer network.

| Label | Value |
|---|---|
| `openchamber.space` | `true`. The marker. |
| `openchamber.space.id` | 12 lowercase hex characters from `crypto.randomBytes`. |
| `openchamber.space.role` | `space`, `gatekeeper`, `setup`, `network`, `outer-network`, or `volume`. |
| `openchamber.space.owner` | Installation id, passed in by the caller. Two installs that share a Docker daemon do not see or touch each other's spaces. |
| `openchamber.space.project` | First 16 hex characters of the sha256 of the project directory. |
| `openchamber.space.name` | Display name. |
| `openchamber.space.created` | ISO time. |

Resource names are `openchamber-space-<id>-<role>[-<suffix>]`.

Tools resources belong to an owner, not to a space. They carry the marker, the owner, a role of `tools`, `tools-fill`, or `tools-check`, the created time, and two labels of their own:

| Label | Value |
|---|---|
| `openchamber.space.tools.key` | The content key, 16 lowercase hex characters. |
| `openchamber.space.tools.description` | For people, such as `web 1.24.2, opencode 1.18.31` or `development build`. |

They have no space id. `parseSpaceLabels` therefore returns null for them, and `list` and `remove` of spaces pass them by. `parseToolsLabels` reads them.

Rules the Docker place keeps:

- Labels are read from `docker inspect` JSON. The `Labels` column of `docker ps` is one comma-joined string, and a display name may contain commas.
- A name proves nothing. `remove` and `list` find resources by label filter, then check marker, owner, and id again on the inspect result. `exec`, `stop`, `start`, and `verify` inspect the container first and refuse one without this owner's labels.
- `create` refuses when any of its names exists, because `docker volume create` succeeds silently on an existing volume and would adopt a stranger's data.

## Hardening

`buildSpaceCreateArgs`, `buildSpaceNetworkArgs`, and `findHardeningViolations` in `hardening.js` belong together, and so do `buildGatekeeperCreateArgs`, `buildGatekeeperNetworkArgs`, and `findGatekeeperHardeningViolations`. Change a pair together, and add an escape test for every new restriction. The environment and the command of both containers come from `layout.js`.

| Flag | Why |
|---|---|
| `--init` | Reaps zombies and forwards signals, so the container stops cleanly. |
| `--user 1000:1000` | The agent is never root. |
| `--read-only` | The agent cannot change the image's files. |
| `--tmpfs /tmp:rw,exec,nosuid,size=256m` | A writable scratch area with a size limit. `exec` stays on because tools unpack and run binaries there. |
| `--security-opt no-new-privileges` | setuid binaries such as `su` cannot raise privileges. It is the only security option, so the engine's seccomp and AppArmor defaults stay on. |
| `--cap-drop ALL` | No kernel capabilities, and none are added back. |
| `--pids-limit 512` | A fork bomb stays inside the space. |
| `--memory N --memory-swap N` | Equal values, so swap adds nothing. A process that takes more is killed and the space keeps running. |
| `--shm-size 64m` | `/dev/shm` is memory too. |
| `--ipc private --cgroupns private` | Asked for by name. The checker requires both, and a daemon configured with `default-cgroupns-mode: host` or `default-ipc-mode: shareable` would otherwise fail every create with nothing the user can act on. |
| `--log-driver local --log-opt max-size=10m --log-opt max-file=1 --log-opt compress=false` | The space's output lands in a file on the Docker host. Without a cap the agent can fill that disk. The `local` driver refuses `max-file=1` while compression is on. |
| `--network <space network>` | The only network is the space's own. Its only other member is the gatekeeper. |
| `--mount type=volume` twice | Work volume at `/spaces/<id>`, home volume at `/home/space` with `HOME` set. `type=volume` cannot turn into a bind mount, unlike `-v`. |
| `--mount type=volume,...,readonly` once | The tools volume at `/opt/openchamber-tools`. Read-only, because every space of this owner runs its programs from it. An agent that could write there would change what the next space runs. |
| `--env` twelve times | See "The server inside a space". Never the server password, never `OPENCODE_AUTH_CONTENT`, and never a grant's secret. |

The inner network is created with `--internal`, `--ipv6=false`, and `--opt com.docker.network.bridge.gateway_mode_ipv4=isolated`.

`--internal` alone is not enough. Measured on Docker 29.2.1: from a space on a plain internal network, a TCP connect to the network's gateway address reached a listener on the Docker host. With the isolated gateway mode the bridge has no address on the host, `docker network inspect` shows no `Gateway`, and the same connect fails. The option needs Docker Engine 28. The checker looks at the option and at the missing gateway address, so an engine that ignores the option fails verification and `create` rolls back. `check()` reports such an engine with `hostIsolation: false`.

Never present: bind mounts, `--volumes-from`, the runtime socket, `--privileged`, extra security options, shared namespaces, sysctls, another runtime than `runc`, devices, published ports, a second tmpfs, `OPENCHAMBER_UI_PASSWORD` or `OPENCODE_AUTH_CONTENT` in the container environment. The checker reports each of these. For the namespace modes it accepts `''` and `'private'`, which is what this engine reports for a correct container: `''` for pid, uts, and userns, `'private'` for ipc and cgroupns.

The checker demands that every mount is a volume whose name starts with this space's prefix. The mount at `/opt/openchamber-tools` is the one exception, and it has rules of its own:

- There is exactly one mount at that path. Check `tools_mount`.
- It is a volume named `openchamber-tools-<this owner>-<key>`. Check `tools_mount`.
- It is read-only, `RW === false` in the inspect result. Check `tools_read_only`.
- The inspected volume carries the marker, this owner, the role `tools`, and the key that its name holds. Check `tools_labels`. A volume with a matching name and no labels fails here.

The exception goes by destination. A tools volume mounted anywhere else, read-only or not, is reported by `mounts` like any foreign volume. `verify` does not ask for the current key, because a running space keeps the volume it started with.

`create` runs `docker create`, then `verify`, then `docker start`. A container that fails the check never runs. Confirmed on Docker 29.2.1: `docker inspect` of a created container that never started already has every field the checker reads, including `NetworkSettings.Networks` and `Mounts`. The Docker place therefore has nothing left to check after the start.

Every create makes the space, the `setup` one-shot, and the `tools-check` one-shot. A new tools volume adds the filler. The `setup` one-shot runs as root with `--network none`, `--cap-drop ALL --cap-add CHOWN`, a 128 MiB memory limit, the same log cap, and the fixed argv `/bin/chown 1000:1000 <mount points>`, then removes itself. Fresh volumes belong to root, and the space user cannot fix that itself.

Do not add `--workdir /spaces/<id>`. Docker then resets the ownership of that empty volume to root, and the space user cannot write to its own work directory. The escape suite's positive control catches this.

Known limit: a named volume of the default driver has no size limit. A space can fill the disk of the Docker host through its work or home volume. Nothing here prevents that.

## Tools volume

A space downloads nothing to start. Its programs come from a tools volume: one volume per owner and per tools content, filled once by a trusted one-shot container that can reach the npm registry, then mounted read-only into every space of that owner.

The volume is a plain npm project at `/opt/openchamber-tools`, with `package.json`, `node_modules`, and the binaries in `node_modules/.bin`. It is not a global install. A development build needs the local `@openchamber/sdk` tarball to win over the published package with the same version number. npm `overrides` in a project `package.json` does that. A `-g` install would pull the published sdk as a dependency of `web`.

Contents: `@openchamber/web`, `opencode-ai`, and `@opencode-ai/plugin` at the version of `opencode-ai`.

### Sources and the key

The Docker place gets its source at construction, `createDockerPlace({ ..., toolsSource })`.

- `createRegistryToolsSource({ webVersion, openCodeVersion })` asks the registry for exact versions of the three packages. `readHostToolVersions()` reads them from `packages/web/package.json`: the version of `web`, and the version of its `@opencode-ai/sdk` dependency for OpenCode. A range or a URL is rejected.
- `createPackedToolsSource({ webTarballPath, sdkTarballPath, openCodeVersion })` is a development build. Its `package.json` uses `file:` dependencies for both tarballs and `"overrides": { "@openchamber/sdk": "$@openchamber/sdk" }`, so every sdk in the tree is the local one. The tarballs are read and hashed once, when the source is made.
- Both take an optional `revision`. It changes the key and nothing that gets installed, for the day the same packages must be filled again.

The place accepts only an object that one of the two functions made.

The key is the first 16 hex characters of a sha256 over the source's canonical description, the base image reference, and the sha256 of the filler program. For the registry the description holds the exact versions, for a packed source the sha256 of each tarball plus the OpenCode versions.

The volume is named `openchamber-tools-<owner>-<key>`. Docker cannot change the labels of a volume after it made it, so "the fill finished" cannot be a label. The filler writes `/opt/openchamber-tools/.filled`, holding the key, as its last step.

A filled volume is never changed again. New content means a new key and a new volume.

Known limit: only the three named packages are pinned. Their own dependencies are still ranges, and no lock file travels with the source. Two fills of the same key, on two machines or on two days, can differ in a transitive package.

### ensure

`create` and `start` call `ensure` of `places/docker-tools.js`:

1. Inspect the volume name. If it exists, it must carry the marker, this owner, the role `tools`, and this key. Otherwise the call rejects with `tools_volume_not_ours`. `docker volume create` succeeds silently on an existing name, so a stranger's volume would otherwise be adopted.
2. Remove one-shot containers of this key that a killed CLI left behind. They would block the container name.
3. If the volume exists, read the marker with the `tools-check` one-shot: no network, the volume read-only, the space user, the hardening of the `setup` one-shot. Its fixed command is `/bin/sh -c '[ -f "$1" ] || exit 42; /bin/cat "$1"' sh <marker>`. Exit code 42, and only 42, means there is no marker: the fill was interrupted, the volume is ours by label, so it is removed and filled again. Exit code 0 with this key means filled. Exit code 0 with anything else, an empty marker included, means the content cannot be trusted: the volume is removed and filled again. Docker refuses the removal while any container mounts the volume. Then the call rejects with `tools_marker_mismatch`, and the message says in plain words what frees it: apply or discard the work in the spaces that were made with these tools and remove them. It names no docker command, because the user never needs a terminal. A restart of those spaces would not help, because a stopped container still holds its volumes. Every other exit code rejects. Measured with CLI 29.3.0: a docker CLI that cannot reach the daemon exits with 1, the same code `cat` uses for a missing file. With a plain `cat` a daemon hiccup would have removed a filled volume.
4. If the volume is absent: create it with labels, run the filler, read the marker once more as the space user.
5. After a new fill, try to remove this owner's other tools volumes. Docker refuses a volume that a container still mounts. That refusal means a space still runs on it, and it stays. Pruning never fails the call.

Two creates in one process share one `ensure` run, so one key is never filled twice at once. A failed fill does not stick: the next call tries again.

Known limit: two OpenChamber processes with the same owner are not coordinated. Step 2 of one would remove the running filler of the other.

### The filler

| Flag | Why |
|---|---|
| `--rm --interactive` | It removes itself, and its input arrives on stdin. |
| `--init`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, `--ipc private --cgroupns private`, the log cap | The same as a space. |
| `--user 0:0` | Root owns the fresh volume, so no chown and no capability is needed. Measured: `npm install` works as root with every capability dropped. npm writes files with mode 644 and 755, so uid 1000 can read and run them. |
| `--network bridge` | The one container here with a way out. It needs the npm registry. |
| `--tmpfs /tmp:rw,exec,nosuid,size=1g` | The npm cache and the tarballs live here and vanish with the container. Measured: the cache of one fill is 444 MB. Kept out of the volume, that halves its size. |
| `--memory 2g --memory-swap 2g` | A tmpfs counts as memory. |
| `--env HOME=/tmp` | npm keeps its logs under HOME, and the root filesystem is read-only. |

The command is `/usr/local/bin/node -e <program> /opt/openchamber-tools /tmp/openchamber-fill`. The program in `tools-filler.js` is fixed. Only its stdin varies: one JSON header line with the key and the name and byte length of each file, then the bytes. There is no tar library here. The program accepts plain file names only, puts `package.json` into the tools directory and every other file into the staging directory, runs `npm install --ignore-scripts --no-audit --no-fund --cache <staging>/npm-cache`, checks that `openchamber`, `opencode`, and the plugin are there, runs `/bin/sync`, and only then writes the marker through a temporary name and a rename. It flushes the file and its directory to disk before the rename and the directory again after it. The order matters. The marker vouches for everything npm wrote, and npm flushes nothing, so a marker that reached the disk before the packages did would be a broken volume that nothing repairs. A Docker machine that crashes right after a fill can still lose the marker or leave it empty. `ensure` treats both the same way, it removes the volume and fills again. Whether the order survives a real crash of the Docker machine was not tested.

The program is one line. 1a verified many special characters in an argument on Docker Desktop for Windows, but never a newline.

`--ignore-scripts`, measured with `web` 1.24.2 and OpenCode 1.18.31. Three packages in the tree have an install script: `node-pty`, `msgpackr-extract`, and `opencode-ai`. `node-pty` ships prebuilt binaries for Linux arm64 and x64, and the terminal works without its script. `msgpackr-extract` is optional. `opencode-ai` does need its script: its launcher `bin/opencode.exe` is a stub that prints "postinstall script was not run" until `postinstall.mjs` links the OpenCode binary for this CPU and C library into its place. The filler therefore runs `node postinstall.mjs` in `node_modules/opencode-ai`, and no other script. It makes a hard link and needs no network.

A fill has its own timeout of 30 minutes and its own output cap of 16 MB.

### Fill rollback

A failed fill leaves nothing. It removes the one-shots of this key and the volume, and rejects with `tools_fill_failed` or the code of the failed step, with `details.rollbackFailures`. After an interrupted step it waits two seconds and sweeps again, like the space rollback, and the error carries `details.uncertain: true`. The volume goes by name in both sweeps, labelled or not, because a late `docker run` makes the missing `src=` volume again without labels. This is safe for the same reason as in the space rollback: the same call found the name free, or found it ours.

A failed space create never removes a tools volume that carries labels. The space rollback removes by space id and by the five names of the space, and a tools volume has neither.

There are two by-name removals here, next to the one in "Rollback". The fill rollback removes the tools volume of this key by name, labelled or not: the same call found the name free, or found it ours, moments earlier. The second one has the same justification. Another process of the same owner with another key can prune this key's volume between this call's `ensure` and its `docker create`. `docker create` then makes the missing `src=` volume again without labels. Verification fails on `tools_labels`, and without a repair every later call would refuse that volume as a stranger's, for good. So the failure path of `create`, and of a move to new tools, looks at the tools volume that `ensure` handed to this same call as ours and filled. If it now exists with no labels at all, it is removed by name, after the failed container is gone. A volume with any label, ours or anyone's, is never touched there.

Known limit: the wedge is still reachable in two ways. The process can die between that `docker create` and the rollback. Or the rollback cannot remove the failed container, and Docker then refuses the volume too. In both cases an unlabelled volume with the tools name stays, every later call rejects with `tools_volume_not_ours`, and somebody has to remove that volume by hand.

## The server inside a space

The container command is a fixed `/bin/sh -c` line from `layout.js`:

```
while [ ! -s <token file> ]; do /bin/sleep 0.2; done; OPENCHAMBER_UI_PASSWORD="$(/bin/cat <token file>)"; export OPENCHAMBER_UI_PASSWORD; exec openchamber serve --foreground --api-only --host 127.0.0.1 --port 27600
```

`--init` stays, and with `--foreground` the container stops cleanly. The server binds to loopback inside the space. In this stage the host reaches it only through `exec`, so no listener faces the space network. An escape test reads `/proc/net/tcp` to prove that. The port is an unusual one because the agent's own dev servers share that loopback.

Environment:

| Variable | Why |
|---|---|
| `HOME=/home/space` | The home volume. |
| `PATH` with `/opt/openchamber-tools/node_modules/.bin` last | The server refuses to start without `opencode` on PATH. The image has no `openchamber` and no `opencode`, so both are found there. The image's own directories come first, so a transitive npm package that ships a bin named `node` or `sh` never shadows the image's program. |
| `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`, all four `http://gatekeeper:3128` | The corridor. curl 7.88.1, the version in this image, ignores an uppercase `HTTP_PROXY` on purpose, the httpoxy protection, and honours the lowercase one. Without the lowercase spelling, plain-HTTP traffic from curl and from everything that uses libcurl never reaches the corridor. |
| `NO_PROXY`, `no_proxy`, both `gatekeeper,localhost,127.0.0.1` | Window traffic skips the corridor, and so does the space's own loopback. Measured: with `http_proxy` set, curl sends even a request to 127.0.0.1 to the corridor, and Node with `NODE_USE_ENV_PROXY=1` proxies loopback too. curl reads both spellings. |
| `NODE_USE_ENV_PROXY=1` | Node 22 ignores proxy variables without it. Measured: `EAI_AGAIN` for every fetch, and with it Node honours the uppercase spelling. |
| `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1` | The catalog and the update check would spend corridor attempts on downloads a space does not need. |
| `OPENCHAMBER_RELAY_HOST=off` | The server inside a space must never host the relay passively. It has a way out now, and paired devices must not land on a space. `server/index.js` reads this variable when it computes `allowPassiveHost`. |

`npm_config_fetch_retries=0` is gone. Stage 1b set it because a space had no route at all, and OpenCode's background install of `@opencode-ai/plugin` then held its tool registry for a long time: measured with OpenCode 1.18.31 and no network, the first request for a project with `.opencode/tool/*.ts` took 131 seconds. Measured again in stage 2 with `npm view opencode-ai version` from a space-like container: with no route, 70 seconds; through a corridor that answers an immediate 403, 0.3 seconds with npm's own retry settings, because npm does not retry a 403. So the corridor's refusal does the work the variable did, and the agent's own `npm install` gets its retries back.

The plugin must also resolve from project files, or such a project fails with `Cannot find module '@opencode-ai/plugin'`. After the start, `create` makes `/spaces/<id>/node_modules/@opencode-ai/plugin` a symlink to the package in the tools volume. Module resolution walks up from the project, so one link above every project is enough. Only the plugin is linked, so project code does not quietly resolve our other packages. Measured: with this narrow link a tool that uses `tool.schema` is listed in 141 ms, so the plugin's own dependencies resolve from the link's real path. The agent can delete the link. That hurts only itself and is not a boundary.

### Token

`create` makes 32 random bytes with `crypto.randomBytes`. After `docker start` it writes them over the stdin of an `exec` into `/home/space/.openchamber-space/token`: directory mode 0700, file mode 0600, through a temporary name and `mv`, so the waiting server never reads half a token. The token is in no argument on the host, not in the container environment, not in a label, and not in anything `docker inspect` shows. An escape test checks the full inspect output.

The honest limit: the agent runs as the same user. It can read the token file and the environment of the server process. The token is not a secret from the agent. It keeps the server closed to anything else, and it stays out of container metadata.

The host keeps no copy. `readToken` reads it back over `exec`. `stop` and `start` keep it, so the server comes up by itself. DESIGN.md wants a fresh token at every host start. That belongs to the dispatcher stage. Nothing here blocks it: the server reads the file when it starts, so a new `writeToken` and a restart of the container rotate it.

### The exec channel

`createSpaceServerChannel({ exec, wait, now })` in `space-server.js` works for every place, because it needs `exec` only. `wait` and `now` are the pause and the clock of the readiness wait.

- `request(spaceId, { method, path, headers, body })` runs `/usr/bin/curl --disable ... --config -` inside the space against loopback and resolves `{ status, headers, body }`. The whole request is a curl config on stdin. A cookie or a token in a header therefore shows up in no argument list, on the host or inside. `curl` is part of the base image.
- `waitUntilReady(spaceId)` polls `/health` until it answers 200 with `isOpenCodeReady: true`. Each attempt has a curl time limit of 3 seconds, attempts are half a second apart, and no attempt begins later than 120 seconds after the wait began, by the injected clock. The wait can therefore overrun 120 seconds by the length of one attempt, at most 13 seconds. Then it rejects with `space_server_not_ready` and names the seconds that really passed. When `exec` itself fails, for example because the container is gone, it rejects at once. `docker exec` reports that with exit code 1, 125, 126, or 127. curl uses exit code 1 too. Measured with curl 7.88.1: a listener that answers `hello` gives exit code 1 and `curl: (1) Received HTTP/0.9 when not allowed`. curl starts its error lines with `curl:`, so one of those codes counts as "exec failed" only when stderr does not start like that. In `create` that failure rolls the space back and keeps the tools volume.

Everything that comes out of a space is untrusted data. When a stopped space starts, agent code can run before the server does and can own the port. The channel is written for that:

- `--disable` is the first curl argument, so curl never reads the `~/.curlrc` of the space user. Measured: a `write-out` line there injected text into the output the host parses. An escape test repeats that.
- The body travels as `data-raw`. `data-binary` reads a body that starts with `@` as a file name.
- Header names go into an object without a prototype, so `__proto__` and `constructor` are names like any other. The host parses at most 64 KiB and 200 lines of headers and answers `space_server_answer_unreadable` beyond that. Values are pushed into one array per name. The first draft copied the array for every line, and 160,000 repeated lines blocked the host's event loop for 38 seconds.
- A request whose `exec` timed out or was killed becomes `space_server_unreachable`, which the readiness wait counts as "not ready yet". No Docker step was interrupted there, so `create` must not answer "Docker may still finish the interrupted step".
- `readToken` has a time limit of 10 seconds and accepts 32 to 128 characters of base64url only. The agent owns the token file and can make it huge, empty, or a FIFO. All of that becomes `space_token_unreadable`.
- The host names every program it runs in a container by its absolute path in the pinned image: `/bin/sh`, `/bin/cat`, `/bin/chown`, `/usr/bin/curl`, `/usr/local/bin/node`. The constants are in `layout.js`, and the paths were checked in the image with `command -v`. Every fixed script that the host sends through `exec` starts with `PATH=` set to the image's own directories. The space command and the marker check use shell builtins and absolute paths instead, with one exception: the space command ends in `exec openchamber`, which the space PATH finds in the tools volume, the only place that has it. The filler's own `npm` call keeps the bare name: the filler's PATH is the image default and does not include the volume it fills.
- A body that is `null`, not JSON, or anything else than an object with `isOpenCodeReady: true` counts as "not ready yet". So does an answer that is not HTTP, any curl error, and more output than the runner accepts. That last one becomes `space_server_answer_unreadable`. It is never `command_output_too_large`, which the rollback would read as "Docker may still finish the step".
- A listener that accepts and never answers costs 3 seconds per attempt, and the deadline still ends the wait. With 20 seconds per attempt and a count of 240 attempts it would have held `start` for 82 minutes.
- Error messages carry at most 2,000 characters of text from inside.
- No answer from inside makes the channel throw anything but a `SpaceError`.

Measured: from the `create` call to a healthy server takes 2.3 seconds when the tools volume is filled, and 38 to 46 seconds with a first fill.

## The gatekeeper

Every space has one, and it is the only way out. The space keeps exactly one network, its inner one, and the gatekeeper is the other member of that network. The gatekeeper is also on an outer network of this space alone, an ordinary bridge, and that is where its own traffic goes. Nothing else joins either network.

```
inner network (internal, no gateway)      outer network (ordinary bridge)
   space  ──────────►  gatekeeper  ──────────►  the internet
                       corridor 3128
                       window   8080
                       control  127.0.0.1:9099
```

Measured on Docker 29.2.1, Colima, linux/arm64, with the pinned image:

- A container on both networks works as the design wants. The space keeps one route, its own subnet, with no gateway, and still gets `ENETUNREACH` for a public address.
- Docker's embedded DNS resolves the gatekeeper's network alias from inside the space, and public names still do not resolve there (`EAI_AGAIN`). So on Docker the gatekeeper runs no DNS server: the space resolves container aliases and nothing else, and the gatekeeper resolves public names itself when it opens a tunnel. A place where alias resolution does not work, such as Apple `container` on a host-only network, has to bring its own answer.
- A listener on the gatekeeper's `127.0.0.1` is refused from the space (`ECONNREFUSED`), while the same listener on `0.0.0.0` answers. That is why the control channel is a loopback listener, reached over `exec`, and invisible to the space.
- The gatekeeper can reach the Docker host: a TCP connect to the outer bridge's gateway address and to `host.docker.internal` both succeed from it. This is the whole reason the corridor refuses by address. A corridor that let private, loopback, link-local and metadata addresses through would hand the space everything stage 1a shut.
- On an isolated network Docker gives the first container the `.1` address. The gatekeeper is created first, so `.1` on the space's subnet is the gatekeeper and never the Docker host. An escape test must not read a connection to it as an escape.

### The gatekeeper container

`buildGatekeeperCreateArgs` and `findGatekeeperHardeningViolations` belong together, exactly as the space's pair does. The gatekeeper gets everything the space gets: `--init`, `--user 1000:1000`, `--read-only`, a size-limited `nosuid` tmpfs, `--security-opt no-new-privileges`, `--cap-drop ALL`, `--pids-limit 512`, equal `--memory` and `--memory-swap`, `--shm-size 64m`, `--ipc private --cgroupns private`, the same log cap, no bind mount, no `--volumes-from`, no runtime socket, no sysctl, no device, no published port, and none of the forbidden environment variables. Three things differ, and the checker demands each of them:

| Difference | Why |
|---|---|
| Two networks, this space's inner one and this space's outer one, by name, and no others. The checker also demands the alias `gatekeeper` on the inner one. | The inner network is where the space reaches it, under that name and no other. The outer one is its way out. Any third network would be a way around this pair. |
| No mount at all. The checker demands zero mounts. | Its only writable place is its tmpfs, which is gone when the container stops. It holds no volume, so nothing it holds survives it, and there is no shared volume for an agent to read. |
| `--memory 256m --memory-swap 256m`, and the checker demands that exact value. | Measured: an idle gatekeeper with its three listeners holds about 24 MiB. 256 MiB is ten times that. The tunnel cap is 64 and two sockets with their buffers cost well under a megabyte each, so a gatekeeper at its busiest stays far below the limit, and a leak is still capped. A space's 4 GiB would be for an agent, and this is not one. |
| `--tmpfs /tmp:rw,noexec,nosuid,size=16m` where a space gets `rw,exec,nosuid,size=256m`. | One file lives there, the program, and Node reads it. Nothing runs from it. |

Its environment is `HOME=/tmp` and nothing else: the root filesystem is read-only, and a program that resolves HOME must land somewhere writable. No secret is ever in the environment, in an argument, in a label, or on disk. A grant arrives on the stdin of an `exec` and lives in the program's memory.

The outer network is created with `--driver bridge --ipv6=false` and the labels of the space. It is never `--internal`: that is the corridor's way out, and the checker reports an internal one.

Docker refuses `--network-alias` together with a second `--network`, so `create` makes the container on the inner network with the alias and then runs `docker network connect` for the outer one. Both happen before the verification, and the verification before the start.

### The program

`gatekeeper-program.cjs` is one self-contained CommonJS script on Node's standard library. It is far larger than the tools filler, and stage 1a only ever verified a 2,641 character `node -e` argument on Windows, so it does not travel as an argument. The container's command waits for the file in its tmpfs and then execs Node on it, the same shape as the space's wait for its token file:

```
while [ ! -s /tmp/openchamber-gatekeeper/gatekeeper.cjs ]; do /bin/sleep 0.2; done; exec /usr/local/bin/node /tmp/openchamber-gatekeeper/gatekeeper.cjs 0.0.0.0 3128 8080 9099 300000 128 64 8
```

The host writes the file over `exec` on stdin, through a temporary name, so the waiting container never runs half a file. `docker cp` is not an option: measured, it fails with "container rootfs is marked read-only" against a read-only container, even for a tmpfs destination.

Its size crosses no boundary, and the question is worth answering once rather than every time it grows. It travels on the stdin of `docker exec --interactive` and never as an argument, `run-command.js` writes it and ends that stdin with the pipe's own backpressure, so no single write of ours can block or truncate, and it is in any case under the 65,536-byte default pipe buffer on Windows. The 2,641 characters stage 1a verified were the limit of a `node -e` argument, which is exactly what this path avoids.

The bind address, the three ports, the window's deadline and the three connection caps are arguments, so the container and the unit test run the very same program. There is no switch in it that weakens a rule: every argument is a length or a place, the container command carries the production numbers, and a test asserts that command whole.

The caps are arguments because a test has to exceed one, and exceeding a cap is not something a test can do reliably at 128. A drop happens when a connection is *accepted* past the cap, and a machine under load accepts slowly while the kernel's backlog keeps completing handshakes. Measured: with the program stopped while 300 clients connected, all of them reported themselves connected, 128 were queued in the backlog, none was accepted past the cap, and no note was ever written — the flood was invisible to the journal by construction. At a cap of 4 that cannot happen.

`gatekeeper-channel.js` reads the file with `readFileSync(new URL('./gatekeeper-program.cjs', import.meta.url), 'utf8')` and hands the text to the container. `packages/web` ships `server/` as plain files with no build step, so this works in the published package as it does in a checkout.

Everything the space sends is hostile input. A malformed request line, an absurd header block, a huge body, a slow client, a reset in the middle of the handshake: none of it may end the process, because a crash of the gatekeeper is a denial of service the agent can trigger whenever it likes. Every socket has an error handler, the HTTP servers answer a `clientError` on that one socket and destroy it, the header block is capped at 16 KiB, and headers must arrive within 10 seconds. After the three listeners are up, an uncaught exception is written to stderr and the process keeps running. That line holds the error's name, its code when it has one, and the frame where it happened, and no message text: a message can carry what the space sent, a header value or a piece of a body among it, and the container log is not a place for that. Before the listeners are up, one that cannot bind still ends the process with a message.

### Corridor

An HTTP CONNECT proxy on the space-facing interface. Stage 0 proved that OpenCode, curl, npm and git all use CONNECT for https, so a plain HTTP proxy request is answered 403 and journalled, with the destination host and without the path.

- **The corridor takes names and never addresses, in both modes.** A literal address walks past every rule that is about a name, and that is not a theory: with the address rules alone, `auth.openai.com` was refused and its address was not, and a TLS handshake through that tunnel reached the real service. The space has no public resolver of its own, but in open mode it can ask a public DNS-over-HTTPS resolver through this same corridor and then connect to what it learns, which is two CONNECTs and nothing the base image lacks. Every CONNECT a space makes on purpose is already by name, so nothing it needs is lost. Comparing the resolved addresses of the refused names instead would be unreliable in both directions, because a CDN's answers rotate.
- Two modes, set by the host and changed live with no restart: `allowlist` and `open`. In `allowlist` mode a name passes only by an exact match, read in any case and with a trailing dot stripped. No wildcards, no suffix matching: `sub.example.com` does not match `example.com`. The list holds names, and it is checked with the same predicate a target passes, so the host can never put an entry on the list that the corridor would then always refuse. In `open` mode any name passes the name check.
- Port 443 only, in both modes, for two reasons. A space that could reach any port could attack a third party from the user's address: a port scan, an SSH brute-force, mail abuse, with the user as the apparent origin. Data can leave over 443 whatever anyone does here, but attacking a service that does not listen on 443 cannot, so this is a real restriction and not a speed bump. And it costs almost nothing: services on other ports are overwhelmingly private ones, internal registries and internal git, which the private-address block already refuses in both modes at every port, while public HTTPS is essentially all 443. When a port is genuinely needed, the intended route is an explicit `address:port` the user opens in the grant dialog, which belongs to the UI stage. Do not solve it again by loosening a mode.
- `auth.openai.com` is refused in both modes, whatever the allowlist says, and the window refuses it as an upstream too. What that is worth differs by mode, and the honest statement is three lines:
  - The guarantee is that the user's long-lived refresh token never enters the space. That is what protects their login, and it holds in both modes.
  - In allowlist mode `auth.openai.com` is unreachable.
  - In open mode reaching it is only made harder, not prevented: the space reaches every public host on 443, so it can go through a third-party intermediary, a public proxy, a relay or a mirror, and the corridor sees only that intermediary's name. No rule about names or addresses closes that.
- **In both modes, the refusal is by resolved address.** The corridor resolves the name itself and refuses when any answer is loopback, private, link-local, carrier-grade NAT, multicast, reserved or a cloud metadata address: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`, and for IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, plus the IPv4 inside `::ffff:0:0/96`, `64:ff9b::/96` (NAT64) and `2002::/16` (6to4). A target that reads as an address never gets this far: the corridor takes names only, and "a name" means a domain name whose last label is neither a number nor hex. That is what closes the spellings `getaddrinfo` takes and four dotted octets do not describe, `1746020849`, `0x01010101`, `1.1.257`, `0x1.0x1.0x1.0x1` and `0177.0.0.1` among them. Leaning on the address check for those would have been wrong: it only refuses private ranges, and a public address in one of those spellings went straight out, which is how a reviewer reached a refused host through this corridor with a real TLS session.
- **The connection goes to the address that was checked.** The name is never resolved a second time. That is the rebinding defence, and it is one line in the code with the check right above it.
- Among the checked answers, IPv4 comes first, whatever order the resolver gave them. The outer network is created with `--ipv6=false`, so an IPv6 address there is a connection that cannot be made, and a resolver that answered AAAA first would turn a perfectly allowed host into a 502 that names nothing. An IPv6-only host is still attempted and fails with a message that says so. This changes which checked address is used and never whether it was checked.
- A refusal and a connection that did not happen are different answers, and both say which they are, and no more than that. The corridor refuses with `x-gatekeeper-reason: refused`, under a status that says what kind of refusal it was: 403 for a target it will not take, 400 for a request line it cannot read, 503 when the tunnel cap is full; a host it allowed and could not reach answers 502 with `x-gatekeeper-reason: unreachable`, and that attempt is journalled as `failed:<error code>` next to the `allow` that came before it. Without the difference, an unreachable host reads as a refused one in the user's view.
- Why it refused stays in the journal and is never told to the space. Sorting `deny:blocked-address` from `deny:unresolved` would let an agent walk a list of names and map the user's internal DNS without reaching any of it, and telling `deny:not-on-allowlist` from `deny:not-a-name` would tell it which mode it is in.
- Sockets are capped as well as tunnels: 128 connections on the corridor, 64 on the window, 8 on the control channel, each an argument of the program with those numbers in the container command, and the window's own sockets out are capped at 64 by an agent of its own. `MAX_TUNNELS` counts established tunnels only, so without a socket cap a space could hold thousands of connections in the ten-second header window and have the process killed for its memory. Egress fails closed when that happens, but the journal lives in that memory, so the space would erase the record of everything it tried. The corridor's cap is twice the tunnel cap, which leaves room for every handshake a working space makes. A connection refused by the cap, and a request the HTTP parser threw out before any rule saw it, are journalled once per listener and per kind per minute: five hundred notes would erase everything else the record holds, and no record at all would let a space probe invisibly with targets the parser rejects.

  That limit has a cost worth naming, because the journal is the user's only view: a second flood inside the same minute leaves no mark of its own. Two answers were considered and neither was taken. Putting something in the limiter's key that separates one flood from another gives the space a way back to unbounded notes, which is the denial of service the limiter exists to stop. Protecting notes from eviction by ordinary records answers a different problem: measured, the journal held 190 records when a flood went unrecorded in CI, so nothing had been evicted at all. What would actually close the gap is a count carried by the note — one note a minute saying how many connections it stands for — and that changes the shape of a record the host reads back, so it belongs with the stage that puts the journal in front of a user, where a count is what they would read.
- A tunnel that is established is torn down the way TCP means it: a close on one side is passed on to the other as a close, once what is buffered has gone out. Destroying both sockets instead is how a proxy truncates a download. It takes both directions at once to see it: with the space still uploading, the socket to it has unread bytes, a destroy becomes a reset, and the kernel throws away the send queue with it. Measured with the old teardown, four runs of a four-megabyte answer to a reader taking 16 KiB every 15 ms lost between 1,114,112 and 1,572,864 bytes; with this one, four runs delivered all 4,194,304 bytes with equal hashes. One direction alone does not show it, which is why the first test written for this defect passed against the defect.
- A death is not a close, and `pipe` does not carry one. When one socket is destroyed, pipe unpipes its peer, the peer goes paused, and a paused socket never learns that the other end is gone: the second close never arrives and the place stays taken until the idle timeout, five minutes later. So each side tells the other to go, with `destroySoon`, which writes out what it holds first. Measured before that: 20 tunnels whose clients were destroyed left 20 places taken with nothing alive at either end, and rounds of it reach the cap.
- The connection out is made with `allowHalfOpen`, so a close travels in each direction on its own. Without it Node ends our side to the upstream as soon as the upstream sends FIN, and measured against the real program, an upstream that half-closed and kept reading never received what the space sent next. What it costs is that a genuinely half-open tunnel holds its place until one side closes or the idle timeout ends it, and the tunnel cap bounds how many of those a space can hold.
- A refused client's socket is let go, not merely answered. An `http.Server` socket allows half-open, the request timeouts stop applying once a CONNECT has been handed to us, and the idle timeout belongs to a tunnel that in this case never exists. Measured before that: 140 clients that read their refusal and held on filled the connection cap at 128, and the corridor then refused everything for as long as they held, with nothing open anywhere.
- Letting it go means draining it and waiting for the client to finish, not closing on the spot. Closing a socket with unread bytes still in its receive queue sends a reset, and a reset throws away what the client has received and not yet read: measured against a build that closed at once, a client that wrote a megabyte after its CONNECT lost its 403 in three runs out of five, and at four megabytes it was a coin toss. The refusal stands either way, and nothing gets through; what is lost is the one line that tells the space why. So the socket is resumed and closed when the client ends, and at most 16 refused clients are ever waited on at once, against a cap of 128: past that the oldest is closed, which costs it a readable reason and costs the corridor nothing. A timer instead of that bound would not do, because a space can open refusals as fast as the timer expires.
- An error on the connection out answers 502 only while the socket still belongs to the proxy. Once a tunnel carries bytes, writing `HTTP/1.1 502` into them would put proxy protocol in the middle of somebody's TLS stream, and a reset halfway through a download would reach the space as a record error instead of a reset. The `failed:<code>` record is written either way.
- An error, a timeout, or a client that leaves before the tunnel exists still destroys both sockets at once, which is the right answer there because nothing is in flight.
- A tunnel is closed after 300 seconds with no byte in either direction, and 64 tunnels may be open at once. A 65th is refused and journalled. A model answer streams and a long turn can be quiet for minutes, so the idle limit is generous on purpose; the cap is what the space cannot lift. A client that leaves while its name is being resolved frees its place at once, on `end` as well as on `close`: a socket the corridor has not started reading from stays half-open after the client's FIN, and without that the space could hold every place in the corridor by opening connections and walking away. Measured before the fix: a place stayed taken for the full 15 second connect timeout.

### Window

A reverse proxy on the same interface, for services whose secret must not enter the space. `/model/<grant id>/<rest>` goes to that grant's upstream with `<rest>` appended to the upstream's path unchanged, and with the grant's own header set: `Authorization: Bearer <key>` for OpenAI-style APIs, `x-api-key: <key>` for Anthropic. Whatever the space sent as `authorization`, `x-api-key` or `proxy-authorization` is removed first. An unknown grant id is 403 and journalled. A grant id is never guessable from inside, and it is treated as public anyway: nothing relies on it being secret.

A grant opens a place on a host, not the host: a rest of the path that climbs out of it is refused with `deny:path-walks-out`, because with git and a private registry the path is what says which repository or which package. It is the same host and the same credential either way, so this is a door closed before those windows land rather than an escape today.

Looking for a literal `..` is not enough, and a rule that only did that was measured letting `%2e%2e`, `.%2e`, `..%2f`, `..%5c` and `..;` through to an upstream that echoed what it received. The rest reaches the upstream verbatim, and plenty of servers decode before they resolve a path. So the rest is decoded until a round decodes to itself, and every round is split on `/`, `\`, `;`, `?` and `#` before `..` is compared; a rest that will not decode is refused too. A fixed point rather than a fixed number of rounds, because a bound on the rounds is a hole at the round after it — at three, a four-times-encoded `..` went through verbatim — and the loop ends on its own, since every round that changes anything replaces a three-byte escape with one byte. Refusing every rest that carries a `%` would be simpler and would be wrong: a scoped npm package is fetched as `/@scope%2fname`, and that window is half the reason the rule exists.

The window has a deadline of its own: no byte from the upstream for 300 seconds and the request is over, with a 504 and a `failed:timeout` record. The same number as a tunnel's idle limit and for the same reason, that a model answer streams, so what matters is silence rather than how long an answer takes. Measured before it existed: 64 requests to an upstream that accepted and never answered held every slot the window has, in and out, and nothing recovered. The space cannot choose a grant's upstream, so this is about one provider going quiet. The deadline is the program's fifth argument, 300000 in the container command, so that a test can watch one pass without waiting five minutes; it is a length, not a decision.

The window is written for any upstream and any header name, because git over https and a private npm registry go through the same mechanism later. Only the model-provider path is wired and tested in this stage.

The upstream may be `https`, and stage 0 only ever proved a plain-HTTP one. TLS to the upstream is tested live: a grant that points at a public HTTPS endpoint answers through the window, with no credential of anyone's.

The window applies no private-address rule to a grant's upstream, on purpose. A grant is the user's decision, delivered over the control channel, and a private npm registry on the user's own network is exactly the case the design wants later. The space cannot choose an upstream, only a grant id that the host has already set. The one refusal is the gatekeeper itself: any of its own addresses, not only loopback, on one of its three ports. The corridor and the window bind every interface, so the address a space reaches them on is the one on the inner network, and a grant pointing there would feed the window into itself until its 64 sockets out were gone. The consequence is a rule the host must keep: never build a grant out of anything a space said.

### Control

An HTTP listener on the gatekeeper's own loopback, which the space cannot reach. It takes, from the host only:

| Request | Meaning |
|---|---|
| `GET /health` | Answers 200 once all three listeners are up. It is the last to bind, so an answer means the corridor accepts connections. |
| `POST /network` | `{ mode, domains }`. Replaces both. |
| `POST /grants` | `{ id, upstream, header, secret }`. Adds or replaces one grant. |
| `GET /journal` | The records and how many were dropped. |

Anything else is 404, and a body that is not an object is 400. Grants and the allowlist live in the program's memory only.

`createGatekeeperChannel({ exec, wait, now })` in `gatekeeper-channel.js` is the host's side, built on `exec` alone so it works for every place, and written with the same discipline as `space-server.js`, which it shares `exec-http.js` with: `--disable` first so curl never reads a `~/.curlrc` from inside, `--noproxy '*'` on every request, the whole request as a curl config on stdin so no secret reaches an argument list, capped header parsing into a prototype-less object, bounded error text, a wall-clock readiness deadline of 60 seconds, and no answer from inside able to make it throw anything but a `SpaceError`.

The journal comes back as data: known fields only, at most 1,000 records of at most 256 characters each, and a body over 1 MiB, a body that is not JSON, or one without a record list is an error and never an empty journal.

### Journal

A ring buffer of 500 records in memory. One record per attempt: the time, which listener, the destination host and port, and the decision. The host is cut to 256 characters and the decision to 64, the same caps the host channel reads back with, so a full ring always fits in one answer. Without the cut on the host a space could make its own journal unreadable: a plain proxy request carries its target in the request line, and the request line has to fit the 16 KiB header cap, which leaves room for a host of 16,370 characters. Measured with the cut removed: 63 such requests took the journal to 1,054,537 characters, past the 1,048,576 the channel reads. With the cut in place, a full ring of 500 of those records is 180,527 characters, 17 percent of the read cap. It would then hold it that way by refilling the ring, and the journal is the user's only view of what the agent tried. Never a path, never a query, never a body, never a header value, never a secret. When the buffer is full the oldest record goes and `dropped` counts it, and the host reads that count with the records, so a caller can say that it is not looking at the whole story.

The decisions are `allow`, `failed:<error code>` for a host that was allowed and could not be reached, `deny:not-a-name`, `deny:not-on-allowlist`, `deny:port`, `deny:always-refused`, `deny:blocked-address`, `deny:unresolved:<reason>`, `deny:too-many-tunnels`, `deny:too-many-connections`, `deny:malformed`, `deny:unreadable-request` for a request the HTTP parser threw out, and `deny:not-connect` for the corridor, and `allow`, `failed:<error code>`, `deny:no-grant`, `deny:path-walks-out`, `deny:own-listener`, `deny:always-refused`, `deny:unresolved:<reason>`, `deny:too-many-connections` and `deny:unreadable-request` for the window.

### Lifecycle

- `create` makes both networks, the volumes, the ownership one-shot, then the gatekeeper: create, connect the outer network, verify, start, write the program, wait for the corridor. Only then does it make the space container. The space's proxy therefore works from its first moment, and the gatekeeper is the first container on the inner network, which is why it holds `.1` there.
- A new gatekeeper allows nothing. Mode `allowlist` with an empty list is where it starts, so a space never reaches further than the host has said, including in the window between a start and the host's first `setNetwork`.
- `stop` stops the space and then the gatekeeper. `start` starts the gatekeeper, waits for its corridor, and only then starts the space, whether the space starts as it is or moves to new tools first. A space is never running while its way out is not under the host's control, and a failed stop of the gatekeeper leaves the space stopped, which is the safe side of that order.
- A `start` that races a `stop` can leave the space running with its gatekeeper stopped, because `stop` waits for a start of the same space and then stops the space first. That direction is the safe one: the space has no way out at all while its gatekeeper is down, `list` reports it as damaged, and the next `start` brings the gatekeeper back. It is written here so that nobody has to find it twice.
- `start` looks after the gatekeeper even when the space container is already running, and that is the one thing it does to a running space. "A running space is never touched" is about the space's own container and its tools. A gatekeeper can die on its own, from its memory limit among other things, and `list` reports such a space as damaged; without this, the one action a user would take would skip the only step that repairs it, and only a stop and a start would help.
- The program lives in a tmpfs, so it is gone after every stop, and `start` writes it again. Grants and the allowlist are gone with it and are not restored here: the host says again what this space may reach. DESIGN.md already asks for that, as "needs access" after a machine restart. No container of ours has a restart policy, so a Docker machine that comes back up leaves both containers stopped and the next `start` brings them up in this order.
- The move to new tools does not touch the gatekeeper. It mounts no tools volume, so a new tools version changes nothing about it, and the move remakes the space container only.
- `remove` removes both containers, both networks and the volumes, by label, containers first. `create`'s name check covers the two new names, and so does the second by-name sweep after an interrupted step.
- A space whose gatekeeper container is gone does not start, and neither does one that is already running: `start` rejects with `gatekeeper_missing` and changes nothing. Known limit: the gatekeeper is not made again, although it holds no state, so such a space has to be applied or discarded and made again. Making it again would be a repair path with a rollback of its own, and stage 2 does not build one.
- `verify` covers both containers and both networks, and the manager's rule that a space which cannot be verified is never handed out therefore covers the gatekeeper: an absent gatekeeper is the violation `gatekeeper_missing`, and the manager removes the space.

### Known limits

- The corridor and the window listen on every interface of the gatekeeper, because the space's network is the point of them. **On Linux that includes the user's own machine.** A Linux Docker host routes into the bridge subnet, so any local process can reach both listeners without a published port. Measured on Debian 13, amd64, Engine 29.8.1: from the host, `curl http://<the gatekeeper's outer address>:8080/` connected, and reading the socket returned the window's answer. On macOS and Windows a virtual machine stands between the host and the bridge, which is why a Mac-only run could never have shown this.

  The space cannot use it: it still cannot reach the host, and that is what the escape tests prove. What it means is that an unprivileged local process on a Linux desktop could spend the user's model key once a real one sits behind the window. Nothing in this stage puts one there, and the stage that first does has to close it. Two ways are on the table, neither chosen here: a secret the host hands the window together with the grant, which every request must carry, or binding the window to the space's inner network address alone. The second needs no change to the create order, whatever an earlier draft of this paragraph said: the bind address is an argument of the program, and the program arrives over `exec` after the container is running, when Docker has already given it both addresses. `STAGES.md` carries this as an obligation on that stage.
- Anything else attached to the space's outer network could use the two listeners as well. The place attaches nothing else, and the escape suite's stand-in upstream is the only exception, in tests.
- A tunnel the upstream half-closed stays open, because a close travels in each direction on its own. Measured: 64 of those with live clients means the 65th is refused, and all 64 places come back as the clients let go. That is the tunnel cap doing its job on genuinely open tunnels rather than a leak, and the idle limit ends one that goes quiet.
- Port 443 only. A tool that needs another port cannot be reached until the grant dialog can open one.
- The corridor takes names, so a tool that only knows an address, and that the user cannot give a name, cannot be reached either.
- A single-label host, `localhost` among them, is refused. Closing the integer and hex spellings meant demanding a name with a real last label, and a name with no dot at all cannot have one. Nothing in a space needs it: its own loopback does not go through the corridor.
- A host with an underscore in it is refused, for the same reason: the name rule is the allowlist's, and that one takes letters, digits and hyphens. Such names are not valid hostnames, and the ones that exist are service records rather than things a space connects to.
- A grant's upstream is not checked against the private-address block, on purpose, because the user's own registry is a legitimate upstream. See "Window" for the one refusal that does apply and the rule it puts on the host.
- In open mode, refusing `auth.openai.com` is a lock and not a guarantee. See the corridor's rules.
- The gatekeeper is not made again when it is gone.
- The journal is memory only. A restart of the gatekeeper loses it, and so does a host that never reads it between two starts.
- Grants and the allowlist have to be set again after every start of a space.

## New tools at the next start

DESIGN.md: spaces pick up a new host version at their next start, and a busy agent is never interrupted. The mounts of a container are fixed at creation. So `start` of a stopped space whose tools mount is not the current tools volume makes the container again:

1. Rebuild the spec from the labels of the old container and its inspected memory limit.
2. `docker rename` the old container to `openchamber-space-<id>-space-old`.
3. Create the new container on the current tools volume, verify it, start it, wait until its server is ready.
4. Remove the old container, then prune tools volumes.

Everything a space owns lives in its two volumes, so nothing is lost, and the token stays. On any failure in step 3 the new container is removed and the old one gets its name back. `details.rollbackFailures` lists what could not be put back, and the message says "keeps its old container" only when that is true.

The new container is removed by the id that `docker create` printed, never by name. When the create itself failed there is no id, and nothing is removed. A name proves nothing here: if anything gave the old container its name back in the meantime, a removal by name would delete the only container of the space. That was a real defect of the first draft. A failed create that still left a container behind therefore keeps the plain name, the old container stays aside, the error says so, and the next `start` repairs it.

A running space is never touched, whatever tools it runs on.

Only `start` repairs a half-done move, and calls of `start` for one space share one run inside a process. `verify`, `exec`, and `stop` rename nothing. When only the aside container exists they reject with `space_move_unfinished` and tell the caller to start the space. That is also their answer during the short window of a move in the same process. `list` shows such a space as `exited`, which matches: it can be started. When two containers exist, `list` prefers the one with the plain name. `remove` finds both by label.

The repair in `start`: if the aside container exists and the container with the plain name is stopped, that one is the unfinished new container. It is removed by the id that was just inspected and without `--force`, and the old container gets its name back. Then the start goes on as usual and moves the space again. Docker refuses to remove a running container without force. If it refuses, `start` looks again, and a running container with the plain name is a space that is already started. If the container is gone after the repair, `start` rejects with `space_not_found`.

`stop` waits for a `start` of the same space that is under way in this process, whatever its outcome, and stops then. A stop that slipped in between the create and the start of a move would otherwise resolve, and the space would run anyway.

Known limits:

- Two host processes with the same owner are not coordinated. One could repair a move that the other is in the middle of. Two rules keep a container alive in that case. The new container of a move is removed only by the id its create printed, so the old one survives and the move fails with a name conflict. The repair removes the unfinished container without force, so a new container that the other process has started meanwhile survives.
- A move that succeeded and died before it removed the aside container leaves both. While the space runs, nothing happens. The next start of the stopped space takes the container with the plain name for unfinished, goes back to the old one, and moves again. That costs time and loses nothing.
- `start` of a stopped space needs the current tools. If they cannot be prepared, for example with no internet right after a host update, `start` rejects with the fill error. It does not fall back to the old tools.
- A space whose token file the agent deleted cannot start: the command inside waits for the file until the readiness wait ends. Rewriting the token arrives with the dispatcher stage.

Not built: moving a space when the agent finishes its turn. That needs session activity, which only the dispatcher stage knows.

## Rollback

`create` checks that its seven names are free, then creates. On any failure after that check it removes everything labelled with the new id and this owner, containers first, then volumes, then the networks. That covers every step up to the readiness wait, the gatekeeper's steps among them: a space whose gatekeeper never answers, or whose server never becomes ready, is removed with everything it made. The tools volume stays, because other spaces use it. It rejects with the original error's code, and `details.rollbackFailures` lists what it could not remove. The pulled image stays, because spaces share it.

The name check sits outside the rollback on purpose. If the id is taken, the resources belong to an existing space and must survive the failed call.

After an interrupted step (`command_timeout`, `command_killed`, or `command_output_too_large`) the daemon may still finish the step whose CLI died. `create` then sweeps, waits two seconds, and sweeps again. The second sweep also inspects the seven names directly and removes the ones that exist, labelled or not. This covers a late `docker run` or `docker create`: it makes a missing `src=` volume again, and that volume has no labels. This by-name removal, and the two for a tools volume described in "Fill rollback", are the only places in the module where a resource without our labels can be deleted. It is safe because the same call confirmed all seven names absent moments earlier, and the names hold a random 48-bit id, so nobody else makes them in between. The error carries `details.uncertain: true`, so the caller can tell the user to look at the spaces list.

The manager verifies again after `create` and removes a space that reports violations or cannot be inspected. For the Docker place this repeats a check that already passed. It stays because the guarantee must hold for every place, including a place whose `create` forgets to verify.

`list` and `remove` tolerate a resource that vanishes between the listing and the inspect. Docker exits 1 for the missing name and still prints the entries it found, and those are used. Any other inspect failure rejects. `remove` also counts "removal of container ... is already in progress" as removed.

## Process rules

`run-command.js` spawns the executable directly with an argv array, `shell: false`, and `windowsHide: true`. No `cmd.exe`, no shell strings. Every call has a timeout that kills the child, and an output cap. The Docker place receives the runner as a dependency, so tests pass a fake and never mock a module.

A timeout kills the `docker` CLI only. A command started with `exec` keeps running inside the space or the gatekeeper.

`stdin` is a string or a Buffer. A Buffer reaches the child byte for byte, which is how the tarballs of a development build reach the filler. `cwd` sets the working directory and is used by `tools-pack.js` only.

`check()` says the CLI is missing only for `ENOENT`. Any other spawn error names its errno. `check()` also reads `docker info --format '{{json .SecurityOptions}}'` and reports the place unavailable when the engine has no builtin seccomp profile. Older engines name that profile `default`.

## Verified and not verified

Stage 2 ran on three machines on 2026-09-21, the staged files hashed against the worktree before each run:

| Machine | Engine | Result |
|---|---|---|
| macOS 26, Colima, linux/arm64 | 29.2.1 | Unit 695 passed, 83 skipped. Live 774 passed, 4 skipped of 778, 113 s. No leftover container, network or volume |
| Debian 13, linux/amd64, over `DOCKER_HOST=ssh://` | 29.8.1 | 774 passed, 4 skipped of 778, 783 s. No leftovers. The first amd64 run of the corridor |
| Windows 11, Docker Desktop, the module on the Windows host | 29.6.2 | 761 passed, 17 skipped of 778, 311 s, exit 0. No leftovers. Files ran in parallel, as they do by default, beside the three live Docker files |

The 13 tests between the Windows number and the other two are the `tools-filler` group that stage 1b switches off on `win32`: 774 − 761 = 13 and 17 − 4 = 13, so the smaller number is the same run and not a partial one.

The vitest worker that ran `gatekeeper-program.test.js` used to die on Windows. It does not any more: that file ran to completion there and every one of the seven tests that had failed on a clock reading passed on a record count.

Measured on macOS with Colima, Docker Engine 29.2.1, linux/arm64, with `web` 1.24.2 and OpenCode 1.18.31:

- Every unit, contract and escape test and the live tests of the server inside: 774 tests in 96 seconds. The escape suite runs 56 test cases, from 41 `it` blocks and 3 `it.each` tables, 22 of them about the gatekeeper. The contract suite runs 13 and has the three added assertions and no changed one.
- A create with the gatekeeper costs 2.9 seconds when the tools volume is filled, against the 2.3 seconds stage 1b measured without one, and 38.9 seconds when it pays for the fill. `stop` takes 0.2 seconds and `start` 2.5 seconds. The live contract file, one fill plus the whole scenario, took 43 to 49 seconds, and the whole live run of the module 96 seconds.
- The corridor carries a real CONNECT to `example.com:443` from inside a space, refuses a name that is not on the list, refuses the same name on port 80, 22 and 8443 in both modes, and answers a changed list on the next attempt without a restart.
- The address of `auth.openai.com`, resolved on the host at test time, is refused in four forms and in both modes, with the gatekeeper's own reach of that address as the control. Before this rule existed a reviewer reached the real service through the corridor by its address.
- The space holds no long-lived credential: no OpenCode auth record, and nothing shaped like an oauth refresh record, a private key, a GitHub token or a provider key in any file under its HOME or work directory or in any process environment. The search finds all three when the test plants them first.
- A flood of 400 sockets on each listener, and 80 tunnels at once, leave the gatekeeper running, its journal readable, the corridor serving and the space verifying clean.
- 140 refused clients that hold their sockets are all refused, and the corridor still answers with `tunnels: 0` at 5, 15, 30 and 45 seconds afterwards.
- A tunnel whose peer dies gives its place back at once rather than at the idle limit: 20 held became 0, while a genuinely half-closed tunnel kept its place. Through a real corridor, a four-megabyte answer with a concurrent upload arrives byte for byte, sha256 equal; the old teardown loses about 460 KB in the same shape. An upstream that half-closes now receives what the space sends afterwards.
- The window's deadline answers 504 with exactly one `failed:timeout` record, gives the slot back, and 64 hanging requests all recover. It measures silence, not length: an answer of 64 bytes every 700 ms for 8.4 seconds completed under a 1.5 second deadline.
- A reset in the middle of a transfer is journalled and puts no 502 into the stream: all 65,536 bytes arrived and the place came back.
- A gatekeeper that was stopped under a running space is started again by `start`, which changes nothing about the space container.
- The gatekeeper itself reaches the Docker host, and the space reaches none of the host's addresses through the corridor, in allowlist mode and in open mode, by address and in the IPv4-mapped IPv6 form.
- A name of our own that resolves into a refused range — a helper container on the space's outer network, answered by Docker's embedded resolver with an address on that bridge — is refused with `deny:blocked-address` in both modes, including with the name on the allowlist.
- A real model key held by the gatekeeper reached a stand-in upstream on the space's outer network, in the `x-api-key` header and as a bearer token, while the space's own `authorization` and `x-api-key` were dropped. The key is in neither container's `docker inspect`, in no answer, in no error text, in no journal record, and nowhere in the space's environment, process list or files.
- A grant whose upstream is `https://example.com/` answers 200 through the window, so TLS to an upstream works end to end. Stage 0 had only proved a plain-HTTP upstream.
- 12 rounds of malformed CONNECT lines, huge header blocks, resets in the middle of the handshake and parallel connections left the gatekeeper running, the corridor serving, and the space healthy.
- The gatekeeper, seen from inside it: uid 1000, `NoNewPrivs: 1`, empty `CapEff`, `Seccomp: 2`, a read-only root filesystem, no runtime socket, no tools volume, and a writable `/tmp`.
- The filler runs as root with every capability dropped. One fill took 36 seconds and left 438 MB in the volume. The marker check takes 0.1 to 0.2 seconds.
- An idle space with the server and OpenCode holds 357 to 374 MiB and 25 processes. The contract suite's 512 MiB limit is enough to start.
- OpenCode reports the directory of a session byte for byte as the space path: a session created for `/spaces/<id>/repo` reads back `/spaces/<id>/repo`. For a path that goes through a symlink OpenCode reports the real path, so `/spaces/<id>/link-to-repo` reads back `/spaces/<id>/repo`. The dispatcher stage must hand OpenCode real paths only.
- The terminal works through its WebSocket with `node-pty`, although install scripts were ignored.
- `bun pm pack` of bun 1.4.2 runs `prepack`, rewrites `workspace:*` to the version, writes `<name>-<version>.tgz` into `--destination`, and prints the path as the last line of stdout. Two packs of unchanged sources give the same bytes, so the key of a development build changes only when a source file changes. Every file under `packages/web/server` is in the tarball, so any edit there means a new key and a new fill.

Verified on 2026-09-19, for stage 1a, on a Windows 11 host with Docker Desktop, engine 29.6.2:

- Every contract and escape test of 1a.
- Arguments reach the container unchanged: `=`, `,`, spaces, quotes, a backslash, `%PATH%`, `^&`.
- Stdin piping works.
- A timeout leaves no orphan process on the Windows side.
- The isolated network has no gateway. The injected `*.docker.internal` names do not resolve from a space. Neither the WSL VM nor the Windows loopback is reachable from a space.
- A plain internal network there does reach services in the WSL VM through its gateway, the same gap as on Colima.

Verified on 2026-09-19, for stage 1a, on Debian 13, linux/amd64, over `DOCKER_HOST=ssh://`:

- Engine 29.8.1 passed every contract and escape test of 1a.
- Engine 26.1.5 accepted the isolated gateway option silently and still gave the bridge a gateway address. The checker reported it, and `create` failed closed with a clean rollback.

Verified on 2026-09-20, for stage 1b, on Debian 13, linux/amd64, Engine 29.8.1, over `DOCKER_HOST=ssh://`:

- Every contract and escape test, the live tests of the server inside, and the live test of a development build: 197 tests. This covers the x64 binaries of `node-pty` and OpenCode.
- Every `exec` opens its own SSH connection there. The run took 18 minutes against 3 locally, and the readiness wait still ended in time.

Verified on 2026-09-20, for stage 1b, with the module running on a Windows 11 host against Docker Desktop, Engine 29.6.2:

- Every contract and escape test and the live tests of the server inside. This covers the 2,641 character `node -e` argument of the filler and a Buffer on the stdin of `docker.exe`.
- Not run there: the development build, and the 13 unit tests that run the filler program on the host with a stand-in `npm`. They are switched off on `win32` in `tools-filler.test.js`. The filler program itself ran there in the live fill.

Not verified for stage 2:

- Any place but local Docker. The three hosts above are all local Docker: Colima, Docker Desktop, and a Debian daemon driven over `DOCKER_HOST=ssh://`, which is the local place pointed at another machine rather than the SSH place.
- A real model provider. The window was proved against a stand-in upstream on the outer network and against `example.com` over TLS, both without a real key.
- A real OpenCode turn through the window or the corridor. Nothing in this stage configures OpenCode to use either.
- Whether a space with a busy agent stays under the 64 tunnel cap, the socket caps and the 300 second idle limit in real work. The numbers are chosen, not measured against a real workload.
- Memory of a gatekeeper under load. 24 MiB is the idle figure.
- IPv6 to a real upstream. The rules are tested against literals, and the outer network has IPv6 off.
- DNS rebinding as a behaviour. The defence is that the corridor resolves once and connects to what it checked, and it is covered by the rules tests, by a check on the program's own source, and live by a name of ours that resolves into a refused range. Showing a resolver that changes its answer between two lookups would need the gatekeeper pointed at a DNS server this module cannot configure, so nothing here demonstrates the race itself.
- Whether a space can reach a refused host through a third-party intermediary in open mode. It can, by the shape of the thing: the corridor sees only the intermediary's name. Nothing was run to demonstrate it, and nothing here claims otherwise.

Not verified for stage 1b:

- A real agent turn. No model key was used, so OpenCode only reached "ready".
- A fill through a slow or filtered link, and a private npm registry. Measured on 2026-09-20: the registry served metadata for the `@peculiar` scope that no range could satisfy for about four minutes, and every fill in that window failed with `ETARGET`. It reproduced in a bare container with no code of ours involved, and it cleared by itself. That is the "only the three named packages are pinned" limit above, seen live.
- Whether the filler's `sync` and flush order survives a real crash of the Docker machine.
- Two host processes with the same owner. They are not coordinated, and "Known limits" says what can go wrong.

Not verified since 1a:

- Whether a console window flashes in an interactive Windows desktop session. `docker.exe` gets a `conhost.exe` child even with `windowsHide`. The `desktop-shell` skill requires an inspection of the whole process tree before release.
- Docker Desktop's credential helper in a real desktop session. Over SSH a pull failed with "A specified logon session does not exist".

## Base image

`SPACE_BASE_IMAGE` in `places/docker.js` is `node:22-bookworm` pinned as `node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844`.

It must be the multi-arch index digest, or spaces break on the other CPU architecture. Verified on 2026-09-19:

```
docker manifest inspect node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844
```

The answer has `mediaType: application/vnd.oci.image.index.v1+json` and lists manifests for `linux/amd64`, `linux/arm`, `linux/arm64`, and `linux/ppc64le`. An arch-specific digest answers with `application/vnd.oci.image.manifest.v1+json` and no platform list. `docker images --digests node` showed the same digest for the `22-bookworm` tag. Repeat both commands when you bump the digest. `docker buildx imagetools inspect` gives the same facts where buildx is installed.

## Tests

```
bun run --cwd packages/web test -- server/lib/spaces
OPENCHAMBER_TEST_DOCKER=1 bun run --cwd packages/web test -- server/lib/spaces
OPENCHAMBER_TEST_DOCKER_PACKED=1 bun run --cwd packages/web test -- server/lib/spaces/places/packed
```

The second command also runs the live files against the local Docker daemon: `places/contract.docker.live.test.js`, `places/escape.docker.live.test.js`, and `places/server.docker.live.test.js`. The third runs `places/packed.docker.live.test.js`. It compiles the sdk and packs the local `web` and `sdk`, so it needs the workspace dependencies installed.

Each live file uses an owner id of its own, removes its spaces, helper containers, and tools volumes in `afterAll`, and then fails if any container, network, or volume with that owner label remains. An owner of its own also means a tools volume of its own, so every live file pays for one fill of about 40 seconds. The first run pulls the image, about 1.6 GB. The whole live run is timed in "Verified and not verified" above.

`places/contract-suite.js` is a fixed contract. It passes unchanged against the memory place, the fake Docker, and live Docker.

`places/fake-docker.js` answers like the docker CLI for the subcommands the place uses. It knows tools volumes and their fill marker, the three one-shots, container ids, `rename`, `network connect`, a container name that is in use, a volume that is in use, a CLI that cannot reach the daemon and exits with 1, the server inside a space, which answers `/health` once its token is there, and a gatekeeper, whose control channel answers once its program has been written and whose tmpfs is empty again after a stop. Its `wait` moves its own clock, so no test sleeps. `docker.test.js` uses it for tools reuse, fill, fill failure, interrupted fill, a stranger's volume, two creates that share one fill, the readiness timeout, the token that never shows in an argument, a marker check that Docker could not run, a marker for other content, a tools volume that came back without labels, and the move to new tools with its rollbacks, including the old container that got its name back before the create landed.

`space-server.test.js` feeds the channel every hostile answer listed under "The exec channel", and `gatekeeper-channel.test.js` does the same for the gatekeeper's channel, including a journal that is not JSON, one without records, records of another shape, and one larger than the host reads.

`gatekeeper-program.test.js` covers the program two ways. It requires the file and calls the rules directly: every blocked range with its edges, every IPv6 embedded form, the public addresses that must stay allowed, `refuseTarget` for both modes and both ports, thirty target forms that must be refused as addresses or non-names, including the integer, hex, short and octal spellings, ten ordinary names that must still pass, the address-family choice, and what `splitTarget` refuses. The program runs its listeners only as the container's main module, so requiring it binds nothing and there is no switch that changes a decision. Then it spawns the program the way `tools-filler.test.js` runs the filler and reads decisions back from its own journal: a name that does not resolve, `localhost` as the name that proves the check is on the resolved address, exact-match domains, the port rules of both modes, `auth.openai.com` by name and in fifteen address and non-name forms, the three Unicode full stops, which Node's own parser refuses before any rule of ours sees them and which are therefore checked against the rules directly, a plain proxy request, malformed CONNECT lines, a reset in the middle of the handshake, a 200,000 character header block, a flood of 600 sockets on each listener, the window's header rules against a local upstream, a grant that points back at the gatekeeper, journal redaction, the ring buffer's overflow, and what the control channel refuses. A tunnel that carries bytes needs a name that resolves to a public address, so the tunnel cap and every tunnel that carries something live in the escape suite, inside real containers.

`tools-filler.test.js` runs the real filler program with Node against temporary directories, with a stand-in `npm` on PATH.

`places/server.docker.live.test.js` covers `/health`, the token file, the session directory question of stage 0, a project tool that imports `@opencode-ai/plugin`, the terminal WebSocket, stop and start, the move to a second tools key at the next start, and a failed fill that leaves nothing. The terminal probe is a small Node script that runs inside the space and takes `ws` out of the tools volume.

Escape tests run inside a real space and pass only when the attempt fails. A positive control backs the attempts that could pass for the wrong reason:

- Network attempts first need a plain container on the default bridge to reach `example.com:443`. If it cannot, they fail as inconclusive, so an offline machine never passes them. The space then tries the address that the baseline reached.
- The host-listener attempt has two controls. The listener runs with `--network host` and reports every IPv4 address of the Docker host from the kernel's local route table. Those addresses plus `host.docker.internal` and `gateway.docker.internal` are the candidates. First a plain container must reach the listener. Then a container on a throwaway internal network without the isolated gateway mode must reach it too, which shows that the hole is real on this engine and that the probe can see it. If either control connects nowhere, the test fails as inconclusive. The space must then fail on every candidate and on every address a control reached through a name. On an engine that ignores the isolated mode, the candidates contain the gateway of the space's own bridge, and the test fails. Measured on Colima: the plain network connected through its gateway `172.19.0.1`, and the space got `ENETUNREACH` for every address and `EAI_AGAIN` for both names.
- `unshare`, `mount`, the hostname write, and `test -e` first prove that the tool or the file exists.
- The log and memory attempts check that the write and the kill really happened. The memory attempt also checks that the server inside is still healthy afterwards.
- The tools attempts first run `openchamber --version` from the mount, and show that the running server and OpenCode were started from it. Ten attempts to create, overwrite, replace, delete, rename, or chmod must fail with `Read-only file system` and nothing else, and must leave a fingerprint of the mount unchanged. Root owns the files, so `Permission denied` would stop the space user on a writable mount too and is not accepted. Measured: on a writable mount of the same files every one of these attempts answers `Permission denied` or `Operation not permitted`, so the ten would fail there. One more attempt, appending to the launcher, is answered by the file's ownership even on the read-only mount, because the kernel checks permissions first when it opens an existing file without truncating it. That test accepts both answers and says that it proves the ownership, not the mount. A remount must fail too, and `/proc/mounts` must show the mount as `ro`.
- The `~/.curlrc` test first shows that a plain `curl` inside does carry the injected text.
- The token test first logs in with the token it read over `exec`, and gets refused with another one. Then the full `docker inspect` output must not contain it.
- The listener test first finds the server's own loopback listener in `/proc/net/tcp`.
- The gatekeeper tests open with a positive control that the corridor carries a real CONNECT to an allowed domain, so every refusal that follows is a refusal and not a broken corridor. A 502 there ends that test as inconclusive, naming the host and the answer, because it means the corridor allowed the target and the Docker machine could not reach it. Measured on a Debian machine over `DOCKER_HOST=ssh://`: exactly that happened once, for the product service that control used to carry to, and the run reported a failed restriction when the restriction had worked. Both names it carries to now are IANA's reserved documentation domains, so the live suite depends on one operator rather than two.
- The refused name `auth.openai.com` is tried by its real address as well, resolved on the host at test time, in four forms and in both modes, with the gatekeeper's own reach of that address as the control. The test fails as inconclusive if the name does not resolve here. This is the escape a reviewer found in the first draft: the name was refused and the address was not. The allowlist-mode test says the name is unreachable; the open-mode test says only that these two forms are refused, because in that mode nothing can say more.
- The long-lived credential test searches the space's HOME, `/tmp`, its work directory and every process environment for the shape of an oauth refresh record, a private key, a GitHub token or a provider key, and for OpenCode's auth record by path. Its control plants one of each first and requires the search to find all three. Stage 2 puts no such credential inside, so the test guards the one guarantee that holds in both modes.
- The tunnel cap is tested by opening 80 tunnels at once to an allowed domain from inside the space. It passes only when some were established, none beyond the cap, the journal holds `deny:too-many-tunnels`, and the corridor carries a tunnel again once the space lets go.
- The cross-space tests make a second space of the same owner, about three seconds here because both share this owner's tools volume, and look from the first at everything the second has: its space address, both of its gatekeeper's addresses, on the server, corridor, window and control ports, directly and through the first space's own corridor. The controls are that the other space's server answers, that each space reaches the corridor of its own gatekeeper at that same port, and that the shared name `gatekeeper` resolves to the space's own gatekeeper and never the other's.
- The tunnel's teardown is covered by `joinSockets` in the unit tests, with socket pairs built the way the program builds them: the space-facing one half-open as an `http.Server` accepts it, the one out half-open as the program now asks `net.connect` for. Five cases: four megabytes carried whole while the space is still uploading, which is the only shape that shows the truncation; a half-close passed on in each direction with what follows still arriving; the place given back when one side dies under load; and the place kept while a half-closed tunnel is still carrying. It is tested there because no address this machine has is one the corridor would tunnel to, so a tunnel cannot be established any other way. Put the old teardown back and four of them fail; take away the part that tells a peer to go and one does.
- There is no live large-download test, on purpose. The suite used to pull a ten-megabyte published tarball through a real corridor and compare its sha1 with the registry's, which made every run depend on somebody else's service: a bad minute there reported an inconclusive run, and an inconclusive run is a failed one with no evidence in it. It also never caught the defect it was written for, because one direction alone does not fill the corridor's buffer.

  The large-transfer guarantee comes from the unit test above: four megabytes carried full duplex while the space is still uploading, compared by sha256, deterministic, and failing when the teardown goes back. That is byte-exact evidence and the live download was not. What the live suite still proves about carrying is that the corridor carries to a real host through a real container, which is the positive control every gatekeeper test opens with. Adding a large download back would buy size, and size is what the unit test pins.
- The live socket flood opens 400 connections to each of the three listeners from inside the space and holds them. What it proves is survival, not the cap: the gatekeeper is alive afterwards, its journal is still readable and holds at most a few notes about the flood, the corridor serves again, and the space still verifies clean. It does not assert that a connection was refused, because inside a busy container that is no more guaranteed than it was on the host.
- The unit tests do not flood a listener at all. They climb to its cap, and every rung is proven accepted before the next one opens: a listener answers only a connection it has accepted, so a rung that answered is a slot taken. Once the cap is full of proven connections the next one can only be dropped, whatever else the machine is doing, and the client sees its own socket closed with nothing on it. The note is written before that close, so the assertion waits for nothing.

  This replaced three tests that opened 300, 200 and 100 sockets and read the journal. A cap is not exceeded by opening sockets quickly: a connection is dropped when it is *accepted* past the cap, and accepting is the server's turn on the CPU, while the kernel's backlog keeps completing handshakes whether the process runs or not. Measured with the program stopped while 300 clients connected: every one of them connected, 128 sat in the backlog, nothing was accepted past the cap, and no note was ever written — not after three seconds of waiting. That is what failed in CI, which runs 245 files at once, and then on a Windows host beside the live Docker files. Lowering the cap did not fix it, because the number of sockets the client opens was never the problem.

  The rungs on the corridor are refusals, and their clients are opened with `allowHalfOpen`. Without it a client ends its own side when the refusal ends the gatekeeper's, the connection goes away, and the cap never fills: measured, two refusals left nothing behind and nothing was dropped.

  A second gatekeeper runs for these three tests with a cap of 2 on every listener, so each one costs five sockets instead of forty, and the first gatekeeper keeps a corridor cap of 20 — above the 16 refused clients the program waits on at once, which is what the test beside it needs.

  Sockets are the scarce thing here. On a Windows host a closed port waits two minutes in TIME_WAIT before it comes back, and beside the three live Docker files, which hold the daemon for five to six minutes each, this file's worker died twice: once at its original counts and again at 24, 8 and 8. Keep it cheap. Measured on Windows 11 with Docker Desktop 29.6.2 at those counts: the file alone passed 206, the whole folder with `OPENCHAMBER_TEST_DOCKER=1` one file at a time passed 761 of 778, and only the parallel folder run lost the worker — which is the ordinary way it runs.

- The "cannot reach the Docker host through the corridor" test is controlled by the gatekeeper itself reaching that host first, from its own container over `exec`. If it cannot, the test fails as inconclusive. Without that control a refusal could just as well mean that nothing had a route.
- The address block is proved live by a name, because an address in a CONNECT target is refused by the name rule before the block is consulted. The name is ours: a helper container on the space's outer network with a network alias of its own, which Docker's embedded resolver answers with an address on that bridge, inside `172.16.0.0/12`. The test checks that the address really is in a refused range before it asserts anything, and a name that does not answer is a failure rather than an inconclusive, because nothing outside this machine is involved.

  It used to be five names from third-party wildcard DNS services. Twice that turned a run on somebody's machine into an inconclusive one — a failed run with no evidence in it — when the service was having a bad minute, and a test that cries wolf gets ignored. What those names covered, that `10.0.0.0/8`, `192.168.0.0/16`, `169.254.0.0/16` and a Docker bridge are all refused, is arithmetic the unit tests check thirty ways without a network; what they were really for is the path, resolve then refuse, and one name proves that. Measured with the block removed: two live tests fail, this one and `host.docker.internal`, which answered 502 instead of 403.
- The key test first shows that the key is real: the stand-in upstream answers with the sha256 of what it received, and that matches the sha256 of the key the host gave the gatekeeper. Only then does the test look for the key in the answers, the error texts, the journal, the space, and both containers' metadata. The upstream never sends the key back, so proving it travelled does not hand it to the space.
- The host-listener test also asserts that the gatekeeper's own address is not among the candidates, because since stage 2 the `.1` of the space's subnet is the gatekeeper.

The escape suite's space has 1 GiB of memory since 1b, up from 256 MiB, because the server and OpenCode hold about 370 MiB at rest. The memory attempt stays meaningful: the allocating process grows to about 650 MiB, far more than any other process in the space, so it is the one the kernel kills. The test still demands exit code 137 and a running space.

The read-only filesystem, `su`, `sudo`, and `/proc/self/status` checks have no control of their own. They rely on the write control at the top of the suite.

To look for leftovers by hand:

```
docker ps -a --filter label=openchamber.space
docker network ls --filter label=openchamber.space
docker volume ls --filter label=openchamber.space
```
