import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { normalizeGitOutputPath } from './output-path.js';
import { readWorktreeRecords, type createWorktreeRegistry } from './worktree-registry.js';
import { assertLinkedRepositoryReachable, assertPathReachable, assertRepositoryReachable, realpathOf } from './reachable-disk.js';
import type { GitCommandResult } from './service-contracts.js';

const MARKER_FILE = 'openchamber-integrate';
const PICKING_LIMIT_MS = 10 * 60_000;

const sha = z.string().regex(/^[0-9a-fA-F]{4,64}$/);
const branch = z.string().min(1).refine((value) => !value.startsWith('-') && !value.includes('\0'));

const conflictSchema = z.object({
  version: z.literal(1),
  phase: z.literal('conflict'),
  revision: z.number().int().positive(),
  repoRoot: z.string().min(1),
  sourceBranch: branch,
  targetBranch: branch,
  targetSha: sha,
  pickBase: sha,
  commits: z.array(sha).min(1),
  skippedCommits: z.array(sha),
  remainingCommits: z.array(sha),
  currentCommit: sha,
  message: z.string().optional(),
  finish: z.object({ outcome: z.enum(['aborted', 'publishing', 'published']), moved: z.number().int().nonnegative(), result: sha.optional() }).optional(),
});
const pickingSchema = z.object({
  version: z.literal(1),
  phase: z.literal('picking'),
  pid: z.number().int().positive(),
  host: z.string(),
  at: z.number(),
});
const recordSchema = z.discriminatedUnion('phase', [conflictSchema, pickingSchema]);

type IntegrateConflictRecord = z.infer<typeof conflictSchema>;
export type IntegrateConflictFields = Omit<IntegrateConflictRecord, 'version' | 'phase' | 'revision'>;
export interface IntegrateCheckout {
  path: string;
  record: IntegrateConflictRecord;
  unreachable?: string;
}

const comparablePath = async (input: string) => {
  const absolutePath = path.resolve(input);
  const realPath = path.normalize(await realpathOf(absolutePath).catch(() => absolutePath));
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
};

const readGitDirectoryOf = async (directory: string): Promise<string | null> => {
  const entry = path.join(directory, '.git');
  const stat = await fs.stat(entry).catch(() => null);
  if (!stat) return null;
  if (stat.isDirectory()) return comparablePath(entry);
  const link = /^gitdir: (.+)$/m.exec(await fs.readFile(entry, 'utf8').catch(() => ''))?.[1]?.trim();
  return link ? comparablePath(path.resolve(directory, normalizeGitOutputPath(link))) : null;
};

export const belongsToRepository = async (directory: string, gitCommonDirectory: string): Promise<boolean> => {
  const gitDirectory = await readGitDirectoryOf(directory);
  if (!gitDirectory) {
    const parent = path.dirname(directory);
    return parent !== directory && await belongsToRepository(parent, gitCommonDirectory);
  }
  const common = (await fs.readFile(path.join(gitDirectory, 'commondir'), 'utf8').catch(() => '')).trim();
  return await comparablePath(path.resolve(gitDirectory, common)) === await comparablePath(gitCommonDirectory);
};

export const listRecordedWorktrees = async (gitCommonDirectory: string) => (
  (await readWorktreeRecords(gitCommonDirectory)).map((record) => path.resolve(record.worktree))
);

const isRestorable = async (checkout: string, gitDirectory: string, repoRoot: string, gitCommonDirectory: string) => (
  await readGitDirectoryOf(checkout) === await comparablePath(gitDirectory)
  && await fs.stat(repoRoot).then((stat) => stat.isDirectory(), () => false)
  && await belongsToRepository(repoRoot, gitCommonDirectory)
);

const unreachableReason = async (checkout: string, repoRoot: string) => {
  try {
    await assertRepositoryReachable(checkout);
    await assertRepositoryReachable(repoRoot);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const writeRecord = async (gitDirectory: string, record: z.infer<typeof recordSchema>) => {
  const target = path.join(gitDirectory, MARKER_FILE);
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(record));
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
};

const readRecord = async (gitDirectory: string) => {
  const text = await fs.readFile(path.join(gitDirectory, MARKER_FILE), 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    const parsed = recordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const isPickingNow = ({ pid, host, at }: z.infer<typeof pickingSchema>) => {
  if (host !== os.hostname() || Date.now() - at > PICKING_LIMIT_MS) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const creating = new Set<string>();

const readMarkedCheckouts = async (gitCommonDirectory: string) => {
  const administration = await assertPathReachable(path.join(gitCommonDirectory, 'worktrees'));
  const entries = await fs.readdir(administration, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const found = await Promise.all(entries.map(async (entry) => {
    const gitDirectory = path.join(administration, entry.name);
    if (entry.isSymbolicLink() && !await assertPathReachable(gitDirectory).catch(() => null)) return null;
    const record = await readRecord(gitDirectory);
    if (!record) return null;
    const gitFile = (await fs.readFile(path.join(gitDirectory, 'gitdir'), 'utf8').catch(() => '')).trim();
    if (!gitFile) return null;
    const checkout = path.dirname(path.resolve(gitDirectory, normalizeGitOutputPath(gitFile)));
    if (record.phase === 'picking') return isPickingNow(record) ? { path: checkout, record } : null;
    const unreachable = await unreachableReason(checkout, record.repoRoot);
    if (unreachable !== undefined) return { path: checkout, record, unreachable };
    if (await isRestorable(checkout, gitDirectory, record.repoRoot, gitCommonDirectory)) return { path: checkout, record };
    return await unreachableReason(checkout, record.repoRoot).then((reason) => (reason === undefined ? null : { path: checkout, record, unreachable: reason }));
  }));
  if (found.length === 0 || found.includes(null)) await assertPathReachable(administration);
  return found.filter((entry) => entry !== null);
};

export const flagIntegrateCheckouts = async <Row extends { path: string; integrateCheckout?: true }>(
  directory: string,
  gitCommonDirectory: string,
  rows: Row[],
  onFinishing?: () => void,
) => {
  const pending = new Set(creating);
  const marked = await readMarkedCheckouts(path.resolve(directory, normalizeGitOutputPath(gitCommonDirectory.trim())));
  if (marked.length === 0 && pending.size === 0) return rows;
  if (marked.some(({ record }) => record.phase === 'conflict' && record.finish)) onFinishing?.();
  const hidden = new Set([...pending, ...await Promise.all(marked.map((entry) => comparablePath(entry.path)))]);
  await Promise.all(rows.map(async (row) => {
    if (hidden.has(await comparablePath(row.path))) row.integrateCheckout = true;
  }));
  return rows;
};

interface IntegrateCheckoutDependencies {
  runGit(cwd: string, args: string[]): Promise<GitCommandResult>;
  runGitOrThrow(cwd: string, args: string[], failure: string): Promise<GitCommandResult>;
  publishChange(repoRoot: string): Promise<void>;
  registry: ReturnType<typeof createWorktreeRegistry>;
}

export const createIntegrateCheckouts = ({ runGit, runGitOrThrow, publishChange, registry }: IntegrateCheckoutDependencies) => {
  const readGitDirectory = async (checkout: string) =>
    normalizeGitOutputPath((await runGitOrThrow(checkout, ['rev-parse', '--absolute-git-dir'], 'Failed to read the temporary checkout')).stdout.trim());

  const readCommonDirectory = async (directory: string) => {
    await assertLinkedRepositoryReachable(directory);
    const result = await runGit(directory, ['rev-parse', '--git-common-dir']);
    if (!result.success) await assertRepositoryReachable(directory);
    const { stdout } = result.success ? result : await runGitOrThrow(directory, ['rev-parse', '--git-common-dir'], 'Failed to read the repository');
    return path.resolve(directory, normalizeGitOutputPath(stdout.trim()));
  };

  const isEnumerable = (repoRoot: string) => registry.assertEnumerable(repoRoot).then(() => true, () => false);

  const create = async (repoRoot: string, startSha: string) => {
    const tmpParent = path.join(os.homedir(), '.config', 'openchamber', 'tmp');
    await fs.mkdir(tmpParent, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(tmpParent, 'oc-integrate-'));
    const key = await comparablePath(tmpDir);
    creating.add(key);
    try {
      await registry.add(repoRoot, ['worktree', 'add', '--detach', tmpDir, startSha], tmpDir, 'Failed to create temp worktree');
      await writeRecord(await readGitDirectory(tmpDir), { version: 1, phase: 'picking', pid: process.pid, host: os.hostname(), at: Date.now() });
      return tmpDir;
    } catch (error) {
      if (await isEnumerable(repoRoot)) await runGit(repoRoot, ['worktree', 'remove', '--force', tmpDir]);
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      creating.delete(key);
    }
  };

  const saveConflict = async (checkout: string, fields: IntegrateConflictFields, revision: number) => {
    await writeRecord(await readGitDirectory(checkout), { version: 1, phase: 'conflict', revision, ...fields });
    void publishChange(fields.repoRoot);
  };

  const listConflicts = async (directory: string): Promise<IntegrateCheckout[]> => {
    const marked = await readMarkedCheckouts(await readCommonDirectory(directory));
    return marked.flatMap(({ record, ...entry }) => (record.phase === 'conflict' ? [{ ...entry, record }] : []));
  };

  const findConflict = async (directory: string, checkout: string) => {
    const key = await comparablePath(checkout);
    for (const entry of await listConflicts(directory)) {
      if (await comparablePath(entry.path) === key) return entry;
    }
    return null;
  };

  const remove = async (repoRoot: string, tmpDir: string) => {
    if (!await isEnumerable(repoRoot)) return false;
    const gitDirectory = await readGitDirectory(tmpDir).catch(() => null);
    const removed = await runGit(repoRoot, ['worktree', 'remove', '--force', tmpDir]);
    const offline = !removed.success && await unreachableReason(tmpDir, repoRoot) !== undefined;
    if (!removed.success && gitDirectory && !offline) {
      await fs.rm(path.join(gitDirectory, MARKER_FILE), { force: true });
    }
    void publishChange(repoRoot);
    return removed.success;
  };

  const release = async (repoRoot: string, tmpDir: string) => {
    await fs.rm(path.join(await readGitDirectory(tmpDir), MARKER_FILE), { force: true });
    void publishChange(repoRoot);
    return false;
  };

  return { create, saveConflict, listConflicts, findConflict, remove, release, readCommonDirectory };
};
