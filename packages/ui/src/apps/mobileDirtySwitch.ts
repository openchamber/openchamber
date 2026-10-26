import type { GitAPI, GitNetworkOperation } from '@/lib/api/types';
import type { I18nKey, I18nParams } from '@/lib/i18n';

/** What committing before a dirty branch switch reads and drives on the mobile Changes surface. */
type DirtySwitchCommitScope = {
  targetBranch: string | null;
  directory: string | null | undefined;
  sourceBranch: string | null;
  git: Pick<GitAPI, 'createGitCommit'>;
  publishChooser: { prepare: (action: 'push') => Promise<() => Promise<GitNetworkOperation | null>> };
  toast: { success: (message: string) => void; error: (message: string) => void };
  t: (key: I18nKey, params?: I18nParams) => string;
  refreshStatusAndBranches: () => Promise<void>;
  closeDialog: () => void;
  performCheckout: (branch: string) => Promise<void>;
};

/**
 * Commit every change, optionally publish it through the managed chooser, then
 * switch. A failed push keeps the user on the branch the commit belongs to.
 */
export const commitAndSwitchBranch = async (message: string, pushAfter: boolean, scope: DirtySwitchCommitScope): Promise<void> => {
  const { targetBranch, directory, sourceBranch, git, publishChooser, toast, t } = scope;
  if (!targetBranch || !directory) return;
  await git.createGitCommit(directory, message, { addAll: true });
  if (pushAfter) {
    try {
      const executePush = await publishChooser.prepare('push');
      await executePush();
    } catch {
      toast.error(t('gitView.dirtySwitch.pushFailed'));
      await scope.refreshStatusAndBranches();
      scope.closeDialog();
      return;
    }
  }
  toast.success(sourceBranch
    ? pushAfter
      ? t('gitView.publish.succeeded')
      : t('gitView.dirtySwitch.committedNotPushed', { branch: sourceBranch })
    : t('gitView.toast.commitCreated'));
  await scope.refreshStatusAndBranches();
  scope.closeDialog();
  await scope.performCheckout(targetBranch);
};
