import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { directoryReachability, directoryUnreachableError } from '../directory-reachability/index.js';
import { normalizeGitOutputPath } from './output-path.js';
import { cleanBranchName } from './existing-branch-refs.js';
import { assertPathReachable } from './reachable-disk.js';
import type { WorktreeEntry } from './service-contracts.js';

type RunGit = (directory: string, args: string[], failure: string) => Promise<{ stdout: string }>;

interface WorktreeRecord {
  id: string;
  gitDirectory: string;
  worktree: string;
  relative: boolean;
  backlink: string;
}

interface WorktreeHead {
  ref?: string;
  oid?: string;
}

const LIST_DEADLINE_MS = 3000;
const REMOVAL_SETTLE_MS = 50;
const LIST_FAILURE = 'Failed to list git worktrees';
const noHead: WorktreeHead = {};
const UNBORN_LENGTH = new Map([['sha1', 40], ['sha256', 64]]);

const unlessAbsent = <Absent>(absent: Absent) => (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return absent;
  throw error;
};

const isPresent = (target: string) => fs.lstat(target).then(() => true).catch(unlessAbsent(false));

const parseWorktreePorcelain = (raw: string) => {
  const lines = String(raw || '').split('\n').map((line) => line.trim());
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const line of lines) {
    if (!line) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = null;
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = { worktree: normalizeGitOutputPath(line.substring('worktree '.length).trim()) };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.substring('HEAD '.length).trim();
      continue;
    }

    if (line.startsWith('branch ')) {
      const branchRef = line.substring('branch '.length).trim();
      current.branchRef = branchRef;
      current.branch = cleanBranchName(branchRef);
      continue;
    }

    if (line === 'bare') {
      current.bare = true;
      continue;
    }

    if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
      continue;
    }

    if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    }
  }

  if (current?.worktree) {
    entries.push(current);
  }

  return entries;
};

export const readWorktreeRecords = async (gitCommonDirectory: string, { skipOffline = false } = {}): Promise<WorktreeRecord[]> => {
  const administration = await assertPathReachable(path.join(gitCommonDirectory, 'worktrees'));
  const entries = await fs.readdir(administration, { withFileTypes: true }).catch(unlessAbsent([]));
  const records = await Promise.all(entries.map(async (entry) => {
    const gitDirectory = path.join(administration, entry.name);
    if (entry.isSymbolicLink()) {
      const answers = await assertPathReachable(gitDirectory).catch((error) => {
        if (skipOffline) return null;
        throw error;
      });
      if (answers === null) return null;
    }
    const backlink = await fs.readFile(path.join(gitDirectory, 'gitdir'), 'utf8').catch(unlessAbsent(''));
    const link = normalizeGitOutputPath(backlink.trim());
    if (!link) return null;
    const gitFile = path.isAbsolute(link) ? link : path.resolve(gitDirectory, link);
    return { id: entry.name, gitDirectory, worktree: gitFile.replace(/[\\/]\.git$/, ''), relative: !path.isAbsolute(link), backlink };
  }));
  return records.filter((record) => record !== null).sort((left, right) => (left.worktree < right.worktree ? -1 : 1));
};

const isOffline = async (worktree: string) => await directoryReachability.isUnreachable(worktree)
  || assertPathReachable(path.join(worktree, '.git')).then(() => false, () => true);

const anyUnreachable = async (records: WorktreeRecord[]) => (
  await Promise.all(records.map((record) => isOffline(record.worktree)))
).includes(true);

const isPrunable = async (worktree: string) => !await isOffline(worktree)
  && await directoryReachability.check(path.join(worktree, '.git')) === 'missing';

const wait = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

const isRecordGone = async (gitDirectory: string) => {
  const gitFile = path.join(gitDirectory, 'gitdir');
  if (!await isPresent(gitFile)) return true;
  await wait(REMOVAL_SETTLE_MS);
  return !await isPresent(gitFile);
};

const readLink = (gitDirectory: string) => fs.readFile(path.join(gitDirectory, 'gitdir'), 'utf8').catch(unlessAbsent(null));

const discardRecord = async (gitDirectory: string, isStale: () => Promise<boolean>) => {
  if (!await isStale()) return;
  const lock = path.join(gitDirectory, 'locked');
  const claimed = await fs.writeFile(lock, '', { flag: 'wx' }).then(() => true, () => false);
  if (!claimed) return;
  try {
    if (await isStale().catch(() => false)) await fs.rm(gitDirectory, { recursive: true, force: true });
  } finally {
    await fs.rm(lock, { force: true });
  }
};

const alreadyExists = (target: string) => new Error(`fatal: '${target}' already exists`);

const placeOf = async (directory: string) => {
  const parent = path.dirname(path.resolve(directory));
  const place = path.join(await fs.realpath(parent).catch(() => parent), path.basename(directory));
  return process.platform === 'win32' ? place.toLowerCase() : place;
};

const assertFree = async (target: string) => {
  const stat = await fs.lstat(target).catch(unlessAbsent(null));
  if (stat && !(stat.isDirectory() && (await fs.readdir(target)).length === 0)) throw alreadyExists(target);
};

const listings = new Map<string, { startedAt: number; done: Promise<void> }>();

const settlesBy = async (done: Promise<void>, deadline: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), false); });
  return Promise.race([done.then(() => true), late]).finally(() => clearTimeout(timer));
};

const assertEnumerableRecords = async (records: WorktreeRecord[]) => {
  for (const record of records) if (record.relative && await isOffline(record.worktree)) throw directoryUnreachableError(record.worktree);
};

export const createWorktreeRegistry = (runGit: RunGit, { listDeadlineMs = LIST_DEADLINE_MS } = {}) => {
  const commonDirectoryOf = async (directory: string) => {
    const { stdout } = await runGit(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], LIST_FAILURE);
    return path.resolve(directory, normalizeGitOutputPath(stdout.trim().split(/\r?\n/).pop() ?? ''));
  };

  const readHead = async (directory: string, gitDirectory: string, name: string): Promise<WorktreeHead> => {
    const text = (await fs.readFile(path.join(gitDirectory, 'HEAD'), 'utf8').catch(() => '')).trim();
    const ref = /^ref: (refs\/.+)$/.exec(text)?.[1];
    if (ref && ref !== 'refs/heads/.invalid') return { ref };
    if (/^[0-9a-f]{40,64}$/.test(text)) return { oid: text };
    const symbolic = await runGit(directory, ['symbolic-ref', '--quiet', name], LIST_FAILURE).catch(() => null);
    if (symbolic) return { ref: symbolic.stdout.trim() };
    return { oid: (await runGit(directory, ['rev-parse', '--verify', name], LIST_FAILURE)).stdout.trim() };
  };

  const readTips = async (directory: string, refs: string[]) => {
    if (refs.length === 0) return new Map<string, { oid: string; ref: string }>();
    const { stdout } = await runGit(directory, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', ...refs], LIST_FAILURE);
    return new Map(stdout.split('\n').map((line) => line.trim().split(' ')).map(([name = '', oid = '', target]) => [name, { oid, ref: target || name }]));
  };

  const porcelainFromRecords = async (directory: string, commonDirectory: string, records: WorktreeRecord[]) => {
    const bare = (await runGit(directory, ['--git-dir', commonDirectory, 'rev-parse', '--is-bare-repository'], LIST_FAILURE)).stdout.trim() === 'true';
    const main = commonDirectory.replace(/[\\/]\.git$/, '');
    const rows = (await Promise.all([
      { worktree: process.platform === 'win32' ? main.replaceAll('\\', '/') : main, bare, notes: [], gitDirectory: commonDirectory, name: 'main-worktree/HEAD' },
      ...records.map(async ({ id, gitDirectory, worktree }) => {
        const note = await isPresent(path.join(gitDirectory, 'locked')) ? 'locked' : await isPrunable(worktree) && 'prunable';
        return { worktree, bare: false, notes: note ? [note] : [], gitDirectory, name: `worktrees/${id}/HEAD` };
      }),
    ].map(async (pending) => {
      const row = await pending;
      const head = row.bare ? noHead : await readHead(directory, row.gitDirectory, row.name).catch(async (error) => {
        if (row.gitDirectory !== commonDirectory && await isRecordGone(row.gitDirectory)) return null;
        throw error;
      });
      return head && { ...row, head };
    }))).filter((row) => row !== null);
    const tips = await readTips(directory, rows.flatMap(({ head }) => head.ref ?? []));
    const unborn = rows.some(({ head }) => head.ref && !tips.has(head.ref))
      ? '0'.repeat(UNBORN_LENGTH.get((await runGit(directory, ['rev-parse', '--show-object-format'], LIST_FAILURE)).stdout.trim()) ?? 40)
      : '';
    return rows.map(({ worktree, bare: isBare, notes, head }) => {
      const tip = head.ref ? tips.get(head.ref) ?? { oid: unborn, ref: head.ref } : null;
      const state = tip ? [`HEAD ${tip.oid}`, `branch ${tip.ref}`] : [`HEAD ${head.oid}`, 'detached'];
      return [`worktree ${worktree}`, ...(isBare ? ['bare'] : state), ...notes, '', ''].join('\n');
    }).join('');
  };

  const listWithGit = async (directory: string, commonDirectory: string) => {
    const deadline = Date.now() + listDeadlineMs;
    for (let running = listings.get(commonDirectory); running; running = listings.get(commonDirectory)) {
      if (!await settlesBy(running.done, Math.min(deadline, running.startedAt + listDeadlineMs))) return null;
    }
    const listing = runGit(directory, ['worktree', 'list', '--porcelain'], LIST_FAILURE);
    const settle = () => { listings.delete(commonDirectory); };
    const running = { startedAt: Date.now(), done: listing.then(settle, settle) };
    listings.set(commonDirectory, running);
    return await settlesBy(running.done, deadline) ? (await listing).stdout : null;
  };

  const readPorcelain = async (directory: string) => {
    const commonDirectory = await commonDirectoryOf(directory);
    const records = await readWorktreeRecords(commonDirectory);
    const listed = await anyUnreachable(records) ? null : await listWithGit(directory, commonDirectory);
    const trusted = listed !== null && !(/^prunable/m.test(listed) && await anyUnreachable(records));
    return trusted ? listed : porcelainFromRecords(directory, commonDirectory, records);
  };

  const assertEnumerable = async (directory: string) => (
    assertEnumerableRecords(await readWorktreeRecords(await commonDirectoryOf(directory), { skipOffline: true }))
  );

  const list = async (directory: string) => parseWorktreePorcelain(await readPorcelain(directory));

  const discardStaged = async (directory: string, staged: string) => {
    const link = await fs.readFile(path.join(staged, '.git'), 'utf8').catch(() => '');
    if (!link) return;
    const gitDirectory = path.resolve(staged, link.trim().replace(/^gitdir: /, ''));
    const recorded = (await fs.readFile(path.join(gitDirectory, 'gitdir'), 'utf8').catch(() => '')).trim();
    if (!recorded) return;
    const checkout = path.dirname(path.resolve(gitDirectory, recorded));
    await runGit(directory, ['worktree', 'remove', '--force', checkout], 'Failed to remove the staged worktree').catch(() => undefined);
  };

  const moveIntoPlace = async (staged: string, target: string) => {
    const link = (await fs.readFile(path.join(staged, '.git'), 'utf8')).trim().replace(/^gitdir: /, '');
    const gitDirectory = path.resolve(staged, link);
    const recordFile = path.join(gitDirectory, 'gitdir');
    const recorded = (await fs.readFile(recordFile, 'utf8')).trim();
    const gitFile = path.join(await fs.realpath(path.dirname(target)), path.basename(target), '.git');
    const replacement = `${recordFile}.${crypto.randomUUID()}`;
    const lock = path.join(gitDirectory, 'locked');
    const linkTo = (checkout: string) => (path.isAbsolute(link) ? undefined
      : fs.writeFile(path.join(staged, '.git'), `gitdir: ${path.relative(checkout, gitDirectory)}\n`));
    let moved = false;
    try {
      await fs.writeFile(lock, 'moving into place\n');
      await fs.writeFile(replacement, `${path.isAbsolute(recorded) ? gitFile : path.relative(gitDirectory, gitFile)}\n`);
      await linkTo(target);
      await fs.rename(staged, target);
      moved = true;
      await fs.rename(replacement, recordFile);
    } catch (error) {
      if (moved) await fs.rename(target, staged);
      await linkTo(staged);
      await fs.rm(replacement, { force: true });
      throw !moved && await isPresent(target) ? alreadyExists(target) : error;
    } finally {
      await fs.rm(lock, { force: true });
    }
  };

  const add = async (directory: string, args: string[], target: string, failure: string) => {
    const records = await readWorktreeRecords(await commonDirectoryOf(directory));
    if (!await anyUnreachable(records)) return runGit(directory, args, failure);
    await assertEnumerableRecords(records);
    if (records.some((record) => path.relative(record.worktree, target) === '')) {
      throw new Error(`${target} is already registered as a worktree`);
    }
    const run = (checkout: string) => runGit(directory, args.map((arg) => (arg === target ? checkout : arg)), failure);
    const stage = path.join(path.dirname(target), `.openchamber-add-${crypto.randomUUID()}`);
    try {
      await assertFree(target);
      if (process.platform === 'win32') return await run([stage, '..', path.basename(target), ''].join(path.sep));
      const staged = path.join(stage, path.basename(target));
      try {
        const result = await run(staged);
        await moveIntoPlace(staged, target);
        return result;
      } catch (error) {
        await discardStaged(directory, staged);
        throw error;
      }
    } finally {
      await fs.rmdir(stage).catch(() => undefined);
    }
  };

  const forget = async (directory: string, target: string) => {
    const commonDirectory = await commonDirectoryOf(directory);
    const wanted = await placeOf(target);
    for (const { worktree, gitDirectory, backlink } of await readWorktreeRecords(commonDirectory)) {
      if (await isOffline(worktree) || await placeOf(worktree) !== wanted) continue;
      await discardRecord(gitDirectory, async () => !await isPresent(worktree) && await readLink(gitDirectory) === backlink);
    }
    const name = path.basename(path.resolve(target));
    if (!name) return;
    const leftover = path.join(commonDirectory, 'worktrees', name);
    await discardRecord(leftover, async () => await readLink(leftover) === null);
  };

  return { readPorcelain, list, add, assertEnumerable, forget };
};
