export type DiscoveredModelLimit = { context?: number; output?: number };
export type DiscoveredModelCapabilities = { tools: boolean; input: string[]; output: string[] };

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
