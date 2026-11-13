import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT, fakeSystem, FRONT, hostRoot, OWNER } from './fake-system.js';
import { cli } from './main.js';
import { rootCommand, ROOT_COMMANDS } from './root-commands.js';
import { layout } from './host-support.js';
import { setupAgentDocker, setupFrontDoorDocker } from './agent-docker.js';
import { appUnit } from './host-units.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const setup = async () => {
  const root = await hostRoot(cleanups);
  const system = fakeSystem(root);
  system.accounts.set(FRONT.name, FRONT);
  system.accounts.set(AGENT.name, AGENT);
  const paths = layout(root);
  const config = { owner: OWNER.name, separation: { frontDoor: FRONT.name, agent: AGENT.name, agentPort: 41890 } };
  await fs.mkdir(path.dirname(paths.configFile), { recursive: true });
  await fs.writeFile(paths.configFile, JSON.stringify(config));
  return { root, system, paths, config };
};
const capture = () => {
  let text = '';
  return { write: (value) => { text += value; }, value: () => text };
};

describe('root command entrypoint', () => {
  it.each(ROOT_COMMANDS)('routes %s with the correct arguments in JSON mode', async (command) => {
    // Given
    const out = capture();
    const err = capture();
    const calls = [];
    const positional = ['share-project', 'unshare-project', 'revoke-root-passkey'].includes(command) ? ['/srv/project'] : [];
    const argv = [command, ...positional, '--json'];
    if (command === 'backup-prepare') argv.push('--into', '/srv/backups');
    if (command === 'approve-root-passkey') argv.push('--confirm', 'ABCD-EFGH');
    // When
    const code = await cli(argv, { out, err, commands: { rootCommand: async (name, options) => { calls.push({ name, options }); return { result: 'done' }; } } });
    // Then
    expect(code).toBe(0);
    expect(JSON.parse(out.value())).toEqual({ ok: true, result: 'done' });
    expect(err.value()).toBe('');
    expect(calls[0].name).toBe(command);
    expect(calls[0].options).toMatchObject({ argument: positional[0], into: command === 'backup-prepare' ? '/srv/backups' : undefined, confirm: command === 'approve-root-passkey' ? 'ABCD-EFGH' : undefined });
  });

  it.each([['share-project', '--json'], ['install', '--separation', '--no-separation', '--json'], ['unknown', '--json'], ['install', '--agent-port', '--json']])('returns script-safe argument failures for %j', async (...args) => {
    // Given
    const out = capture();
    const err = capture();
    // When
    const code = await cli(args, { out, err });
    // Then
    expect(code).toBe(64);
    expect(JSON.parse(out.value())).toMatchObject({ ok: false, code: 'usage' });
    expect(err.value()).toBe('');
  });

  it('passes separation flags and numeric values to install without prompting', async () => {
    // Given
    const calls = [];
    const out = capture();
    // When
    await cli(['install', '--separation', '--owner', 'alice', '--agent-user', 'worker', '--agent-port', '41891', '--dry-run', '--quiet'], { out, commands: { install: async (options) => { calls.push(options); return { dryRun: true }; } } });
    // Then
    expect(calls[0]).toMatchObject({ owner: 'alice', separation: true, agentUser: 'worker', agentPort: 41891, dryRun: true });
    expect(out.value()).toBe('{"dryRun":true}\n');
  });

  it('requires root before reading or changing state', async () => {
    // Given
    const { root, system } = await setup();
    system.isRoot = () => false;
    // When / Then
    await expect(rootCommand('rotate-agent-token', { root, system })).rejects.toMatchObject({ code: 'root_required' });
    expect(system.calls).toEqual([]);
  });

  it('refuses approval without separation and does not begin a non-TTY ceremony', async () => {
    // Given
    const { root, system, paths } = await setup();
    // When / Then
    await expect(rootCommand('approve-root-passkey', { root, system, input: { isTTY: false }, output: { isTTY: false } })).rejects.toMatchObject({ code: 'confirmation_required' });
    await fs.writeFile(paths.configFile, JSON.stringify({ owner: 'alice', separation: null }));
    await expect(rootCommand('approve-root-passkey', { root, system, confirm: 'ABCD' })).rejects.toMatchObject({ code: 'agent_separation_missing' });
  });

  it('confirms only the explicitly named waiting fingerprint', async () => {
    // Given
    const { root, system } = await setup();
    const calls = [];
    const passkeys = { confirmApproval: async (value) => { calls.push(value); return { id: 'approved' }; } };
    // When
    const result = await rootCommand('approve-root-passkey', { root, system, confirm: 'ABCD-EFGH', passkeys });
    // Then
    expect(calls).toEqual([{ fingerprint: 'ABCD-EFGH' }]);
    expect(result).toEqual({ approved: { id: 'approved' } });
  });

  it('waits to code expiry rather than imposing a short approval timeout and cleans pending state', async () => {
    // Given
    const { root, system } = await setup();
    let now = 0;
    let cancelled = 0;
    system.sleep = async (ms) => { now += ms; };
    const passkeys = { beginApproval: async () => ({ code: 'ABCD-EFGH', expiresAt: 600000 }), pendingCandidate: async () => null, cancelApproval: async () => { cancelled += 1; } };
    // When / Then
    await expect(rootCommand('approve-root-passkey', { root, system, input: { isTTY: true }, output: { isTTY: true }, now: () => now, passkeys })).rejects.toMatchObject({ code: 'approval_expired' });
    expect(now).toBe(600000);
    expect(cancelled).toBe(1);
  });

  it('prepares private database snapshots and a restore manifest without copying live WAL files', async () => {
    // Given
    const { root, system } = await setup();
    const front = '/var/lib/openchamber/.config/openchamber';
    const agent = '/home/alice-agent/.config/openchamber';
    const databases = [`${front}/a.db`, `${agent}/nested/b.sqlite`, '/home/alice-agent/.local/share/opencode/opencode.db'];
    for (const file of [...databases, `${front}/cache/ignored.db`]) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), 'database'); }
    // When
    const result = await rootCommand('backup-prepare', { root, system, into: '/backup' });
    // Then
    expect(result.databases.map(({ source }) => source)).toEqual(databases);
    for (const file of databases) expect(result.exclude).toEqual(expect.arrayContaining([file, `${file}-wal`, `${file}-shm`]));
    expect(result.databases.some(({ source }) => source.includes('/cache/'))).toBe(false);
    expect(result.include).toEqual(expect.arrayContaining(['/etc/openchamber', '/var/lib/openchamber-hostd', '/var/lib/openchamber-protected-mcp']));
    expect(result.restoreOrder).toEqual(['install-same-version', 'stop-units', 'restore-files-and-database-copies', 'repair-permissions', 'start-units']);
    expect(JSON.parse(await fs.readFile(path.join(root, 'backup/backup-manifest.json'), 'utf8'))).toEqual(result);
    expect((await fs.stat(path.join(root, 'backup'))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(root, 'backup/backup-manifest.json'))).mode & 0o777).toBe(0o600);
    expect(system.calls.filter(([name]) => name === 'backupDatabase')).toHaveLength(3);
  });

  it('prepares backups for existing single-account installs without enabling separation', async () => {
    // Given
    const { root, system, paths } = await setup();
    await fs.writeFile(paths.configFile, JSON.stringify({ owner: 'alice', separation: null }));
    const database = path.join(root, OWNER.home, '.local/share/opencode/opencode.db');
    await fs.mkdir(path.dirname(database), { recursive: true });
    await fs.writeFile(database, 'database');
    // When
    const result = await rootCommand('backup-prepare', { root, system, into: '/backup' });
    // Then
    expect(result.databases).toEqual([{ source: '/home/alice/.local/share/opencode/opencode.db', copy: '/backup/database-0.sqlite' }]);
    expect(system.calls.some(([name]) => name === 'useradd')).toBe(false);
  });

  it('repairs ownership by current account names and keeps hostd state root-only', async () => {
    // Given
    const { root, system } = await setup();
    system.accounts.set(AGENT.name, { ...AGENT, uid: 4200, gid: 4201 });
    system.accounts.set('openchamber-mcp', { name: 'openchamber-mcp', uid: 4202, gid: 4202 });
    for (const file of ['/var/lib/openchamber/.config/openchamber/settings.json', '/home/alice-agent/file', '/var/lib/openchamber-protected-mcp/state', '/var/lib/openchamber-hostd/state']) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), file.endsWith('settings.json') ? '{"projects":[]}' : 'data');
    }
    // When
    const result = await rootCommand('repair-permissions', { root, system });
    // Then
    expect(result.changed).toHaveLength(4);
    expect(system.calls).toContainEqual(['chown', path.join(root, '/home/alice-agent/file'), 4200, 4201]);
    expect(system.calls).toContainEqual(['chown', path.join(root, '/var/lib/openchamber-protected-mcp/state'), 4202, 4202]);
    expect(system.calls).toContainEqual(['chown', path.join(root, '/var/lib/openchamber-hostd/state'), 0, 0]);
    expect((await fs.stat(path.join(root, '/var/lib/openchamber-hostd'))).mode & 0o777).toBe(0o700);
  });

  it('rewrites the protected MCP socket groups from their names after a restore', async () => {
    // Given the service configuration of the old host, whose groups had other numbers.
    const { root, system } = await setup();
    const serviceConfig = path.join(root, '/etc/openchamber/protected-mcp/service.json');
    await fs.mkdir(path.dirname(serviceConfig), { recursive: true });
    await fs.writeFile(serviceConfig, JSON.stringify({ version: 1, engineSocketGroup: 120, adminSocketGroup: 121, stateDir: '/var/lib/openchamber-protected-mcp' }));
    system.groups.set('openchamber-mcp-clients', 4300);
    system.groups.set('openchamber-mcp-admins', 4301);
    // When permissions are repaired.
    const result = await rootCommand('repair-permissions', { root, system });
    // Then the file names this host's groups, everything else unchanged.
    expect(JSON.parse(await fs.readFile(serviceConfig, 'utf8'))).toEqual({ version: 1, engineSocketGroup: 4300, adminSocketGroup: 4301, stateDir: '/var/lib/openchamber-protected-mcp' });
    expect(result.changed).toContain('/etc/openchamber/protected-mcp/service.json');
  });

  it('configures rootless Docker as the agent only when prerequisites exist', async () => {
    // Given
    const { root, system } = await setup();
    for (const file of ['/usr/bin/newuidmap', '/usr/bin/dockerd-rootless-setuptool.sh']) { await fs.writeFile(path.join(root, file), '', { mode: 0o755 }); }
    for (const file of ['/etc/subuid', '/etc/subgid']) await fs.writeFile(path.join(root, file), 'alice-agent:100000:65536\n');
    // When
    const result = await setupAgentDocker({ root, system, agent: AGENT });
    // Then
    expect(result).toEqual({ status: 'ready' });
    expect(system.calls).toContainEqual(['loginctl', ['enable-linger', 'alice-agent']]);
    expect(system.calls).toContainEqual(['runuser', ['-u', 'alice-agent', '--', 'env', 'HOME=/home/alice-agent', `XDG_RUNTIME_DIR=/run/user/${AGENT.uid}`, 'PATH=/usr/local/bin:/usr/bin:/bin', '/usr/bin/dockerd-rootless-setuptool.sh', 'install']]);
  });
});

describe('the front door\'s own rootless Docker', () => {
  it('gives the front door account subordinate IDs after every existing range, then installs its rootless Docker as that account', async () => {
    const { root, system } = await setup();
    for (const file of ['/usr/bin/newuidmap', '/usr/bin/dockerd-rootless-setuptool.sh']) { await fs.writeFile(path.join(root, file), '', { mode: 0o755 }); }
    await fs.writeFile(path.join(root, '/etc/subuid'), 'alice:100000:65536\nalice-agent:165536:65536\n');
    await fs.writeFile(path.join(root, '/etc/subgid'), 'alice:100000:65536\nalice-agent:300000:65536\n');
    // The fake usermod is not real: write what it would, so the setup sees the range.
    const run = system.run;
    system.run = async (file, args, options) => {
      if (file === 'usermod') for (const name of ['/etc/subuid', '/etc/subgid']) await fs.appendFile(path.join(root, name), `${args.at(-1)}:${args[1].split('-')[0]}:65536\n`);
      return run(file, args, options);
    };
    const result = await setupFrontDoorDocker({ root, system, front: FRONT });
    expect(result).toEqual({ status: 'ready' });
    expect(system.calls).toContainEqual(['usermod', ['--add-subuids', '393216-458751', '--add-subgids', '393216-458751', FRONT.name]]);
    expect(system.calls).toContainEqual(['loginctl', ['enable-linger', FRONT.name]]);
    expect(system.calls.some(([file, args]) => file === 'usermod' && args.includes('docker'))).toBe(false);
  });

  it('puts the front door\'s Docker socket in its unit only when its Docker is ready', () => {
    const config = { repo: 'rubimpassos/openchamber', port: 41731, host: '127.0.0.1', owner: OWNER.name, separation: { frontDoor: FRONT.name, agent: AGENT.name, agentPort: 41890 } };
    const toolchain = { node: '/usr/bin/node' };
    const live = { envFile: '/etc/openchamber/openchamber.env', app: '/usr/lib/openchamber/current' };
    expect(appUnit({ config, owner: OWNER, front: FRONT, toolchain, live })).not.toContain('DOCKER_HOST');
    expect(appUnit({ config: { ...config, separation: { ...config.separation, frontDocker: true } }, owner: OWNER, front: FRONT, toolchain, live }))
      .toContain(`Environment=DOCKER_HOST=unix:///run/user/${FRONT.uid}/docker.sock\n`);
  });
});
