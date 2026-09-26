/** Resolve within one provider. Fast entries can share modelID with their base model. */
export const findCatalogModel = <T extends { id: string; modelID: string; providerID: string }>(
  models: readonly T[] | undefined,
  modelId: string,
): T | undefined => {
  if (!models || !modelId) return undefined;

  const exact = models.find((model) => model.id === modelId);
  if (exact) return exact;

  // Earlier catalogs/persisted preferences also used provider-qualified ids.
  const qualified = models.find((model) => `${model.providerID}/${model.id}` === modelId);
  if (qualified) return qualified;

  // Older saved references may use modelID when id is provider-qualified.
  const base = models.find((model) => model.id === `${model.providerID}/${modelId}`);
  if (base) return base;

  const aliases = models.filter((model) => model.modelID === modelId);
  return aliases.length === 1 ? aliases[0] : undefined;
};
