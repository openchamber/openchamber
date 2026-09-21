# Spaces module

Design, words, and product decisions are in [docs/isolated-spaces/DESIGN.md](../../../../../docs/isolated-spaces/DESIGN.md). Read it first. Stages are in `STAGES.md` next to it, test rules in `TESTING.md`.

This is stage 1b. Nothing imports the module yet: no routes, no settings, no UI. A space still has no network.

## What the module owns

Creating, finding, stopping, starting, and removing isolated spaces on a place, and proving that a created space has the restrictions it was asked for. Since stage 1b a space runs an OpenChamber server and OpenCode, started from a tools volume that is mounted read-only.

- `manager.js`: `createSpaceManager({ registry, now })`. Generates the space id, builds the spec with the default memory limit of 4 GiB, calls the place. Keeps no state file and no cache. Every answer is read from the place at call time.
- `layout.js`: what a space looks like from the inside, for every place. User, HOME, work path, tools path, the port and the token file of the server inside, the space environment, and the space command.
- `space-server.js`: `createSpaceServerChannel({ exec, wait, now })`. Everything the host does to the server inside, written once on top of `exec`: store and read the token, link the OpenCode plugin, send an HTTP request, wait until the server is ready.
- `tools.js`: tools sources and the content key. `createRegistryToolsSource`, `createPackedToolsSource`, `readHostToolVersions`, `toolsContentKey`.
- `tools-filler.js`: the fixed program of the filler container and the framing of its stdin.
- `tools-pack.js`: `packLocalTools` packs the local `web` and `sdk` packages of a checkout for a development build. Nothing calls it yet except tests. Deciding when a host is a development build is wiring for a later stage.
- `places/registry.js`: place registry, same pattern as the tunnel provider registry. Sealed after boot.
- `places/docker.js`: the local Docker place. `createDockerPlace({ runCommand, dockerPath, owner, toolsSource, wait, now })`. `wait` is the pause used by rollbacks and by the readiness wait. `now` stamps the tools labels and is the clock of the readiness wait. Both are injectable so tests do not sleep.
- `places/docker-tools.js`: the tools volume of the Docker place. Ensure, fill, fill rollback, pruning.
- `places/docker-engine.js`: how both of them call the docker CLI. Run, inspect, find by label, remove.
- `hardening.js`: the `docker create` argv for a space, the argv for its network and for the three one-shot containers, and the pure checker that compares `docker inspect` output with them.
- `labels.js`: label keys, resource names, space ids, tools keys, label parsing.
- `run-command.js`: the only file that starts a process.
- `errors.js`: `SpaceError` with a `code`.
- Test support, never imported by product code: `places/contract-suite.js`, `places/escape-suite.js`, `places/memory-place.js`, `places/fake-docker.js`, `places/docker-live-support.js`.

## Place contract

A place has a non-empty `id` and these operations. The registry rejects a place that lacks one.

| Operation | Contract |
|---|---|
| `check()` | Never rejects for an expected problem. Resolves `{ available: true, version, os, arch, hostIsolation }` or `{ available: false, code, message }`. The message names what the user must fix. `hostIsolation: false` means a space on this place could reach services that listen on the place's host. It is a capability, and the manager decides later what to do with it. |
| `create(spec)` | `spec` is `{ id, name, project, created, memoryBytes }`. Resolves when the space runs, verifies clean, and its server inside reports OpenCode ready. Rejects with code `space_name_taken` when the id is in use. A rejected create has rolled back. `details.rollbackFailures` lists what it could not remove, and `details.uncertain: true` means a step was interrupted and the place may still finish it, so the caller should show the spaces list. |
| `list()` | Resolves `[{ id, name, project, created, state, orphans, damaged, missing }]`. `state` is `running`, `exited`, or `missing`. `orphans` lists `{ kind, name }` resources whose space container is gone. `damaged: true` means the container exists and `missing` names its lost network or volumes. `list` only reads and repairs nothing. A place failure rejects. It never resolves an empty list instead. |
| `exec(spaceId, argv, { stdin, timeoutMs })` | Runs `argv` as the space user. Resolves `{ code, stdout, stderr }` for any exit code of the command. |
| `stop(spaceId)`, `start(spaceId)` | Keep files. `start` resolves when the server inside is ready again. A running space is left alone. A stopped space moves to the current tools first, see "New tools at the next start". `start` is the only operation that repairs a half-done move. |
| `remove(spaceId)` | Resolves `{ removed, failed }`. Missing resources count as removed. Removing an unknown space resolves with both lists empty. |
| `verify(spaceId)` | Resolves the list of `{ check, message }` violations. Empty means verified. |

`connect` from DESIGN.md arrives with the dispatcher stage. Stage 1b talks to the server inside through `exec` only, see "The exec channel".

A new place is done when `runPlaceContractSuite` and `runEscapeSuite` pass against it.

## Labels

Labels are the only record of a space. Every container, network, and volume carries all of them.

| Label | Value |
|---|---|
| `openchamber.space` | `true`. The marker. |
| `openchamber.space.id` | 12 lowercase hex characters from `crypto.randomBytes`. |
| `openchamber.space.role` | `space`, `setup`, `network`, or `volume`. |
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

`buildSpaceCreateArgs`, `buildSpaceNetworkArgs`, and `findHardeningViolations` in `hardening.js` belong together. Change them together, and add an escape test for every new restriction. The environment and the command of a space come from `layout.js`.

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
| `--network <space network>` | The only network is the space's own. The gatekeeper joins it in stage 2. |
| `--mount type=volume` twice | Work volume at `/spaces/<id>`, home volume at `/home/space` with `HOME` set. `type=volume` cannot turn into a bind mount, unlike `-v`. |
| `--mount type=volume,...,readonly` once | The tools volume at `/opt/openchamber-tools`. Read-only, because every space of this owner runs its programs from it. An agent that could write there would change what the next space runs. |
| `--env` five times | See "The server inside a space". Never the server password and never `OPENCODE_AUTH_CONTENT`. |

The network is created with `--internal`, `--ipv6=false`, and `--opt com.docker.network.bridge.gateway_mode_ipv4=isolated`.

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
| `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1` | A space has no way out, so these downloads could only fail. |
| `npm_config_fetch_retries=0` | OpenCode installs `@opencode-ai/plugin` in the background into every config directory, and its tool registry waits for that install. Measured with OpenCode 1.18.31 and no network: the first request for a project with `.opencode/tool/*.ts` took 131 seconds. With this variable it took 0 seconds. OpenCode's npm layer reads `npm_config_*` through `@npmcli/config`. `NODE_PATH` does not help, the compiled binary ignores it. |

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

`create` checks that its five names are free, then creates. On any failure after that check it removes everything labelled with the new id and this owner, containers first, then volumes, then the network. That covers every step up to the readiness wait: a space whose server never becomes ready is removed too. The tools volume stays, because other spaces use it. It rejects with the original error's code, and `details.rollbackFailures` lists what it could not remove. The pulled image stays, because spaces share it.

The name check sits outside the rollback on purpose. If the id is taken, the resources belong to an existing space and must survive the failed call.

After an interrupted step (`command_timeout`, `command_killed`, or `command_output_too_large`) the daemon may still finish the step whose CLI died. `create` then sweeps, waits two seconds, and sweeps again. The second sweep also inspects the five names directly and removes the ones that exist, labelled or not. This covers a late `docker run` or `docker create`: it makes a missing `src=` volume again, and that volume has no labels. This by-name removal, and the two for a tools volume described in "Fill rollback", are the only places in the module where a resource without our labels can be deleted. It is safe because the same call confirmed all five names absent moments earlier, and the names hold a random 48-bit id, so nobody else makes them in between. The error carries `details.uncertain: true`, so the caller can tell the user to look at the spaces list.

The manager verifies again after `create` and removes a space that reports violations or cannot be inspected. For the Docker place this repeats a check that already passed. It stays because the guarantee must hold for every place, including a place whose `create` forgets to verify.

`list` and `remove` tolerate a resource that vanishes between the listing and the inspect. Docker exits 1 for the missing name and still prints the entries it found, and those are used. Any other inspect failure rejects. `remove` also counts "removal of container ... is already in progress" as removed.

## Process rules

`run-command.js` spawns the executable directly with an argv array, `shell: false`, and `windowsHide: true`. No `cmd.exe`, no shell strings. Every call has a timeout that kills the child, and an output cap. The Docker place receives the runner as a dependency, so tests pass a fake and never mock a module.

A timeout kills the `docker` CLI only. A command started with `exec` keeps running inside the space.

`stdin` is a string or a Buffer. A Buffer reaches the child byte for byte, which is how the tarballs of a development build reach the filler. `cwd` sets the working directory and is used by `tools-pack.js` only.

`check()` says the CLI is missing only for `ENOENT`. Any other spawn error names its errno. `check()` also reads `docker info --format '{{json .SecurityOptions}}'` and reports the place unavailable when the engine has no builtin seccomp profile. Older engines name that profile `default`.

## Verified and not verified

Verified on 2026-09-20 on macOS with Colima, Docker Engine 29.2.1, linux/arm64, with `web` 1.24.2 and OpenCode 1.18.31:

- Every unit, contract, and escape test, the live tests of the server inside, and the live test of a development build. The escape suite has 34 tests. The contract suite is unchanged from 1a and passes with the server running inside.
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

Not verified for stage 1b:

- A real agent turn. No model key was used, so OpenCode only reached "ready".
- A fill through a slow or filtered link, and a private npm registry.
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

Each live file uses an owner id of its own, removes its spaces, helper containers, and tools volumes in `afterAll`, and then fails if any container, network, or volume with that owner label remains. An owner of its own also means a tools volume of its own, so every live file pays for one fill of about 40 seconds. The first run pulls the image, about 1.6 GB. The whole live run took 128 seconds here.

`places/contract-suite.js` is a fixed contract. It passes unchanged against the memory place, the fake Docker, and live Docker.

`places/fake-docker.js` answers like the docker CLI for the subcommands the place uses. It knows tools volumes and their fill marker, the three one-shots, container ids, `rename`, a container name that is in use, a volume that is in use, a CLI that cannot reach the daemon and exits with 1, and the server inside a space, which answers `/health` once its token is there. Its `wait` moves its own clock, so no test sleeps. `docker.test.js` uses it for tools reuse, fill, fill failure, interrupted fill, a stranger's volume, two creates that share one fill, the readiness timeout, the token that never shows in an argument, a marker check that Docker could not run, a marker for other content, a tools volume that came back without labels, and the move to new tools with its rollbacks, including the old container that got its name back before the create landed.

`space-server.test.js` feeds the channel every hostile answer listed under "The exec channel".

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

The escape suite's space has 1 GiB of memory since 1b, up from 256 MiB, because the server and OpenCode hold about 370 MiB at rest. The memory attempt stays meaningful: the allocating process grows to about 650 MiB, far more than any other process in the space, so it is the one the kernel kills. The test still demands exit code 137 and a running space.

The read-only filesystem, `su`, `sudo`, and `/proc/self/status` checks have no control of their own. They rely on the write control at the top of the suite.

To look for leftovers by hand:

```
docker ps -a --filter label=openchamber.space
docker network ls --filter label=openchamber.space
docker volume ls --filter label=openchamber.space
```
