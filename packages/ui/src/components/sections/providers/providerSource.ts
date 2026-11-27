import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { storedProviderEntrySchema, type InheritedCanonical, type StoredProviderSource } from './stored-provider-entry';

interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

export interface ProviderSources {
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

const inheritedCanonicalSchema: z.ZodType<InheritedCanonical> = z.object({ provider: z.string().min(1), path: z.string().min(1) });
const sourceInfoSchema = z.object({ exists: z.boolean(), path: z.string().nullable().optional() });
const sourceBodySchema = z.object({
  error: z.string(),
  sources: z.object({ user: sourceInfoSchema, project: sourceInfoSchema, custom: sourceInfoSchema.optional() }).loose(),
  config: z.unknown(),
  inheritedCanonical: z.unknown(),
}).partial();
const sourcePayloadSchema = sourceBodySchema.extend({ data: sourceBodySchema.optional() });

const readStoredProviderSource = (config: unknown, inherited: unknown): StoredProviderSource | null => {
  const entry = storedProviderEntrySchema.safeParse(config).data;
  if (!entry) return null;
  const inheritedCanonical = inheritedCanonicalSchema.safeParse(inherited).data;
  return inheritedCanonical ? { ...entry, inheritedCanonical } : entry;
};

const removeResponseSchema = z.object({ error: z.string(), removed: z.boolean() }).partial();

export async function removeProviderFromConfig(providerId: string, directory: string | null | undefined, failureMessage: string) {
  const query = new URLSearchParams({ scope: 'all' });
  if (directory) query.set('directory', directory);
  const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/auth?${query}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  const payload = removeResponseSchema.safeParse(await response.json().catch(() => null)).data;
  if (!response.ok) throw new Error(payload?.error || failureMessage);
  return payload?.removed === true;
}

export async function fetchProviderSource(providerId: string, directory: string | null | undefined, failureMessage: string) {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/source${query}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const payload = sourcePayloadSchema.safeParse(await response.json().catch(() => null)).data;
  if (!response.ok) throw new Error(payload?.error || failureMessage);
  const body = payload?.sources ? payload : payload?.data;
  if (!body?.sources) return null;
  return { sources: body.sources, stored: readStoredProviderSource(body.config, body.inheritedCanonical) };
}
