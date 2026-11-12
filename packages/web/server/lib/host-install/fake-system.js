// Test-only privileged operations over an isolated root. No command reaches the host.
import fs from 'node:fs/promises';
import path from 'node:path';
import { layout as protectedMcpLayout } from '../protected-mcp/service/install.js';
import { trustedFixtureDirectory } from '../protected-mcp/test-support/fixtures.js';
import { layout } from './host-support.js';

export const OWNER = { name: 'alice', uid: 2_000_000_001, gid: 2_000_000_001, gids: [2_000_000_001], home: '/home/alice', shell: '/bin/bash' };
export const FRONT = { name: 'openchamber', uid: 900, gid: 900, gids: [900], home: '/var/lib/openchamber', shell: '/usr/sbin/nologin' };
export const AGENT = { name: 'alice-agent', uid: 2_000_000_002, gid: 2_000_000_002, gids: [2_000_000_002], home: '/home/alice-agent', shell: '/bin/bash' };
export const linked = async (root, link) => {
  const dir = await fs.readlink(path.join(layout(root).installDir, link)).catch(() => null);
  return dir && JSON.parse(await fs.readFile(path.join(layout(root).installDir, dir, 'node_modules/@openchamber/web/package.json'), 'utf8')).version;
};
export async function hostRoot(cleanups) {
  const scratch = await trustedFixtureDirectory();
  cleanups.push(scratch.remove);
  const root = path.join(scratch.directory, 'root');
  await fs.mkdir(path.join(root, 'usr/bin'), { recursive: true });
  await fs.symlink('/usr/bin/node', path.join(root, 'usr/bin/node'));
  const opencode = path.join(root, 'home/alice/.opencode/bin/opencode');
  await fs.mkdir(path.dirname(opencode), { recursive: true });
  await fs.writeFile(opencode, '', { mode: 0o755 });
  const npm = path.join(root, 'usr/lib/node_modules/npm/bin/npm-cli.js');
  await fs.mkdir(path.dirname(npm), { recursive: true });
  await fs.writeFile(npm, '', { mode: 0o644 });
  return root;
}
export function fakeSystem(root, { latest = '2.7.0', broken = null, agentBroken = false, protectedFails = false, withoutUpdater = null } = {}) {
  const calls = [];
  const accounts = new Map([[OWNER.name, OWNER], ['root', { ...OWNER, name: 'root', uid: 0 }]]);
  const groups = new Map([['openchamber-mcp-clients', 990], ['openchamber-mcp-admins', 992]]);
  const record = (name) => async (...args) => { calls.push([name, ...args]); };
  return {
    calls, accounts, groups, trustedOwners: [0, process.getuid()], isRoot: () => true, hasSystemd: async () => true,
    account: async (name) => {
      if (!accounts.has(name)) throw Object.assign(new Error('Unknown account'), { code: 'owner_unknown' });
      return accounts.get(name);
    },
    async run(command, args) {
      calls.push([command, args]);
      if (command === 'useradd') {
        const name = args.at(-1);
        accounts.set(name, name === 'openchamber' ? FRONT : { ...AGENT, name, home: `/home/${name}` });
      }
      if (command === 'getent' && args[0] === 'group' && groups.has(args[1])) return `${args[1]}:x:${groups.get(args[1])}:\n`;
      return '';
    },
    runResult: async (command, args) => { calls.push([command, args]); return { code: 0, stdout: '', stderr: '' }; },
    chown: record('chown'), systemctl: record('systemctl'), isActive: async () => 'active', nodeVersion: async () => 'v24.21.0\n',
    async npm(_node, _npm, args) {
      calls.push(['npm']);
      const prefix = args[args.indexOf('--prefix') + 1];
      const version = /openchamber-web-(\d+\.\d+\.\d+)/.exec(args.at(-1))[1];
      const app = path.join(prefix, 'node_modules/@openchamber/web');
      await fs.mkdir(path.join(app, 'bin'), { recursive: true });
      await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: '@openchamber/web', version }));
      await fs.writeFile(path.join(app, 'bin/cli.js'), '', { mode: 0o775 });
      if (version !== withoutUpdater) {
        await fs.mkdir(path.join(app, 'server/lib/host-install'), { recursive: true });
        await fs.writeFile(path.join(app, 'server/lib/host-install/main.js'), '');
      }
    },
    findRelease: async () => ({ version: latest, url: 'https://example.test/pkg.tgz', sha256: 'x' }),
    downloadRelease: async (_release, file) => { calls.push(['download']); await fs.writeFile(file, 'package'); },
    async health() { const version = await linked(root, 'current'); return version === broken ? null : { openchamberVersion: version }; },
    async agentHealth(url) { calls.push(['agentHealth', url]); return agentBroken ? null : { openchamberVersion: await linked(root, 'current') }; },
    sleep: async () => {}, installOpenCode: record('installOpenCode'),
    backupDatabase: async (source, destination) => { calls.push(['backupDatabase', source, destination]); await fs.copyFile(source, destination); },
    protectedMcp: {
      install: async (options) => {
        calls.push(['protectedMcp.install', options.version, options.engineUser, options.engineUnit]);
        calls.push(['protectedMcp.options', options]);
        const { installDir } = protectedMcpLayout(root);
        await fs.mkdir(path.join(installDir, options.version), { recursive: true });
        await fs.rm(path.join(installDir, 'current'), { force: true });
        await fs.symlink(options.version, path.join(installDir, 'current'));
        if (protectedFails) throw Object.assign(new Error('The engine can reach root: docker_group'), { code: 'unprotected' });
        return { preflight: { status: 'protected' } };
      },
      uninstall: record('protectedMcp.uninstall'),
    },
  };
}
export const installOptions = (root, system, extra = {}) => ({ root, system, owner: 'alice', repo: 'example/openchamber', tarball: '/cache/openchamber-web-2.6.0.tgz', version: '2.6.0', readUiPassword: async () => 'synthetic ui password', ...extra });
