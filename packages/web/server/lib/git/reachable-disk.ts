import { execFile } from 'node:child_process';
import type { ExecFileOptions, ExecFileOptionsWithBufferEncoding, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { directoryReachability, directoryUnreachableError } from '../directory-reachability/index.js';
import { normalizeGitOutputPath } from './output-path.js';
import { GIT_LAUNCH_DIRECTORY, gitArgsIn } from './git-launch.js';

const execFileOnDisk = promisify(execFile);

export function execFileAsync(file: string, args: string[], options: ExecFileOptionsWithStringEncoding): Promise<{ stdout: string; stderr: string }>;
export function execFileAsync(file: string, args: string[], options: ExecFileOptionsWithBufferEncoding): Promise<{ stdout: Buffer; stderr: Buffer }>;
export async function execFileAsync(file: string, args: string[], options: ExecFileOptions): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  if (!options.cwd) return execFileOnDisk(file, args, options);
  const directory = String(options.cwd);
  await directoryReachability.assertReachable(directory);
  return execFileOnDisk(file, gitArgsIn(directory, args), { ...options, cwd: GIT_LAUNCH_DIRECTORY });
}

export const directoryExists = async (directoryPath: string) => {
  const reachability = await directoryReachability.check(directoryPath);
  if (reachability === 'unreachable') throw directoryUnreachableError(directoryPath);
  if (reachability === 'missing') return false;
  const exists = await fs.promises.access(directoryPath).then(() => true, () => false);
  if (!exists) await directoryReachability.assertReachable(directoryPath);
  return exists;
};

export const realpathOf = async (target: string) => {
  if (await directoryReachability.isUnreachable(target)) return target;
  return fs.promises.realpath(target);
};

const MAX_LINKS = 32;

export const assertPathReachable = async (target: string, links = 0): Promise<string> => {
  await directoryReachability.assertReachable(target);
  const { root } = path.parse(target);
  const parts = target.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const entry = await fs.promises.lstat(current).catch(() => null);
    if (!entry) break;
    if (!entry.isSymbolicLink() || links >= MAX_LINKS) continue;
    const link = await fs.promises.readlink(current).catch(() => null);
    if (link !== null) return assertPathReachable(path.resolve(path.dirname(current), link, ...parts.slice(index + 1)), links + 1);
  }
  return target;
};

const MAX_METADATA_BYTES = 1_048_576;

const readLine = async (file: string) => {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_METADATA_BYTES) return '';
  return (await fs.promises.readFile(file, 'utf8').catch(() => '')).trim();
};

const namesCommit = async (directory: string) => {
  const head = path.join(directory, 'HEAD');
  const link = await fs.promises.readlink(head).catch(() => '');
  return /^refs\//.test(link) || /^(?:ref:\s*refs\/|[0-9a-f]{40,64}\b)/i.test(await readLine(head));
};

const assertGitDirectoryReachable = async (gitDirectory: string) => {
  const directory = await assertPathReachable(gitDirectory);
  await assertPathReachable(path.join(directory, 'HEAD'));
  if (!await namesCommit(directory)) return false;
  const common = await readLine(await assertPathReachable(path.join(directory, 'commondir')));
  const shared = common ? await assertPathReachable(path.resolve(directory, normalizeGitOutputPath(common))) : directory;
  const required = await Promise.all([
    path.join(shared, 'objects'), path.join(shared, 'refs'), path.join(shared, 'config'),
  ].map((entry) => assertPathReachable(entry)));
  const present = await Promise.all(required.slice(0, 2).map((entry) => fs.promises.lstat(entry).then(() => true, () => false)));
  return present.every(Boolean);
};

export const assertRepositoryReachable = async (checkout: string, { linkedOnly = false } = {}) => {
  for (let folder = await assertPathReachable(path.resolve(checkout)); ; folder = path.dirname(folder)) {
    const entry = path.join(folder, '.git');
    const target = await assertPathReachable(entry);
    const stat = await fs.promises.stat(target).catch(() => null);
    if (stat?.isFile()) {
      const link = /^gitdir: (.+)$/m.exec(await readLine(target))?.[1]?.trim();
      if (link) await assertGitDirectoryReachable(path.resolve(folder, normalizeGitOutputPath(link)));
      return;
    }
    if (linkedOnly && stat?.isDirectory()) return;
    if (stat?.isDirectory() && await assertGitDirectoryReachable(target)) return;
    const bare = await fs.promises.lstat(path.join(folder, 'HEAD')).then(() => true, () => false);
    if (bare && await assertGitDirectoryReachable(folder)) return;
    if (folder === path.dirname(folder)) return;
  }
};

export const assertLinkedRepositoryReachable = (checkout: string) => assertRepositoryReachable(checkout, { linkedOnly: true });
