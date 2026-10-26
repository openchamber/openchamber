/**
 * Variant ("thinking level") ids of a catalog model.
 *
 * OpenCode 2 lists a model's variants as `{ id, settings }[]`; v1 keyed them
 * by id. `Object.keys` on the array yields `"0", "1", "2"`, which is how a
 * session's `low` stopped matching and the picker fell back to "Default".
 * Every place that needs the ids goes through here.
 */
export type ModelVariantSource =
  | ReadonlyArray<{ readonly id: string }>
  | Readonly<Record<string, { readonly id?: string } | null>>
  | null
  | undefined;

export const listModelVariantIds = (variants: ModelVariantSource): string[] => {
  if (!variants) return [];
  if (Array.isArray(variants)) {
    return variants.map((variant) => variant.id).filter((id) => id.length > 0);
  }
  return Object.keys(variants);
};

/** Names of the thinking levels a model exposes, empty when it has none. */
export const modelVariantNames = (model: { readonly variants?: ModelVariantSource } | undefined): string[] =>
  listModelVariantIds(model?.variants);
