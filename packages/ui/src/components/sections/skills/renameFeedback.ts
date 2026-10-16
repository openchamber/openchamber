import type { SkillRenameResult } from '@/stores/useSkillsStore';

type Translate = (key: 'settings.skills.sidebar.toast.skillRenamed'
  | 'settings.skills.sidebar.toast.renameOldSwitchRuleKept'
  | 'settings.skills.sidebar.toast.renameFailed', values?: Record<string, string>) => string;

type Feedback = {
  t: Translate;
  toast: { success: (message: string) => void; warning: (message: string) => void; error: (message: string) => void };
  select: (id: string) => void;
};

/**
 * What the Skills sidebar tells the user after a rename. A rename the server
 * did is reported as done and its new id selected, also when the switch rule
 * for the old id was left in a config file: that is a warning beside the
 * success, naming the files. Only a rename the server refused is an error.
 */
export const reportRenameResult = (result: SkillRenameResult, newName: string, { t, toast, select }: Feedback): void => {
  if (!result.ok) {
    toast.error(t('settings.skills.sidebar.toast.renameFailed'));
    return;
  }
  toast.success(t('settings.skills.sidebar.toast.skillRenamed', { name: newName }));
  if (result.oldRuleCleanupFailed.length > 0) {
    toast.warning(t('settings.skills.sidebar.toast.renameOldSwitchRuleKept', {
      paths: result.oldRuleCleanupFailed.map((file) => file.path).join(', '),
    }));
  }
  select(result.id);
};
