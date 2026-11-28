import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import { normalizeGitOutputPath } from './output-path.js';
import type { GitCommandResult } from './service-contracts.js';

const PROBE_ARGS = ['rev-parse', '--git-dir', '--show-toplevel'];
const STATUS_GIT_PATHS = ['MERGE_HEAD', 'MERGE_MSG', 'rebase-merge', 'rebase-apply'];
const STATUS_GIT_PATH_ARGS = STATUS_GIT_PATHS.flatMap((name) => ['--git-path', name]);
const STATUS_LAYOUT_ARGS = ['--path-format=absolute', ...STATUS_GIT_PATH_ARGS, '--verify', '--quiet', 'HEAD'];

export type StatusLayout = { gitPaths: string[]; unborn: boolean };

const readStatusLayout = (result: GitCommandResult): StatusLayout | null => {
  if (result.exitCode !== 0 && result.exitCode !== 1) return null;
  const lines = result.stdout.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 2 + STATUS_GIT_PATHS.length + (result.exitCode === 0 ? 1 : 0)) return null;
  const gitPaths = lines.slice(2, 2 + STATUS_GIT_PATHS.length).map((line) => normalizeGitOutputPath(line.trim()));
  if (!gitPaths.every((gitPath) => path.isAbsolute(gitPath))) return null;
  return { gitPaths: gitPaths.map((gitPath) => path.resolve(gitPath)), unborn: result.exitCode === 1 };
};

export const runRepositoryProbe = async (run: (args: string[]) => Promise<GitCommandResult>, withStatusLayout: boolean) => {
  if (!withStatusLayout) return { result: await run(PROBE_ARGS), statusLayout: null };
  const result = await run([...PROBE_ARGS, ...STATUS_LAYOUT_ARGS]);
  const statusLayout = readStatusLayout(result);
  if (statusLayout) return { result: { ...result, success: true }, statusLayout };
  if (result.stdout.trim() && !result.timedOut && !result.spawnFailed) return { result: await run(PROBE_ARGS), statusLayout: null };
  return { result, statusLayout: null };
};

export const readStatusLayoutSeparately = async (repoRoot: string, git: SimpleGit, readHead: () => Promise<GitCommandResult>): Promise<StatusLayout> => {
  const [headProbe, gitPaths] = await Promise.all([
    readHead(),
    git
      .raw(['rev-parse', ...STATUS_GIT_PATH_ARGS])
      .then((value) => String(value || '').split(/\r?\n/).slice(0, STATUS_GIT_PATHS.length).map((line) => (
        line.trim() ? path.resolve(repoRoot, normalizeGitOutputPath(line.trim())) : ''
      )))
      .catch(() => []),
  ]);
  return { gitPaths, unborn: headProbe.exitCode === 1 };
};
