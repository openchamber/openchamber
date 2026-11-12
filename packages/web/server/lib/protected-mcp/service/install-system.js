import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(`${command} failed`), { code: error.code, stderr: String(stderr).slice(-2000) }));
    else resolve(String(stdout));
  });
});

/** Privileged operations, injectable for temporary-root installer tests. */
export function createSystem() {
  const exists = (command, args) => run(command, args).then(() => true, () => false);
  return {
    trustedOwners: [0],
    isRoot: () => process.getuid() === 0,
    hasSystemd: () => fs.stat('/run/systemd/system').then(() => true, () => false),
    async identity(user) {
      const [uid, gids] = await Promise.all([run('id', ['-u', '--', user]), run('id', ['-G', '--', user])]);
      return { uid: Number(uid.trim()), gids: gids.trim().split(/\s+/).map(Number) };
    },
    async ensureGroup(name) {
      if (!await exists('getent', ['group', name])) await run('groupadd', ['--system', name]);
      return Number((await run('getent', ['group', name])).split(':')[2]);
    },
    async ensureUser(name, { home }) {
      if (!await exists('id', ['-u', '--', name])) {
        await run('useradd', ['--system', '--user-group', '--home-dir', home, '--no-create-home', '--shell', '/usr/sbin/nologin', name]);
      }
      return Number((await run('id', ['-u', '--', name])).trim());
    },
    addToGroup: (user, group) => run('usermod', ['--append', '--groups', group, user]),
    removeFromGroup: (user, group) => run('gpasswd', ['--delete', user, group]).catch(() => {}),
    removeUser: (name) => run('userdel', [name]).catch(() => {}),
    removeGroup: (name) => run('groupdel', [name]).catch(() => {}),
    chown: (target, uid, gid) => fs.lchown(target, uid, gid),
    systemctl: (args) => run('systemctl', args),
    createTmpfiles: (file) => run('systemd-tmpfiles', ['--create', file]),
    nodeVersion: (node) => run(node, ['--version']),
    connect: (socket) => new Promise((resolve, reject) => {
      const client = net.createConnection(socket);
      let answer = '';
      client.setEncoding('utf8');
      client.once('connect', () => client.write('{"type":"status"}\n'));
      client.on('data', (chunk) => { answer += chunk; });
      client.once('error', reject);
      client.once('close', () => {
        try { resolve(JSON.parse(answer)); }
        catch (error) { reject(error); }
      });
    }),
  };
}
