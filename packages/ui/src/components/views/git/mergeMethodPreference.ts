import type { MergeMethod } from '@/lib/source-control/types';

const KEY = 'openchamber:pr-merge-method:v1';

/**
 * A forge's merge method, the one remembered across change requests. Submit
 * is a review host's only method and is never a choice to remember.
 */
export type RememberedMergeMethod = Exclude<MergeMethod, 'submit'>;

const isRememberedMergeMethod = (value: string | null): value is RememberedMergeMethod =>
  value === 'merge' || value === 'squash' || value === 'rebase';

export const readMergeMethod = (): RememberedMergeMethod => {
  try {
    const stored = localStorage.getItem(KEY);
    return isRememberedMergeMethod(stored) ? stored : 'squash';
  } catch { return 'squash'; }
};

export const rememberMergeMethod = (method: MergeMethod): void => {
  if (!isRememberedMergeMethod(method)) return;
  try { localStorage.setItem(KEY, method); } catch { /* convenience only */ }
};
