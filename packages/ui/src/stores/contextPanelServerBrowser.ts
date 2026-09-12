import { z } from 'zod';

export type SavedServerBrowserSelection = {
  browserSessionId?: string;
  serverTargetId?: string;
  targetPath: string | null;
  touchedAt: number;
};

const savedSelectionSchema = z.object({
  browserSessionId: z.string().trim().min(1).optional().catch(undefined),
  serverTargetId: z.string().trim().min(1).optional().catch(undefined),
  targetPath: z.string().nullable().catch(null),
  touchedAt: z.number().finite().catch(0),
}).refine((selection) => Boolean(selection.browserSessionId || selection.serverTargetId));

export const mergeSavedServerBrowserSelections = (
  selections: readonly SavedServerBrowserSelection[],
): SavedServerBrowserSelection[] => {
  const byTarget = new Map<string, SavedServerBrowserSelection>();
  for (const selection of selections) {
    if (!selection.browserSessionId && !selection.serverTargetId) continue;
    const key = JSON.stringify([selection.browserSessionId ?? null, selection.serverTargetId ?? null]);
    const previous = byTarget.get(key);
    if (!previous || selection.touchedAt >= previous.touchedAt) byTarget.set(key, selection);
  }
  return [...byTarget.values()].sort((a, b) => b.touchedAt - a.touchedAt);
};

export const savedServerBrowserSelectionsSchema = z.array(savedSelectionSchema.optional().catch(undefined)).catch([])
  .transform((selections) => mergeSavedServerBrowserSelections(selections.filter((selection) => selection !== undefined)));
