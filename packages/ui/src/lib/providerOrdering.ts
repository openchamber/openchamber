/**
 * Shared provider ordering semantics.
 *
 * The user-defined `providerOrder` ranks providers by id; providers missing
 * from the order keep their incoming relative order and come last. The chat
 * model picker and the provider settings sidebar must show the same order, so
 * both use this helper instead of inlining the rank sort.
 */
export const orderProvidersByUserOrder = <T extends { id: string }>(
  providers: T[],
  providerOrder: readonly string[],
): T[] => {
  if (providerOrder.length === 0) return providers;
  const rank = new Map(providerOrder.map((id, index) => [id, index] as const));
  const ranked = providers
    .filter((provider) => rank.has(provider.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  const unranked = providers.filter((provider) => !rank.has(provider.id));
  return [...ranked, ...unranked];
};
