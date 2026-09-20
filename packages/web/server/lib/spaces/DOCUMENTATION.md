# Spaces module

Design, words, and product decisions are in [docs/isolated-spaces/DESIGN.md](../../../../../docs/isolated-spaces/DESIGN.md). Read it first. Stages are in `STAGES.md` next to it, test rules in `TESTING.md`.

This is stage 1a. Nothing imports the module yet: no routes, no settings, no UI.

## What the module owns

Creating, finding, stopping, starting, and removing isolated spaces on a place, and proving that a created space has the restrictions it was asked for.

- `manager.js`: `createSpaceManager({ registry, now })`. Generates the space id, builds the spec with the default memory limit of 4 GiB, calls the place. Keeps no state file and no cache. Every answer is read from the place at call time.
- `places/registry.js`: place registry, same pattern as the tunnel provider registry. Sealed after boot.
- `places/docker.js`: the local Docker place. `createDockerPlace({ runCommand, dockerPath, owner, wait })`. `wait` is the pause used by the rollback, injectable so tests do not sleep.
- `hardening.js`: the `docker create` argv for a space and the argv for its network, and the pure checker that compares `docker inspect` output with it.
- `labels.js`: label keys, resource names, space ids, label parsing.
- `run-command.js`: the only file that starts a process.
- `errors.js`: `SpaceError` with a `code`.
- Test support, never imported by product code: `places/contract-suite.js`, `places/escape-suite.js`, `places/memory-place.js`, `places/fake-docker.js`, `places/docker-live-support.js`.

## Place contract

A place has a non-empty `id` and these operations. The registry rejects a place that lacks one.

| Operation | Contract |
|---|---|
| `check()` | Never rejects for an expected problem. Resolves `{ available: true, version, os, arch, hostIsolation }` or `{ available: false, code, message }`. The message names what the user must fix. `hostIsolation: false` means a space on this place could reach services that listen on the place's host. It is a capability, and the manager decides later what to do with it. |
| `create(spec)` | `spec` is `{ id, name, project, created, memoryBytes }`. Resolves when the space runs and verifies clean. Rejects with code `space_name_taken` when the id is in use. A rejected create has rolled back. `details.rollbackFailures` lists what it could not remove, and `details.uncertain: true` means a step was interrupted and the place may still finish it, so the caller should show the spaces list. |
| `list()` | Resolves `[{ id, name, project, created, state, orphans, damaged, missing }]`. `state` is `running`, `exited`, or `missing`. `orphans` lists `{ kind, name }` resources whose space container is gone. `damaged: true` means the container exists and `missing` names its lost network or volumes. `list` only reads and repairs nothing. A place failure rejects. It never resolves an empty list instead. |
| `exec(spaceId, argv, { stdin, timeoutMs })` | Runs `argv` as the space user. Resolves `{ code, stdout, stderr }` for any exit code of the command. |
| `stop(spaceId)`, `start(spaceId)` | Keep files. |
| `remove(spaceId)` | Resolves `{ removed, failed }`. Missing resources count as removed. Removing an unknown space resolves with both lists empty. |
| `verify(spaceId)` | Resolves the list of `{ check, message }` violations. Empty means verified. |

`connect` from DESIGN.md arrives with the stage that needs it.

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

Rules the Docker place keeps:

- Labels are read from `docker inspect` JSON. The `Labels` column of `docker ps` is one comma-joined string, and a display name may contain commas.
- A name proves nothing. `remove` and `list` find resources by label filter, then check marker, owner, and id again on the inspect result. `exec`, `stop`, `start`, and `verify` inspect the container first and refuse one without this owner's labels.
- `create` refuses when any of its names exists, because `docker volume create` succeeds silently on an existing volume and would adopt a stranger's data.

## Hardening

`buildSpaceCreateArgs`, `buildSpaceNetworkArgs`, and `findHardeningViolations` in `hardening.js` belong together. Change them together, and add an escape test for every new restriction.

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

The network is created with `--internal`, `--ipv6=false`, and `--opt com.docker.network.bridge.gateway_mode_ipv4=isolated`.

`--internal` alone is not enough. Measured on Docker 29.2.1: from a space on a plain internal network, a TCP connect to the network's gateway address reached a listener on the Docker host. With the isolated gateway mode the bridge has no address on the host, `docker network inspect` shows no `Gateway`, and the same connect fails. The option needs Docker Engine 28. The checker looks at the option and at the missing gateway address, so an engine that ignores the option fails verification and `create` rolls back. `check()` reports such an engine with `hostIsolation: false`.

Never present: bind mounts, `--volumes-from`, the runtime socket, `--privileged`, extra security options, shared namespaces, sysctls, another runtime than `runc`, devices, published ports, a second tmpfs. The checker reports each of these. For the namespace modes it accepts `''` and `'private'`, which is what this engine reports for a correct container: `''` for pid, uts, and userns, `'private'` for ipc and cgroupns.

`create` runs `docker create`, then `verify`, then `docker start`. A container that fails the check never runs. Confirmed on Docker 29.2.1: `docker inspect` of a created container that never started already has every field the checker reads, including `NetworkSettings.Networks` and `Mounts`. The Docker place therefore has nothing left to check after the start.

Two containers exist per create. The `setup` one-shot runs as root with `--network none`, `--cap-drop ALL --cap-add CHOWN`, a 128 MiB memory limit, the same log cap, and the fixed argv `chown 1000:1000 <mount points>`, then removes itself. Fresh volumes belong to root, and the space user cannot fix that itself.

Do not add `--workdir /spaces/<id>`. Docker then resets the ownership of that empty volume to root, and the space user cannot write to its own work directory. The escape suite's positive control catches this.

Known limit: a named volume of the default driver has no size limit. A space can fill the disk of the Docker host through its work or home volume. Nothing here prevents that.

## Rollback

`create` checks that its five names are free, then creates. On any failure after that check it removes everything labelled with the new id and this owner, containers first, then volumes, then the network. It rejects with the original error's code, and `details.rollbackFailures` lists what it could not remove. The pulled image stays, because spaces share it.

The name check sits outside the rollback on purpose. If the id is taken, the resources belong to an existing space and must survive the failed call.

After an interrupted step (`command_timeout`, `command_killed`, or `command_output_too_large`) the daemon may still finish the step whose CLI died. `create` then sweeps, waits two seconds, and sweeps again. The second sweep also inspects the five names directly and removes the ones that exist, labelled or not. This covers a late `docker run` or `docker create`: it makes a missing `src=` volume again, and that volume has no labels. This by-name removal is the one place in the module where a resource without our labels can be deleted. It is safe because the same call confirmed all five names absent moments earlier, and the names hold a random 48-bit id, so nobody else makes them in between. The error carries `details.uncertain: true`, so the caller can tell the user to look at the spaces list.

The manager verifies again after `create` and removes a space that reports violations or cannot be inspected. For the Docker place this repeats a check that already passed. It stays because the guarantee must hold for every place, including a place whose `create` forgets to verify.

`list` and `remove` tolerate a resource that vanishes between the listing and the inspect. Docker exits 1 for the missing name and still prints the entries it found, and those are used. Any other inspect failure rejects. `remove` also counts "removal of container ... is already in progress" as removed.

## Process rules

`run-command.js` spawns the executable directly with an argv array, `shell: false`, and `windowsHide: true`. No `cmd.exe`, no shell strings. Every call has a timeout that kills the child, and an output cap. The Docker place receives the runner as a dependency, so tests pass a fake and never mock a module.

A timeout kills the `docker` CLI only. A command started with `exec` keeps running inside the space.

`check()` says the CLI is missing only for `ENOENT`. Any other spawn error names its errno. `check()` also reads `docker info --format '{{json .SecurityOptions}}'` and reports the place unavailable when the engine has no builtin seccomp profile. Older engines name that profile `default`.

## Verified and not verified

Verified on 2026-09-19 on macOS with Colima, Docker Engine 29.2.1, linux/arm64: every unit, contract, and escape test, and every measurement quoted in this file.

Verified on 2026-09-19 on a Windows 11 host with Docker Desktop, engine 29.6.2:

- Every contract and escape test.
- Arguments reach the container unchanged: `=`, `,`, spaces, quotes, a backslash, `%PATH%`, `^&`.
- Stdin piping works.
- A timeout leaves no orphan process on the Windows side.
- The isolated network has no gateway. The injected `*.docker.internal` names do not resolve from a space. Neither the WSL VM nor the Windows loopback is reachable from a space.
- A plain internal network there does reach services in the WSL VM through its gateway, the same gap as on Colima.

Verified on 2026-09-19 on Debian 13, linux/amd64, over `DOCKER_HOST=ssh://`:

- Engine 29.8.1 passed every contract and escape test.
- Engine 26.1.5 accepted the isolated gateway option silently and still gave the bridge a gateway address. The checker reported it, and `create` failed closed with a clean rollback.

Not verified:

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
```

The second command also runs `places/contract.docker.live.test.js` and `places/escape.docker.live.test.js` against the local Docker daemon. Each live file uses an owner id of its own, removes its spaces and helper containers in `afterAll`, and then fails if any container, network, or volume with that owner label remains. The first run pulls the image, about 1.6 GB.

Escape tests run inside a real space and pass only when the attempt fails. A positive control backs the attempts that could pass for the wrong reason:

- Network attempts first need a plain container on the default bridge to reach `example.com:443`. If it cannot, they fail as inconclusive, so an offline machine never passes them. The space then tries the address that the baseline reached.
- The host-listener attempt has two controls. The listener runs with `--network host` and reports every IPv4 address of the Docker host from the kernel's local route table. Those addresses plus `host.docker.internal` and `gateway.docker.internal` are the candidates. First a plain container must reach the listener. Then a container on a throwaway internal network without the isolated gateway mode must reach it too, which shows that the hole is real on this engine and that the probe can see it. If either control connects nowhere, the test fails as inconclusive. The space must then fail on every candidate and on every address a control reached through a name. On an engine that ignores the isolated mode, the candidates contain the gateway of the space's own bridge, and the test fails. Measured on Colima: the plain network connected through its gateway `172.19.0.1`, and the space got `ENETUNREACH` for every address and `EAI_AGAIN` for both names.
- `unshare`, `mount`, the hostname write, and `test -e` first prove that the tool or the file exists.
- The log and memory attempts check that the write and the kill really happened.

The read-only filesystem, `su`, `sudo`, and `/proc/self/status` checks have no control of their own. They rely on the write control at the top of the suite.

To look for leftovers by hand:

```
docker ps -a --filter label=openchamber.space
docker network ls --filter label=openchamber.space
docker volume ls --filter label=openchamber.space
```
