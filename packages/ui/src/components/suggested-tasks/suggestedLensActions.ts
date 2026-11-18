import type { I18nKey } from '@/lib/i18n';
import type { LensAction } from '@/lib/suggestedTasksApi';

/** What each lens action is called and what it does, for the lens list and editor. */
export const LENS_ACTION_TEXT = {
  suggest: { label: 'suggestedTasks.lens.action.suggest', description: 'suggestedTasks.lens.action.suggestInfo' },
  todo: { label: 'suggestedTasks.lens.action.todo', description: 'suggestedTasks.lens.action.todoInfo' },
  session: { label: 'suggestedTasks.lens.action.session', description: 'suggestedTasks.lens.action.sessionInfo' },
  worktree: { label: 'suggestedTasks.lens.action.worktree', description: 'suggestedTasks.lens.action.worktreeInfo' },
  'draft-pr': { label: 'suggestedTasks.lens.action.draftPr', description: 'suggestedTasks.lens.action.draftPrInfo' },
} satisfies Record<LensAction, { label: I18nKey; description: I18nKey }>;
