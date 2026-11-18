import { isString } from '../shared/guards.js';
import { readBranchChangeIds, runGit } from '../source-control/change-id.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const CHANGE_ID = /^I[0-9a-f]{40}$/;
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[^\0-\x20\x7f~^:?*[\\{}]+$/;

export interface LocalRevision {
  sha: string | null;
  changeId: string | null;
}

export type GerritGitReader = (directory: string, args: string[]) => Promise<string>;

export async function readLocalRevision(directory: string, branch: string): Promise<LocalRevision> {
  const { head: tip } = await readBranchChangeIds(directory, branch);
  return {
    sha: isString(tip?.sha) && COMMIT_SHA.test(tip.sha) ? tip.sha : null,
    changeId: tip?.changeId !== null && isString(tip?.changeId) && CHANGE_ID.test(tip.changeId) ? tip.changeId : null,
  };
}

export async function readUpstreamBranch(directory: string, branch: string, primaryRemote: string, { git = runGit }: { git?: GerritGitReader } = {}) {
  if (!isString(branch) || !BRANCH_NAME.test(branch) || !isString(primaryRemote) || !primaryRemote) return null;
  const remote = (await git(directory, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim();
  if (remote !== primaryRemote) return null;
  const tracking = (await git(directory, ['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]).catch(() => '')).trim();
  const prefix = `refs/remotes/${remote}/`;
  return tracking.startsWith(prefix) ? tracking.slice(prefix.length) || null : null;
}
