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
  providerId: string,
  modelEntries: ReadonlyArray<readonly [string, T]>,
  selectedModels: readonly string[],
): ReadonlyArray<readonly [string, T]> => {
  if (selectedModels.length === 0) return modelEntries;
  const matched = modelEntries.filter(([modelName]) => selectedModels.includes(modelName));
  if (matched.length === 0 && providerId === 'opencode') return modelEntries;
  return matched;
};

export const selectVisibleModelNames = (
  providerId: string,
  modelNames: readonly string[],
  selectedModels: readonly string[],
): string[] => selectVisibleModelEntries(providerId, modelNames.map((name) => [name, name] as const), selectedModels)
  .map(([name]) => name);

export const toggleVisibleModel = (
  providerId: string,
  modelNames: readonly string[],
  selectedModels: readonly string[],
  modelName: string,
): string[] => {
  const visible = selectVisibleModelNames(providerId, modelNames, selectedModels);
  if (!visible.includes(modelName)) return [...visible, modelName];
  return visible.length > 1 ? visible.filter((name) => name !== modelName) : visible;
};
