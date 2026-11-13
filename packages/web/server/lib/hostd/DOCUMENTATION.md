# Host daemon

## Ownership

hostd is the root process behind the Linux `host` and `host-root` places. It owns systemd units, namespace pins, per-space network accounts, private metadata and sealed tools. `spaces/places/host.js` owns the unprivileged place adapter; the Spaces manager, journey, gatekeeper program and code-transfer rules remain in `../spaces/`.

The installed code and its ancestors must be root-owned and unwritable by the owner or a space. The service uses `/usr/bin/node` and Node built-ins. Socket activation supplies one Unix listener at `/run/openchamber-hostd/hostd.sock`, owned by the OpenChamber owner with mode 0600. Its parent must permit that owner to traverse it. Namespace pins have a separate root-only parent. The optional `--socket <absolute path>` listener is root-owned mode 0600 and is for disposable fixtures or root callers.

The installation and password requirement belong to the host installer and front door. This module neither installs itself nor changes a VPS service. The socket owner may run arbitrary commands in a user space. It must never be reachable by the space agent.

## Invariants

- Caller data expresses intent only. The daemon parses exact operation fields, lowercase fixed-length ids, bounded argv and a placeholder-only provider configuration. Callers cannot choose unit properties, identities, mount sources or namespaces.
- Every `host-root` create and start reaches the root activation check of `root-ops.js` before side effects; the lifecycle cannot be built without it. The check passes only when `/etc/openchamber/host.json` names separate human, front-door and agent accounts that exist and are not root, the spec is not an approval worker, and the request carries a fresh passkey assertion made for exactly this operation on exactly this space. Root execution makes no isolation promise. Exec and attach into a running root space need the same separation: after a rollback or a reinstall onto one account the human's agents hold hostd's socket, and the space they would reach runs as root.
- hostd parses requests on its one event loop, as root, before any other connection is served. Each field check costs what a comparison costs, and a size limit is checked before the elements it bounds, so a large request is refused at once.
- Before a host space starts, hostd makes the folder of its protected MCP subject (`space-<id>` under the service's subjects folder), owned as the service's other subject folders. The unit's bind of that folder is optional and systemd skips a missing source, so without the folder a grant made later never reaches the space.
- Root activation, in `passkey.js`: a person with root approves a passkey in three steps. The root command prints a code; the person proves one of their OpenChamber sign-in passkeys with that code; the root command shows that passkey's label, origin and fingerprint, and approves it only after the person confirms on that terminal. Each activation then needs a one-time challenge bound to `{ op, id, specHash }`, where the hash covers place, id, name, project, purpose and memory and never the creation time. The challenge is consumed before the signature is checked, the assertion must come from the exact origin and RP ID the passkey was approved at, user verification is required, and a counter that does not grow is refused. Challenges live in hostd's memory only.
- Project sharing, in `share-project.js`: hostd gives the agent account ACLs on one of the human's projects, and takes them back. It refuses the human's home and private folders, symbolic links on the way, projects holding the human's own configuration links, other filesystems and mounts inside, and never follows or changes a link in the walk. It needs the separated accounts, read by name from the system at each request.
- Root-only metadata lives in `/var/lib/openchamber-hostd/spaces/<id>.json`. Agent state lives under systemd's private `StateDirectory`, with separate work and home binds. A root space has no DynamicUser, so systemd would make its `StateDirectory` a plain empty folder; its unit has none and binds hostd's private work and home folders directly (`stateSource` in `units.js`). A new id must have no existing unit, state path, interface, network pin or account. Only an existing root-owned record permits restart and deletion of its resources.
- Each ordinary space and gatekeeper has its own DynamicUser. Every transient exec uses the target's complete property list, identity and network namespace, joins its private tmp, and shares its limited slice. Requisite and ordering prevent an exec from starting after its target stops; PartOf stops an existing exec with its target. The main unit, gatekeeper, slirp and exec descendants count toward the space's memory and task limits.
- Both aliases of the backing state directory are read-only in every ordinary main and exec unit. Work and home remain writable through their separate permitted binds. The agent cannot rename those backing entries into symlinks before a later root-created exec resolves them. Exec refuses a main unit that lacks this restriction and requires a restart.
- The space has only loopback and one veth on a private `10.233.0.0/16` /30, with no default route. Its peer is in a gatekeeper network namespace owned by a dedicated non-root static account's user namespace. No interface in that pair is addressed on the host.
- slirp runs as that static account with no effective, permitted, bounding or ambient capabilities. It disables host loopback and enables seccomp. Gatekeeper IP forwarding remains off. Corridor and window bind only to the veth address; control binds to the gatekeeper's own loopback.
- `host` uses read-only system files, private home and runtime overlays, private shared memory, namespace and syscall restrictions, no new privileges and no capabilities. `/spaces` and `/opt` are empty overlays with only this space's permitted binds. The space cannot reach the owner socket or sibling state even when a sibling makes its files public.
- Units are generated under `/run/systemd/system` and inspected before services start. The checker reads interpreted properties and network state. Reboot removes runtime units and namespaces; records and files remain for the next explicit start. No restart policy starts a space automatically.
- Start brings up slirp and the gatekeeper before the space, waits for actual readiness, and stops the topology on failure. Idle-stop can leave the gatekeeper running, so a stopped-space start stops that old topology before replacing its pins. Stop and remove finish service shutdown before destroying namespaces. Remove then stops the space's slice and resets its units, because the space server exits non-zero on SIGTERM and would otherwise stay listed as a failed unit beside an empty active slice. Work and home must remain real directories; agent-selected symlinks cannot become root-selected bind sources on restart. Failed cleanup keeps the record and returns the failure.
- Tools fill runs as an unprivileged DynamicUser in a transient service. After its cgroup ends, root refuses symlink output roots, external links and special files, breaks hard links, removes writable modes and seals ownership. Only then does the directory become usable. Pruning retains keys used by records or fills.

### Wire contract

One request uses one connection. A frame is a type byte, a four-byte big-endian payload length and at most 1 MiB of payload. Types 1 through 5 are control JSON, stdin, stdout, stderr and stdin end. The first frame is a complete control request. Results use `{ ok: true, result }` or `{ ok: false, code, message, details? }`. Exec and attach first acknowledge acceptance, carry binary output and finish with `{ exit }` or an error. Acceptance alone does not establish that the unit started.

Operations are `check`, `list`, `disk`, `create`, `start`, `stop`, `remove`, `verify`, `exec`, `attach`, `tools-ensure` and `tools-prune`. Space operations name `place: host|host-root`; exec targets are `space|gatekeeper`. `attach` with no argv uses the shared HTTP bridge command. With argv it runs the git transport command in the same sandbox. `create` and `start` of `host-root` take `assertion`, a WebAuthn assertion as the browser makes it; any other place refuses that field.

The root operations, in `root-ops.js`, are `root-status` (whether root spaces may run, and the approved passkeys without their keys), `root-approval-challenge { code }` and `root-approval-complete { code, credential: { id, publicKey, rpID }, response, label? }` (the proof half of an approval the root command started), `root-activation-options { action: 'create', spec }` or `{ action: 'start', id }` (one challenge for one activation; a start's spec is read from hostd's own record), and `share-project`, `unshare-project`, `project-owner { path }` and `project-shares`. `project-owner` answers `{ owner }`: `agent` for a folder of the agent's own, which the front door registers without a share, `human` for one `share-project` can open, `other` for anything else, a path through a link included. The front door's project registry asks it before every new project. The passkey store and the shares live in hostd's state directory: `root-passkeys.json`, `root-passkey-approval.json` and `shares.json`.

Each space unit binds `/run/openchamber-protected-mcp/subjects/space-<id>` read-only at `/run/openchamber-mcp`, so OpenCode inside reaches the protected MCP service through the space's own subject and nothing else of the service. The bind is skipped while the service has no such subject; the gatekeeper gets none.

Small fills may use base64 `tools-ensure { key, input }`. Packed fills use `input: null`, type-2 chunks, then type 5. The aggregate upload cap is 64 MiB and the deadline is 60 seconds. Every chunk retains the 1 MiB frame cap. The first-frame deadline is 10 seconds and at most 64 clients connect at once. An EOF or socket close cancels an exec; stdin completion is represented only by type 5.

Exec defaults to 60 seconds and 4 MiB of output. Requests may select up to 4 hours and 128 MiB. `keepTail` streams output while the client retains the requested tail. A timeout, output overflow or disconnect stops the transient cgroup, including descendants. Attach has no command deadline because the dispatcher may keep its bridge alive. The client's handshake deadline ends when hostd answers: the HTTP agent sets its own idle timeout on the stream, and a request that waits on OpenCode, such as the first shell of a session, must outlast it. The request's stdout and stderr stay binary until the collecting client decodes them.

## Decisions

### Why a user-owned namespace for egress

slirp must enter the user namespace that owns the gatekeeper netns. A dedicated non-root owner lets slirp do this without initial-user-namespace capabilities. Running it as uid 0 without capabilities still permits root-authorized local services, including systemd D-Bus. `--enable-sandbox` requires that unsafe identity here and stays absent.

### Why network namespaces instead of a host firewall

An addressless veth pair with no route enforces the direct-network restriction without relying on BPF availability. `IPAddressDeny` failed open in the disposable test environment when BPF could not load. `PrivatePIDs` also stays absent because it hung shutdown in that environment.

### Why `nsenter` invokes the absolute ip executable

`ip -n` tries to remount `/sys` and fails in the rootless privileged test container. `nsenter --net=<pin> -- <absolute ip>` changes only the network namespace and successfully configures the same veths.

### Why exec acknowledges unit startup internally

Cancellation can arrive before systemd has created the transient unit. A fixed launcher emits a random marker before it execs the requested argv. The daemon strips the marker and repeats a pending stop once the unit exists. The marker does not count against output limits.

### Why successful exec may use the runner's exit

systemd 259 can garbage-collect an inactive successful transient unit immediately after `systemd-run --wait` releases it. A missing unit maps to exit 0 only when that authoritative wait returned 0. Other exits use the inspected status, including signal and OOM results.

### Why the exit recorder is inline

`ExecStopPost=+` restores root write authority, while the `/opt` overlay still hides the installed script. A fixed built-ins-only Node program in the root-owned unit records the exit atomically. It consumes only the fixed id and systemd's exit variables.

### Why state source parents are read-only

Checking source types at start cannot prevent an active agent from replacing a bind source before the next exec. Read-only source parents make those entries immutable in every agent namespace while separate work/home binds retain normal writes. Descriptor-based sources from another mount namespace failed namespace setup in the harness, so exec uses ordinary host paths behind this kernel-enforced restriction.

### Why host tools precede global programs

The host can already have global OpenChamber and OpenCode binaries. Host space PATH selects the sealed tools first so a prepared version actually runs; Docker retains its existing image-first PATH. Gatekeeper commands continue to use fixed system tools.

### Why the desktop attach helper uses Electron's Node mode

The desktop server's executable is Electron, and its helper script can live inside app.asar. The adapter uses the existing Git helper environment rule and carries `ELECTRON_RUN_AS_NODE=1` through `/usr/bin/env` in the argv. A system Node executable cannot replace Electron for an asar path.

### Why packed tools use framed stdin

The development packages exceed 4 MiB before encoding and cannot fit in a 1 MiB control frame. Bounded stdin chunks preserve that frame cap and reuse the shared filler input format. A separate aggregate cap bounds memory during upload.

### Why uv extraction precreates its directory

GNU tar 1.35 uses `openat2` for archive directory traversal. DynamicUser's implicit restrictions return ENOSYS for that operation in the test environment. The shared filler creates the destination and extracts with `--strip-components=1`, producing the same files under unchanged restrictions.

## Limits and validation

Host spaces share the host kernel and see its system tools. World-readable host files outside the masked paths remain readable. Work, home and private temporary storage have no disk quota. Shared memory counts toward the slice's memory limit; retained journal output uses rate limiting with no fixed per-space byte quota. New transitive npm dependencies are not locked by the tools content key. The collecting client drains buffered decoder output before treating socket close as an incomplete command, so a slow reader retains the final exit and every output byte.

slirp itself runs in the host network namespace. A compromised slirp is a local unprivileged account and can connect to host loopback services. Local services must authenticate their clients; disabling loopback in slirp protects normal forwarded traffic, not a compromised slirp process. Host-loopback and Docker-host-alias window grants are explicitly refused by the front-door host adapter. An explicitly granted private-network upstream remains allowed.

While a root space runs, the account that owns hostd's socket can run anything as root through `exec` and `attach`. Root spaces exist for the work that needs it and are never offered as an equivalent of the isolated places.

The focused unit suites cover framing, parsing, state, sealing, generated properties, adapter wiring, the root operations with a software authenticator, and the lifecycle's root check. The disposable harness runs the shared contract and escape suites plus kernel boundary and idle-stop lifecycle tests. Kernel controls and mutations use a separate unrestricted root fixture that is never part of the product protocol. Executed results, environment and deviations belong in the task evidence.
