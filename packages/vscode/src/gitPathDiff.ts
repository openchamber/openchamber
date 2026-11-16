import * as fs from 'fs';
import * as path from 'path';


type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type GitPathUnavailableReason = 'path_not_found' | 'nested_repository';

export interface GitSubmoduleState {
  headCommit: string | null;
  indexCommit: string | null;
  worktreeCommit: string | null;
  hasTrackedChanges: boolean;
  hasUntrackedFiles: boolean;
  hasConflict: boolean;
}

export type GitPathUnavailable = { kind: 'unavailable'; reason: GitPathUnavailableReason; message: string };

type GitPathTarget =
  | { kind: 'file' | 'submodule'; repoPath: string; absolutePath: string }
  | GitPathUnavailable;

const GITLINK_MODE = '160000';

const pathExists = (target: string): Promise<boolean> => fs.promises.lstat(target).then(() => true, () => false);

const readEntryMode = async (run: GitRunner, cwd: string, args: string[], repoPath: string): Promise<string | null> => {
  const result = await run(args, cwd);
  if (result.exitCode !== 0) return null;
  for (const record of result.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab !== -1 && record.slice(tab + 1) === repoPath) {
      return record.slice(0, record.indexOf(' '));
    }
  }
  return null;
};

export async function resolveGitPathTarget(run: GitRunner, directory: string, filePath: string): Promise<GitPathTarget> {
  const repoPath = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const absolutePath = path.resolve(directory, repoPath);
  const entry = await fs.promises.lstat(absolutePath).catch(() => null);
  const indexMode = await readEntryMode(run, directory, ['ls-files', '--stage', '-z', '--', `:(literal)${repoPath}`], repoPath);
  const headMode = await readEntryMode(run, directory, ['ls-tree', '-z', 'HEAD', '--', repoPath], repoPath);

  if (indexMode === GITLINK_MODE || headMode === GITLINK_MODE) {
    return { kind: 'submodule', repoPath, absolutePath };
  }
  if (entry?.isFile() || entry?.isSymbolicLink() || indexMode || headMode) {
    return { kind: 'file', repoPath, absolutePath };
  }
  if (entry?.isDirectory() && await pathExists(path.join(absolutePath, '.git'))) {
    return { kind: 'unavailable', reason: 'nested_repository', message: `Path is a separate Git repository: ${filePath}` };
  }
  return { kind: 'unavailable', reason: 'path_not_found', message: `Path not found in working tree, index, or HEAD: ${filePath}` };
}

export async function readSubmoduleState(run: GitRunner, directory: string, target: { repoPath: string; absolutePath: string }): Promise<GitSubmoduleState> {
  const status = await run(['status', '--porcelain=v2', '-z', '--', `:(literal)${target.repoPath}`], directory);
  if (status.exitCode !== 0) {
    throw new Error(status.stderr.trim() || 'Failed to read submodule status');
  }
  // external: https://git-scm.com/docs/git-status#_porcelain_format_version_2 Unmerged submodules have no stage-0 index entry; clean submodules have no status record.
  const record = status.stdout.split('\0').find((entry) => /^[12u] /.test(entry))?.split(' ');
  const hasConflict = record?.[0] === 'u';
  // external: https://git-scm.com/docs/gitrevisions HEAD:./path resolves relative to the command directory.
  const readHead = async () => (await run(['rev-parse', '--verify', '--quiet', `HEAD:./${target.repoPath}`], directory)).stdout.trim();
  const head = record && !hasConflict ? record[6] : await readHead();
  const index = hasConflict ? '' : (record ? record[7] : head);
  const flags = record ? record[2] : 'S...';
  const worktree = await pathExists(path.join(target.absolutePath, '.git'))
    ? await run(['rev-parse', '--verify', 'HEAD'], target.absolutePath)
    : null;
  const commitOrNull = (value: string): string | null => (value && !/^0+$/.test(value) ? value : null);

  return {
    headCommit: commitOrNull(head),
    indexCommit: commitOrNull(index),
    worktreeCommit: worktree?.exitCode === 0 ? worktree.stdout.trim() : null,
    hasTrackedChanges: flags[2] === 'M',
    hasUntrackedFiles: flags[3] === 'U',
    hasConflict,
  };
}
