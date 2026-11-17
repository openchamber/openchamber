import { z } from 'zod';
import type { Model } from '@/lib/opencode/model';

export type ModelVariantConfig = Model['variants'][number];
export type ModelVariantOverlay = Omit<ModelVariantConfig, 'id'>;

export type ModelCostConfig = { input: number; output: number; cache: { read: number; write: number } };

export type ModelRow = {
  row: string;
  id: string;
  name: string;
  contextWindow: string;
  maxOutputTokens: string;
  inputCapabilities: string[];
  outputCapabilities: string[];
  tools: boolean;
  type?: string;
  capabilitiesKnown: boolean;
  metadataSource?: 'provider-api' | 'models.dev' | 'manual';
  variants: string;
  savedVariants?: Record<string, ModelVariantOverlay>;
  cost?: ModelCostConfig;
};

export type HeaderRow = {
  row: string;
  key: string;
  value: string;
};

let rowCounter = 0;

export const nextRow = (): string => `row-${rowCounter++}`;

export const createModelRow = (): ModelRow => ({
  row: nextRow(),
  id: '',
  name: '',
  contextWindow: '',
  maxOutputTokens: '',
  inputCapabilities: ['text'],
  outputCapabilities: ['text'],
  tools: true,
  capabilitiesKnown: false,
  variants: '',
});

export const createHeaderRow = (): HeaderRow => ({
  row: nextRow(),
  key: '',
  value: '',
});

export function readSavedVariants(variants: readonly ModelVariantConfig[] | undefined): Record<string, ModelVariantOverlay> {
  return Object.fromEntries((variants ?? []).map(({ id, ...overlay }) => [id, overlay]));
}

const discoveredLimitSchema = z.object({ context: z.number().optional(), output: z.number().optional() });
const discoveredCapabilitiesSchema = z.object({
  tools: z.boolean(),
  input: z.array(z.string()),
  output: z.array(z.string()),
});
const discoveredCostSchema = z.object({
  input: z.number(),
  output: z.number(),
  cache: z.object({ read: z.number(), write: z.number() }),
});
const discoveredModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  limit: discoveredLimitSchema.optional(),
  capabilities: discoveredCapabilitiesSchema.optional(),
  cost: discoveredCostSchema.optional(),
  metadata: z.object({
    providerID: z.string(),
    modelID: z.string(),
    name: z.string().optional(),
    limit: discoveredLimitSchema.optional(),
    capabilities: discoveredCapabilitiesSchema.optional(),
  }).optional(),
});

export const modelDiscoveryResponseSchema = z.object({ models: z.array(discoveredModelSchema) });
export const modelDiscoveryErrorSchema = z.object({ error: z.string() });

export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;

export const modelRowFromDiscovery = (model: DiscoveredModel): ModelRow => {
  const metadata = model.metadata;
  const context = model.limit?.context ?? metadata?.limit?.context;
  const output = model.limit?.output ?? metadata?.limit?.output;
  const capabilities = model.capabilities ?? metadata?.capabilities;
  const describedByProvider = Boolean(model.limit || model.capabilities || model.cost);
  const row: ModelRow = {
    ...createModelRow(),
    id: model.id,
    name: model.name !== model.id ? model.name : (metadata?.name ?? model.id),
    contextWindow: context ? String(context) : '',
    maxOutputTokens: output ? String(output) : '',
    inputCapabilities: capabilities?.input ?? ['text'],
    outputCapabilities: capabilities?.output ?? ['text'],
    tools: capabilities?.tools ?? true,
    capabilitiesKnown: Boolean(capabilities),
    ...(describedByProvider
      ? { metadataSource: 'provider-api' as const }
      : metadata ? { metadataSource: 'models.dev' as const } : {}),
  };
  if (model.cost) row.cost = model.cost;
  return row;
};

export const storedVariantsSchema = z.array(z.object({
  id: z.string(),
  settings: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
}));

export const storedLimitSchema = z.object({ context: z.number().optional(), output: z.number().optional() });
export const storedCapabilitiesSchema = z.object({
  tools: z.boolean().optional(),
  input: z.array(z.string()).optional(),
  output: z.array(z.string()).optional(),
});
export const storedModelCostSchema = z.object({
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  cache: z.object({ read: z.number().finite().nonnegative().optional(), write: z.number().finite().nonnegative().optional() }).optional(),
}).transform((cost) => ({
  input: cost.input,
  output: cost.output,
  cache: { read: cost.cache?.read ?? 0, write: cost.cache?.write ?? 0 },
}));

export const storedProviderEntrySchema = z.object({
  name: z.string().optional(),
  package: z.string().optional(),
  env: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.record(z.string(), z.object({
    modelID: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    package: z.string().optional(),
    variants: storedVariantsSchema.optional(),
    limit: storedLimitSchema.optional(),
    capabilities: storedCapabilitiesSchema.optional(),
    cost: storedModelCostSchema.optional(),
  })).optional(),
});

export type StoredProviderEntry = z.infer<typeof storedProviderEntrySchema>;
