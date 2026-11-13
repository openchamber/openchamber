import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SpaceError } from '../spaces/errors.js';
import { FILLER_PROGRAM } from '../spaces/tools-filler.js';
import { checked } from './system.js';
import { toolsKey } from './validation.js';

// No symlink is followed while root seals code produced by an unprivileged filler.
// External symlinks and special files are refused, including links to root-owned host paths.
export async function sealTools({ directory, system }) {
  const root = await fs.lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new SpaceError('tools_unsafe_file', 'The tools output must be a real directory');
  const walk = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        const destination = path.resolve(path.dirname(file), await fs.readlink(file));
        if (!destination.startsWith(`${directory}/`)) throw new SpaceError('tools_unsafe_link', 'A tools link points outside its installation');
        await system.chown(file, 0, 0);
      } else if (stat.isDirectory()) {
        await walk(file);
        await system.chown(file, 0, 0);
        await fs.chmod(file, 0o755);
      } else if (stat.isFile() && stat.nlink === 1) {
        await system.chown(file, 0, 0);
        await fs.chmod(file, stat.mode & 0o111 ? 0o755 : 0o644);
      } else if (stat.isFile()) {
        // OpenCode intentionally hard-links its launcher. Copy each inode before sealing:
        // a filler must not retain a writable hard-link into a sealed installation.
        const copy = `${file}.${randomBytes(4).toString('hex')}`;
        await fs.copyFile(file, copy, fs.constants.COPYFILE_EXCL);
        await fs.rename(copy, file);
        await system.chown(file, 0, 0);
        await fs.chmod(file, stat.mode & 0o111 ? 0o755 : 0o644);
      } else throw new SpaceError('tools_unsafe_file', 'A tools installation contains a special file');
    }
  };
  await walk(directory);
  await system.chown(directory, 0, 0);
  await fs.chmod(directory, 0o755);
}

export function createTools({ system, paths, state }) {
  const inFlight = new Map();
  const directory = (key) => path.join(paths.tools, toolsKey(key));
  const ready = async (key) => {
    try {
      const output = await fs.lstat(directory(key));
      if (!output.isDirectory()) throw new SpaceError('tools_unsafe_file', 'The tools output must be a real directory');
      const marker = path.join(directory(key), '.filled');
      const stat = await fs.lstat(marker);
      return stat.isFile() && stat.size === 16 && (await fs.readFile(marker, 'utf8')) === key;
    }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const fill = async (key, input) => {
    if (await ready(key)) return { key, filled: false };
    if ((await state.list()).some((record) => record.toolsKey === key)) throw new SpaceError('tools_marker_mismatch', 'A space still uses damaged tools; remove that space before refilling');
    const name = `openchamber-tools-fill-${key}-${randomBytes(4).toString('hex')}`;
    const relative = `openchamber-tools-fill/${name}`;
    const staging = path.join(path.dirname(paths.privateState), relative);
    await fs.mkdir(path.join(staging, 'tools'), { recursive: true, mode: 0o700 });
    const properties = [
      ['DynamicUser', 'yes'], ['StateDirectory', relative], ['StateDirectoryMode', '0700'],
      ['ProtectSystem', 'strict'], ['ProtectHome', 'yes'], ['PrivateTmp', 'yes'], ['PrivateDevices', 'yes'],
      ['NoNewPrivileges', 'yes'], ['CapabilityBoundingSet', ''], ['RestrictSUIDSGID', 'yes'],
      ['MemoryMax', '2147483648'], ['MemorySwapMax', '0'], ['TasksMax', '512'], ['KillMode', 'control-group'],
      ['BindPaths', `${staging}/tools:/opt/openchamber-tools`], ['Environment', 'HOME=/tmp'],
      ['Environment', 'PATH=/usr/bin:/bin'],
    ];
    try {
      await checked(system, '/usr/bin/systemd-run', ['--pipe', '--wait', '--quiet', '--collect', '--expand-environment=no', `--unit=${name}`,
        ...properties.map(([key, value]) => `--property=${key}=${value}`), '--', '/usr/bin/node', '-e', FILLER_PROGRAM, '/opt/openchamber-tools', '/tmp/openchamber-fill'],
      { stdin: input, timeoutMs: 30 * 60_000, maxOutputBytes: 16 * 1024 * 1024 });
      // The unit has ended with KillMode=control-group, so no filler process can race sealing.
      const output = path.join(staging, 'tools');
      await sealTools({ directory: output, system });
      const marker = path.join(output, '.filled');
      const stat = await fs.lstat(marker);
      if (!stat.isFile() || stat.size !== 16 || await fs.readFile(marker, 'utf8') !== key) throw new SpaceError('tools_fill_failed', 'The tools filler did not finish this key');
      await fs.rm(directory(key), { recursive: true, force: true });
      await fs.rename(output, directory(key));
      return { key, filled: true };
    } finally {
      await system.run('/usr/bin/systemctl', ['stop', `${name}.service`]);
      await fs.rm(staging, { recursive: true, force: true });
    }
  };
  const ensure = (key, input) => {
    if (!inFlight.has(key)) inFlight.set(key, fill(key, input).finally(() => inFlight.delete(key)));
    return inFlight.get(key);
  };
  const prune = async (keep) => {
    const used = new Set([...keep, ...(await state.list()).map((record) => record.toolsKey), ...inFlight.keys()]);
    const removed = [];
    for (const key of await fs.readdir(paths.tools)) if (/^[0-9a-f]{16}$/.test(key) && !used.has(key)) {
      await fs.rm(directory(key), { recursive: true, force: true });
      removed.push({ kind: 'tools', name: key });
    }
    return { removed, failed: [] };
  };
  return { ensure, prune, ready };
}
