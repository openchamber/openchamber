import fs from 'node:fs/promises';
import path from 'node:path';
import { fail, FRONT_HOME } from './accounts.js';
import { oldDataDirectory, readOptional } from './migrate-accounts.js';
import { writeRootFile } from './host-support.js';

export async function prepareBackup({ root, system, config, accounts, paths, into }) {
  if (!into || !path.isAbsolute(into) || path.normalize(into) !== into || into === '/') fail('backup_directory_required', 'Give --into with a new absolute directory');
  const at = (file) => path.join(root, file);
  const dataDirs = config.separation
    ? [`${FRONT_HOME}/.config/openchamber`, `${accounts.agent.home}/.config/openchamber`]
    : [oldDataDirectory(await readOptional(paths.envFile), accounts.human)];
  const opencode = `${accounts.agent.home}/.local/share/opencode`;
  const include = ['/etc/openchamber', '/var/lib/openchamber-hostd', '/var/lib/openchamber-protected-mcp', ...dataDirs, opencode, `${accounts.agent.home}/.config/opencode`];
  if (config.separation) include.push(`${FRONT_HOME}/migration.json`);
  const exclude = dataDirs.flatMap((dir) => ['cache', 'tmp', 'run', 'logs', 'bin'].map((name) => `${dir}/${name}`));
  exclude.push(`${opencode}/log`, `${opencode}/bin`, `${opencode}/cache`);
  const destination = at(into);
  for (const directory of include) if (into === directory || into.startsWith(`${directory}/`)) fail('backup_directory_inside_data', 'The backup directory must be outside the live data');
  // A fresh root-owned directory prevents following a pre-planted destination link.
  await fs.mkdir(destination, { mode: 0o700 });
  await system.chown(destination, 0, 0);
  const manifest = { version: 1, include, exclude, databases: [], restoreOrder: ['install-same-version', 'stop-units', 'restore-files-and-database-copies', 'repair-permissions', 'start-units'], projects: 'Back up human-owned project paths separately' };
  const visit = async (directory) => {
    let entries;
    try { entries = await fs.readdir(at(directory), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      if (exclude.includes(source) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(source);
      else if (entry.isFile() && /\.(db|sqlite)$/.test(entry.name)) {
        const copy = path.join(into, `database-${manifest.databases.length}.sqlite`);
        await system.backupDatabase(at(source), at(copy));
        await fs.chmod(at(copy), 0o600);
        await system.chown(at(copy), 0, 0);
        manifest.databases.push({ source, copy });
        manifest.include.push(copy);
        manifest.exclude.push(source, `${source}-wal`, `${source}-shm`);
      }
    }
  };
  for (const directory of [...dataDirs, opencode]) await visit(directory);
  await writeRootFile(system, path.join(destination, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return manifest;
}
