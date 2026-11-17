import { z } from 'zod';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSafeStorage } from '@/stores/utils/safeStorage';

const STORAGE_KEY = 'oc.projectActions.selectedAction.v1';
const storedSchema = z.record(z.string(), z.record(z.string(), z.string()));
type StoredSelections = z.infer<typeof storedSchema>;

const read = (): StoredSelections => {
  const raw = getSafeStorage().getItem(STORAGE_KEY);
  if (raw === null) return {};
  try {
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

export const getSelectedProjectActionId = (projectId: string, runtimeKey = getRuntimeKey()): string | null => (
  read()[runtimeKey]?.[projectId] ?? null
);

export const setSelectedProjectActionId = (projectId: string, actionId: string, runtimeKey = getRuntimeKey()): void => {
  const stored = read();
  if (stored[runtimeKey]?.[projectId] === actionId) return;
  getSafeStorage().setItem(STORAGE_KEY, JSON.stringify({
    ...stored,
    [runtimeKey]: { ...stored[runtimeKey], [projectId]: actionId },
  }));
};
