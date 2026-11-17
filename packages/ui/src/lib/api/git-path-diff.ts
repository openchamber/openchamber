import { z } from 'zod';

export type GitPathUnavailableReason = 'path_not_found' | 'nested_repository' | 'untracked_directory';

export class GitPathUnavailableError extends Error {
  readonly reason: GitPathUnavailableReason;

  constructor(message: string, reason: GitPathUnavailableReason) {
    super(message);
    this.name = 'GitPathUnavailableError';
    this.reason = reason;
  }
}

export const gitPathUnavailableBodySchema = z.object({
  error: z.string(),
  code: z.enum(['path_not_found', 'nested_repository', 'untracked_directory']),
});

export const gitSubmoduleStateSchema = z.object({
  headCommit: z.string().nullable(),
  indexCommit: z.string().nullable(),
  worktreeCommit: z.string().nullable(),
  hasTrackedChanges: z.boolean(),
  hasUntrackedFiles: z.boolean(),
  hasConflict: z.boolean(),
});
