import { compact, type Model, type ModelRef, type Provider } from "./model"
import { withZenName } from "./providerDisplayName"

export type ProviderCatalog = {
  providers: Provider[]
  models: Model[]
  default?: ModelRef
}

export const projectProviderCatalog = (
  models: readonly Model[],
  fallback: { modelID: string; providerID: string } | null | undefined,
  providers: readonly Provider[],
): ProviderCatalog => compact({
  providers: providers.map(withZenName),
  models: models.map((model) => (Array.isArray(model.variants) ? model : { ...model, variants: [] })),
  default: fallback ? { id: fallback.modelID, providerID: fallback.providerID } : undefined,
})
