export type DiscoveredModelLimit = { context?: number; output?: number };
export type DiscoveredModelCapabilities = { tools: boolean; input: string[]; output: string[] };
export type DiscoveredModelCost = { input: number; output: number; cache: { read: number; write: number } };

export type DiscoveredModelMetadata = {
  providerID: string;
  modelID: string;
  name?: string;
  limit?: DiscoveredModelLimit;
  capabilities?: DiscoveredModelCapabilities;
};

export type DiscoveredModel = {
  id: string;
  name: string;
  limit?: DiscoveredModelLimit;
  capabilities?: DiscoveredModelCapabilities;
  cost?: DiscoveredModelCost;
  metadataMatch?: 'exact' | 'ambiguous' | 'none' | 'unavailable';
  metadata?: DiscoveredModelMetadata;
  metadataCandidates?: DiscoveredModelMetadata[];
};

export type ProviderModelDiscoveryResult = {
  models: DiscoveredModel[];
  enrichment: { requested: boolean; available: boolean; stale?: boolean };
};

export type DiscoverProviderModelsOptions = {
  storedApiKey?: string | null;
  storedBaseURL?: string;
};

export function discoverProviderModels(input: unknown, options?: DiscoverProviderModelsOptions): Promise<ProviderModelDiscoveryResult>;
