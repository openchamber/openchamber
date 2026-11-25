import * as path from 'path';
import { flagIntegrateCheckouts } from '../../web/server/lib/git/integrate-checkouts.js';

type WorktreeRow = { head: string; name: string; branch: string; path: string; integrateCheckout?: true };

export const listWorktreeRows = async (
  directory: string,
  entries: readonly { worktree: string; head?: string; branch?: string; bare?: boolean }[],
  runGitOrThrow: (cwd: string, args: string[], failure: string) => Promise<{ stdout: string }>,
): Promise<WorktreeRow[]> => {
  const rows = entries
    .filter((entry) => entry.bare !== true)
    .map((entry): WorktreeRow => ({
      head: entry.head || '',
      name: path.basename(entry.worktree || ''),
      branch: entry.branch || '',
      path: entry.worktree,
    }));
  const commonDirectory = await runGitOrThrow(directory, ['rev-parse', '--git-common-dir'], 'Failed to read the repository');
  return flagIntegrateCheckouts(directory, commonDirectory.stdout, rows);
};
