import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureAccounts, separationConfig } from './accounts.js';
import { AGENT, fakeSystem, FRONT, hostRoot, installOptions, OWNER } from './fake-system.js';
import { install, layout, rollback, uninstall, update } from './host.js';
import { AGENT_UNIT, ALL_UNITS, APP_UNIT, HOSTD_SOCKET, HOSTD_UNIT, MANAGED_MARKER, UPDATER_PATH, UPDATER_TIMER, UPDATER_UNIT } from './host-units.js';
import { rootCommand } from './root-commands.js';
import { deriveUiPasswordKey, parseUiPasswordHash } from '../ui-auth/ui-password-hash.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fresh = async (extra = {}) => {
  const root = await hostRoot(cleanups);
  const system = fakeSystem(root);
  const result = await install(installOptions(root, system, extra));
  return { root, system, result, paths: layout(root) };
};
const separated = { frontDoor: 'openchamber', agent: 'alice-agent', agentPort: 41890 };

describe('separated host install', () => {
  it('defaults fresh installs to separate identities and splits MCP administration', async () => {
    // Given / When
    const { system, result, paths } = await fresh();
    // Then
    expect(result.config.separation).toEqual(separated);
    expect(system.calls).toContainEqual(['useradd', ['--system', '--home-dir', '/var/lib/openchamber', '--create-home', '--shell', '/usr/sbin/nologin', '--user-group', 'openchamber']]);
    expect(system.calls).toContainEqual(['useradd', ['--create-home', '--shell', '/bin/bash', '--user-group', 'alice-agent']]);
    expect(system.calls).toContainEqual(['usermod', ['--lock', 'alice-agent']]);
    expect(system.calls).toContainEqual(['chown', paths.requestDir, FRONT.uid, FRONT.gid]);
    expect(system.calls.find(([name]) => name === 'protectedMcp.options')[1]).toMatchObject({ engineUser: 'alice-agent', adminUser: 'openchamber', engineUnit: AGENT_UNIT });
    expect(system.calls.find(([name]) => name === 'installOpenCode')[1]).toMatchObject(AGENT);
    expect(await fs.readFile(paths.wrapper, 'utf8')).toBe('#!/bin/sh\nexec /usr/bin/node /usr/lib/openchamber/current/node_modules/@openchamber/web/server/lib/host-install/main.js "$@"\n');
    expect((await fs.stat(paths.wrapper)).mode & 0o777).toBe(0o755);
  });

  it('writes every unit contract without embedding the token', async () => {
    // Given / When
    const { paths } = await fresh();
    // Then
    const expected = {
      [APP_UNIT]: ['After=network-online.target openchamber-agent.service openchamber-hostd.socket', 'Wants=network-online.target openchamber-hostd.socket openchamber-agent.service', 'User=openchamber', 'Group=openchamber', 'WorkingDirectory=/var/lib/openchamber', 'Environment=HOME=/var/lib/openchamber', 'Environment="PATH=/usr/local/bin:/usr/bin:/bin"', 'EnvironmentFile=-/etc/openchamber/openchamber.env', 'EnvironmentFile=/etc/openchamber/agent-link.env', 'ProtectHome=tmpfs', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'ProtectSystem=full', 'UMask=0077'],
      [AGENT_UNIT]: ['User=alice-agent', `Group=${AGENT.gid}`, 'WorkingDirectory=/home/alice-agent', 'Environment=HOME=/home/alice-agent', 'Environment="PATH=/home/alice-agent/.local/bin:/home/alice-agent/.opencode/bin:/home/alice-agent/.bun/bin:/usr/local/bin:/usr/bin:/bin"', 'EnvironmentFile=/etc/openchamber/agent.env', 'Environment=OPENCHAMBER_PROTECTED_MCP_CLIENT_CONFIG=/etc/openchamber/protected-mcp/agent-client.json', 'BindReadOnlyPaths=-/run/openchamber-protected-mcp/subjects/agent:/run/openchamber-mcp', `InaccessiblePaths=-/run/openchamber-hostd -/run/openchamber-protected-mcp-admin -/var/lib/openchamber -/etc/openchamber/openchamber.env -/etc/openchamber/agent-link.env -/run/user/${OWNER.uid}`, 'ProtectProc=invisible', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'UMask=0077', 'Restart=always', 'ExecStart=/usr/bin/node /usr/lib/openchamber/current/node_modules/@openchamber/web/bin/cli.js serve --foreground --api-only --host 127.0.0.1 --port 41890'],
      [HOSTD_SOCKET]: ['ListenStream=/run/openchamber-hostd/hostd.sock', 'SocketUser=openchamber', 'SocketGroup=root', 'SocketMode=0600', 'DirectoryMode=0711', 'RemoveOnStop=yes', 'WantedBy=sockets.target'],
      [HOSTD_UNIT]: ['Requires=openchamber-hostd.socket', 'After=openchamber-hostd.socket', 'ExecStart=/usr/bin/node /usr/lib/openchamber/current/node_modules/@openchamber/web/server/lib/hostd/main.js', 'UMask=0077', 'NoNewPrivileges=yes', 'LockPersonality=yes', 'Restart=on-failure'],
      [UPDATER_UNIT]: ['Type=oneshot', 'ExecStart=/usr/bin/node /usr/lib/openchamber/current/node_modules/@openchamber/web/server/lib/host-install/main.js update', 'NoNewPrivileges=yes', 'PrivateTmp=yes'],
      [UPDATER_TIMER]: ['OnCalendar=daily', 'RandomizedDelaySec=1h', 'Persistent=true', 'WantedBy=timers.target'],
      [UPDATER_PATH]: ['PathChanged=/var/lib/openchamber-host/requests/update', 'Unit=openchamber-updater.service', 'WantedBy=paths.target'],
    };
    const token = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(await fs.readFile(paths.agentEnv, 'utf8'))[1];
    for (const [unit, lines] of Object.entries(expected)) {
      const content = await fs.readFile(paths.unit(unit), 'utf8');
      expect(content.startsWith(MANAGED_MARKER)).toBe(true);
      for (const line of lines) expect(content.split('\n')).toContain(line);
      expect(content).not.toContain(token);
    }
    // A mount namespace of hostd's own would hide the namespace pins from the units it starts.
    expect(await fs.readFile(paths.unit(HOSTD_UNIT), 'utf8')).not.toMatch(/^User=|^ProtectSystem=|^RestrictNamespaces=|^PrivateTmp=|^Protect[A-Za-z]+=|^PrivateMounts=|^MountFlags=/m);
  });

  it('keeps the shared token across updates and rotates both root-only files on command', async () => {
    // Given
    const { root, system, paths } = await fresh();
    const before = await fs.readFile(paths.agentEnv, 'utf8');
    const token = /^OPENCHAMBER_UI_PASSWORD=([A-Za-z0-9_-]{43})$/m.exec(before)[1];
    // When
    await update({ root, system });
    // Then
    expect(await fs.readFile(paths.agentEnv, 'utf8')).toBe(before);
    expect(await fs.readFile(paths.agentLink, 'utf8')).toBe(`OPENCHAMBER_AGENT_SERVER_URL=http://127.0.0.1:41890\nOPENCHAMBER_AGENT_SERVER_TOKEN=${token}\nOPENCHAMBER_DATA_DIR=/var/lib/openchamber/.config/openchamber\n`);
    for (const file of [paths.agentLink, paths.agentEnv, paths.envFile]) expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(before).toContain('OPENCHAMBER_AGENT_SERVER=1\nOPENCHAMBER_RELAY_HOST=off\n');
    expect(JSON.stringify(system.calls)).not.toContain(token);
    // When
    await rootCommand('rotate-agent-token', { root, system });
    // Then
    expect(await fs.readFile(paths.agentEnv, 'utf8')).not.toBe(before);
    expect(system.calls.at(-1)).toEqual(['systemctl', ['restart', AGENT_UNIT, APP_UNIT]]);
  });

  it('keeps an old install on one account until an explicit separation and restores it on failed promotion', async () => {
    // Given
    const { root, system, paths } = await fresh({ separation: false });
    const config = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));
    delete config.separation;
    await fs.writeFile(paths.configFile, JSON.stringify(config));
    // When
    await update({ root, system });
    await install(installOptions(root, system));
    // Then
    expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8')).separation).toBeNull();
    expect(await fs.readFile(paths.unit(HOSTD_SOCKET), 'utf8')).toContain('SocketUser=alice');
    const failing = fakeSystem(root, { broken: '2.6.0' });
    // When
    await expect(install(installOptions(root, failing, { separation: true }))).rejects.toMatchObject({ code: 'not_started' });
    // Then
    expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8')).separation).toBeNull();
    expect(await fs.readFile(paths.unit(APP_UNIT), 'utf8')).toContain('User=alice\n');
    expect(await fs.lstat(paths.unit(AGENT_UNIT)).catch(() => null)).toBeNull();
  });

  it('honors custom agent identity and port without enabling separation on a later automatic update', async () => {
    // Given / When
    const { result } = await fresh({ agentUser: 'worker', agentPort: 41900 });
    // Then
    expect(result.config.separation).toMatchObject({ agent: 'worker', agentPort: 41900 });
    expect(separationConfig({ existing: {}, owner: 'alice', port: 3000 })).toBeNull();
  });

  it('rejects promotion when the front door is healthy but authenticated agent health fails', async () => {
    // Given
    const { root, paths } = await fresh({ separation: false });
    const system = fakeSystem(root, { agentBroken: true });
    // When / Then
    await expect(install(installOptions(root, system, { separation: true, version: '2.7.0', tarball: '/cache/openchamber-web-2.7.0.tgz' }))).rejects.toMatchObject({ code: 'not_started' });
    expect((await fs.readlink(path.join(paths.installDir, 'current'))).startsWith('2.6.0-')).toBe(true);
    expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8')).separation).toBeNull();
    expect(system.calls.some(([name]) => name === 'agentHealth')).toBe(true);
  });

  it('overrides custom human data paths in a later env file and restores the legacy deployment on manual rollback', async () => {
    // Given
    const { root, system, paths } = await fresh({ separation: false });
    const oldEnv = 'OPENCHAMBER_DATA_DIR=/srv/human-data\n';
    await fs.writeFile(paths.envFile, oldEnv);
    await fs.mkdir(path.join(root, 'srv/human-data'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv/human-data/settings.json'), '{"locale":"pt-BR"}');
    // Model a legacy version with no hostd units or agent mode support.
    for (const unit of [HOSTD_UNIT, HOSTD_SOCKET]) await fs.rm(paths.unit(unit));
    const oldAppUnit = await fs.readFile(paths.unit(APP_UNIT), 'utf8');
    await install(installOptions(root, system, { separation: true, version: '2.7.0', tarball: '/cache/openchamber-web-2.7.0.tgz' }));
    const unit = await fs.readFile(paths.unit(APP_UNIT), 'utf8');
    const envFiles = unit.split('\n').filter((line) => line.startsWith('EnvironmentFile=')).map((line) => line.slice('EnvironmentFile='.length).replace(/^-/, ''));
    const values = {};
    for (const file of envFiles) for (const line of (await fs.readFile(path.join(root, file), 'utf8')).split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (match) values[match[1]] = match[2];
    }
    expect(values.OPENCHAMBER_DATA_DIR).toBe('/var/lib/openchamber/.config/openchamber');
    // The old env file stays as it was; it only gains the front door's UI password hash.
    expect(await fs.readFile(paths.envFile, 'utf8')).toMatch(new RegExp(`^${oldEnv}OPENCHAMBER_UI_PASSWORD_HASH=scrypt\\$[^\\n]+\\n$`));
    expect(JSON.stringify(JSON.parse(await fs.readFile(paths.previousDeployment, 'utf8')))).not.toContain(values.OPENCHAMBER_AGENT_SERVER_TOKEN);
    // When
    const result = await rollback({ root, system });
    // Then
    expect(result).toEqual({ version: '2.6.0', skipped: '2.7.0' });
    expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8')).separation).toBeNull();
    expect(await fs.readFile(paths.unit(APP_UNIT), 'utf8')).toBe(oldAppUnit);
    for (const name of [AGENT_UNIT, HOSTD_UNIT, HOSTD_SOCKET]) expect(await fs.lstat(paths.unit(name)).catch(() => null)).toBeNull();
    expect(system.calls).toContainEqual(['chown', paths.requestDir, OWNER.uid, OWNER.gid]);
  });

  it.each([
    { agentUser: 'root' }, { agentUser: 'alice' }, { agentUser: 'openchamber' }, { agentUser: '../worker' }, { agentPort: 3000 }, { agentPort: 0 },
  ])('refuses conflicting account or port options %j', async (options) => {
    // Given
    const root = await hostRoot(cleanups);
    const system = fakeSystem(root);
    // When / Then
    await expect(install(installOptions(root, system, options))).rejects.toMatchObject({ code: expect.stringMatching(/^invalid_/) });
    expect(system.calls).toEqual([]);
  });

  it.each([{ ...FRONT, home: '/srv/other' }, { ...FRONT, shell: '/bin/bash' }, { ...FRONT, uid: 0 }])('refuses an unsafe existing front-door identity %j', async (front) => {
    // Given
    const root = await hostRoot(cleanups);
    const system = fakeSystem(root);
    system.accounts.set('openchamber', front);
    // When / Then
    await expect(ensureAccounts({ root, system, config: { owner: 'alice', separation: separated } })).rejects.toMatchObject({ code: 'front_account_conflict' });
  });

  it.each([
    ['a system account', { uid: 1, home: '/usr/sbin' }, 'agent_account_conflict'],
    ['a home inside the human\'s', { home: '/home/alice/agent' }, 'agent_account_conflict'],
    ['a home in a system folder', { home: '/var/lib/agent' }, 'agent_account_conflict'],
    ['the docker group', { groups: ['alice-agent', 'docker'] }, 'agent_account_privileged'],
    ['the sudo group', { groups: ['sudo'] }, 'agent_account_privileged'],
  ])('refuses to reuse an existing agent account with %s', async (_name, change, code) => {
    // Given an agent account that already exists.
    const root = await hostRoot(cleanups);
    const system = fakeSystem(root);
    system.accounts.set('openchamber', FRONT);
    system.accounts.set('alice-agent', { ...AGENT, ...change });
    // When / Then it is refused before anything changes for it.
    await expect(ensureAccounts({ root, system, config: { owner: 'alice', separation: separated } })).rejects.toMatchObject({ code });
    expect(system.calls.some(([command]) => command === 'usermod')).toBe(false);
  });

  it('refuses a front-door account in a group that is root by another name', async () => {
    const root = await hostRoot(cleanups);
    const system = fakeSystem(root);
    system.accounts.set('openchamber', { ...FRONT, groups: ['openchamber', 'docker'] });
    await expect(ensureAccounts({ root, system, config: { owner: 'alice', separation: separated } })).rejects.toMatchObject({ code: 'front_account_privileged' });
  });

  it('removes every managed unit while keeping the account homes without explicit account purge', async () => {
    // Given
    const { root, system, paths } = await fresh();
    // When
    await uninstall({ root, system, purge: true });
    // Then
    for (const unit of ALL_UNITS) expect(await fs.lstat(paths.unit(unit)).catch(() => null)).toBeNull();
    for (const home of [FRONT.home, AGENT.home]) expect((await fs.stat(path.join(root, home))).isDirectory()).toBe(true);
    expect(system.calls.some(([name]) => name === 'userdel')).toBe(false);
    expect(await fs.lstat(paths.agentEnv).catch(() => null)).toBeNull();
  });
});

describe('the UI password of a separated install', () => {
  it('refuses a fresh install without a password before any account or file changes', async () => {
    const root = await hostRoot(cleanups);
    const system = fakeSystem(root);
    await expect(install(installOptions(root, system, { readUiPassword: async () => null }))).rejects.toMatchObject({ code: 'ui_password_required' });
    expect(system.calls.some(([name]) => ['useradd', 'usermod', 'systemctl', 'installOpenCode'].includes(name))).toBe(false);
    expect(await fs.readFile(layout(root).envFile, 'utf8').catch(() => null)).toBeNull();
  });

  it('writes only the hash of a typed password into the front door\'s env file', async () => {
    const { paths } = await fresh({ readUiPassword: async () => '  correct horse battery  ' });
    const env = await fs.readFile(paths.envFile, 'utf8');
    expect(env).not.toContain('correct horse battery');
    const stored = parseUiPasswordHash(/^OPENCHAMBER_UI_PASSWORD_HASH=(.+)$/m.exec(env)?.[1]);
    expect(stored).not.toBeNull();
    expect(deriveUiPasswordKey('correct horse battery', stored.salt).equals(stored.key)).toBe(true);
    expect((await fs.stat(paths.envFile)).mode & 0o777).toBe(0o600);
  });

  it('asks nothing when the env file already sets a password, and asks nothing on one account', async () => {
    const root = await hostRoot(cleanups);
    const system = fakeSystem(root);
    const paths = layout(root);
    await fs.mkdir(path.dirname(paths.envFile), { recursive: true });
    await fs.writeFile(paths.envFile, '# kept\nOPENCHAMBER_UI_PASSWORD_HASH=scrypt$c2FsdA==$a2V5\n', { mode: 0o600 });
    let asked = 0;
    await install(installOptions(root, system, { readUiPassword: async () => { asked += 1; return 'unused'; } }));
    expect(asked).toBe(0);
    expect(await fs.readFile(paths.envFile, 'utf8')).toBe('# kept\nOPENCHAMBER_UI_PASSWORD_HASH=scrypt$c2FsdA==$a2V5\n');
    const single = await hostRoot(cleanups);
    await install(installOptions(single, fakeSystem(single), { separation: false, readUiPassword: async () => { asked += 1; return null; } }));
    expect(asked).toBe(0);
  });
});
