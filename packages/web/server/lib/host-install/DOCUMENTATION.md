# Host install module

The host install puts OpenChamber on a Linux host with systemd as a system
service, from one root command:

```bash
curl -fsSL https://raw.githubusercontent.com/rubimpassos/openchamber/main/scripts/install.sh \
  | sudo bash -s -- --host --owner <account> [--port 3000] [--host 127.0.0.1] [--repo owner/name]
```

Fresh installs separate the human, front door and agent accounts. Existing
installs retain their account mode until an explicit `install --separation`.
`--no-separation` selects the original single-account mode on a fresh install.
The protected MCP service and root updater keep their own identities.

## Ownership

- `host.js` runs as root and orchestrates install, update, rollback and removal.
  `host-deploy.js` owns promotion and restoration of code, units and account mode.
  `host-package.js` owns staging and sealing the release package;
  `host-rollback.js` restores a prior package's account mode and units.
- `accounts.js` owns account provisioning and account-mode compatibility.
  `host-units.js` owns systemd text; `host-support.js` owns privileged operations
  injectable into the fake system used by the tests.
- `migrate-accounts.js` owns first-separation copies and the migration journal.
  `root-commands.js` consumes hostd's passkey and project-sharing APIs in-process.
  `backup.js` prepares SQLite snapshots; `agent-link.js` owns token files;
  `agent-docker.js` provisions the agent's optional rootless Docker.
- `release.js` finds a release's web package on GitHub and downloads it,
  checked against the SHA-256 digest GitHub records for the asset.
- `main.js` is the command line `scripts/install.sh --host` and the updater
  unit run.
- `managed.js` runs as the owner, in the server and the CLI. It tells whether
  this copy is the host install and asks the root updater for an update.
- `scripts/install.sh --host` bootstraps a host with no OpenChamber: it
  downloads and verifies the package, unpacks it as root and hands it to
  `main.js install`.

## Layout

| Path | Owner, mode | What it is |
| --- | --- | --- |
| `/usr/lib/openchamber/<version>-<random>/node_modules/@openchamber/web` | `root:root`, `0755`/`0644` | Installed package; `current` and `previous` link to these directories |
| `/etc/openchamber/host.json` | `root:root 0644` | Human owner, repository, listener, updates, protected MCP, `separation`, and `skipVersion` after a rollback |
| `/etc/openchamber/previous-deployment.json` | `root:root 0600` | Prior package directory, account-mode config and unit text for manual rollback; no env secrets |
| `/etc/openchamber/openchamber.env` | `root:root 0600` | Environment for OpenChamber, such as `OPENCHAMBER_UI_PASSWORD` |
| `/etc/openchamber/agent-link.env` | `root:root 0600` | Agent loopback URL and token consumed by the front door |
| `/etc/openchamber/agent.env` | `root:root 0600` | Matching server password, agent mode, relay disabled |
| `/var/lib/openchamber-host/requests/` | front door, `0700` | Where OpenChamber drops the empty `update` request file |
| `/var/lib/openchamber/` | `openchamber`, `0700` | Front-door home, with authoritative data in `.config/openchamber` |
| `/var/lib/openchamber/migration.json` | `root:root 0600` | Source, target, class and outcome of each migration entry |
| `/home/<owner>-agent/` | agent, `0700` | Agent's own data, OpenCode, tools and rootless Docker |
| `/etc/systemd/system/openchamber.service` | `root:root 0644` | Front door; original mode runs as the human |
| `openchamber-agent.service` | `root:root 0644` | Agent-only API server on loopback; separate mode only |
| `openchamber-hostd.socket`, `.service` | `root:root 0644` | Root operations, activated through a socket owned by the front door |
| `openchamber-updater.service`, `.timer`, `.path` | `root:root 0644` | The updater, its daily timer and the request trigger |
| `/usr/local/bin/openchamber` | link | The installed CLI, unless that name was already taken |
| `/usr/local/sbin/openchamber-host` | `root:root 0755` | Root installer CLI using the trusted Node toolchain and live current package |

## Accounts and systemd

`owner` always names the human who owns projects. With separation enabled,
`separation` names `{ frontDoor: 'openchamber', agent: '<owner>-agent', agentPort: 41890 }`.
`--agent-user` and `--agent-port` override agent defaults during installation.
The installer refuses root, reused identities and conflicting homes. An existing
`openchamber` account must have home `/var/lib/openchamber` and a nologin shell.
An existing agent account must be a regular account (uid 1000 or more) whose home
lies outside the human's home, the front door's home and the system folders.
Neither may be in a group that is root by another name (`ROOT_EQUIVALENT_GROUPS`
in `accounts.js`: sudo, docker, lxd, disk, shadow and the like); hostd's
`separation()` checks the same groups before it allows root spaces.
The agent has a locked password and bash; missing subordinate IDs are reported.

The front door starts only behind its UI password. An install with separation
that finds neither `OPENCHAMBER_UI_PASSWORD` nor `OPENCHAMBER_UI_PASSWORD_HASH`
in `openchamber.env` asks for a new one at the terminal, twice and without echo,
or reads it from stdin with `--ui-password-stdin`, and appends only its scrypt
hash to that file. It opens `/dev/tty` by name, because under `curl | sudo bash`
stdin is the script. Without a terminal and without the flag it refuses with
`ui_password_required` before any account or file changes; automation puts the
hash of `openchamber hash-password` into the file first. A rollback to one
account keeps the hash, so the restored server asks for the same password.

The front door runs with a system-only PATH, `ProtectHome=tmpfs`, private tmp,
`NoNewPrivileges=yes`, `ProtectSystem=full` and umask 0077. Its data-directory
in the later `agent-link.env` overrides a former human data path in
`openchamber.env`, following systemd's environment-file precedence. It wants
the agent unit and hostd socket. The agent unit has its own HOME/PATH, private
tmp, invisible other processes and explicit inaccessible paths for hostd,
front-door data/env and MCP administration. Its subject socket is a read-only
bind at `/run/openchamber-mcp`. DAC protects these boundaries even for processes
the agent starts outside its service.

Protected MCP installs with `engineUser=<agent>`, `adminUser=openchamber` and
`engineUnit=openchamber-agent.service`. The protected MCP installer removes old
admin/engine memberships; the agent joins neither MCP group. Original mode
retains its existing protected MCP arrangement.

The hostd socket is 0600, owned by the front door, with root group and a 0711
runtime directory. The root service consumes systemd's listening descriptor.
It retains the privileges needed for units, namespaces, accounts and ACLs.
Its unit has no `PrivateTmp`, `Protect*` or other option that gives it a mount
namespace of its own: hostd bind-mounts each space's network namespace pins under
`/run/openchamber-hostd/ns`, and the slirp and gatekeeper units systemd starts
must see those mounts. Inside a private mount namespace they stayed plain files,
and slirp failed with "Permission denied" (measured in the harness). The unit
keeps `NoNewPrivileges=yes`, `LockPersonality=yes` and umask 0077. It has no
`User=` line, not even `User=root`: systemd 259 then starts the service with
`LockPersonality` but without `CAP_SETUID`, and creating any host space fails
with "setresuid failed" (measured in the harness).

`setup-agent-docker` checks rootless Docker tools and both subordinate-ID
ranges, enables linger, then invokes the setup tool as the agent. Installation
attempts it once on first separation. Unavailability is reported without failing
the install. Success persists the Docker choice and writes the agent's own
`DOCKER_HOST` socket into its unit. It never joins the host docker group.

`setup-front-docker` does the same for the front door account, whose Docker
runs the Docker place of isolated spaces: a daemon the agent cannot reach, where
the docker group would make the front door root-equivalent. The front door is a
system account, which `useradd` gives no subordinate IDs, so the command first
adds one 65536-wide range after every range `/etc/subuid` and `/etc/subgid`
hold. On success its socket goes into `openchamber.service` as `DOCKER_HOST`.
Without it the Docker place says Docker is unreachable; nothing falls back to
another daemon.

## First separation

`install --separation --dry-run` prints the migration without creating accounts,
changing units, installing packages or writing destinations. A real first
separation stops the old system service before copying its data. User services
are reported separately and must be stopped by the human before migration.
Source data remains in place for rollback.

Sources are the old env file's absolute `OPENCHAMBER_DATA_DIR`, or the human's
`.config/openchamber`, plus their OpenCode data and configuration. Explicit
agent classes go to the agent. UI authentication, pairing, relay, Spaces,
preferences, voice and notification data stay with the front door. Unknown
entries also stay there and are reported as `unclassified`. The front door's
settings are authoritative; the agent copy uses `pickAgentSettings` from
`agent-server/settings-mirror.js`. Cache, temporary, runtime, log, binary and
lock entries are skipped.

Copies never replace an existing target. Repeating migration preserves existing
files and fills missing directory entries. Before the split the agents ran as the
human and could leave links in this data, and the copy runs as root: an entry
whose target the human does not own is never read, and the manifest records it as
`foreign-skipped`. Each file is read through a handle opened without following a
last link and checked for the human's ownership. OpenCode config symlinks resolve to
private regular copies, including versioned dev-server configuration. OpenCode
worktrees, logs and binaries are excluded from the OpenCode data copy; existing
human worktrees are listed in the report. OpenCode itself installs as the agent
through `runuser`. Each project in the source settings goes through
`createProjectSharing`; a refusal is reported per project and installation
continues. The root-only manifest is saved even after a partial failure.

If promotion fails, the prior package links, unit files, agent env files, account
mode and update-request ownership are restored before the former server starts.
New accounts and non-destructive migration copies remain for inspection or a
retry. They are never rolled back by deleting human data.

Promotion requires the expected version from both the front door and the agent.
The agent check logs in with its env token, verifies the resulting session, and
checks health through that cookie. A healthy front door alone cannot accept a
broken agent deployment. The live harness remains the check of actual systemd
startup and authenticated server behavior.

Manual `rollback` restores the prior deployment's saved configuration and units
with its package. Crossing back over first separation restores the human unit
and original env/data path; migrated copies and account homes stay intact.
The deployment snapshot never stores env-file contents or the agent token.

## Root commands

Run these as root through `openchamber-host`. `--json` emits a JSON result or
error; `--quiet` suppresses progress and keeps the result. Status needs no root.

- `approve-root-passkey` prints a code for Settings -> Isolated spaces -> Root
  spaces. It waits until expiry or Ctrl-C, then shows the proved label, exact
  origin and fingerprint. Only typing `yes` approves it. A script confirms an
  already waiting candidate with `--confirm <fingerprint>`; it never begins a
  non-interactive approval. Root passkey activation requires separation.
- `root-passkeys` lists approved credentials. `revoke-root-passkey <id>` revokes one.
- `share-project <absolute-path>` and `unshare-project <absolute-path>` apply
  hostd's human-ownership, symlink, filesystem and configuration checks, with
  its explicit partial-result reporting.
- `repair-permissions` recreates missing accounts, resolves names to current
  IDs, repairs front-door, agent, MCP and root hostd ownership, and reapplies
  project shares from authoritative settings. It does not follow restored links
  and leaves a file with more than one hard link to its owner. It rewrites the
  protected MCP service's socket group IDs from the group names, since a restore
  brings back the old host's numbers.
- `backup-prepare --into <new-absolute-directory>` prepares SQLite snapshots and
  a root-only manifest. See [backup and recovery](../../../../../docs/host-backup-and-recovery.md).
- `rotate-agent-token` replaces both root-only env files and restarts both units.
- `setup-agent-docker` retries optional rootless Docker setup and updates its unit.
- `setup-front-docker` does the same for the front door's Docker place.

`uninstall` removes all managed units and the wrapper. Env files and data remain
by default. `--purge` also removes env and protected MCP credentials; the two
account homes require the additional explicit `--purge-accounts`.

## Invariants

1. The owner account cannot change any code root runs or any code OpenChamber
   runs. Every installed file belongs to root with no group or other write
   bit, and the installer refuses a Node.js or npm the owner can replace.
2. The owner can only ask for an update. The request file carries no content;
   the updater reads the repository from `host.json`, which only root writes,
   and installs only a web package whose digest matches the one GitHub
   records. Its dependencies come from the npm registry unpinned, so npm runs
   with `--ignore-scripts` and no dependency runs code as root. node-pty and
   ripgrep ship their Linux x64 and arm64 binaries inside their packages.
3. OpenChamber never runs as root. In separated mode the front door also never
   runs as the human. The three identities must differ.
4. A unit file without the installer's marker line belongs to someone else and
   is never replaced or removed. Settings of the person running the host go
   in drop-ins, which updates keep.
5. Every install goes into a new directory, so the running server's files are
   never replaced under it, also when the same version is installed again.
   `current` moves only after the new version is installed, carries a host
   updater, passes the integrity check and has OpenCode available. When a later
   step throws, or the restarted OpenChamber does not report the new version on
   `/health` within 90 seconds, `current` and `previous` go back to what they
   were, the protected MCP service is reinstalled from the version that ran
   before, that version restarts, and `skipVersion` holds the failed one back.
6. A rollback, automatic or by `main.js rollback`, records the version it left
   in `skipVersion`. The updater does not install that version again; an
   explicit `install` or `update --tarball` clears the hold.
7. The update check of a host install reads the stable channel only, because
   the updater installs the repository's latest release. A Canary pick in
   Settings is not offered there.
8. The protected MCP service is installed before OpenChamber restarts, so the
   new OpenChamber process gets the service's groups. A host the service
   refuses still gets OpenChamber; the result and exit code 2 report it.
9. An update request is consumed before the updater works, so a failing
   update does not run again until the next request or timer. The path unit
   watches with `PathChanged=`, so a request file the owner turned into a
   directory cannot keep restarting the updater.
10. Root never deletes recursively inside the request directory. Uninstall
   first takes it from the owner, then removes the entries it knows.
11. OpenCode is installed by `../opencode/v2-install.js` running as the agent
   through `runuser`, so root never runs a binary the owner can write.
12. The agent token is 32 random bytes in base64url, created once and preserved
    across updates. It appears only in the 2 root-owned 0600 env files, never in
    a unit, argv, result or log. Token rotation is an explicit root operation.
13. Migration preserves human source data and existing destinations. The agent
    receives only the settings mirror allowlist. Project sharing uses hostd's
    checks even when invoked by the installer.

## Decisions

### Why a root updater and not a root OpenChamber server

The HTTP server, its routes, extensions and the agent it starts would all run
as root, and any defect in one of them would be root on the host. The updater
is a short oneshot. Hostd separately owns the root operations needed by Spaces;
the web server reaches it through the front door's private Unix socket.

### Why a dedicated front-door account and not the human account

The front door holds UI authentication, pairing, MCP administration and hostd
access. A dedicated private home keeps those files outside the human and
agent accounts, including the agent's user manager and rootless Docker.

### Why copy and not move

The source is the person's rollback copy. Exclusive destination creation lets
a partial migration be resumed without replacing already migrated data.

### Why ownership is repaired by name and not stored IDs

Restoring on another host can assign the same name a different ID. Repair
resolves each service account locally so a backup's numbers cannot grant
front-door or root state to an unrelated account.

### Why a request file and not a socket or sudo rule

A path unit is enough to start a oneshot, needs no listener and no password,
and the empty file gives the owner nothing to choose. A sudo rule would also
be blocked by `NoNewPrivileges=yes` on OpenChamber's own unit.

### Why GitHub's recorded asset digest and not a signature

GitHub records a SHA-256 digest for every release asset, and both the bootstrap
script and the updater check it. This trusts whoever can publish releases in
the configured repository. A signature with a key pinned at install time would
also survive a compromised GitHub account; it is not built yet.

### Why npm installs the package under root

The web package needs its dependencies and node-pty's native build. Running
npm from a root-owned Node.js into a staging directory, with an empty user
config and a root-only cache, keeps the result root-owned and leaves the
owner's npm configuration out of it.

### Why npm skips install scripts and not a lockfile

A lockfile in the release would pin every dependency, but the web package does
not ship one, and adding it changes the release pipeline. Skipping install
scripts keeps unverified dependency code from running as root today; the
dependencies are still resolved at install time, so two installs of one
version can differ. A shrinkwrap in the release would close that.

### Why releases without a host updater are refused

A release published before this module would replace `current` with code
that has no `main.js`. The updater unit would then fail on every run and the
host could not update again without a person.
