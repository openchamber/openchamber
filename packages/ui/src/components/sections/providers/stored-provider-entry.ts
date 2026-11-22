import { z } from 'zod';

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

export const storedProviderEntrySchema = z.object({
  canonical: z.string().optional(),
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
  })).optional(),
});

type StoredProviderEntry = z.infer<typeof storedProviderEntrySchema>;

export type InheritedCanonical = { provider: string; path: string };
export type StoredProviderSource = StoredProviderEntry & { inheritedCanonical?: InheritedCanonical };
