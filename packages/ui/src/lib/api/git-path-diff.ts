import { z } from 'zod';

/**
 * Why a path from an earlier status listing has no diff: it no longer exists
 * anywhere git looks, or it is a separate repository nested in this one.
 */
export type GitPathUnavailableReason = 'path_not_found' | 'nested_repository';

export class GitPathUnavailableError extends Error {
  readonly reason: GitPathUnavailableReason;

  constructor(message: string, reason: GitPathUnavailableReason) {
    super(message);
    this.name = 'GitPathUnavailableError';
    this.reason = reason;
  }
}

/** Body the git diff routes send with 404 and 422. */
export const gitPathUnavailableBodySchema = z.object({
  error: z.string(),
  code: z.enum(['path_not_found', 'nested_repository']),
});

export const gitSubmoduleStateSchema = z.object({
  headCommit: z.string().nullable(),
  indexCommit: z.string().nullable(),
  worktreeCommit: z.string().nullable(),
  hasTrackedChanges: z.boolean(),
  hasUntrackedFiles: z.boolean(),
  hasConflict: z.boolean(),
});
