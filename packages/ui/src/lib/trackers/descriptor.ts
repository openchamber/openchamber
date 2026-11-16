import { z } from 'zod';

import { SHARED_RESERVED_PROVIDER_IDS } from '@/lib/source-control/providers/descriptor';
import type { TrackerAuthMethod, TrackerDescriptor } from './types';

const RESERVED_TRACKER_IDS: ReadonlySet<string> = new Set(SHARED_RESERVED_PROVIDER_IDS);

export const trackerProviderIdSchema = z.string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .refine((id) => !RESERVED_TRACKER_IDS.has(id), { message: 'Reserved tracker id' });

const compiles = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

const patternSchema = z.string().min(1).max(2_048).refine(compiles);

const flag = z.boolean().catch(false);

const descriptorSchema = z.object({
  id: trackerProviderIdSchema,
  name: z.string().min(1).max(64),
  authMethods: z.array(z.string()).transform((methods) => methods.filter((method): method is TrackerAuthMethod => (
    method === 'oauth' || method === 'token'
  ))),
  capabilities: z.object({
    multipleAccounts: flag,
    stateUpdate: flag,
    children: flag,
    labels: flag,
    priority: flag,
    filters: z.object({ people: flag, priority: flag }).catch({ people: false, priority: false }),
    projectMapping: flag,
    sessionComments: flag,
    hostAccess: flag,
  }),
  stateFilters: z.array(z.string().min(1).max(32)).max(32),
  urlPatterns: z.array(z.object({
    host: z.string().min(1).max(256),
    path: patternSchema,
    query: z.object({ name: z.string().min(1).max(64) }).optional().catch(undefined),
  }).nullable().catch(null))
    .max(8)
    .transform((patterns) => patterns.filter((pattern): pattern is { host: string; path: string; query?: { name: string } } => pattern !== null)),
  identifierPattern: patternSchema,
}) satisfies z.ZodType<TrackerDescriptor>;

export const trackerDescriptorListSchema = z.array(descriptorSchema.nullable().catch(null)).transform((list) => {
  const seen = new Set<string>();
  const descriptors: TrackerDescriptor[] = [];
  for (const descriptor of list) {
    if (!descriptor || seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    descriptors.push(descriptor);
  }
  return descriptors;
});

const unknownDescriptors = new Map<string, TrackerDescriptor>();

export const unknownTrackerDescriptor = (id: string): TrackerDescriptor => {
  const cached = unknownDescriptors.get(id);
  if (cached) return cached;
  const descriptor: TrackerDescriptor = {
    id,
    name: id,
    authMethods: [],
    capabilities: {
      multipleAccounts: false,
      stateUpdate: false,
      children: false,
      labels: false,
      priority: false,
      filters: { people: false, priority: false },
      projectMapping: false,
      sessionComments: false,
      hostAccess: false,
    },
    stateFilters: ['open', 'all'],
    urlPatterns: [],
    identifierPattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  };
  unknownDescriptors.set(id, descriptor);
  return descriptor;
};
