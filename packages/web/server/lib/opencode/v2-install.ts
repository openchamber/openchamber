import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { requireOpenCodeV2 } from './compatibility.js';

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const NPM_REGISTRY = 'https://registry.npmjs.org';

export interface OpenCodeV2InstallOptions {
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  tarCommand?: string;
}

interface InstallerScriptOptions {
  version: string;
  workDirectory: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}

interface WindowsBinaryOptions extends Omit<InstallerScriptOptions, 'env'> {
  arch: NodeJS.Architecture;
  directory: string;
  tarCommand: string;
}

const releaseSchema = z.object({ version: z.string().regex(/^2\.\d+\.\d+$/) });
const packageDistSchema = z.object({
  dist: z.object({
    tarball: z.string().url(),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  }),
});

const windowsPackage = (arch: NodeJS.Architecture) => (arch === 'arm64' ? '@opencode/cli-windows-arm64' : '@opencode/cli-windows-x64-baseline');

export const supportsOpenCodeV2Install = (platform = process.platform) =>
  (platform === 'darwin' || platform === 'linux' || platform === 'win32') && (process.arch === 'x64' || process.arch === 'arm64');

const runInstaller = (script: string, version: string, env: NodeJS.ProcessEnv) => new Promise<void>((resolve, reject) => {
  const child = spawn('/bin/bash', [script, '--version', version, '--no-modify-path'], {
    env, cwd: os.tmpdir(), detached: true, stdio: 'ignore',
  });
  const terminate = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { void 0; }
  };
  const timer = setTimeout(terminate, INSTALL_TIMEOUT_MS);
  child.once('error', () => {
    clearTimeout(timer);
    reject(new Error('Could not start the OpenCode installer.'));
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    terminate();
    if (code === 0) resolve();
    else reject(new Error('OpenCode installation failed. Try the official installation guide.'));
  });
});

const extractArchive = (tarCommand: string, archive: string, destination: string) => new Promise<void>((resolve, reject) => {
  const child = spawn(tarCommand, ['-xzf', archive, '-C', destination], {
    stdio: 'ignore', windowsHide: true, timeout: INSTALL_TIMEOUT_MS,
  });
  child.once('error', () => reject(new Error('Could not unpack the OpenCode package.')));
  child.once('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error('Could not unpack the OpenCode package.'));
  });
});

const prepareInstallerScript = async ({ version, workDirectory, env, fetchImpl }: InstallerScriptOptions) => {
  const response = await fetchImpl('https://opencode.ai/v2/install', { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Could not download the OpenCode installer.');
  const script = path.join(workDirectory, 'install.sh');
  await fs.writeFile(script, await response.text(), { mode: 0o600 });
  return () => runInstaller(script, version, env);
};

const prepareWindowsBinary = async ({ version, arch, directory, workDirectory, fetchImpl, tarCommand }: WindowsBinaryOptions) => {
  const metadataResponse = await fetchImpl(`${NPM_REGISTRY}/${windowsPackage(arch).replace('/', '%2F')}/${version}`, { signal: AbortSignal.timeout(15_000) });
  if (!metadataResponse.ok) throw new Error('Could not resolve the OpenCode v2 package.');
  const { dist } = packageDistSchema.parse(await metadataResponse.json());
  if (new URL(dist.tarball).origin !== NPM_REGISTRY) throw new Error('The OpenCode v2 package is not served by the npm registry.');
  const archiveResponse = await fetchImpl(dist.tarball, { signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
  if (!archiveResponse.ok) throw new Error('Could not download the OpenCode v2 package.');
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== dist.integrity) {
    throw new Error('The downloaded OpenCode v2 package failed its integrity check.');
  }
  const archivePath = path.join(workDirectory, 'opencode.tgz');
  const extractDirectory = path.join(workDirectory, 'extract');
  await fs.writeFile(archivePath, archive);
  await fs.mkdir(extractDirectory);
  await extractArchive(tarCommand, archivePath, extractDirectory);
  const extracted = path.join(extractDirectory, 'package', 'bin', 'opencode.exe');
  await fs.access(extracted).catch(() => { throw new Error('The OpenCode v2 package does not contain opencode.exe.'); });
  return () => fs.copyFile(extracted, path.join(directory, 'opencode.exe'));
};

export const installOpenCodeV2 = async ({
  homeDirectory = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
  tarCommand = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
}: OpenCodeV2InstallOptions = {}) => {
  if (!supportsOpenCodeV2Install(platform)) throw new Error('Automatic OpenCode v2 installation is unavailable on this platform.');
  const windows = platform === 'win32';
  const binaryNames: [string, ...string[]] = windows ? ['opencode.exe'] : ['opencode', 'opencode2'];
  const directory = path.join(homeDirectory, '.opencode', 'bin');
  await fs.mkdir(directory, { recursive: true });
  const lock = path.join(directory, '.openchamber-install');
  await fs.mkdir(lock).catch(() => { throw new Error('Another OpenCode installation is already in progress.'); });
  const snapshots = [];
  let started = false;
  let cleanup = true;
  try {
    const releaseResponse = await fetchImpl(`${NPM_REGISTRY}/@opencode%2Fcli/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!releaseResponse.ok) throw new Error('Could not resolve the OpenCode v2 release.');
    const { version } = releaseSchema.parse(await releaseResponse.json());
    const replaceBinary = windows
      ? await prepareWindowsBinary({ version, arch, directory, workDirectory: lock, fetchImpl, tarCommand })
      : await prepareInstallerScript({ version, workDirectory: lock, env, fetchImpl });
    for (const name of binaryNames) {
      const target = path.join(directory, name);
      const backup = path.join(lock, name);
      const exists = await fs.lstat(target).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (exists) await fs.cp(target, backup, { dereference: false, verbatimSymlinks: true });
      snapshots.push({ target, backup, exists });
    }
    started = true;
    await replaceBinary();
    const binary = path.join(directory, binaryNames[0]);
    const installedVersion = await requireOpenCodeV2({ binary, args: [] }, { env });
    if (installedVersion !== version) throw new Error('The installed OpenCode version does not match the requested release.');
    return binary;
  } catch (error) {
    if (started) {
      try {
        for (const { target, backup, exists } of snapshots) {
          await fs.rm(target, { force: true });
          if (exists) await fs.rename(backup, target);
        }
      } catch {
        cleanup = false;
        throw new Error('Could not restore the previous OpenCode installation. The backup remains in .opencode/bin/.openchamber-install.');
      }
    }
    throw error;
  } finally {
    if (cleanup) await fs.rm(lock, { recursive: true, force: true });
  }
};
