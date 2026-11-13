# Moving from per-domain MCP brokers to the protected MCP service

On a host that runs dev-server's `workspaces` role, one broker per domain and
provider holds the MCP credentials, and the `dev-server.workspaces` OpenCode
plugin selects the brokers per project. After the cutover, OpenChamber's
protected MCP service holds the credentials and OpenChamber selects the
connections per project. Git identities, signing, VPN and backups stay as they
are.

Every step runs as a person with root on the host. Nothing in these steps puts a
credential where the agent's account can read it. The manifest holds only file
paths and key names, and the migration reads each credential as root and writes
it only into the service's private state.

## 1. Install the service and keep the brokers running

On a host where OpenChamber itself is a host install (`install.sh --host`, see
`../host-install/DOCUMENTATION.md`), the service is already installed and
updated with OpenChamber; go to step 2. Otherwise install it alone:

```bash
curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh \
  | sudo bash -s -- --protected-mcp --engine-user dev --engine-unit openchamber.service
```

The installer asks for no password. It creates the groups `openchamber-mcp-clients`
and `openchamber-mcp-admins`, adds the engine account to both and prints the
boundary status. If any finding is an `error`, it stops before it starts the
service and names the findings. Fix them and run it again, or add
`--accept-unprotected` to install anyway with the status `unprotected`. A
root-owned Docker socket the agent can reach is one such finding.

Reinstalling with a different `--engine-user` removes the previous account from
both groups and prints that change. Stop the old account's engine processes,
because processes keep their supplementary groups until they exit.

This is stage 1 of the design. OpenChamber administers protected MCP as the
engine account, through the admins group, and the agent runs as that same
account. An agent acting on purpose can therefore reach administration, and
change the protected servers or capture a secret while you type it. What stage 1
protects is credentials an agent could read by accident, in files and
environments. Stage 2, which runs the agent under an account of its own, is not
built yet.

Restart OpenChamber once so its account picks up both groups. Brokers keep
serving the projects meanwhile.

## 2. Build the manifest from the catalog

```bash
sudo node /usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/dev-server-manifest.js \
  --catalog /home/dev/workspace/dev-server/ansible/group_vars/all/workspaces.json \
  --brokers /etc/dev-server/workspaces.json \
  --out /root/protected-mcp-manifest.json
```

`--catalog` is the workspace catalog in the dev-server checkout of the account
step 1 passed as `--engine-user`, and it gives each provider's settings.
`--brokers`, the catalog dev-server renders for its plugin, says which brokers
run and where. Neither holds a credential. The command also prints, on stderr,
every provider that needs a person, with an action and a reason:

| Action | Meaning |
| --- | --- |
| `authorize` | An OAuth grant stays with the old broker. Sign in to the new connection once in Settings, as step 3 shows. |
| `bridge` | The service has no equivalent yet. Atlassian's group policy, AWS grants and Google `workspace-mcp` are such cases. The connection reaches the running broker on this machine, which keeps its credential, grants and policy. Keep that broker. |
| `skip` | No broker runs for the provider, so nothing moves and no failing entry appears. |
| `check` | Read the reason. Either the provider was migrated with a caveat, such as a Microsoft app registration that is not carried over, or it was left out because the rendered catalog names a broker that is not plain `http` on this machine, and it keeps that broker. |

Without `--brokers`, providers the service cannot take over are listed as
`keep-broker` and stay with the dev-server plugin.

Before step 3, read the destinations in the manifest: for each connection its
URL, command, arguments and environment values, and for each bridge its
address. The catalog lives in the engine account's home, so in stage 1 an agent
acting on purpose could have changed paths, arguments or environment values
there that step 3 then binds to the real credentials; the origins of the
connection URLs and the executables are fixed in the code, and bridge addresses
come from the root-owned `--brokers` file. The manifest holds no credential, so
this prints none:

```bash
sudo node -e '
const manifest = JSON.parse(require("fs").readFileSync("/root/protected-mcp-manifest.json", "utf8"));
for (const c of manifest.connections) console.log(c.source, JSON.stringify(c.definition.http ?? c.definition.stdio));
'
```

Each line starts with the provider as `dev-server:<domain>/<provider>`, and a
bridge's URL is the address of its broker. An environment value such as
`GITLAB_API_URL` decides where a server sends its credential, so check those
too.

## 3. Migrate with the service stopped

```bash
sudo systemctl stop openchamber-protected-mcp
sudo node /usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/migrate.js apply \
  --manifest /root/protected-mcp-manifest.json --dry-run
sudo node /usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/migrate.js apply \
  --manifest /root/protected-mcp-manifest.json
sudo systemctl start openchamber-protected-mcp
```

The dry run checks the manifest and that every credential file exists, and
writes nothing. The report shows a short fingerprint of each credential, so you
can match it with the source without seeing it. If a run stops half way, run it
again. It finishes a connection it created but did not complete, state files
included, and reports it `resumed`, or `would-resume` in a dry run. A
connection it already finished reports `present`.

Then sign in to every `authorize` connection. Open Settings → MCP, open the
connection and choose "Sign in". The browser goes to the provider and returns
to OpenChamber. While the page shows "Waiting for the sign-in", it shows the
authorization address with "Open" and "Copy". If the automatic tab was blocked,
choose "Open". It also offers
the field "Address the sign-in tab ended on". If the tab that finishes the
sign-in cannot reach OpenChamber, copy the address from that tab's address bar,
paste it into the field and choose "Finish".

A provider whose client is registered with fixed addresses, such as Harness's
public client, refuses the address OpenChamber derives from where you open it.
On the connection's page, set "Fixed redirect address" to an address the client
accepts, for example the `http://localhost:<port>/callback` dev-server uses, and
choose "Save". The save drops the connection's stored credentials, as any
change to its OAuth settings does, so sign in after it. The browser then lands
on the fixed address, so every sign-in for the connection ends by pasting.
Choose "Sign in", copy the address the tab ended on, paste it into "Address the
sign-in tab ended on" and choose "Finish". If the provider still refuses,
choose "Delete server" in its card's menu and keep that provider on its
dev-server broker.

After a sign-in, a destination or typed-secret save, enabling a connection or
"Forget stored credentials", Settings reconnects every name of that connection
used in the current project. Other projects show the server as failed until
reconnected there, for example from the chat's MCP menu. Tools autosave still
works after forgetting credentials, and missing secrets stay missing until
typed again. A destination change still requires every secret again.

Deleting or forgetting credentials finishes locally before the service asks
the provider to revoke its tokens. A provider failure does not undo the local
change. A repeated DELETE still cleans selections when the connection is
already gone. `selectionsNotUpdated` reports files that need cleanup, or
`mcp-protected` if its directory could not be listed; fix the filesystem problem
and retry DELETE to finish cleanup.

## 4. Select the connections in OpenChamber

The manifest's `selections` reproduce what the plugin did, and `migrate.js`
prints them with its report. Each project gets its domain's connections under
the provider names it used before, such as `github` and `sentry`. The protected
connections appear as cards with a lock in the main MCP list in Settings → MCP.
With the project chosen at the top of that page, choose "Use in this project"
from each card's menu, or "Use in all projects". Selections take effect without
restarting OpenChamber or OpenCode. A new project needs no registration
anywhere. Select its connections in Settings, or use them in all projects. For
a script, `DOCUMENTATION.md` next to this guide lists the routes under
Administration through OpenChamber.

Until step 5 the dev-server plugin still injects entries under the same names,
and either one may win. Both reach working servers.

## 5. Switch the dev-server plugin off

With `--brokers`, once every provider that runs has a working protected
connection, turn off dev-server's `workspaces` OpenCode plugin,
`config/opencode/plugins/workspaces.ts`, and deploy. The protected selection is
then the only entry of each name. When a provider keeps its broker, because the
manifest left it out under `check` or its sign-in still fails, or when you built
the manifest without `--brokers`, keep the plugin. Drop from the catalog only
the providers that moved, so the ones on their brokers still reach their
projects.

Check a session in a migrated project: the tools of each provider answer. With
that project chosen in Settings → MCP, each protected card the project uses
shows the OpenCode status, "Connected" when it works. A card shows "Ready" only
where the project does not use it.

## 6. Remove the old brokers, when you are ready

Wait until the protected connections have worked for a while. Then disable and
remove the `mcp-<domain>-<provider>` units of the providers that moved, their
environment files under `/etc/dev-server/mcp/<domain>/` and their state under
`/var/lib/dev-server-mcp/`. Keep the brokers that bridged connections reach and
those of the providers that stayed on the plugin. That change belongs to
dev-server and ships with its own playbook; OpenChamber does not make it.

## Going back

You can undo each step on its own:

- **Before step 5.** Nothing to undo for the projects, because the plugin still
  injects the brokers. Remove the selections in Settings if you added them.
- **After step 5.** Switch the plugin back on, or put the providers back into
  the catalog, and deploy. The brokers never stopped, so their credentials
  still work.
- **To remove what the migration created.** Stop the service, run
  `migrate.js rollback`, then start the service again. Only the migrated
  connections go.

  ```bash
  sudo systemctl stop openchamber-protected-mcp
  sudo node /usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/migrate.js rollback
  sudo systemctl start openchamber-protected-mcp
  ```

- **To remove the service.** Run the installer with
  `--protected-mcp-uninstall`. It stops the service and removes its unit, its
  code, `client.json` and `service.json`. It keeps the state, credentials
  included, the `openchamber-mcp` account and both groups for a reinstall.

  ```bash
  curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh \
    | sudo bash -s -- --protected-mcp-uninstall
  ```

  Add `--purge-state` to delete the state, the `openchamber-mcp` account and
  both groups as well, and `--engine-user dev` so the engine account leaves
  both groups first.

  ```bash
  curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh \
    | sudo bash -s -- --protected-mcp-uninstall --purge-state --engine-user dev
  ```

No step writes a credential back into the engine's reach.
