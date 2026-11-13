import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createIntegrity } from '../protected-mcp/service/integrity.js';
import { install, uninstall } from '../protected-mcp/service/install.js';
import { HOST_CONFIG_FILE, HOST_INSTALL_DIR, HOST_REQUEST_DIR } from './managed.js';
import { downloadRelease, findRelease, VERSION_PATTERN } from './release.js';
import { fail } from './accounts.js';

export const PACKAGE_SUBDIR = 'node_modules/@openchamber/web';
export const exists = (target) => fs.lstat(target).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
export const readJson = async (file) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(`${command} ${args[0] ?? ''} failed: ${String(stderr).trim().slice(-2000)}`), { stderr: String(stderr) }));
    else resolve(String(stdout));
  });
});
export function layout(root = '/') {
  const live = {
    installDir: HOST_INSTALL_DIR, current: `${HOST_INSTALL_DIR}/current`, app: `${HOST_INSTALL_DIR}/current/${PACKAGE_SUBDIR}`,
    configFile: HOST_CONFIG_FILE, envFile: '/etc/openchamber/openchamber.env', requestDir: HOST_REQUEST_DIR,
    requestFile: `${HOST_REQUEST_DIR}/update`, cacheDir: '/var/cache/openchamber-host', binLink: '/usr/local/bin/openchamber',
    wrapper: '/usr/local/sbin/openchamber-host', agentEnv: '/etc/openchamber/agent.env', agentLink: '/etc/openchamber/agent-link.env',
    previousDeployment: '/etc/openchamber/previous-deployment.json',
  };
  return { live, ...Object.fromEntries(Object.entries(live).map(([key, value]) => [key, path.join(root, value)])), unit: (name) => path.join(root, '/etc/systemd/system', name) };
}
export function createSystem() {
  return {
    trustedOwners: [0], isRoot: () => process.getuid() === 0,
    hasSystemd: () => fs.stat('/run/systemd/system').then(() => true, () => false),
    async account(user) {
      const entry = (await run('getent', ['passwd', '--', user]).catch(() => '')).trim();
      if (!entry) fail('owner_unknown', `There is no account "${user}"`);
      const [, , uid, gid, , home, shell] = entry.split(':');
      const gids = (await run('id', ['-G', '--', user])).trim().split(/\s+/).map(Number);
      const groups = (await run('id', ['-Gn', '--', user])).trim().split(/\s+/).filter(Boolean);
      return { name: user, uid: Number(uid), gid: Number(gid), gids, groups, home, shell };
    },
    run,
    async runResult(command, args) {
      try { return { code: 0, stdout: await run(command, args), stderr: '' }; }
      catch (error) { return { code: 1, stdout: '', stderr: error.message }; }
    },
    chown: (target, uid, gid) => fs.lchown(target, uid, gid),
    systemctl: (args) => run('systemctl', args),
    isActive: (unit) => run('systemctl', ['is-active', unit]).then((out) => out.trim(), (error) => String(error.stderr ?? '').trim() || 'inactive'),
    nodeVersion: (node) => run(node, ['--version']),
    npm: (node, npmCli, args, env) => run(node, [npmCli, ...args], { timeout: 15 * 60_000, env }),
    installOpenCode: (owner, node, app) => run('runuser', ['-u', owner.name, '--', 'env', `HOME=${owner.home}`, 'PATH=/usr/local/bin:/usr/bin:/bin', node, '--input-type=module', '-e',
      `const { installOpenCodeV2 } = await import(${JSON.stringify(`${app}/server/lib/opencode/v2-install.js`)}); process.stdout.write(await installOpenCodeV2());`], { timeout: 10 * 60_000, cwd: '/' }),
    findRelease, downloadRelease,
    async health(url) {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return response.ok ? response.json() : null;
    },
    async agentHealth(url, token) {
      const login = await fetch(`${url}/auth/session`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: token }), signal: AbortSignal.timeout(2000) });
      const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
      await login.body?.cancel();
      if (!login.ok || !cookie) return null;
      const session = await fetch(`${url}/auth/session`, { redirect: 'error', headers: { cookie }, signal: AbortSignal.timeout(2000) });
      if (!session.ok || (await session.json()).authenticated !== true) return null;
      const health = await fetch(`${url}/health`, { redirect: 'error', headers: { cookie }, signal: AbortSignal.timeout(2000) });
      return health.ok ? health.json() : null;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    protectedMcp: { install, uninstall },
    async backupDatabase(source, destination) {
      const { DatabaseSync, backup } = await import('node:sqlite');
      const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
      try { await backup(db, destination); } finally { db.close(); }
    },
  };
}
export async function requireTrusted(system, owner, target, code) {
  const { findings } = await createIntegrity({ owners: system.trustedOwners, groups: [0], engine: { uid: owner.uid, gids: owner.gids } }).inspect(target);
  if (findings.length) fail(code, `${target}: ${findings.map((finding) => `${finding.code} ${finding.subject}`).join(', ')}`);
}
export async function trustedToolchain(system, owner, root) {
  let node;
  for (const candidate of ['/usr/bin/node', '/usr/local/bin/node']) {
    if (!await exists(path.join(root, candidate))) continue;
    await requireTrusted(system, owner, path.join(root, candidate), 'untrusted_node');
    const match = /^v(\d+)\.(\d+)/.exec((await system.nodeVersion(path.join(root, candidate))).trim());
    if (!match || Number(match[1]) < 24 || (Number(match[1]) === 24 && Number(match[2]) < 14)) fail('node_too_old', `${candidate} must be Node.js 24.14 or newer`);
    node = candidate;
    break;
  }
  if (!node) fail('node_missing', 'Install Node.js 24.14+ system-wide at /usr/bin/node, owned by root, then run this again');
  for (const candidate of ['/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js']) {
    if (!await exists(path.join(root, candidate))) continue;
    await requireTrusted(system, owner, path.join(root, candidate), 'untrusted_npm');
    return { node, npm: candidate };
  }
  fail('npm_missing', 'Install npm system-wide with Node.js, owned by root, then run this again');
}
export async function writeRootFile(system, file, content, mode = 0o644) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temporary, content, { mode, flag: 'wx' });
    await fs.chmod(temporary, mode);
    await system.chown(temporary, 0, 0);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
export const writeConfig = (system, paths, config) => writeRootFile(system, paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
export const replaceSymlink = async (link, destination) => {
  const temporary = `${link}.${randomBytes(4).toString('hex')}`;
  await fs.symlink(destination, temporary);
  await fs.rename(temporary, link);
};
export async function linkedVersion(paths, link) {
  const target = await fs.readlink(path.join(paths.installDir, link)).catch(() => null);
  return target ? (await readJson(path.join(paths.installDir, target, PACKAGE_SUBDIR, 'package.json')).catch(() => null))?.version ?? null : null;
}
export async function prepare(system) {
  if (!system.isRoot()) fail('root_required', 'Run this as root');
  if (!await system.hasSystemd()) fail('systemd_required', 'The host install needs systemd');
}
export async function obtainPackage({ system, paths, config, tarball, version, release = null }) {
  if (tarball) {
    if (!VERSION_PATTERN.test(version ?? '')) fail('invalid_version', 'Give --version with --tarball');
    return { tarball, version, cleanup: async () => {} };
  }
  release ??= await system.findRelease({ repo: config.repo });
  await fs.mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  const file = path.join(paths.cacheDir, `openchamber-web-${release.version}-${randomBytes(4).toString('hex')}.tgz`);
  await system.downloadRelease(release, file);
  return { tarball: file, version: release.version, cleanup: () => fs.rm(file, { force: true }) };
}
