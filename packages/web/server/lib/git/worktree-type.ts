import path from 'path';

export const WORKTREE_TYPE_ARGS = ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'];

export const isLinkedWorktreeAnswer = (directory: string, output: string) => {
  const [gitDir = '', commonDir = ''] = output.split(/\r?\n/).filter(Boolean).slice(-2);
  return path.resolve(directory, gitDir) !== path.resolve(directory, commonDir);
};
