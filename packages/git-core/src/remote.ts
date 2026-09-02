import type { GitRunner } from './types.js';

/**
 * Fetch a single branch from a remote into `refs/remotes/<remote>/<branch>`.
 * Throws on failure — the caller decides whether to swallow or surface.
 */
export const fetchRemoteBranchRef = async (
  runner: GitRunner,
  primaryWorktree: string,
  remoteName: string,
  branchName: string,
): Promise<void> => {
  const remote = String(remoteName ?? '').trim();
  const branch = String(branchName ?? '').trim();
  if (!remote || !branch) {
    return;
  }

  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  // `--` prevents a leading `--upload-pack=…`-style remote value from
  // being interpreted as a git option (defence-in-depth; refs are not
  // currently user-authored here, but git treats any leading-`-`
  // argument as a flag).
  const result = await runner.run(primaryWorktree, ['fetch', '--', remote, refspec]);
  if (!result.success) {
    throw new Error(result.message || `Failed to fetch ${remote}/${branch}`);
  }
};

/**
 * Check whether `<remote>` exposes `<branch>` on its refs/heads.
 *
 * When `remoteUrl` is provided, `ls-remote` is invoked against the URL
 * directly — useful when the remote is not yet configured locally.
 * Returns `{ success, found }` so callers can distinguish "transport
 * failed" from "ref genuinely missing".
 */
export const checkRemoteBranchExists = async (
  runner: GitRunner,
  primaryWorktree: string,
  remoteName: string,
  branchName: string,
  remoteUrl: string = '',
): Promise<{ success: boolean; found: boolean }> => {
  const remote = String(remoteName ?? '').trim();
  const branch = String(branchName ?? '').trim();
  const url = String(remoteUrl ?? '').trim();
  if (!remote || !branch) {
    return { success: false, found: false };
  }

  const target = url || remote;
  // `--` separates flags (`--heads`) from the positional `<repository>`
  // argument so a `--upload-pack=…`-style value can't be parsed as a
  // git option. `target` is GitHub-sourced today, but the guard is
  // consistent with `checkPullRequestHeadRefExists` in `availability.ts`.
  const lsRemote = await runner.run(primaryWorktree, [
    'ls-remote',
    '--heads',
    '--',
    target,
    `refs/heads/${branch}`,
  ]);
  if (!lsRemote.success) {
    return { success: false, found: false };
  }

  return {
    success: true,
    found: Boolean(String(lsRemote.stdout ?? '').trim()),
  };
};
