// The branch and worktree name a worktree from a pull or merge request gets.
// A fork module: upstream only checks out the request's own branch.
import { DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE, branchNameFromTemplate, uniqueBranchName } from './branch-name-template.js';

export type ChangeRequestBranchOptions = {
  name?: string;
  branchName?: string;
  branchOff?: boolean;
  branchTemplate?: string;
  existingBranches?: Set<string>;
};

/**
 * It checks out the request's branch, or with `branchOff` starts a new branch
 * from its head. `branchName` defaults to the head branch, or for a new branch
 * to `branchTemplate` filled with `name` (else the head branch), the number and
 * the head, past any of `existingBranches` that has it; `name` defaults to the
 * branch.
 */
export const changeRequestWorktreeTarget = (
  { name, branchName, branchOff = false, branchTemplate = DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE, existingBranches = new Set<string>() }: ChangeRequestBranchOptions,
  { number, headBranch }: { number: number; headBranch: string },
) => {
  const branch = branchName || (branchOff
    ? uniqueBranchName(branchNameFromTemplate(branchTemplate, { name: name || headBranch, pr: number, head: headBranch }), existingBranches)
    : headBranch);
  const mode: 'new' | 'existing' = branchOff ? 'new' : 'existing';
  return { mode, branchName: branch, worktreeName: name || branch };
};
