import type { MergeMethod } from '@/lib/source-control/types';

const KEY = 'openchamber:pr-merge-method:v1';

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
