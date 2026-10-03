import { isGuestCommitSha, type HostRequestErrorCode } from '@openchamber/sdk';

import type { GitAPI } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { commitSelectionKey, useCommitSelectionStore } from '@/stores/useCommitSelectionStore';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';

export type GuestOpenCommitResult =
  | { ok: true }
  | { ok: false; code: HostRequestErrorCode; message: string };

type OpenGuestCommitOptions = {
  sha: string;
  directory: string | null;
  /** Null when no runtime registered its APIs yet; answered as unavailable. */
  git: Pick<GitAPI, 'getGitLog'> | null;
  /** The directory's current branch, which keys the Diff view's commit selection. */
  currentBranch: (directory: string) => Promise<string | null>;
  /** VS Code and mobile have no Diff view commit scope for guests. */
  supported: boolean;
};

/**
 * `host.openCommit`: read the commit from the open project ourselves, select it
 * the way the Diff view's commit picker would, and open that view in commit
 * scope. The guest only names a hash; nothing it sends reaches git unchecked.
 */
export const openGuestCommit = async ({ sha, directory, git, currentBranch, supported }: OpenGuestCommitOptions): Promise<GuestOpenCommitResult> => {
  if (!supported) return { ok: false, code: 'UNSUPPORTED', message: 'This OpenChamber surface has no Diff view.' };
  if (!isGuestCommitSha(sha)) return { ok: false, code: 'HOST_REJECTED', message: 'Commit id must be 7 to 64 hex characters.' };
  if (!directory) return { ok: false, code: 'NO_DIRECTORY', message: 'No project is open.' };
  if (!git) return { ok: false, code: 'HOST_UNAVAILABLE', message: 'Git is not available yet.' };
  const runtimeKey = getRuntimeKey();
  let entry;
  try {
    const log = await git.getGitLog(directory, { maxCount: 1, to: sha });
    entry = log.all[0];
  } catch {
    return { ok: false, code: 'NOT_FOUND', message: 'That commit is not in this project.' };
  }
  if (!entry || !entry.hash.toLowerCase().startsWith(sha.toLowerCase())) {
    return { ok: false, code: 'NOT_FOUND', message: 'That commit is not in this project.' };
  }
  const branch = await currentBranch(directory);
  if (getRuntimeKey() !== runtimeKey) return { ok: false, code: 'HOST_UNAVAILABLE', message: 'The connection changed.' };
  useCommitSelectionStore.getState().select(commitSelectionKey(directory, branch, useGitStore.getState().runtimeKey), entry);
  useUIStore.getState().openContextPanelTab(directory, { mode: 'diff', diffScope: 'commit' });
  return { ok: true };
};

/** Branch from the shared git status cache, loading it once when missing. A failed load means "no branch". */
export const readCurrentBranch = async (git: GitAPI, directory: string): Promise<string | null> => {
  await useGitStore.getState().ensureStatus(directory, git).catch(() => undefined);
  return useGitStore.getState().directories.get(directory)?.status?.current ?? null;
};
