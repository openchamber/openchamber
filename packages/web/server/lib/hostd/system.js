import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { SpaceError } from '../spaces/errors.js';
import { runCommand } from '../spaces/run-command.js';

const ENVIRONMENT = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' });

export function createSystem() {
  const run = (file, args, options = {}) => runCommand(file, args, { env: ENVIRONMENT, timeoutMs: 60_000, ...options });
  return {
    run,
    spawn: (file, args) => spawn(file, args, { env: ENVIRONMENT, cwd: '/', shell: false, stdio: ['pipe', 'pipe', 'pipe'] }),
    chown: (file, uid, gid) => fs.lchown(file, uid, gid),
    async ipPath() {
      for (const candidate of ['/usr/bin/ip', '/usr/sbin/ip']) if (await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false)) return candidate;
      throw new SpaceError('ip_missing', 'Install iproute2 system-wide');
    },
  };
}

export async function checked(system, file, args, options) {
  const result = await system.run(file, args, options);
  if (result.code !== 0) throw new SpaceError('hostd_command_failed', `${file} ${args[0] ?? ''} failed: ${result.stderr.slice(-2000)}`);
  return result.stdout;
}

function propertiesOf(text) {
  return Object.fromEntries(text.trimEnd().split('\n').map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}

export const showUnit = async (system, unit) => propertiesOf(await checked(system, '/usr/bin/systemctl', ['show', '--all', unit]));

export async function checkRequirements(system) {
  const unavailable = (code, message) => ({ available: false, code, message });
  const required = [
    ['/usr/bin/node', 'node_missing', 'Install Node.js 24.14+ at /usr/bin/node'],
    ['/usr/bin/slirp4netns', 'slirp4netns_missing', 'Install slirp4netns'],
    ['/dev/net/tun', 'tun_missing', 'Enable /dev/net/tun'],
    ['/usr/bin/curl', 'curl_missing', 'Install curl'], ['/usr/bin/git', 'git_missing', 'Install git'],
    ...['systemctl', 'systemd-run', 'systemd-analyze', 'setpriv', 'unshare', 'nsenter', 'mount', 'umount', 'getent'].map((name) => [`/usr/bin/${name}`, `${name.replaceAll('-', '_')}_missing`, `Install ${name}`]),
    ...['useradd', 'userdel'].map((name) => [`/usr/sbin/${name}`, `${name}_missing`, `Install ${name}`]),
  ];
  for (const [file, code, message] of required) if (!await fs.access(file).then(() => true, () => false)) return unavailable(code, message);
  let version;
  let nodeVersion;
  try {
    await system.ipPath();
    const result = await system.run('/usr/bin/systemctl', ['--version']);
    version = /^systemd (\d+)/.exec(result.stdout)?.[1];
    if (result.code !== 0 || Number(version ?? 0) < 259) return unavailable('systemd_version', 'Host spaces require systemd 259 or newer');
    const node = await system.run('/usr/bin/node', ['--version']);
    if (node.code !== 0 || !/^v24\.(?:1[4-9]|[2-9]\d)\.|^v(?:2[5-9]|[3-9]\d)\./.test(node.stdout)) return unavailable('node_version', 'Install Node.js 24.14+ at /usr/bin/node');
    nodeVersion = node.stdout.trim();
  } catch (error) { return unavailable(error.code ?? 'hostd_requirements_failed', error.message); }
  return { available: true, version, os: 'linux', arch: process.arch, nodeVersion, hostIsolation: true };
}
