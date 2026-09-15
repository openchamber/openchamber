import type { GitCommitChangedFile } from '@/lib/api/types';
import type { GitCommitDetailsController } from './gitCommitDetailsController';

export const createGitContextCommitDetailsController = (
  controller: GitCommitDetailsController,
  directory: string,
  openContextCommitDiff: (directory: string, target: { commitHash: string; parentHash: string | null; file: GitCommitChangedFile }) => void,
): GitCommitDetailsController => ({
  ...controller,
  selectFile(comparison, file) {
    openContextCommitDiff(directory, {
      commitHash: comparison.commitHash,
      parentHash: comparison.parentHash,
      file,
    });
  },
});
