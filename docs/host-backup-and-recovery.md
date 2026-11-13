# Host backup and recovery

The host installer keeps application code root-owned and separates front-door,
agent, protected MCP and hostd state. Backups must preserve the private data of
each account. Several paths below contain credentials; encrypt the backup and
limit who can restore or read it.

## Paths

| Path | Contents | Secrets |
| --- | --- | --- |
| `/etc/openchamber/` | Host config, policy, front-door env, agent link/env, protected MCP config | UI password and agent token |
| `/var/lib/openchamber/.config/openchamber/` | Authoritative settings, UI passkeys, JWT key, pairing, relay identity, Spaces, notifications and voice data | Yes |
| `/var/lib/openchamber/migration.json` | Migration sources, targets, classes and worktree report | Private paths |
| `/home/<agent>/.config/openchamber/` | Chats, git identities, extensions, projects, memory, queue and other agent state | Yes |
| `/home/<agent>/.local/share/opencode/` | OpenCode database and provider credentials | Yes |
| `/home/<agent>/.config/opencode/` | Agent's regular configuration copies and plugins | May contain keys |
| `/var/lib/openchamber-protected-mcp/` | MCP definitions, credentials and installed workers | Yes |
| `/var/lib/openchamber-hostd/` | Approved root passkeys, project-share records, space metadata and sealed tools | Security-sensitive |
| `/var/lib/private/openchamber-spaces/` | DynamicUser space home and work trees | Project copies and whatever the agent wrote there; granted keys and logins stay in the gatekeeper's memory |
| `/var/lib/openchamber/.local/share/docker/` | The front door's rootless Docker: image, tools and the volumes of Docker spaces | Project copies |
| Human-owned project roots | Projects stay at their existing paths | May contain project credentials |
| Agent home credential directories and rootless Docker state | SSH, CLI logins, git config and Docker volumes if the agent has created them | Yes |
| `/etc/systemd/system/openchamber*.d/` | Local unit drop-ins | May contain local environment values |

For an original single-account install, the human's OpenChamber/OpenCode data
directories replace the separate-account paths. An absolute `OPENCHAMBER_DATA_DIR`
in `/etc/openchamber/openchamber.env` selects its OpenChamber data directory.
Custom agent homes use the home in the local account database.

## Prepare each backup

Run as root, with a fresh output directory on private storage:

```sh
openchamber-host backup-prepare --into /var/backups/openchamber-snapshot-001
```

The command uses Node's SQLite online backup API for every `.db` and `.sqlite`
in the known OpenChamber data directories and the agent's OpenCode data tree.
Each copy is internally consistent while the original database remains live.
The root-only `backup-manifest.json` lists source-to-copy mappings, include paths,
live database/WAL/SHM exclusions and restore order. A failed preparation leaves
its private output for inspection and does not publish a completed manifest.
Retry into another new directory. Nothing uploads automatically.

Use those copies in place of live database files. Add the project roots,
DynamicUser space state, local unit drop-ins and any agent-home credentials or
Docker volumes required by the installation. These depend on local usage and
are not discovered by the database preparation command. Keep their account
names and custom paths with the backup. Pause services for a coordinated
application-wide snapshot if state across multiple databases or ordinary JSON
files must reflect the same instant; SQLite online backup only guarantees each
individual database's consistency.

OneDrive-style file sync alone does not produce a reliable restore. Live SQLite
files can be captured without the matching WAL, and syncing ownership numbers
can give restored files to unrelated accounts on another machine. Backup storage
also needs confidentiality and a retention policy; sync can propagate deletion.

## Restore

1. Install the same application version with the same human and agent names,
   account mode, custom homes and ports. Keep the verified release tarball with
   the backup. Stop the front door, agent, hostd and protected MCP units before
   replacing their state.
2. Restore `/etc/openchamber`, front-door and agent data, protected MCP and
   hostd state, project roots and any space/Docker volumes. Restore each prepared
   database copy to its manifest `source` path. Remove stale live `-wal` and
   `-shm` companions while the owning service is stopped.
3. Run `openchamber-host repair-permissions` as root. It resolves current account
   IDs by name, rewrites the protected MCP group IDs in its `service.json` the
   same way, repairs service ownership and mode boundaries, and reapplies
   project ACLs from authoritative settings. Review refused shares; do not grant
   access to human configuration repositories to make a restore pass.
4. Start protected MCP and the hostd socket, then agent and front door. Run
   `openchamber-host status` and verify UI login, projects, MCP and Spaces before
   discarding the old backup. Host spaces remain stopped after a reboot until
   explicitly started.

Hostd's root-only passkey approval records are part of the backup. Restore them
only from trusted storage. A root operator can list or revoke approvals with
`root-passkeys` and `revoke-root-passkey <id>`. Re-enroll through
`approve-root-passkey` if the approval records cannot be trusted.

## Reinstallable data

Installed OpenChamber versions under `/usr/lib/openchamber`, the protected MCP
code tree, managed OpenCode binaries, hostd's sealed tools, npm caches, ordinary
caches, runtime sockets and generated unit files can be recreated. Keep local
drop-ins, project data, Docker volumes and authentication state. Uninstall keeps
the account homes by default; deleting them requires `--purge --purge-accounts`.
