import type { QuotaProviderId } from '@/types';

/**
 * The model rows a compact usage panel shows. A saved selection wins while it
 * still names a model the provider reports.
 *
 * OpenCode Zen (`opencode`) once listed OpenCode Go models, so a selection
 * saved back then can name no current Zen model; for Zen alone, the current
 * rows replace an empty panel. Every other provider keeps filtering by its
 * saved selection, even when nothing matches.
 */
export const selectVisibleModelEntries = <T>(
  providerId: QuotaProviderId,
  modelEntries: ReadonlyArray<readonly [string, T]>,
  selectedModels: readonly string[],
): ReadonlyArray<readonly [string, T]> => {
  if (selectedModels.length === 0) return modelEntries;
  const matched = modelEntries.filter(([modelName]) => selectedModels.includes(modelName));
  if (matched.length === 0 && providerId === 'opencode') return modelEntries;
  return matched;
};
