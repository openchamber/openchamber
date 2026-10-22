import { z } from 'zod';

import { SHARED_RESERVED_PROVIDER_IDS } from '@/lib/source-control/providers/descriptor';
import type { TrackerAuthMethod, TrackerDescriptor } from './types';

/**
 * Ids the tracker registry never accepts by syntax: values other surfaces
 * already use as a `provider` or source (guest panels, links, external items,
 * the board's repository tab). Ids the connected server serves as source
 * control are refused by the registry instead (`registry.ts`), because tracked
 * items and the read cache key both families by `provider` in one namespace.
 */
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

const patternSchema = z.string().min(1).max(256).refine(compiles);

// A capability an older server does not name is off.
const flag = z.boolean().catch(false);

const descriptorSchema = z.object({
  id: trackerProviderIdSchema,
  name: z.string().min(1).max(64),
  // Methods this version cannot offer are left out instead of failing the tracker.
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
  // A pattern that does not compile is dropped; the tracker still lists.
  urlPatterns: z.array(z.object({ host: z.string().min(1).max(256), path: patternSchema }).nullable().catch(null))
    .max(8)
    .transform((patterns) => patterns.filter((pattern): pattern is { host: string; path: string } => pattern !== null)),
  identifierPattern: patternSchema,
}) satisfies z.ZodType<TrackerDescriptor>;

/**
 * A tracker list, in the server's order. One malformed or reserved descriptor
 * is left out and never fails the others; a repeated id keeps its first entry.
 */
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

/**
 * What the UI shows for a tracker id the registry does not hold: its id as
 * the name, no auth methods, every capability off, only the `open` and `all`
 * filters, and no URL patterns, so it matches no link. Cached per id, so
 * selectors see one stable object.
 */
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
