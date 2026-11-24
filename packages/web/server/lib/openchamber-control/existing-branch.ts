import { OpenChamberControlError } from './error.js';
import { asNonEmptyString } from '../shared/guards.js';

interface ExistingBranchFields {
  existingBranch?: unknown;
  worktree?: unknown;
  pullRequest?: unknown;
}

export const assertSessionActionExistingBranch = (action: string, input: ExistingBranchFields) => {
  if (input.existingBranch !== undefined && !asNonEmptyString(input.existingBranch)) {
    throw new OpenChamberControlError('existingBranch must be a non-empty branch name', 400);
  }
  if (input.existingBranch === undefined) return;
  if (action !== 'session.create') {
    throw new OpenChamberControlError('existingBranch applies only to session.create or session.moveToWorktree', 400);
  }
  if (input.pullRequest === undefined && !asNonEmptyString(input.worktree)) {
    throw new OpenChamberControlError('existingBranch needs worktree: pass the folder name for the worktree that checks the branch out', 400);
  }
};
