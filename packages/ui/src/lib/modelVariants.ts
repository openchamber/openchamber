import type { Provider } from '@opencode-ai/sdk/v2';

type ProviderModel = Provider['models'][string];

/**
 * Names of the thinking levels a model exposes, empty when it has none.
 *
 * The SDK's model type does not describe `variants`, so the shape is asserted
 * here once instead of at every call site that offers the levels.
 */
export const modelVariantNames = (model: ProviderModel | undefined): string[] => {
  if (!model) {
    return [];
  }
  // SAFETY: the payload types `variants` as an optional object whose keys are
  // the variant names. Only the key set is read, and it is returned as strings,
  // so no caller depends on the value shape.
  const variants = (model as { variants?: object }).variants;
  return variants ? Object.keys(variants) : [];
};
