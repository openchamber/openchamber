import { toast } from '@/components/ui';
import type { I18nKey, I18nParams } from '@/lib/i18n';

type Translate = (key: I18nKey, params?: I18nParams) => string;

/**
 * The toast for a failed Track / Mark done. When the chat's folder was
 * deleted (`SessionDirectoryMissingError`), OpenCode refuses every work-state
 * change for it while archive still works, so that toast says so and offers
 * Archive in place of Copy. `archive` is the surface's own archive of the
 * session and its subagents. It runs without the archive confirmation: the
 * user just chose Archive here, and the success toast offers Undo.
 */
export const toastSessionWorkFailure = (folderDeleted: boolean, archive: () => void, t: Translate): void => {
  if (folderDeleted) {
    toast.error(t('sessions.sidebar.session.work.folderDeleted'), {
      action: { label: t('sessions.sidebar.bulkActions.archive'), onClick: archive },
    });
    return;
  }
  toast.error(t('sessions.sidebar.session.work.updateFailed'));
};
