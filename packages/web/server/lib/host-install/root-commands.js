import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createRootPasskeys } from '../hostd/passkey.js';
import { createProjectSharing } from '../hostd/share-project.js';
import { ensureAccounts, fail, FRONT_HOME } from './accounts.js';
import { setupAgentDocker, setupFrontDoorDocker } from './agent-docker.js';
import { writeAgentLink } from './agent-link.js';
import { prepareBackup } from './backup.js';
import { ownTree, readOptional, requirePhysicalDirectory, shareSettingsProjects } from './migrate-accounts.js';
import { agentUnit, appUnit, AGENT_UNIT, APP_UNIT } from './host-units.js';
import { ADMIN_GROUP, CLIENT_GROUP, layout as protectedMcpLayout } from '../protected-mcp/service/install-layout.js';
import { createSystem, exists, layout, readJson, trustedToolchain, writeConfig, writeRootFile } from './host-support.js';

export const ROOT_COMMANDS = ['approve-root-passkey', 'root-passkeys', 'revoke-root-passkey', 'share-project', 'unshare-project', 'repair-permissions', 'backup-prepare', 'rotate-agent-token', 'setup-agent-docker', 'setup-front-docker'];

export const projectSharing = ({ system, root, accounts }) => createProjectSharing({
  human: accounts.human, agent: accounts.agent,
  run: system.runResult,
  statePath: path.join(root, '/var/lib/openchamber-hostd/shares.json'),
});

async function approve({ passkeys, confirm, say, input, output, signal, sleep, now }) {
  if (confirm) return { approved: await passkeys.confirmApproval({ fingerprint: confirm }) };
  if (!input.isTTY || !output.isTTY) fail('confirmation_required', 'Use a terminal to begin approval, or --confirm <fingerprint> to confirm a waiting passkey');
  const pending = await passkeys.beginApproval();
  say(`Approval code: ${pending.code}`);
  say('Enter it in Settings -> Isolated spaces -> Root spaces.');
  try {
    while (now() < pending.expiresAt) {
      signal?.throwIfAborted();
      const candidate = await passkeys.pendingCandidate();
      if (candidate) {
        say(`Label: ${JSON.stringify(candidate.label)}\nOrigin: ${candidate.origin}\nFingerprint: ${candidate.fingerprint}`);
        const terminal = createInterface({ input, output });
        const interrupted = new AbortController();
        terminal.once('SIGINT', () => interrupted.abort(new Error('Approval cancelled')));
        try {
          const expiry = AbortSignal.timeout(Math.max(1, pending.expiresAt - now()));
          const questionSignal = AbortSignal.any([...(signal ? [signal] : []), expiry, interrupted.signal]);
          const answer = await terminal.question('Type yes to approve: ', { signal: questionSignal });
          if (answer !== 'yes') fail('approval_cancelled', 'Passkey approval cancelled');
          return { approved: await passkeys.confirmApproval({ fingerprint: candidate.fingerprint }) };
        } finally { terminal.close(); }
      }
      await sleep(1000);
    }
    fail('approval_expired', 'The approval code expired');
  } finally { await passkeys.cancelApproval(); }
}

async function repair({ system, root, accounts, sharing, say }) {
  const changed = [];
  for (const [directory, account] of [
    [FRONT_HOME, accounts.front], [accounts.agent.home, accounts.agent],
    ['/var/lib/openchamber-protected-mcp', null], ['/var/lib/openchamber-hostd', { uid: 0, gid: 0 }],
  ]) {
    const target = path.join(root, directory);
    if (!await exists(target)) continue;
    await requirePhysicalDirectory(root, target);
    const identity = account ?? await system.account('openchamber-mcp');
    await ownTree(system, target, identity);
    await fs.chmod(target, 0o700);
    changed.push(directory);
  }
  const journal = path.join(root, FRONT_HOME, 'migration.json');
  if (await exists(journal)) { await system.chown(journal, 0, 0); await fs.chmod(journal, 0o600); }
  // The protected MCP service's configuration names its socket groups by number. A restore brings
  // back the old host's numbers; the service then cannot hand its sockets to its own groups.
  const serviceConfig = protectedMcpLayout(root).serviceConfig;
  const service = await readJson(serviceConfig);
  if (service) {
    const groupId = async (name) => Number((await system.run('getent', ['group', name])).split(':')[2]);
    const repaired = { ...service };
    for (const [key, group] of [['engineSocketGroup', CLIENT_GROUP], ['adminSocketGroup', ADMIN_GROUP]]) {
      if (service[key] === null || service[key] === undefined) continue;
      const id = await groupId(group);
      if (!Number.isSafeInteger(id) || id < 0) fail('group_unknown', `There is no group ${group}: install OpenChamber again before repairing`);
      repaired[key] = id;
    }
    if (JSON.stringify(repaired) !== JSON.stringify(service)) {
      await writeRootFile(system, serviceConfig, `${JSON.stringify(repaired, null, 2)}\n`);
      changed.push(protectedMcpLayout().serviceConfig);
    }
  }
  const text = await readOptional(path.join(root, FRONT_HOME, '.config/openchamber/settings.json'));
  return { changed, projects: await shareSettingsProjects({ settings: text ? JSON.parse(text) : {}, sharing, say }) };
}

/** All authority comes from root-owned host.json, never command-line account names. */
export async function rootCommand(command, {
  root = '/', system = createSystem(), say = () => {}, argument, into, confirm,
  input = process.stdin, output = process.stdout, signal, now = Date.now, passkeys: suppliedPasskeys,
} = {}) {
  if (!system.isRoot()) fail('root_required', 'Run this as root');
  if (!ROOT_COMMANDS.includes(command)) fail('usage', `Unknown root command ${command}`);
  const paths = layout(root);
  const config = await readJson(paths.configFile);
  if (!config) fail('not_installed', 'OpenChamber is not installed on this host');
  if (!config.separation && !['root-passkeys', 'revoke-root-passkey', 'backup-prepare'].includes(command)) fail('agent_separation_missing', 'Install with --separation first');
  if (['share-project', 'unshare-project', 'revoke-root-passkey'].includes(command) && !argument) fail('usage', 'Give a project path or passkey ID');
  if (['approve-root-passkey', 'root-passkeys', 'revoke-root-passkey'].includes(command)) {
    const state = path.join(root, '/var/lib/openchamber-hostd');
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    await fs.chmod(state, 0o700);
    const passkeys = suppliedPasskeys ?? createRootPasskeys({
      stateFile: path.join(state, 'root-passkeys.json'), pendingFile: path.join(state, 'root-passkey-approval.json'),
      verify: async (options) => (await import('@simplewebauthn/server')).verifyAuthenticationResponse(options),
    });
    switch (command) {
      case 'root-passkeys': return { passkeys: await passkeys.list() };
      case 'revoke-root-passkey': return passkeys.revoke(argument);
      case 'approve-root-passkey': return approve({ passkeys, confirm, say, input, output, signal, sleep: system.sleep, now });
    }
  }
  const accounts = command === 'repair-permissions'
    ? await ensureAccounts({ system, root, config, say })
    : { human: await system.account(config.owner), front: await system.account(config.separation?.frontDoor ?? config.owner), agent: await system.account(config.separation?.agent ?? config.owner) };
  const sharing = projectSharing({ system, root, accounts });
  switch (command) {
    case 'share-project': return sharing.share(argument);
    case 'unshare-project': return sharing.unshare(argument);
    case 'repair-permissions': return repair({ system, root, accounts, sharing, say });
    case 'backup-prepare': return prepareBackup({ root, system, config, accounts, paths, into });
    case 'rotate-agent-token':
      await writeAgentLink({ system, paths, config, rotate: true });
      await system.systemctl(['restart', AGENT_UNIT, APP_UNIT]);
      return { rotated: true };
    case 'setup-agent-docker': {
      const docker = await setupAgentDocker({ root, system, agent: accounts.agent, say });
      if (docker.status === 'ready') {
        config.separation.docker = true;
        const toolchain = await trustedToolchain(system, accounts.human, root);
        await writeRootFile(system, paths.unit(AGENT_UNIT), agentUnit({ config: { ...config, ownerUid: accounts.human.uid }, agent: accounts.agent, toolchain, live: paths.live }));
        await writeConfig(system, paths, config);
        await system.systemctl(['daemon-reload']);
        await system.systemctl(['restart', AGENT_UNIT]);
      }
      return { docker };
    }
    case 'setup-front-docker': {
      const docker = await setupFrontDoorDocker({ root, system, front: accounts.front, say });
      if (docker.status === 'ready') {
        config.separation.frontDocker = true;
        const toolchain = await trustedToolchain(system, accounts.human, root);
        await writeRootFile(system, paths.unit(APP_UNIT), appUnit({ config, owner: accounts.human, front: accounts.front, toolchain, live: paths.live }));
        await writeConfig(system, paths, config);
        await system.systemctl(['daemon-reload']);
        await system.systemctl(['restart', APP_UNIT]);
      }
      return { docker };
    }
    default: fail('usage', `Unknown root command ${command}`);
  }
}
