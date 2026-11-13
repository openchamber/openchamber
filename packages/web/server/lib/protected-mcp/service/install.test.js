import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { trustedFixtureDirectory } from '../test-support/fixtures.js';
import { install, layout, rollback, uninstall } from './install.js';

const serverSource = fileURLToPath(new URL('../../../', import.meta.url));
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ENGINE = { uid: 2_000_000_001, gids: [2_000_000_001] };

/** The privileged operations, recorded instead of run, over a temporary root. */
function recordingSystem(overrides = {}) {
  const calls = [];
  const record = (name) => async (...args) => {
    calls.push([name, ...args]);
  };
  return {
    calls,
    trustedOwners: [0, process.getuid()],
    isRoot: () => true,
    hasSystemd: async () => true,
    identity: async () => ENGINE,
    ensureGroup: async (name) => {
      calls.push(['ensureGroup', name]);
      return name === 'openchamber-mcp-clients' ? 990 : name === 'openchamber-mcp-admins' ? 992 : 991;
    },
    ensureUser: async (name) => {
      calls.push(['ensureUser', name]);
      return 991;
    },
    addToGroup: record('addToGroup'),
    removeFromGroup: record('removeFromGroup'),
    removeUser: record('removeUser'),
    removeGroup: record('removeGroup'),
    chown: async () => {},
    systemctl: record('systemctl'),
    createTmpfiles: record('createTmpfiles'),
    nodeVersion: async () => 'v24.21.0\n',
    connect: async () => ({ protocol: 1, enforcement: { status: 'protected' } }),
    sockets: [],
    ...overrides,
  };
}

async function hostRoot() {
  const scratch = await trustedFixtureDirectory();
  cleanups.push(scratch.remove);
  const root = path.join(scratch.directory, 'root');
  await fs.mkdir(path.join(root, 'usr/bin'), { recursive: true });
  await fs.symlink('/usr/bin/node', path.join(root, 'usr/bin/node'));
  return { root, scratch };
}

const options = (root, system, extra = {}) => ({
  root, source: serverSource, version: '2.5.3', engineUser: 'dev', system, ...extra,
});

describe('protected MCP installer', () => {
  it('removes the previous engine account from both groups when reinstalling for another account', async () => {
    // Given an installation for the old account.
    const { root } = await hostRoot();
    await install(options(root, recordingSystem()));
    const system = recordingSystem();
    const output = [];
    // When a reinstall chooses another engine account.
    await install(options(root, system, { engineUser: 'new-engine', say: (line) => output.push(line) }));
    // Then the old account loses both memberships and the operator sees the change.
    expect(system.calls.filter(([name]) => name === 'removeFromGroup')).toEqual([
      ['removeFromGroup', 'dev', 'openchamber-mcp-clients'],
      ['removeFromGroup', 'dev', 'openchamber-mcp-admins'],
    ]);
    expect(output.some((line) => line.includes('dev') && line.includes('neither') && line.includes('openchamber-mcp-clients') && line.includes('openchamber-mcp-admins'))).toBe(true);
  });

  it('puts OpenChamber in both groups and the agents\' account in neither when they run as separate accounts', async () => {
    // Given a stage 1 installation, where OpenChamber and the agents share the account dev.
    const { root } = await hostRoot();
    await install(options(root, recordingSystem()));
    const identities = { dev: { uid: 2_000_000_001, gids: [2_000_000_001] }, 'dev-agent': { uid: 2_000_000_002, gids: [2_000_000_002] } };
    const system = recordingSystem({ identity: async (name) => identities[name] });
    // When the agents get an account of their own.
    await install(options(root, system, { engineUser: 'dev-agent', adminUser: 'dev', engineUnit: 'openchamber-agent.service' }));
    // Then dev administers and calls status, and dev-agent joins no group of the service.
    const memberships = system.calls.filter(([name]) => name === 'addToGroup' || name === 'removeFromGroup');
    expect(memberships).toEqual([
      ['addToGroup', 'dev', 'openchamber-mcp-clients'],
      ['addToGroup', 'dev', 'openchamber-mcp-admins'],
      ['removeFromGroup', 'dev-agent', 'openchamber-mcp-clients'],
      ['removeFromGroup', 'dev-agent', 'openchamber-mcp-admins'],
    ]);
    const paths = layout(root);
    expect(JSON.parse(await fs.readFile(paths.serviceConfig, 'utf8'))).toMatchObject({ engineUser: 'dev-agent', adminUser: 'dev', engineUnit: 'openchamber-agent.service' });
    // The agents' client configuration names the subject socket their unit binds, never engine.sock.
    expect(JSON.parse(await fs.readFile(paths.agentClientConfig, 'utf8'))).toEqual({
      version: 1,
      socket: '/run/openchamber-mcp/engine.sock',
      adminSocket: '/run/openchamber-protected-mcp-admin/admin.sock',
      relay: ['/usr/bin/node', '/usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/relay.js'],
    });
    expect(JSON.parse(await fs.readFile(paths.clientConfig, 'utf8')).socket).toBe('/run/openchamber-protected-mcp/engine.sock');
    // The agents' subject folder exists from every boot on, and now, before the agent unit restarts.
    expect(await fs.readFile(paths.tmpfilesFile, 'utf8')).toBe([
      'd /run/openchamber-protected-mcp 0750 openchamber-mcp openchamber-mcp -',
      'd /run/openchamber-protected-mcp/subjects 0700 openchamber-mcp openchamber-mcp -',
      'd /run/openchamber-protected-mcp/subjects/agent 0711 openchamber-mcp openchamber-mcp -',
      '',
    ].join('\n'));
    const order = system.calls.map(([name, ...args]) => (name === 'systemctl' ? `systemctl ${args[0][0]}` : name));
    expect(order.indexOf('createTmpfiles')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('createTmpfiles')).toBeLessThan(order.indexOf('systemctl restart'));
  });

  it('goes back to one shared account and removes the agents\' client configuration', async () => {
    // Given separate accounts.
    const { root } = await hostRoot();
    const identities = { dev: { uid: 2_000_000_001, gids: [2_000_000_001] }, 'dev-agent': { uid: 2_000_000_002, gids: [2_000_000_002] } };
    await install(options(root, recordingSystem({ identity: async (name) => identities[name] }), { engineUser: 'dev-agent', adminUser: 'dev' }));
    const system = recordingSystem({ identity: async (name) => identities[name] });
    // When the installation runs without an administrator account of its own.
    await install(options(root, system));
    // Then dev is in both groups, the former agents' account in none, and no agents' configuration stays.
    expect(system.calls.filter(([name]) => name === 'addToGroup' || name === 'removeFromGroup')).toEqual([
      ['addToGroup', 'dev', 'openchamber-mcp-clients'],
      ['addToGroup', 'dev', 'openchamber-mcp-admins'],
      ['removeFromGroup', 'dev-agent', 'openchamber-mcp-clients'],
      ['removeFromGroup', 'dev-agent', 'openchamber-mcp-admins'],
    ]);
    await expect(fs.stat(layout(root).agentClientConfig)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(layout(root).tmpfilesFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(layout(root).serviceConfig, 'utf8')).adminUser).toBeNull();
  });

  it.each([null, '', '--no-start'])('refuses a missing engine account when its value is %s', async (engineUser) => {
    // Given
    const system = recordingSystem({ identity: async () => { throw new Error('identity must not run'); } });
    // When
    const result = install(options('/unused', system, { engineUser }));
    // Then
    await expect(result).rejects.toMatchObject({ code: 'engine_user_required' });
    expect(system.calls).toEqual([]);
  });

  it('uses the existing admins group when it is already present', async () => {
    // Given
    const { root } = await hostRoot();
    const groups = new Map([['openchamber-mcp-admins', 995]]);
    const system = recordingSystem({ ensureGroup: async (name) => {
      if (!groups.has(name)) groups.set(name, 990 + groups.size);
      return groups.get(name);
    } });
    // When
    await install(options(root, system));
    // Then
    expect(JSON.parse(await fs.readFile(layout(root).serviceConfig, 'utf8')).adminSocketGroup).toBe(995);
    expect(system.calls).toContainEqual(['addToGroup', 'dev', 'openchamber-mcp-admins']);
  });

  it('installs without a password when the engine account is specified', async () => {
    // Given
    const { root } = await hostRoot();
    const system = recordingSystem();
    // When
    const result = await install(options(root, system));
    // Then
    const paths = layout(root);
    const versionDir = path.join(paths.installDir, '2.5.3');
    expect(await fs.readlink(path.join(paths.installDir, 'current'))).toBe('2.5.3');
    const files = await fs.readdir(path.join(versionDir, 'lib/protected-mcp/service'));
    expect(files).toContain('main.js');
    expect(files.some((name) => name.endsWith('.test.js'))).toBe(false);
    expect((await fs.stat(path.join(versionDir, 'lib/shared/guards.js'))).mode & 0o777).toBe(0o644);
    expect(JSON.parse(await fs.readFile(path.join(versionDir, 'package.json'), 'utf8')).type).toBe('module');

    expect(JSON.parse(await fs.readFile(paths.clientConfig, 'utf8'))).toEqual({
      version: 1,
      socket: '/run/openchamber-protected-mcp/engine.sock',
      adminSocket: '/run/openchamber-protected-mcp-admin/admin.sock',
      relay: ['/usr/bin/node', '/usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/relay.js'],
    });
    const config = JSON.parse(await fs.readFile(paths.serviceConfig, 'utf8'));
    expect(config).toEqual({
      version: 1, serviceVersion: '2.5.3', stateDir: '/var/lib/openchamber-protected-mcp',
      engineUser: 'dev', adminUser: null, engineUnit: null, engineSocket: '/run/openchamber-protected-mcp/engine.sock', engineSocketGroup: 990,
      adminSocket: '/run/openchamber-protected-mcp-admin/admin.sock', adminSocketGroup: 992,
      subjectsDir: '/run/openchamber-protected-mcp/subjects',
      workerPath: '/usr/local/bin:/usr/bin:/bin', node: '/usr/bin/node', npm: null,
      installDir: '/usr/lib/openchamber-protected-mcp', configDir: '/etc/openchamber/protected-mcp',
    });
    const unit = await fs.readFile(paths.unitFile, 'utf8');
    for (const line of ['User=openchamber-mcp', 'SupplementaryGroups=openchamber-mcp-clients openchamber-mcp-admins', 'RuntimeDirectory=openchamber-protected-mcp openchamber-protected-mcp-admin', 'RuntimeDirectoryMode=0750', 'RuntimeDirectoryPreserve=yes', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'CapabilityBoundingSet=', 'UMask=0077', 'LimitCORE=0']) {
      expect(unit.split('\n')).toContain(line);
    }
    expect((await fs.stat(paths.stateDir)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(paths.stateDir)).toEqual([]);
    expect(system.calls).toEqual(expect.arrayContaining([
      ['addToGroup', 'dev', 'openchamber-mcp-clients'],
      ['ensureGroup', 'openchamber-mcp-admins'],
      ['addToGroup', 'dev', 'openchamber-mcp-admins'],
      ['systemctl', ['enable', 'openchamber-protected-mcp.service']],
      ['systemctl', ['restart', 'openchamber-protected-mcp.service']],
    ]));
    expect(result.status.enforcement.status).toBe('protected');
  });

  it('leaves every directory it creates traversable even when root runs with umask 077', async () => {
    const { root } = await hostRoot();
    const previous = process.umask(0o077);
    try {
      await install(options(root, recordingSystem()));
    } finally {
      process.umask(previous);
    }
    const paths = layout(root);
    for (const directory of [path.dirname(paths.configDir), paths.configDir, paths.installDir, path.join(paths.installDir, '2.5.3'), path.dirname(paths.unitFile)]) {
      expect((await fs.stat(directory)).mode & 0o777, directory).toBe(0o755);
    }
    expect((await fs.stat(paths.serviceConfig)).mode & 0o777).toBe(0o644);
    expect((await fs.stat(paths.stateDir)).mode & 0o777).toBe(0o700);
  });

  it('rewrites the listener configuration when reinstalling over legacy state', async () => {
    // Given
    const { root } = await hostRoot();
    await install(options(root, recordingSystem(), { engineUnit: 'engine.service' }));
    const paths = layout(root);
    const credentials = path.join(paths.stateDir, 'credentials');
    await fs.mkdir(credentials, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(credentials, 'pmcp_0123456789abcdef.json'), '{"kept":true}', { mode: 0o600 });
    const legacyConfig = JSON.parse(await fs.readFile(paths.serviceConfig, 'utf8'));
    await fs.writeFile(paths.serviceConfig, JSON.stringify({ ...legacyConfig, admin: { host: '127.0.0.1', port: 42001 } }));
    const legacyFile = path.join(paths.stateDir, 'admin.json');
    await fs.writeFile(legacyFile, '{"legacy":true}', { mode: 0o600 });

    // When
    await install(options(root, recordingSystem(), { version: '2.6.0' }));
    // Then
    expect(await fs.readlink(path.join(paths.installDir, 'current'))).toBe('2.6.0');
    expect(await fs.readlink(path.join(paths.installDir, 'previous'))).toBe('2.5.3');
    expect(await fs.readFile(legacyFile, 'utf8')).toBe('{"legacy":true}');
    expect((await fs.stat(legacyFile)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(credentials, 'pmcp_0123456789abcdef.json'), 'utf8')).toBe('{"kept":true}');
    const updated = JSON.parse(await fs.readFile(paths.serviceConfig, 'utf8'));
    expect(updated).not.toHaveProperty('admin');
    expect(updated.engineUnit).toBe('engine.service');

    await install(options(root, recordingSystem(), { version: '2.6.0' }));
    expect(await fs.readlink(path.join(paths.installDir, 'previous'))).toBe('2.5.3');
    expect((await rollback({ root, system: recordingSystem() })).current).toBe('2.5.3');
    expect(await fs.readlink(path.join(paths.installDir, 'current'))).toBe('2.5.3');
  });

  it('refuses a source, a Node.js or an account that would put the engine in control', async () => {
    const { root, scratch } = await hostRoot();
    const copy = path.join(scratch.directory, 'source');
    await fs.cp(path.join(serverSource, 'lib/protected-mcp/service'), path.join(copy, 'lib/protected-mcp/service'), { recursive: true });
    await fs.cp(path.join(serverSource, 'lib/shared/guards.js'), path.join(copy, 'lib/shared/guards.js'));
    await fs.chmod(path.join(copy, 'lib/protected-mcp/service'), 0o777);
    await expect(install(options(root, recordingSystem(), { source: copy }))).rejects.toMatchObject({ code: 'untrusted_source' });

    const writable = path.join(scratch.directory, 'writable-bin');
    await fs.mkdir(writable, { mode: 0o777 });
    await fs.chmod(writable, 0o777);
    await fs.symlink('/usr/bin/node', path.join(writable, 'node'));
    await expect(install(options(root, recordingSystem(), { node: path.relative(root, path.join(writable, 'node')).replace(/^/, '/') })))
      .rejects.toMatchObject({ code: expect.stringMatching(/untrusted_node|node_missing/) });

    await expect(install(options(root, recordingSystem({ identity: async () => ({ uid: 0, gids: [0] }) }))))
      .rejects.toMatchObject({ code: 'engine_is_root' });
    await expect(install(options(root, recordingSystem({ isRoot: () => false })))).rejects.toMatchObject({ code: 'root_required' });
    expect(await fs.stat(layout(root).unitFile).then(() => true, () => false)).toBe(false);
  });

  it('stops when the engine can reach a root-owned container socket unless told to accept it', async () => {
    const { root } = await hostRoot();
    // A Unix socket path must stay under 108 bytes, so this one lives in /tmp.
    const socketDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-sock-'));
    cleanups.push(() => fs.rm(socketDirectory, { recursive: true, force: true }));
    const socketPath = path.join(socketDirectory, 'docker.sock');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    await fs.chmod(socketPath, 0o660);
    const { gid } = await fs.stat(socketPath);
    const system = () => recordingSystem({ sockets: [socketPath], socketOwners: [process.getuid()], identity: async () => ({ uid: ENGINE.uid, gids: [gid] }) });
    await expect(install(options(root, system()))).rejects.toMatchObject({ code: 'unprotected' });
    const result = await install(options(root, system(), { acceptUnprotected: true }));
    expect(result.preflight.status).toBe('unprotected');
    expect(result.preflight.findings).toEqual(expect.arrayContaining([{ code: 'root_equivalent_socket', level: 'error', subject: socketPath }]));
  });

  it('uninstalls without touching credentials unless asked to purge them', async () => {
    const { root } = await hostRoot();
    await install(options(root, recordingSystem()));
    const paths = layout(root);
    await uninstall({ root, system: recordingSystem() });
    expect(await fs.stat(paths.installDir).then(() => true, () => false)).toBe(false);
    expect(await fs.stat(paths.unitFile).then(() => true, () => false)).toBe(false);
    expect((await fs.stat(paths.stateDir)).isDirectory()).toBe(true);
    const system = recordingSystem();
    await uninstall({ root, engineUser: 'dev', purgeState: true, system });
    expect(await fs.stat(paths.stateDir).then(() => true, () => false)).toBe(false);
    expect(system.calls).toEqual(expect.arrayContaining([
      ['removeUser', 'openchamber-mcp'], ['removeFromGroup', 'dev', 'openchamber-mcp-clients'],
      ['removeFromGroup', 'dev', 'openchamber-mcp-admins'], ['removeGroup', 'openchamber-mcp-admins'],
    ]));
  });
});
