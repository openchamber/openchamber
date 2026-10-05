const KEY = 'openchamber:pr-merge-method:v1';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

const isMergeMethod = (value: unknown): value is MergeMethod =>
  value === 'merge' || value === 'squash' || value === 'rebase';

export const readMergeMethod = (): MergeMethod => {
  try {
    const stored = localStorage.getItem(KEY);
    return isMergeMethod(stored) ? stored : 'squash';
  } catch { return 'squash'; }
};

export const rememberMergeMethod = (method: MergeMethod): void => {
  try { localStorage.setItem(KEY, method); } catch { /* convenience only */ }
};
