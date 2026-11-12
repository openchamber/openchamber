import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './accounts.js';
import { exists, PACKAGE_SUBDIR, readJson } from './host-support.js';

async function sealTree(system, directory) {
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    await system.chown(full, 0, 0);
    if (entry.isSymbolicLink()) continue;
    const executable = entry.isDirectory() || ((await fs.stat(full)).mode & 0o111) !== 0;
    await fs.chmod(full, executable ? 0o755 : 0o644);
  }
  await system.chown(directory, 0, 0);
  await fs.chmod(directory, 0o755);
}

export async function installPackage({ system, paths, toolchain, root, tarball, version }) {
  await fs.mkdir(paths.installDir, { recursive: true, mode: 0o755 });
  await system.chown(paths.installDir, 0, 0);
  await fs.chmod(paths.installDir, 0o755);
  await fs.mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  const staging = path.join(paths.installDir, `.staging-${randomBytes(4).toString('hex')}`);
  const name = `${version}-${randomBytes(4).toString('hex')}`;
  try {
    await fs.mkdir(staging, { mode: 0o755 });
    await system.npm(path.join(root, toolchain.node), path.join(root, toolchain.npm), [
      'install', '--prefix', staging, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', tarball,
    ], { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.cacheDir, npm_config_cache: path.join(paths.cacheDir, 'npm'), npm_config_userconfig: '/dev/null' });
    const installed = await readJson(path.join(staging, PACKAGE_SUBDIR, 'package.json'));
    if (installed?.name !== '@openchamber/web' || installed.version !== version) fail('package_mismatch', `The package installed ${installed?.name ?? '?'}@${installed?.version ?? '?'}, expected @openchamber/web@${version}`);
    if (!await exists(path.join(staging, PACKAGE_SUBDIR, 'server/lib/host-install/main.js'))) fail('no_host_installer', `OpenChamber ${version} has no host installer, so it cannot be installed system-wide`);
    await sealTree(system, staging);
    await fs.rename(staging, path.join(paths.installDir, name));
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return name;
}

export async function pruneVersions(paths) {
  const keep = new Set();
  for (const link of ['current', 'previous']) {
    const target = await fs.readlink(path.join(paths.installDir, link)).catch(() => null);
    if (target) keep.add(target);
  }
  for (const entry of await fs.readdir(paths.installDir)) {
    if (entry === 'current' || entry === 'previous' || keep.has(entry) || entry.startsWith('.staging-')) continue;
    await fs.rm(path.join(paths.installDir, entry), { recursive: true, force: true });
  }
}
