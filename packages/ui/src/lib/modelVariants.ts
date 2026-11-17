// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/client Model variants are id/settings arrays; Object.keys yields indices instead of variant IDs.
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

export const nextThinkingVariant = (variants: readonly string[], current: string | null | undefined): string | null => {
  if (current === null || current === undefined) return variants[0] ?? null;
  const index = variants.indexOf(current);
  return index >= 0 ? variants[index + 1] ?? null : null;
};

export const modelVariantNames = (model: { readonly variants?: ModelVariantSource } | undefined): string[] =>
  listModelVariantIds(model?.variants);
