import { z } from 'zod';

import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

export type MobileBrowserScope = {
  readonly runtimeKey: string;
  readonly directory: string;
};

const selectionSchema = z.object({
  sessionId: z.string().min(1),
  serverTargetId: z.string().min(1),
}).readonly();

type MobileBrowserSelection = z.infer<typeof selectionSchema>;

const storageKey = (scope: MobileBrowserScope): string =>
  `oc.mobile.browser.v1:${JSON.stringify([scope.runtimeKey, scope.directory])}`;

export const readMobileBrowserSelection = (
  scope: MobileBrowserScope,
  storage: Pick<Storage, 'getItem'> = getDeferredSafeStorage(),
): MobileBrowserSelection | null => {
  const raw = storage.getItem(storageKey(scope));
  if (!raw) return null;
  try {
    const result = selectionSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

export const saveMobileBrowserSelection = (
  scope: MobileBrowserScope,
  selection: MobileBrowserSelection,
  storage: Pick<Storage, 'setItem'> = getDeferredSafeStorage(),
): void => {
  storage.setItem(storageKey(scope), JSON.stringify(selection));
};
