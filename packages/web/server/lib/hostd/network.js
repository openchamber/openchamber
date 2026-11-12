import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { SpaceError } from '../spaces/errors.js';
import { addresses } from './state.js';
import { checked } from './system.js';

export function createNetwork({ system, paths, ipPath }) {
  const run = (file, args) => checked(system, file, args);
  const net = (id) => path.join(paths.pins, id);
  const account = async (id) => {
    const user = `openchamber-net-${id}`;
    let result = await system.run('/usr/bin/getent', ['passwd', user]);
    if (result.code === 2) {
      await run('/usr/sbin/useradd', ['--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', user]);
      result = await system.run('/usr/bin/getent', ['passwd', user]);
    }
    const parts = result.stdout.trim().split(':');
    if (result.code !== 0 || parts[0] !== user || !/^\d+$/.test(parts[2] ?? '') || !/^\d+$/.test(parts[3] ?? '') || Number(parts[2]) === 0) throw new SpaceError('net_account_unusable', 'Cannot establish the space network account');
    return { uid: parts[2], gid: parts[3] };
  };
  const create = async (record) => {
    const id = record.id;
    const directory = net(id);
    const { uid, gid } = await account(id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    for (const name of ['user', 'net']) await fs.writeFile(path.join(directory, name), '', { mode: 0o600 });
    await run(ipPath, ['netns', 'add', `ocs-${id}`]);
    const holder = system.spawn('/usr/bin/setpriv', [
      `--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '--inh-caps=+sys_admin', '--ambient-caps=+sys_admin',
      '/usr/bin/unshare', '--user', '--net', '--map-current-user', '--fork', '--kill-child=SIGKILL',
      '/usr/bin/node', '-e', 'console.log(process.pid); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
    ]);
    // Listened for now: a holder that exits on its own can emit close in the same callback as exit,
    // before the cleanup below runs, and a listener added there would wait forever.
    const closed = once(holder, 'close').catch(() => {});
    holder.stdin.on('error', () => {});
    let stderr = '';
    holder.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    try {
      const pid = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { reject(new SpaceError('namespace_timeout', 'The network namespace holder did not answer')); }, 5000);
        const fail = () => { clearTimeout(timeout); reject(new SpaceError('namespace_failed', stderr || 'The network namespace holder exited')); };
        holder.once('error', fail);
        holder.once('exit', fail);
        holder.stdout.once('data', (chunk) => {
          clearTimeout(timeout);
          holder.removeListener('exit', fail);
          const text = String(chunk).trim();
          if (!/^[1-9]\d*$/.test(text)) reject(new SpaceError('namespace_failed', 'Invalid namespace holder pid'));
          else resolve(text);
        });
      });
      for (const name of ['user', 'net']) await run('/usr/bin/mount', ['--bind', `/proc/${pid}/ns/${name}`, path.join(directory, name)]);
      await run(ipPath, ['link', 'add', `vs-${id}`, 'type', 'veth', 'peer', 'name', `vg-${id}`]);
      await run(ipPath, ['link', 'set', `vs-${id}`, 'netns', `ocs-${id}`]);
      await run(ipPath, ['link', 'set', `vg-${id}`, 'netns', pid]);
      const ips = addresses(record.subnet);
      const inSpace = (args) => run('/usr/bin/nsenter', [`--net=/run/netns/ocs-${id}`, '--', ipPath, ...args]);
      await inSpace(['addr', 'add', `${ips.space}/30`, 'dev', `vs-${id}`]);
      for (const device of ['lo', `vs-${id}`]) await inSpace(['link', 'set', device, 'up']);
      const inGatekeeper = (args) => run('/usr/bin/nsenter', [`--net=${directory}/net`, '--', ipPath, ...args]);
      await inGatekeeper(['addr', 'add', `${ips.gatekeeper}/30`, 'dev', `vg-${id}`]);
      for (const device of ['lo', `vg-${id}`]) await inGatekeeper(['link', 'set', device, 'up']);
    } finally {
      holder.stdin.end();
      holder.kill('SIGTERM');
      await closed;
    }
    await fs.writeFile(path.join(directory, 'resolv.conf'), 'nameserver 10.0.2.3\n');
    await fs.writeFile(path.join(directory, 'space-resolv.conf'), 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n');
    await fs.writeFile(path.join(directory, 'hosts'), `127.0.0.1 localhost\n${addresses(record.subnet).gatekeeper} gatekeeper\n`);
    await fs.writeFile(path.join(directory, 'gatekeeper-hosts'), '127.0.0.1 localhost\n');
    for (const target of ['space', 'gatekeeper']) await fs.writeFile(path.join(directory, `${target}.hostname`), `${target}-${id}\n`);
    // systemd binds the two pins into slirp's own RuntimeDirectory before dropping identity.
    // The original pins and all configuration stay behind root-owned 0700 parents.
    for (const file of await fs.readdir(directory)) if (!['net', 'user'].includes(file)) await fs.chmod(path.join(directory, file), 0o644);
  };
  const destroy = async (id) => {
    const problems = [];
    for (const name of ['net', 'user']) {
      const result = await system.run('/usr/bin/umount', [path.join(net(id), name)]);
      if (result.code !== 0 && !/not mounted|no mount point|No such file/.test(result.stderr)) problems.push(result.stderr);
    }
    const result = await system.run(ipPath, ['netns', 'delete', `ocs-${id}`]);
    if (result.code !== 0 && !/No such file/.test(result.stderr)) problems.push(result.stderr);
    const orphan = await system.run(ipPath, ['link', 'delete', `vs-${id}`]);
    if (orphan.code !== 0 && !/Cannot find device|does not exist/.test(orphan.stderr)) problems.push(orphan.stderr);
    if (problems.length) throw new SpaceError('namespace_cleanup_failed', problems.join('; ').slice(-2000));
    await fs.rm(net(id), { recursive: true, force: true });
  };
  return { create, destroy };
}
