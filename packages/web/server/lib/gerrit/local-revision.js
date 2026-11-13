import { isString } from '../shared/guards.js';
import { readBranchChangeIds, runGit } from '../source-control/change-id.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const CHANGE_ID = /^I[0-9a-f]{40}$/;
// A branch name Git takes as one argument: no option, range or revision syntax
// (`rev-parse` reads `<branch>@{upstream}` only in the short form, after its options).
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[^\0-\x20\x7f~^:?*[\\{}]+$/;

/**
 * The tip of a local branch and the Change-Id trailer of its commit, read
 * through the shared trailer reader (`source-control/change-id.js`). A Git
 * failure (no such branch) rejects; it never reads as "no Change-Id".
 */
export async function readLocalRevision(directory, branch) {
  const { head: tip } = await readBranchChangeIds(directory, branch);
  return {
    sha: isString(tip?.sha) && COMMIT_SHA.test(tip.sha) ? tip.sha : null,
    changeId: isString(tip?.changeId) && CHANGE_ID.test(tip.changeId) ? tip.changeId : null,
  };
}

/**
 * The branch `branch` tracks on the primary remote (`main` of
 * `origin/main`), or null: for a branch without an upstream, or one that
 * tracks another remote. It picks among cherry-picks of one Change-Id the
 * change on that branch. The remote comes from `branch.<b>.remote` and the
 * tracking ref from Git, so a remote named `team/gerrit` is stripped whole.
 */
export async function readUpstreamBranch(directory, branch, primaryRemote, { git = runGit } = {}) {
  if (!isString(branch) || !BRANCH_NAME.test(branch) || !isString(primaryRemote) || !primaryRemote) return null;
  const remote = (await git(directory, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim();
  if (remote !== primaryRemote) return null;
  const tracking = (await git(directory, ['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]).catch(() => '')).trim();
  const prefix = `refs/remotes/${remote}/`;
  return tracking.startsWith(prefix) ? tracking.slice(prefix.length) || null : null;
}
